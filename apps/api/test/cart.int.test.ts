/**
 * The basket against real PostgreSQL and Redis (migration 0014, task P5-5).
 *
 * Two kinds of customer reach the same basket: a signed-in account and a
 * verified guest. Most of this file is about the boundaries between them —
 * that a guest can buy, that a guest still cannot do anything a session is
 * required for, and that neither of them can get a UK basket to hold an IE
 * draw however the request is shaped.
 */
import { CartResponseSchema, ErrorResponseSchema } from '@hv/contracts';
import {
  SecretBox,
  VERIFICATION_EMAIL_TOPIC,
  openPayload,
  type VerificationEmailPayload,
} from '@hv/domain';
import {
  enableGermanyForTesting,
  enableMarketsForTesting,
  insertFixtureDraw,
  insertFixtureUser,
} from '@hv/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUEST_SESSION_COOKIE } from '../src/auth/cookies';
const HOUR = 60 * 60 * 1000;

import {
  type Harness,
  WEB_ORIGIN,
  randomIp,
  registeredClient,
  startApp,
  startHarness,
  uniqueEmail,
} from './support';

const cartOf = (response: { json: () => unknown }) =>
  CartResponseSchema.parse(response.json()).cart;
const errorCode = (response: { json: () => unknown }) =>
  ErrorResponseSchema.parse(response.json()).error.code;

// Low entropy on purpose: the repository's placeholder convention.
const KEY = 'a1'.repeat(16) + 'b2'.repeat(16);
const box = new SecretBox(KEY, 'k1');

describe('the basket', () => {
  let h: Harness;
  let ukSlug: string;
  let ieSlug: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie,de', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);
    ukSlug = `cart-uk-${Date.now()}`;
    ieSlug = `cart-ie-${Date.now()}`;
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: ukSlug,
      state: 'live',
      totalTickets: 200,
      maxPerPerson: 10,
      ticketPriceMinor: 250,
    });
    await insertFixtureDraw(h.sql, {
      market: 'ie',
      slug: ieSlug,
      state: 'live',
      totalTickets: 200,
      maxPerPerson: 10,
      ticketPriceMinor: 300,
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  /** A fresh client address per test: the basket limit is keyed per owner, sending per IP. */
  let ip: string;
  beforeEach(() => {
    ip = randomIp();
  });

  // ---- guest helpers -------------------------------------------------------

  const inject = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    cookie?: string,
    payload?: unknown,
  ) =>
    h.app.inject({
      method,
      url,
      remoteAddress: ip,
      headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const guestCookieFrom = (response: { headers: Record<string, unknown> }) => {
    const raw = response.headers['set-cookie'] as string | string[] | undefined;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = value ? new RegExp(`${GUEST_SESSION_COOKIE}=([^;]*)`).exec(value) : null;
    return match ? `${GUEST_SESSION_COOKIE}=${match[1]}` : null;
  };

  /** Requests a code, reads it out of the outbox as the worker would, and verifies it. */
  const verifiedGuest = async (market = 'uk') => {
    const email = uniqueEmail('cart-guest');
    const requested = await inject('POST', `/markets/${market}/checkout/email/code`, undefined, {
      email,
    });
    expect(requested.statusCode).toBe(202);
    const cookie = guestCookieFrom(requested);
    expect(cookie).not.toBeNull();

    // Read the code the way the mail worker would: out of the outbox,
    // unsealed. It is stored only as a hash, so there is nothing to read back.
    const { rows } = await h.sql.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = $1 ORDER BY created_at DESC LIMIT 1`,
      [VERIFICATION_EMAIL_TOPIC],
    );
    const code = openPayload<VerificationEmailPayload>(
      box,
      VERIFICATION_EMAIL_TOPIC,
      rows[0]!.payload,
    ).code;

    const verified = await inject(`POST`, `/markets/${market}/checkout/email/verify`, cookie!, {
      email,
      code,
    });
    expect(verified.statusCode).toBe(200);
    return { cookie: cookie!, email };
  };

  // ---- authenticated customers --------------------------------------------

  describe('a signed-in customer', () => {
    it('starts with an empty basket and no row behind it', async () => {
      const client = await registeredClient(h.app);
      const cart = cartOf(await client.get('/markets/uk/cart'));
      expect(cart).toMatchObject({ id: null, owner: 'user', items: [], activeItemCount: 0 });
      expect(cart.totalMinor).toBeNull();
      expect(cart.currency).toBeNull();
    });

    it('adds a draw, which holds real tickets', async () => {
      const client = await registeredClient(h.app);
      const response = await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 3 });
      expect(response.statusCode).toBe(201);

      const cart = cartOf(response);
      expect(cart.items).toHaveLength(1);
      expect(cart.activeItemCount).toBe(1);
      const reservation = cart.items[0]!.reservation;
      expect(reservation.status).toBe('active');
      expect(reservation.quantity).toBe(3);
      expect(reservation.ticketNumbers).toHaveLength(3);
      // Price and total come from the server, never from the request.
      expect(reservation.unitPriceMinor).toBe(250);
      expect(reservation.totalMinor).toBe(750);
      expect(cart.totalMinor).toBe(750);
      expect(cart.currency).toBe('GBP');
    });

    it('keeps one basket per market however many times it is used', async () => {
      const client = await registeredClient(h.app);
      await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 });
      const first = cartOf(await client.get('/markets/uk/cart'));
      await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 });
      const again = cartOf(await client.get('/markets/uk/cart'));
      expect(again.id).toBe(first.id);

      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM carts WHERE id = $1`,
        [first.id],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('refuses a second live item for the same draw', async () => {
      const client = await registeredClient(h.app);
      expect(
        (await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 })).statusCode,
      ).toBe(201);
      const second = await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 });
      expect(second.statusCode).toBe(409);
      expect(errorCode(second)).toBe('CONFLICT');
    });

    it('removes an item and gives the tickets back', async () => {
      const client = await registeredClient(h.app);
      const added = cartOf(
        await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 2 }),
      );
      const item = added.items[0]!;

      const after = cartOf(await client.request('DELETE', `/markets/uk/cart/items/${item.id}`));
      expect(after.activeItemCount).toBe(0);
      expect(after.totalMinor).toBeNull();

      const { rows } = await h.sql.query<{ status: string }>(
        `SELECT status FROM reservations WHERE id = $1`,
        [item.reservation.id],
      );
      expect(rows[0]!.status).toBe('released');
    });

    it('refuses to remove an item that is not in its basket', async () => {
      const alice = await registeredClient(h.app);
      const bob = await registeredClient(h.app);
      const added = cartOf(
        await alice.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 }),
      );
      const response = await bob.request('DELETE', `/markets/uk/cart/items/${added.items[0]!.id}`);
      expect(response.statusCode).toBe(404);
    });

    it('charges the per-person cap, which the basket cannot exceed', async () => {
      const client = await registeredClient(h.app);
      const tooMany = await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 11 });
      expect(tooMany.statusCode).toBe(400);
      expect(errorCode(tooMany)).toBe('INVALID_QUANTITY');
    });
  });

  // ---- guests --------------------------------------------------------------

  describe('a verified guest', () => {
    it('can hold a basket without an account', async () => {
      const { cookie } = await verifiedGuest();
      const response = await inject('POST', '/markets/uk/cart/items', cookie, {
        slug: ukSlug,
        quantity: 2,
      });
      expect(response.statusCode).toBe(201);
      const cart = cartOf(response);
      expect(cart.owner).toBe('guest');
      expect(cart.items[0]!.reservation.ticketNumbers).toHaveLength(2);
      expect(cart.totalMinor).toBe(500);
    });

    it('is charged against the verified email, not a user', async () => {
      const { cookie, email } = await verifiedGuest();
      await inject('POST', '/markets/uk/cart/items', cookie, { slug: ukSlug, quantity: 1 });
      const { rows } = await h.sql.query<{
        entrant_type: string;
        entrant_ref: string;
        user_id: string | null;
      }>(
        `SELECT r.entrant_type, r.entrant_ref, r.user_id
           FROM reservations r JOIN cart_items ci ON ci.reservation_id = r.id
          WHERE r.entrant_ref = $1`,
        [email],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entrant_type: 'email', entrant_ref: email, user_id: null });
    });

    it('has a basket of its own, separate from any account', async () => {
      const { cookie } = await verifiedGuest();
      const client = await registeredClient(h.app);
      await inject('POST', '/markets/uk/cart/items', cookie, { slug: ukSlug, quantity: 1 });
      await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 });

      const guestCart = cartOf(await inject('GET', '/markets/uk/cart', cookie));
      const userCart = cartOf(await client.get('/markets/uk/cart'));
      expect(guestCart.id).not.toBe(userCart.id);
      expect(guestCart.owner).toBe('guest');
      expect(userCart.owner).toBe('user');
    });

    it('cannot add anything before verifying an email', async () => {
      // A guest session exists (the code request issued one) but nothing is verified.
      const requested = await inject('POST', '/markets/uk/checkout/email/code', undefined, {
        email: uniqueEmail('unverified'),
      });
      const cookie = guestCookieFrom(requested)!;
      const response = await inject('POST', '/markets/uk/cart/items', cookie, {
        slug: ukSlug,
        quantity: 1,
      });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VERIFICATION_REQUIRED');
    });

    it('cannot add anything once the verification has gone stale', async () => {
      const { cookie } = await verifiedGuest();
      // Past the 30-minute binding window (ADR-0020/0029).
      await h.sql.query(
        `UPDATE guest_sessions SET verified_email_at = now() - interval '31 minutes'
          WHERE verified_email IS NOT NULL`,
      );
      const response = await inject('POST', '/markets/uk/cart/items', cookie, {
        slug: ukSlug,
        quantity: 1,
      });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VERIFICATION_REQUIRED');
    });

    it('is refused a basket with no identity at all', async () => {
      const response = await inject('GET', '/markets/uk/cart');
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('CHECKOUT_IDENTITY_REQUIRED');
    });
  });

  // ---- the boundary the guest identity must never cross --------------------

  describe('a guest is still not a signed-in customer', () => {
    it('cannot reach the authenticated reservation routes', async () => {
      const { cookie } = await verifiedGuest();
      for (const [method, url] of [
        ['POST', `/markets/uk/draws/${ukSlug}/reservations`],
        ['GET', '/markets/uk/reservations'],
      ] as const) {
        const response = await inject(method, url, cookie, { quantity: 1 });
        expect(response.statusCode).toBe(401);
      }
    });

    it('cannot reach an admin route', async () => {
      const { cookie } = await verifiedGuest();
      const response = await inject('GET', '/markets/uk/cart', cookie);
      expect(response.statusCode).toBe(200);
      // The same cookie against an admin route gets nothing.
      const admin = await inject('GET', '/admin/markets', cookie);
      expect([401, 403]).toContain(admin.statusCode);
    });

    it('cannot see or empty an account holder’s basket', async () => {
      const client = await registeredClient(h.app);
      const owned = cartOf(
        await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 }),
      );
      const { cookie } = await verifiedGuest();

      const seen = cartOf(await inject('GET', '/markets/uk/cart', cookie));
      expect(seen.id).not.toBe(owned.id);
      const removal = await inject(
        'DELETE',
        `/markets/uk/cart/items/${owned.items[0]!.id}`,
        cookie,
      );
      expect(removal.statusCode).toBe(404);
    });
  });

  // ---- market isolation ----------------------------------------------------

  describe('one basket per market, and never a mixed one', () => {
    it('gives the same customer separate baskets in UK and IE', async () => {
      const client = await registeredClient(h.app);
      await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 });
      await client.post('/markets/ie/cart/items', { slug: ieSlug, quantity: 1 });

      const uk = cartOf(await client.get('/markets/uk/cart'));
      const ie = cartOf(await client.get('/markets/ie/cart'));
      expect(uk.id).not.toBe(ie.id);
      expect(uk.currency).toBe('GBP');
      expect(ie.currency).toBe('EUR');
      expect(uk.items).toHaveLength(1);
      expect(ie.items).toHaveLength(1);
    });

    it('refuses an IE draw through the UK basket, with the UI bypassed', async () => {
      const client = await registeredClient(h.app);
      // A direct API call naming the other market's draw — no UI involved.
      const response = await client.post('/markets/uk/cart/items', { slug: ieSlug, quantity: 1 });
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
    });

    it('will not let an item be filed under another market, even in SQL', async () => {
      const client = await registeredClient(h.app);
      const cart = cartOf(
        await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 }),
      );
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'ie'`,
      );
      // The composite foreign keys make a cross-market row unrepresentable.
      await expect(
        h.sql.query(`UPDATE cart_items SET market_id = $1 WHERE cart_id = $2`, [
          rows[0]!.id,
          cart.id,
        ]),
      ).rejects.toThrow();
    });

    it('is refused in a market that is not available', async () => {
      const client = await registeredClient(h.app);
      expect((await client.get('/markets/de/cart')).statusCode).toBe(404);
    });
  });

  // ---- the database holds the line even without the API --------------------

  describe('the schema, not just the API', () => {
    it('refuses a basket owned by both a user and a guest session', async () => {
      const { rows: markets } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'uk'`,
      );
      const { rows: users } = await h.sql.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
      const { rows: guests } = await h.sql.query<{ id: string }>(
        `SELECT id FROM guest_sessions LIMIT 1`,
      );
      await expect(
        h.sql.query(
          `INSERT INTO carts (market_id, user_id, guest_session_id) VALUES ($1, $2, $3)`,
          [markets[0]!.id, users[0]!.id, guests[0]!.id],
        ),
      ).rejects.toThrow(/carts_one_owner/);
    });

    it('refuses a basket owned by nobody', async () => {
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'uk'`,
      );
      await expect(
        h.sql.query(`INSERT INTO carts (market_id) VALUES ($1)`, [rows[0]!.id]),
      ).rejects.toThrow(/carts_one_owner/);
    });

    it('refuses a second basket for the same owner in the same market', async () => {
      const client = await registeredClient(h.app);
      const cart = cartOf(
        await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 }),
      );
      const { rows } = await h.sql.query<{ user_id: string; market_id: string }>(
        `SELECT user_id, market_id FROM carts WHERE id = $1`,
        [cart.id],
      );
      await expect(
        h.sql.query(`INSERT INTO carts (market_id, user_id) VALUES ($1, $2)`, [
          rows[0]!.market_id,
          rows[0]!.user_id,
        ]),
      ).rejects.toThrow(/carts_user_market_idx/);
    });

    it('refuses someone else’s reservation in a basket', async () => {
      const alice = await registeredClient(h.app);
      const bob = await registeredClient(h.app);
      const aliceCart = cartOf(
        await alice.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 }),
      );
      const bobCart = cartOf(
        await bob.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 }),
      );
      const { rows } = await h.sql.query<{ market_id: string; draw_id: string }>(
        `SELECT market_id, draw_id FROM cart_items WHERE cart_id = $1`,
        [bobCart.id],
      );
      // Bob's reservation, filed into Alice's basket.
      await expect(
        h.sql.query(
          `INSERT INTO cart_items (cart_id, market_id, draw_id, reservation_id)
           VALUES ($1, $2, $3, $4)`,
          [aliceCart.id, rows[0]!.market_id, rows[0]!.draw_id, bobCart.items[0]!.reservation.id],
        ),
      ).rejects.toThrow(/may only hold its own owner/);
    });

    it('will not let hv_app delete a basket or its items', async () => {
      const { rows } = await h.sql.query<{ has: boolean }>(
        `SELECT bool_or(has_table_privilege('hv_app', c.oid, 'DELETE')) AS has
           FROM pg_class c WHERE c.relname IN ('carts', 'cart_items')`,
      );
      expect(rows[0]!.has).toBe(false);
    });
  });

  // ---- reservation integration and expiry ----------------------------------

  describe('the basket holds reservations, with all their rules', () => {
    it('shows a lapsed hold as expired and stops counting it', async () => {
      // A reservation's terms are immutable once issued, so the hold is made
      // genuinely short-lived rather than edited into the past, and the basket
      // is polled until it reports the lapse. A fixed sleep would be a race on
      // a loaded machine; a basket that never lapses still fails here.
      const brief = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie,de',
        OUTBOX_ENCRYPTION_KEY: KEY,
        RESERVATION_TTL_SECONDS: '2',
      });
      try {
        const client = await registeredClient(brief);
        await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 2 });

        const deadline = Date.now() + 15_000;
        let cart = cartOf(await client.get('/markets/uk/cart'));
        while (cart.activeItemCount > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          cart = cartOf(await client.get('/markets/uk/cart'));
        }

        // The item stays visible — it explains where the tickets went — but it
        // is no longer active and no longer part of the total.
        expect(cart.items).toHaveLength(1);
        expect(cart.items[0]!.reservation.status).toBe('expired');
        expect(cart.activeItemCount).toBe(0);
        expect(cart.totalMinor).toBeNull();
      } finally {
        await brief.close();
      }
    });

    it('refuses a draw that is published but not yet open', async () => {
      const upcoming = `cart-upcoming-${Date.now()}`;
      await insertFixtureDraw(h.sql, {
        market: 'uk',
        slug: upcoming,
        state: 'scheduled',
        totalTickets: 50,
        opensAt: new Date(Date.now() + HOUR),
        closesAt: new Date(Date.now() + 48 * HOUR),
      });
      const client = await registeredClient(h.app);
      const response = await client.post('/markets/uk/cart/items', { slug: upcoming, quantity: 1 });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('DRAW_NOT_OPEN');
    });

    it('refuses a draw that does not exist', async () => {
      const client = await registeredClient(h.app);
      const response = await client.post('/markets/uk/cart/items', {
        slug: 'no-such-draw',
        quantity: 1,
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses unknown fields', async () => {
      const client = await registeredClient(h.app);
      const response = await client.post('/markets/uk/cart/items', {
        slug: ukSlug,
        quantity: 1,
        priceMinor: 1,
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ---- concurrency, against real PostgreSQL --------------------------------

  describe('under concurrency', () => {
    it('creates one basket when a customer’s first two requests race', async () => {
      const client = await registeredClient(h.app);
      const slugs = [ukSlug, ieSlug];
      // Two markets would be two baskets; the race that matters is the same
      // market twice, where ON CONFLICT DO NOTHING has to settle it.
      const [a, b] = await Promise.all([
        client.post('/markets/uk/cart/items', { slug: slugs[0], quantity: 1 }),
        client.post('/markets/uk/cart/items', { slug: slugs[0], quantity: 1 }),
      ]);
      // One wins the draw slot; the other is refused as a duplicate item, not
      // by a crash, and never by creating a second basket.
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([201, 409]);

      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM carts c
            JOIN users u ON u.id = c.user_id
           WHERE u.email = $1`,
        [client.email],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('never holds two live items for one draw, however the adds interleave', async () => {
      const client = await registeredClient(h.app);
      const attempts = await Promise.all(
        Array.from({ length: 4 }, () =>
          client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 }),
        ),
      );
      expect(attempts.filter((r) => r.statusCode === 201)).toHaveLength(1);

      const cart = cartOf(await client.get('/markets/uk/cart'));
      expect(cart.items.filter((i) => i.reservation.status === 'active')).toHaveLength(1);
    });

    it('holds the per-person cap when one customer’s adds race', async () => {
      // maxPerPerson is 10 on this draw. Four concurrent adds of 4 cannot all
      // succeed, and the counter is what stops them — not the API.
      const capped = `cart-cap-${Date.now()}`;
      await insertFixtureDraw(h.sql, {
        market: 'uk',
        slug: capped,
        state: 'live',
        totalTickets: 100,
        maxPerPerson: 4,
      });
      const client = await registeredClient(h.app);
      await Promise.all(
        Array.from({ length: 4 }, () =>
          client.post(`/markets/uk/cart/items`, { slug: capped, quantity: 4 }),
        ),
      );

      const { rows } = await h.sql.query<{ count: number }>(
        `SELECT dec.count FROM draw_entrant_counts dec
            JOIN draws d ON d.id = dec.draw_id
           WHERE d.slug = $1`,
        [capped],
      );
      expect(rows[0]?.count ?? 0).toBeLessThanOrEqual(4);
    });

    it('gives a limited pool to exactly as many baskets as it has tickets', async () => {
      const scarce = `cart-scarce-${Date.now()}`;
      await insertFixtureDraw(h.sql, {
        market: 'uk',
        slug: scarce,
        state: 'live',
        totalTickets: 5,
        maxPerPerson: 1,
      });
      const clients = await Promise.all(Array.from({ length: 8 }, () => registeredClient(h.app)));
      const results = await Promise.all(
        clients.map((c) => c.post('/markets/uk/cart/items', { slug: scarce, quantity: 1 })),
      );

      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
      const { rows } = await h.sql.query<{ n: number; distinct: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT t.ticket_number)::int AS distinct
           FROM tickets t JOIN draws d ON d.id = t.draw_id
          WHERE d.slug = $1 AND t.status = 'reserved'`,
        [scarce],
      );
      // Five tickets, five holders, no number issued twice.
      expect(rows[0]!.n).toBe(5);
      expect(rows[0]!.distinct).toBe(5);
    });
  });
});

/** Germany stays refused whatever the basket does. */
describe('the German gate is unaffected', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
    await enableMarketsForTesting(h.sql, ['uk']);
    await enableGermanyForTesting(
      h.sql,
      await insertFixtureUser(h.sql, 'de-approver-cart@example.com'),
    );
  });

  afterAll(async () => {
    await h?.close();
  });

  it('refuses a German basket even when the market row is enabled', async () => {
    const client = await registeredClient(h.app);
    expect((await client.get('/markets/de/cart')).statusCode).toBe(404);
  });
});
