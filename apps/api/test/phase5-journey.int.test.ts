/**
 * Phase 5 end to end, as one customer would live it (task P5-8).
 *
 * Every stage of checkout is tested thoroughly in its own file. What is not
 * tested anywhere else is the whole of it in sequence — guest session, email
 * verification, basket, terms, order — with the state each stage leaves behind
 * being exactly what the next one needs.
 *
 * It also pins the phase boundary from the customer's side: at the end of a
 * complete, successful checkout, nothing is sold and nothing is paid.
 */
import { OrderResponseSchema } from '@hv/contracts';
import {
  SecretBox,
  VERIFICATION_EMAIL_TOPIC,
  openPayload,
  type VerificationEmailPayload,
} from '@hv/domain';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUEST_SESSION_COOKIE } from '../src/auth/cookies';
import {
  type Client,
  type Harness,
  WEB_ORIGIN,
  enrolMfa,
  grantRole,
  randomIp,
  registeredClient,
  startHarness,
  uniqueEmail,
} from './support';

const KEY = 'a1'.repeat(16) + 'b2'.repeat(16);
const box = new SecretBox(KEY, 'k1');
const orderOf = (r: { json: () => unknown }) => OrderResponseSchema.parse(r.json()).order;

describe('the whole of Phase 5, in order', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let slug: string;
  let termsVersion: string;
  let correctOption: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk']);

    admin = await registeredClient(h.app, uniqueEmail('journey-admin'));
    await grantRole(h.sql, admin.email, 'super_admin');
    await enrolMfa(admin);

    termsVersion = `test-fixture-journey-${Date.now()}`;
    const created = (
      await admin.post('/admin/markets/uk/terms', {
        version: termsVersion,
        publish: true,
        reason: 'Integration test fixture.',
      })
    ).json<{ version: { id: string } }>().version;
    await admin.post(`/admin/markets/uk/terms/${created.id}/activate`, {
      reason: 'Integration test fixture.',
    });

    slug = `journey-${Date.now()}`;
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug,
      state: 'live',
      totalTickets: 200,
      maxPerPerson: 10,
      ticketPriceMinor: 250,
    });
    const options = await h.sql.query<{ id: string }>(
      `SELECT o.id FROM skill_question_options o
         JOIN draws d ON d.skill_question_id = o.skill_question_id
        WHERE d.slug = $1 AND o.is_correct`,
      [slug],
    );
    correctOption = options.rows[0]!.id;
  });

  afterAll(async () => {
    await h?.close();
  });

  let ip: string;
  beforeEach(() => {
    ip = randomIp();
  });

  const inject = (
    method: 'GET' | 'POST',
    url: string,
    cookie?: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      remoteAddress: ip,
      headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}), ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const guestCookieFrom = (response: { headers: Record<string, unknown> }) => {
    const raw = response.headers['set-cookie'] as string | string[] | undefined;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = value ? new RegExp(`${GUEST_SESSION_COOKIE}=([^;]*)`).exec(value) : null;
    return match ? `${GUEST_SESSION_COOKIE}=${match[1]}` : null;
  };

  /** A guest session with `email` verified on it. */
  const verifiedGuest = async (email: string) => {
    const requested = await inject('POST', '/markets/uk/checkout/email/code', undefined, { email });
    expect(requested.statusCode).toBe(202);
    const cookie = guestCookieFrom(requested)!;
    const { rows } = await h.sql.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = $1 ORDER BY created_at DESC LIMIT 1`,
      [VERIFICATION_EMAIL_TOPIC],
    );
    const code = openPayload<VerificationEmailPayload>(
      box,
      VERIFICATION_EMAIL_TOPIC,
      rows[0]!.payload,
    ).code;
    const verified = await inject('POST', '/markets/uk/checkout/email/verify', cookie, {
      email,
      code,
    });
    expect(verified.statusCode).toBe(200);
    return cookie;
  };

  /** Nothing in this phase may sell a ticket or take a payment. */
  const assertPhaseBoundary = async (orderId: string) => {
    const sold = await h.sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tickets WHERE status = 'sold'`,
    );
    expect(sold.rows[0]!.n).toBe(0);

    const held = await h.sql.query<{ status: string; reserved: number }>(
      `SELECT r.status, count(t.id)::int AS reserved
         FROM reservations r
         JOIN order_items oi ON oi.reservation_id = r.id
         LEFT JOIN tickets t ON t.reservation_id = r.id AND t.status = 'reserved'
        WHERE oi.order_id = $1 GROUP BY r.status`,
      [orderId],
    );
    expect(held.rows[0]!.status).toBe('active');
    expect(held.rows[0]!.reserved).toBeGreaterThan(0);

    const order = await h.sql.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [
      orderId,
    ]);
    expect(order.rows[0]!.status).toBe('awaiting_payment');
  };

  // ---- the guest journey ---------------------------------------------------

  it('takes a guest from nothing to an order, without an account', async () => {
    const email = uniqueEmail('journey-guest');
    const usersBefore = await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);

    // 1. Ask for a code. This is what issues the guest session.
    const requested = await inject('POST', '/markets/uk/checkout/email/code', undefined, { email });
    expect(requested.statusCode).toBe(202);
    const cookie = guestCookieFrom(requested);
    expect(cookie).not.toBeNull();

    // 2. Read the code the way the mail worker would, and verify.
    const { rows } = await h.sql.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = $1 ORDER BY created_at DESC LIMIT 1`,
      [VERIFICATION_EMAIL_TOPIC],
    );
    const code = openPayload<VerificationEmailPayload>(
      box,
      VERIFICATION_EMAIL_TOPIC,
      rows[0]!.payload,
    ).code;
    const verified = await inject('POST', '/markets/uk/checkout/email/verify', cookie!, {
      email,
      code,
    });
    expect(verified.statusCode).toBe(200);

    // 3. Basket. Not possible before the address was verified.
    const added = await inject('POST', '/markets/uk/cart/items', cookie!, { slug, quantity: 3 });
    expect(added.statusCode).toBe(201);

    // 4. Terms. The version the customer is shown is the one they accept.
    const terms = (await inject('GET', '/markets/uk/terms', cookie!)).json<{
      active: { version: string };
      checkoutAllowed: boolean;
    }>();
    expect(terms.checkoutAllowed).toBe(true);
    expect(
      (
        await inject('POST', '/markets/uk/terms/acceptance', cookie!, {
          version: terms.active.version,
        })
      ).statusCode,
    ).toBe(201);

    // 5. Order.
    const placed = await inject(
      'POST',
      '/markets/uk/checkout/orders',
      cookie!,
      { items: [{ slug, quantity: 3, optionId: correctOption }], termsVersion },
      { 'idempotency-key': `journey-guest-${Date.now()}` },
    );
    expect(placed.statusCode).toBe(201);
    const order = orderOf(placed);
    expect(order.placedBy).toBe('guest');
    expect(order.totalMinor).toBe(750);
    expect(order.termsVersion).toBe(termsVersion);

    // Still no account anywhere in that.
    const usersAfter = await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    expect(usersAfter.rows[0]!.n).toBe(usersBefore.rows[0]!.n);

    // The basket is spent, the hold is not.
    const cart = (await inject('GET', '/markets/uk/cart', cookie!)).json<{
      cart: { activeItemCount: number };
    }>().cart;
    expect(cart.activeItemCount).toBe(0);
    await assertPhaseBoundary(order.id);
  });

  // ---- the authenticated journey ------------------------------------------

  it('takes a signed-in customer from nothing to an order', async () => {
    const client = await registeredClient(h.app);

    expect((await client.post('/markets/uk/cart/items', { slug, quantity: 2 })).statusCode).toBe(
      201,
    );
    const terms = (await client.get('/markets/uk/terms')).json<{
      active: { version: string };
      accepted: boolean;
    }>();
    expect(terms.accepted).toBe(false);
    expect(
      (await client.post('/markets/uk/terms/acceptance', { version: terms.active.version }))
        .statusCode,
    ).toBe(201);
    expect((await client.get('/markets/uk/terms')).json<{ accepted: boolean }>().accepted).toBe(
      true,
    );

    const placed = await client.request(
      'POST',
      '/markets/uk/checkout/orders',
      { items: [{ slug, quantity: 2, optionId: correctOption }], termsVersion },
      { 'idempotency-key': `journey-user-${Date.now()}` },
    );
    expect(placed.statusCode).toBe(201);
    const order = orderOf(placed);
    expect(order.placedBy).toBe('user');
    expect(order.totalMinor).toBe(500);
    await assertPhaseBoundary(order.id);
  });

  // ---- the boundary between the two ---------------------------------------

  describe('an order belongs to one identity', () => {
    it('does not let a guest read an account holder’s order', async () => {
      const client = await registeredClient(h.app);
      await client.post('/markets/uk/cart/items', { slug, quantity: 1 });
      const terms = (await client.get('/markets/uk/terms')).json<{ active: { version: string } }>();
      await client.post('/markets/uk/terms/acceptance', { version: terms.active.version });
      const order = orderOf(
        await client.request(
          'POST',
          '/markets/uk/checkout/orders',
          { items: [{ slug, quantity: 1, optionId: correctOption }], termsVersion },
          { 'idempotency-key': `iso-user-${Date.now()}` },
        ),
      );

      // Fully verified, so the refusal below is about OWNERSHIP rather than
      // about the guest not having proved an address yet.
      const cookie = await verifiedGuest(uniqueEmail('iso-guest'));

      const seen = await inject('GET', `/markets/uk/checkout/orders/${order.id}`, cookie);
      // Not 403: someone else's order is indistinguishable from one that is
      // not there.
      expect(seen.statusCode).toBe(404);
      expect(seen.body).not.toContain(order.orderNumber);
    });

    it('does not let an account holder read a guest’s order', async () => {
      const cookie = await verifiedGuest(uniqueEmail('iso-guest2'));
      await inject('POST', '/markets/uk/cart/items', cookie, { slug, quantity: 1 });
      const terms = (await inject('GET', '/markets/uk/terms', cookie)).json<{
        active: { version: string };
      }>();
      await inject('POST', '/markets/uk/terms/acceptance', cookie, {
        version: terms.active.version,
      });
      const order = orderOf(
        await inject(
          'POST',
          '/markets/uk/checkout/orders',
          cookie,
          { items: [{ slug, quantity: 1, optionId: correctOption }], termsVersion },
          { 'idempotency-key': `iso-guest-${Date.now()}` },
        ),
      );

      // A different account entirely.
      const other = await registeredClient(h.app);
      const seen = await other.get(`/markets/uk/checkout/orders/${order.id}`);
      expect(seen.statusCode).toBe(404);
      expect(seen.body).not.toContain(order.orderNumber);
    });
  });
});
