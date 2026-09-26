/**
 * Order creation against real PostgreSQL and Redis (migration 0016, task
 * P5-7).
 *
 * An order is the permanent record of a checkout, so most of this file is
 * about what must be true at the moment it is written and can never change
 * afterwards: the price, the terms, the answer, who bought. The rest is about
 * the two ways a checkout can be asked for twice — a retry, which must return
 * the same order, and a mistake, which must not.
 *
 * Phase 5 stops at `awaiting_payment`. Several tests assert, positively, that
 * no ticket is sold and no payment exists.
 */
import { ErrorResponseSchema, OrderListResponseSchema, OrderResponseSchema } from '@hv/contracts';
import {
  SecretBox,
  VERIFICATION_EMAIL_TOPIC,
  openPayload,
  type VerificationEmailPayload,
} from '@hv/domain';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import { RATE_LIMITS } from '../src/auth/rate-limiter';
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
  startApp,
  startHarness,
  uniqueEmail,
} from './support';

const KEY = 'a1'.repeat(16) + 'b2'.repeat(16);
const box = new SecretBox(KEY, 'k1');

const orderOf = (response: { json: () => unknown }) =>
  OrderResponseSchema.parse(response.json()).order;
const errorCode = (response: { json: () => unknown }) =>
  ErrorResponseSchema.parse(response.json()).error.code;

let keyCounter = 0;
const freshKey = () => `idem-${Date.now().toString(36)}-${keyCounter++}-aaaaaaaa`;

describe('creating an order', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let ukSlug: string;
  let ieSlug: string;
  let termsVersion: string;
  let ieTermsVersion: string;
  /** The correct and a wrong option for the UK draw's question. */
  let correctOption: string;
  let wrongOption: string;
  /** A second UK draw, so a request can name a line the basket does not hold. */
  let secondSlug: string;
  let secondOption: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie,de', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);

    admin = await registeredClient(h.app, uniqueEmail('orders-admin'));
    await grantRole(h.sql, admin.email, 'super_admin');
    await enrolMfa(admin);
    termsVersion = await activateTerms('uk');
    ieTermsVersion = await activateTerms('ie');

    ukSlug = `ord-uk-${Date.now()}`;
    secondSlug = `ord-uk2-${Date.now()}`;
    ieSlug = `ord-ie-${Date.now()}`;
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: ukSlug,
      state: 'live',
      totalTickets: 500,
      maxPerPerson: 10,
      ticketPriceMinor: 250,
    });
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: secondSlug,
      state: 'live',
      totalTickets: 500,
      maxPerPerson: 10,
      ticketPriceMinor: 400,
    });
    await insertFixtureDraw(h.sql, {
      market: 'ie',
      slug: ieSlug,
      state: 'live',
      totalTickets: 500,
      maxPerPerson: 10,
      ticketPriceMinor: 300,
    });

    // The correct option is read straight from the database. It is never
    // available through any customer API, which is the point of the test below.
    const options = await h.sql.query<{ id: string; is_correct: boolean }>(
      `SELECT o.id, o.is_correct
         FROM skill_question_options o
         JOIN draws d ON d.skill_question_id = o.skill_question_id
        WHERE d.slug = $1 ORDER BY o.position`,
      [ukSlug],
    );
    correctOption = options.rows.find((o) => o.is_correct)!.id;
    wrongOption = options.rows.find((o) => !o.is_correct)!.id;

    const secondOptions = await h.sql.query<{ id: string }>(
      `SELECT o.id FROM skill_question_options o
         JOIN draws d ON d.skill_question_id = o.skill_question_id
        WHERE d.slug = $1 AND o.is_correct`,
      [secondSlug],
    );
    secondOption = secondOptions.rows[0]!.id;
  });

  afterAll(async () => {
    await h?.close();
  });

  let ip: string;
  beforeEach(() => {
    ip = randomIp();
  });

  async function activateTerms(market: string): Promise<string> {
    const version = `test-fixture-${market}-${Date.now()}`;
    const created = (
      await admin.post(`/admin/markets/${market}/terms`, {
        version,
        publish: true,
        reason: 'Integration test fixture.',
      })
    ).json<{ version: { id: string } }>().version;
    await admin.post(`/admin/markets/${market}/terms/${created.id}/activate`, {
      reason: 'Integration test fixture.',
    });
    return version;
  }

  const inject = (
    method: 'GET' | 'POST' | 'DELETE',
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

  /** A verified guest with a basket and the terms accepted. */
  const readyGuest = async (quantity = 2, market = 'uk', slug = ukSlug, version = termsVersion) => {
    const email = uniqueEmail('ord-guest');
    const requested = await inject('POST', `/markets/${market}/checkout/email/code`, undefined, {
      email,
    });
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
    await inject('POST', `/markets/${market}/checkout/email/verify`, cookie, { email, code });
    await inject('POST', `/markets/${market}/cart/items`, cookie, { slug, quantity });
    await inject('POST', `/markets/${market}/terms/acceptance`, cookie, { version });
    return { cookie, email };
  };

  /** A signed-in customer with a basket and the terms accepted. */
  const readyCustomer = async (
    quantity = 2,
    market = 'uk',
    slug = ukSlug,
    version = termsVersion,
  ) => {
    const client = await registeredClient(h.app);
    await client.post(`/markets/${market}/cart/items`, { slug, quantity });
    await client.post(`/markets/${market}/terms/acceptance`, { version });
    return client;
  };

  /**
   * The request a checkout page would send for `quantity` of the UK draw.
   * Pass `null` for the option to leave the answer off the line entirely;
   * `undefined` would take the default, which is the correct one.
   */
  const buying = (quantity: number, optionId: string | null = correctOption) => ({
    items: [{ slug: ukSlug, quantity, ...(optionId ? { optionId } : {}) }],
    termsVersion,
  });

  const place = (client: Client, key: string, bodyOrQuantity: unknown = 1, market = 'uk') =>
    client.request(
      'POST',
      `/markets/${market}/checkout/orders`,
      typeof bodyOrQuantity === 'number' ? buying(bodyOrQuantity) : bodyOrQuantity,
      { 'idempotency-key': key },
    );

  // ---- the happy paths -----------------------------------------------------

  describe('a signed-in customer', () => {
    it('turns a basket into an order awaiting payment', async () => {
      const client = await readyCustomer(3);
      const response = await place(client, freshKey(), 3);
      expect(response.statusCode).toBe(201);

      const order = orderOf(response);
      expect(order.status).toBe('awaiting_payment');
      expect(order.placedBy).toBe('user');
      expect(order.orderNumber).toMatch(/^HV-[A-Z2-7]{10}$/);
      expect(order.currency).toBe('GBP');
      expect(order.termsVersion).toBe(termsVersion);
      expect(order.items).toHaveLength(1);
      // Prices come from the reservation, never from the request.
      expect(order.items[0]).toMatchObject({ quantity: 3, unitPriceMinor: 250, totalMinor: 750 });
      expect(order.totalMinor).toBe(750);
      expect(order.walletAppliedMinor).toBe(0);
      expect(order.externalDueMinor).toBe(750);
      expect(order.items[0]!.ticketNumbers).toHaveLength(3);
    });

    it('empties the basket but keeps the tickets held', async () => {
      const client = await readyCustomer(2);
      const order = orderOf(await place(client, freshKey(), 2));

      const cart = (await client.get('/markets/uk/cart')).json<{
        cart: { activeItemCount: number };
      }>().cart;
      expect(cart.activeItemCount).toBe(0);

      const { rows } = await h.sql.query<{ status: string; n: number }>(
        `SELECT r.status, count(t.id)::int AS n
           FROM reservations r
           JOIN order_items oi ON oi.reservation_id = r.id
           JOIN tickets t ON t.reservation_id = r.id
          WHERE oi.order_id = $1 GROUP BY r.status`,
        [order.id],
      );
      // Still an ACTIVE hold on RESERVED tickets. Phase 6 sells them.
      expect(rows[0]!.status).toBe('active');
      expect(rows[0]!.n).toBe(2);
    });

    it('records the chosen answer and the terms on the order', async () => {
      const client = await readyCustomer(1);
      const order = orderOf(await place(client, freshKey()));
      const { rows } = await h.sql.query<{ option: string; terms: string }>(
        `SELECT oi.skill_answer_option_id AS option, tv.version AS terms
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           JOIN terms_versions tv ON tv.id = o.terms_version_id
          WHERE o.id = $1`,
        [order.id],
      );
      expect(rows[0]!.option).toBe(correctOption);
      expect(rows[0]!.terms).toBe(termsVersion);
    });

    it('lists and fetches only its own orders', async () => {
      const alice = await readyCustomer(1);
      const order = orderOf(await place(alice, freshKey()));
      const bob = await registeredClient(h.app);

      expect((await bob.get(`/markets/uk/checkout/orders/${order.id}`)).statusCode).toBe(404);
      const mine = OrderListResponseSchema.parse(
        (await alice.get('/markets/uk/checkout/orders')).json(),
      ).orders;
      expect(mine.map((o) => o.id)).toContain(order.id);
      const theirs = OrderListResponseSchema.parse(
        (await bob.get('/markets/uk/checkout/orders')).json(),
      ).orders;
      expect(theirs.map((o) => o.id)).not.toContain(order.id);
    });
  });

  describe('a verified guest', () => {
    it('places an order without an account', async () => {
      const before = await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
      const { cookie, email } = await readyGuest(2);

      const response = await inject('POST', '/markets/uk/checkout/orders', cookie, buying(2), {
        'idempotency-key': freshKey(),
      });
      expect(response.statusCode).toBe(201);
      const order = orderOf(response);
      expect(order.placedBy).toBe('guest');
      expect(order.status).toBe('awaiting_payment');

      // The order records the verified ADDRESS, not the session (B18).
      const { rows } = await h.sql.query<{ guest_email: string; user_id: string | null }>(
        `SELECT guest_email, user_id FROM orders WHERE id = $1`,
        [order.id],
      );
      expect(rows[0]!.guest_email).toBe(email);
      expect(rows[0]!.user_id).toBeNull();

      const after = await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it('is refused once its verification has gone stale', async () => {
      const { cookie } = await readyGuest(1);
      await h.sql.query(
        `UPDATE guest_sessions SET verified_email_at = now() - interval '31 minutes'
          WHERE verified_email IS NOT NULL`,
      );
      const response = await inject('POST', '/markets/uk/checkout/orders', cookie, buying(2), {
        'idempotency-key': freshKey(),
      });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VERIFICATION_REQUIRED');
    });

    it('cannot reach an authenticated route with its cookie', async () => {
      const { cookie } = await readyGuest(1);
      expect((await inject('GET', '/markets/uk/reservations', cookie)).statusCode).toBe(401);
    });
  });

  // ---- the skill answer ----------------------------------------------------

  describe('the skill answer', () => {
    it('refuses a wrong answer and creates nothing at all', async () => {
      const client = await readyCustomer(2);
      const before = await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders`);
      const key = freshKey();

      const response = await place(client, key, {
        items: [{ slug: ukSlug, quantity: 2, optionId: wrongOption }],
        termsVersion,
      });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('INVALID_SKILL_ANSWER');

      const after = await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders`);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

      // The basket and its hold survive: a wrong answer is not a cancellation.
      const cart = (await client.get('/markets/uk/cart')).json<{
        cart: { activeItemCount: number };
      }>().cart;
      expect(cart.activeItemCount).toBe(1);

      // And the key is not spent — the whole transaction rolled back.
      const retry = await place(client, key, 2);
      expect(retry.statusCode).toBe(201);
    });

    it('gives the same answer for a wrong option and a missing one', async () => {
      const wrong = await place(await readyCustomer(1), freshKey(), buying(1, wrongOption));
      // "Missing" now means an item for a question-bearing draw with no option
      // on it; a slug that is not in the basket is a basket conflict instead.
      const missing = await place(await readyCustomer(1), freshKey(), buying(1, null));
      expect(errorCode(wrong)).toBe(errorCode(missing));
      expect(ErrorResponseSchema.parse(wrong.json()).error.message).toBe(
        ErrorResponseSchema.parse(missing.json()).error.message,
      );
    });

    it('never tells a customer which option is correct', async () => {
      const draw = (await (await registeredClient(h.app)).get(`/markets/uk/draws/${ukSlug}`)).body;
      expect(draw).not.toContain('isCorrect');
      expect(draw).not.toContain('is_correct');
      // The option ids are public; which one is right is not.
      expect(draw).toContain(correctOption);
      expect(draw).toContain(wrongOption);

      const refusal = await place(await readyCustomer(1), freshKey(), buying(1, wrongOption));
      expect(refusal.body).not.toContain(correctOption);
    });
  });

  // ---- terms ---------------------------------------------------------------

  describe('terms', () => {
    it('refuses when the customer has not accepted', async () => {
      const client = await registeredClient(h.app);
      await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 });
      const response = await place(client, freshKey());
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('TERMS_NOT_ACCEPTED');
    });

    it('refuses a stale version even when something was accepted', async () => {
      const client = await readyCustomer(1);
      const response = await place(client, freshKey(), {
        items: [{ slug: ukSlug, quantity: 1, optionId: correctOption }],
        termsVersion: 'test-fixture-older',
      });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('TERMS_VERSION_STALE');
    });

    it('refuses when the market activated a new version after acceptance', async () => {
      const client = await readyCustomer(1);
      const replacement = await activateTerms('uk');
      const response = await place(client, freshKey(), {
        items: [{ slug: ukSlug, quantity: 1, optionId: correctOption }],
        termsVersion: replacement,
      });
      // They accepted the previous version, which is no longer the active one.
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('TERMS_NOT_ACCEPTED');
      // Put the fixture back for the remaining tests.
      termsVersion = replacement;
    });
  });

  // ---- idempotency ---------------------------------------------------------

  describe('idempotency', () => {
    it('requires a key', async () => {
      const client = await readyCustomer(1);
      const response = await client.request('POST', '/markets/uk/checkout/orders', buying(1), {});
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('returns the same order for the same key and request', async () => {
      const client = await readyCustomer(2);
      const key = freshKey();
      const first = orderOf(await place(client, key, 2));
      const second = await place(client, key, 2);

      expect(second.statusCode).toBe(201);
      const replayed = orderOf(second);
      expect(replayed.id).toBe(first.id);
      expect(replayed.orderNumber).toBe(first.orderNumber);

      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders WHERE idempotency_key = $1`,
        [key],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('creates exactly one order when duplicate requests race', async () => {
      const client = await readyCustomer(2);
      const key = freshKey();
      const results = await Promise.all(Array.from({ length: 5 }, () => place(client, key, 2)));

      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 201, 201, 201]);
      const ids = new Set(results.map((r) => orderOf(r).id));
      expect(ids.size).toBe(1);

      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders WHERE idempotency_key = $1`,
        [key],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('refuses the same key used for a different request', async () => {
      const client = await readyCustomer(1);
      const key = freshKey();
      expect((await place(client, key)).statusCode).toBe(201);

      // Same key, a different answer: a mistake, not a retry.
      const conflicting = await place(client, key, buying(1, wrongOption));
      expect(conflicting.statusCode).toBe(409);
      expect(errorCode(conflicting)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('never hands one customer’s order to another who reuses the key', async () => {
      const alice = await readyCustomer(1);
      const key = freshKey();
      const order = orderOf(await place(alice, key));

      const bob = await readyCustomer(1);
      const response = await place(bob, key);
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain(order.orderNumber);
      expect(response.body).not.toContain(order.id);
    });

    it('refuses the same key with a different quantity', async () => {
      const client = await readyCustomer(2);
      const key = freshKey();
      expect((await place(client, key, 2)).statusCode).toBe(201);

      // The basket is empty now, but the point is the SEMANTIC request: a
      // different quantity is a different purchase, not a retry (ADR-0032).
      const changed = await place(client, key, 5);
      expect(changed.statusCode).toBe(409);
      expect(errorCode(changed)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('refuses the same key with a different draw', async () => {
      const client = await readyCustomer(1);
      const key = freshKey();
      expect((await place(client, key, 1)).statusCode).toBe(201);

      const changed = await place(client, key, {
        items: [{ slug: secondSlug, quantity: 1, optionId: secondOption }],
        termsVersion,
      });
      expect(changed.statusCode).toBe(409);
      expect(errorCode(changed)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('refuses the same key with a different terms version', async () => {
      const client = await readyCustomer(1);
      const key = freshKey();
      expect((await place(client, key, 1)).statusCode).toBe(201);

      const changed = await place(client, key, {
        items: [{ slug: ukSlug, quantity: 1, optionId: correctOption }],
        termsVersion: 'test-fixture-something-else',
      });
      expect(changed.statusCode).toBe(409);
      expect(errorCode(changed)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('gives different keys different orders', async () => {
      const first = await readyCustomer(1);
      const second = await readyCustomer(1);
      const a = orderOf(await place(first, freshKey()));
      const b = orderOf(await place(second, freshKey()));
      expect(a.id).not.toBe(b.id);
      expect(a.orderNumber).not.toBe(b.orderNumber);
    });
  });

  // ---- the request must describe the basket (ADR-0032) --------------------

  describe('the request has to match the basket', () => {
    it('accepts a request that describes the basket exactly', async () => {
      const client = await readyCustomer(3);
      expect((await place(client, freshKey(), 3)).statusCode).toBe(201);
    });

    it('refuses a quantity the basket does not hold', async () => {
      const client = await readyCustomer(3);
      // The page said 3; this request says 2. The order must not be for
      // something the customer was never shown.
      const response = await place(client, freshKey(), 2);
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('CONFLICT');
    });

    it('refuses a draw the basket does not hold', async () => {
      const client = await readyCustomer(1);
      const response = await place(client, freshKey(), {
        items: [{ slug: ieSlug, quantity: 1 }],
        termsVersion,
      });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('CONFLICT');
    });

    it('refuses a request that omits a line the basket holds', async () => {
      const client = await registeredClient(h.app);
      await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 });
      await client.post('/markets/uk/cart/items', { slug: secondSlug, quantity: 1 });
      await client.post('/markets/uk/terms/acceptance', { version: termsVersion });

      const response = await place(client, freshKey(), buying(1));
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('CONFLICT');
    });

    it('refuses a request with an extra line the basket does not hold', async () => {
      const client = await readyCustomer(1);
      const response = await place(client, freshKey(), {
        items: [
          { slug: ukSlug, quantity: 1, optionId: correctOption },
          { slug: secondSlug, quantity: 1, optionId: secondOption },
        ],
        termsVersion,
      });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('CONFLICT');
    });

    it('refuses the same draw named twice', async () => {
      const client = await readyCustomer(1);
      const response = await place(client, freshKey(), {
        items: [
          { slug: ukSlug, quantity: 1, optionId: correctOption },
          { slug: ukSlug, quantity: 1, optionId: correctOption },
        ],
        termsVersion,
      });
      expect(response.statusCode).toBe(409);
    });
  });

  // ---- market isolation and money -----------------------------------------

  describe('one market, one currency', () => {
    it('places an IE order in euros from the IE basket', async () => {
      const client = await registeredClient(h.app);
      await client.post('/markets/ie/cart/items', { slug: ieSlug, quantity: 2 });
      await client.post('/markets/ie/terms/acceptance', { version: ieTermsVersion });

      const ieOptions = await h.sql.query<{ id: string }>(
        `SELECT o.id FROM skill_question_options o
           JOIN draws d ON d.skill_question_id = o.skill_question_id
          WHERE d.slug = $1 AND o.is_correct`,
        [ieSlug],
      );
      const response = await place(
        client,
        freshKey(),
        {
          items: [{ slug: ieSlug, quantity: 2, optionId: ieOptions.rows[0]!.id }],
          termsVersion: ieTermsVersion,
        },
        'ie',
      );
      expect(response.statusCode).toBe(201);
      const order = orderOf(response);
      expect(order.currency).toBe('EUR');
      expect(order.totalMinor).toBe(600);
    });

    it('does not see a UK basket from the IE market', async () => {
      const client = await readyCustomer(1);
      await client.post('/markets/ie/terms/acceptance', { version: ieTermsVersion });
      const response = await place(
        client,
        freshKey(),
        {
          items: [{ slug: ukSlug, quantity: 1, optionId: correctOption }],
          termsVersion: ieTermsVersion,
        },
        'ie',
      );
      // The IE basket is empty; the UK one is not reachable from here.
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('BASKET_EMPTY');
    });

    it('refuses a market that is not available', async () => {
      const client = await readyCustomer(1);
      expect((await place(client, freshKey(), undefined, 'de')).statusCode).toBe(404);
    });

    it('will not let an order line be moved to another market, even in SQL', async () => {
      const order = orderOf(await place(await readyCustomer(1), freshKey()));
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'ie'`,
      );
      await expect(
        h.sql.query(`UPDATE order_items SET market_id = $1 WHERE order_id = $2`, [
          rows[0]!.id,
          order.id,
        ]),
      ).rejects.toThrow();
    });
  });

  // ---- the schema holds the line ------------------------------------------

  describe('the schema, not just the API', () => {
    it('refuses an order bought by both a user and a guest', async () => {
      const { rows: m } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'uk'`,
      );
      const { rows: u } = await h.sql.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
      const { rows: t } = await h.sql.query<{ id: string }>(
        `SELECT id FROM terms_versions WHERE market_id = $1 LIMIT 1`,
        [m[0]!.id],
      );
      await expect(
        h.sql.query(
          `INSERT INTO orders (order_number, market_id, currency, user_id, guest_email,
                               terms_version_id, total_minor, external_due_minor,
                               idempotency_key, idempotency_digest)
           VALUES ('HV-AAAAAAAAAA', $1, 'GBP', $2, 'someone@example.com', $3, 100, 100,
                   'schema-test-key-1', sha256('x'::bytea))`,
          [m[0]!.id, u[0]!.id, t[0]!.id],
        ),
      ).rejects.toThrow();
    });

    it('refuses a malformed order number', async () => {
      const order = orderOf(await place(await readyCustomer(1), freshKey()));
      await expect(
        h.sql.query(`UPDATE orders SET order_number = 'BAD-1' WHERE id = $1`, [order.id]),
      ).rejects.toThrow();
    });

    it('never lets an order’s price or terms be rewritten', async () => {
      const order = orderOf(await place(await readyCustomer(1), freshKey()));
      await expect(
        h.sql.query(`UPDATE orders SET total_minor = 1 WHERE id = $1`, [order.id]),
      ).rejects.toThrow(/fixed when it is placed/);
      await expect(
        h.sql.query(`UPDATE order_items SET quantity = 99 WHERE order_id = $1`, [order.id]),
      ).rejects.toThrow(/fixed when the order is placed/);
    });

    it('lets the status move, because Phase 6 has to', async () => {
      const order = orderOf(await place(await readyCustomer(1), freshKey()));
      await h.sql.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
      const { rows } = await h.sql.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [order.id],
      );
      expect(rows[0]!.status).toBe('cancelled');
    });

    it('gives hv_app no way to erase an order or rewrite a line', async () => {
      const { rows } = await h.sql.query<{ relname: string; del: boolean; upd: boolean }>(
        `SELECT c.relname,
                has_table_privilege('hv_app', c.oid, 'DELETE') AS del,
                has_table_privilege('hv_app', c.oid, 'UPDATE') AS upd
           FROM pg_class c WHERE c.relname IN ('orders', 'order_items') ORDER BY c.relname`,
      );
      const items = rows.find((r) => r.relname === 'order_items')!;
      const orders = rows.find((r) => r.relname === 'orders')!;
      expect(items.del).toBe(false);
      expect(items.upd).toBe(false);
      expect(orders.del).toBe(false);
      // Orders keep UPDATE: Phase 6 moves the status.
      expect(orders.upd).toBe(true);
    });
  });

  // ---- checkout rate limiting (B19, ADR-0030) ------------------------------

  describe('checkout is rate limited', () => {
    it('allows checkouts inside the limit', async () => {
      const client = await readyCustomer(1);
      expect((await place(client, freshKey(), 1)).statusCode).toBe(201);
    });

    it('refuses once the owner is over the limit', async () => {
      const client = await readyCustomer(1);
      const limit = RATE_LIMITS.checkoutPerOwner.limit;
      // Most of these fail on an empty basket, which is fine: the limiter runs
      // before any of that and counts the attempt either way.
      for (let i = 0; i < limit; i++) await place(client, freshKey(), 1);

      const over = await place(client, freshKey(), 1);
      expect(over.statusCode).toBe(429);
      expect(errorCode(over)).toBe('RATE_LIMITED');
      expect(over.headers['retry-after']).toBeDefined();
    });

    it('gives each owner its own bucket', async () => {
      const first = await readyCustomer(1);
      for (let i = 0; i < RATE_LIMITS.checkoutPerOwner.limit; i++) {
        await place(first, freshKey(), 1);
      }
      expect((await place(first, freshKey(), 1)).statusCode).toBe(429);

      const second = await readyCustomer(1);
      expect((await place(second, freshKey(), 1)).statusCode).toBe(201);
    });

    it('refuses rather than checks out when Redis is unreachable', async () => {
      // Fail closed (B19): without the limiter there is no protection, so the
      // checkout is refused rather than waved through.
      // The identity has to exist before Redis goes away: registering or
      // verifying would itself be refused by the fail-closed limiter. Sessions
      // live in PostgreSQL, so the same cookie works against a second app on
      // the same database with an unreachable Redis.
      const client = await readyCustomer(1);
      const offline = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie,de',
        OUTBOX_ENCRYPTION_KEY: KEY,
        REDIS_URL: 'redis://127.0.0.1:1/0',
      });
      try {
        const response = await offline.inject({
          method: 'POST',
          url: '/markets/uk/checkout/orders',
          remoteAddress: randomIp(),
          headers: {
            origin: WEB_ORIGIN,
            cookie: `hv_session=${client.cookie}`,
            'idempotency-key': freshKey(),
          },
          payload: {
            items: [{ slug: ukSlug, quantity: 1, optionId: correctOption }],
            termsVersion,
          },
        });
        expect(response.statusCode).toBe(503);
      } finally {
        await offline.close();
      }
    });
  });

  // ---- the Phase 5 boundary ------------------------------------------------

  describe('checkout stops before payment', () => {
    it('sells no tickets and records no payment', async () => {
      const order = orderOf(await place(await readyCustomer(2), freshKey(), 2));

      const sold = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tickets WHERE status = 'sold'`,
      );
      expect(sold.rows[0]!.n).toBe(0);

      // P6-2 added `payments` and P6-3 added `payment_events`, so this no
      // longer asserts that they are absent — it asserts the thing that
      // actually matters and has not changed: placing an order starts no
      // payment and receives no provider event. Both exist only once the
      // customer asks to pay and a provider answers.
      const attempts = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payments WHERE order_id = $1`,
        [order.id],
      );
      expect(attempts.rows[0]!.n).toBe(0);
      const events = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM payment_events e JOIN payments p ON p.id = e.payment_id
          WHERE p.order_id = $1`,
        [order.id],
      );
      expect(events.rows[0]!.n).toBe(0);

      // The phases that own refunds and the wallet have still not arrived.
      const tables = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('refunds', 'wallets', 'wallet_entries')`,
      );
      expect(tables.rows[0]!.n).toBe(0);

      const { rows } = await h.sql.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [order.id],
      );
      expect(rows[0]!.status).toBe('awaiting_payment');
    });

    it('writes an audit entry without the address or the answer', async () => {
      const { cookie, email } = await readyGuest(1);
      const response = await inject('POST', '/markets/uk/checkout/orders', cookie, buying(1), {
        'idempotency-key': freshKey(),
      });
      const order = orderOf(response);
      const { rows } = await h.sql.query<{ action: string; after: Record<string, unknown> }>(
        `SELECT action, after FROM audit_log WHERE entity_id = $1`,
        [order.id],
      );
      expect(rows[0]!.action).toBe('order.created');
      const recorded = JSON.stringify(rows[0]!.after);
      expect(recorded).not.toContain(email);
      expect(recorded).not.toContain(correctOption);
    });
  });
});
