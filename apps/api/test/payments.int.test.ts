/**
 * Payment attempts and initiation against real PostgreSQL and Redis
 * (migrations 0019 and 0020, task P6-2).
 *
 * Three things this file is mostly about, because they are the three that must
 * hold even when the code is wrong:
 *
 *   * the amount is the ORDER's amount, and no request or provider can change it;
 *   * an order has at most one live attempt, and at most one that ever succeeds;
 *   * the payment deadline always lands before the holds behind the order expire.
 *
 * The first two are partial unique indexes and a composite foreign key, so
 * several tests here attack them in raw SQL with the application bypassed. If
 * they can only be broken through the API, they were never really invariants.
 *
 * Nothing here confirms a payment. P6-2 starts one; a verified webhook (P6-3)
 * and a trusted status check (P6-5) are the only things that may decide an
 * order was paid, and a browser returning from a provider is neither.
 */
import { ErrorResponseSchema, OrderResponseSchema, PaymentResponseSchema } from '@hv/contracts';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import {
  SecretBox,
  VERIFICATION_EMAIL_TOPIC,
  openPayload,
  type VerificationEmailPayload,
} from '@hv/domain';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../src/auth/rate-limiter';
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

/**
 * The locked values this file asserts against (D1a, D3a). The floor is not
 * here because no test measures it against the default — it is driven by an
 * override instead, and `env.test.ts` is what pins all four in production.
 */
const MARGIN_SECONDS = 90;
const ATTEMPT_TTL_SECONDS = 120;

const orderOf = (r: { json: () => unknown }) => OrderResponseSchema.parse(r.json()).order;
const paymentOf = (r: { json: () => unknown }) => PaymentResponseSchema.parse(r.json()).payment;
const errorCode = (r: { json: () => unknown }) => ErrorResponseSchema.parse(r.json()).error.code;

let keyCounter = 0;
const freshKey = () => `pay-${Date.now().toString(36)}-${keyCounter++}-aaaaaaaa`;

describe('starting a payment', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let ukSlug: string;
  let ieSlug: string;
  let termsVersion: string;
  let ieTermsVersion: string;
  let correctOption: string;
  let ieOption: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);

    admin = await registeredClient(h.app, uniqueEmail('pay-admin'));
    await grantRole(h.sql, admin.email, 'super_admin');
    await enrolMfa(admin);
    termsVersion = await activateTerms('uk');
    ieTermsVersion = await activateTerms('ie');

    ukSlug = `pay-uk-${Date.now()}`;
    ieSlug = `pay-ie-${Date.now()}`;
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: ukSlug,
      state: 'live',
      totalTickets: 500,
      maxPerPerson: 10,
      ticketPriceMinor: 250,
    });
    await insertFixtureDraw(h.sql, {
      market: 'ie',
      slug: ieSlug,
      state: 'live',
      totalTickets: 500,
      maxPerPerson: 10,
      ticketPriceMinor: 300,
    });
    correctOption = await correctOptionFor(ukSlug);
    ieOption = await correctOptionFor(ieSlug);
  });

  afterAll(async () => {
    await h?.close();
  });

  let ip: string;
  beforeEach(() => {
    ip = randomIp();
  });

  // ---- fixtures ------------------------------------------------------------

  async function correctOptionFor(slug: string): Promise<string> {
    const { rows } = await h.sql.query<{ id: string }>(
      `SELECT o.id FROM skill_question_options o
         JOIN draws d ON d.skill_question_id = o.skill_question_id
        WHERE d.slug = $1 AND o.is_correct`,
      [slug],
    );
    return rows[0]!.id;
  }

  async function activateTerms(market: string): Promise<string> {
    const version = `pay-fixture-${market}-${Date.now()}`;
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
    method: 'GET' | 'POST',
    url: string,
    cookie?: string,
    payload?: unknown,
    headers: Record<string, string> = {},
    app: NestFastifyApplication = h.app,
  ) =>
    app.inject({
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

  /** A signed-in customer holding an order awaiting payment. */
  async function customerWithOrder(quantity = 2, app: NestFastifyApplication = h.app) {
    const client = await registeredClient(app);
    await client.post(`/markets/uk/cart/items`, { slug: ukSlug, quantity });
    await client.post(`/markets/uk/terms/acceptance`, { version: termsVersion });
    const order = orderOf(
      await client.request(
        'POST',
        '/markets/uk/checkout/orders',
        { items: [{ slug: ukSlug, quantity, optionId: correctOption }], termsVersion },
        { 'idempotency-key': freshKey() },
      ),
    );
    return { client, order };
  }

  /** A verified guest holding an order awaiting payment. */
  async function guestWithOrder(quantity = 2) {
    const email = uniqueEmail('pay-guest');
    const requested = await inject('POST', '/markets/uk/checkout/email/code', undefined, { email });
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
    await inject('POST', '/markets/uk/checkout/email/verify', cookie, { email, code });
    await inject('POST', '/markets/uk/cart/items', cookie, { slug: ukSlug, quantity });
    await inject('POST', '/markets/uk/terms/acceptance', cookie, { version: termsVersion });
    const order = orderOf(
      await inject(
        'POST',
        '/markets/uk/checkout/orders',
        cookie,
        { items: [{ slug: ukSlug, quantity, optionId: correctOption }], termsVersion },
        { 'idempotency-key': freshKey() },
      ),
    );
    return { cookie, email, order };
  }

  /** POST the payment route for an order. */
  const pay = (
    orderId: string,
    options: {
      cookie?: string;
      client?: Client;
      key?: string;
      market?: string;
      app?: NestFastifyApplication;
    } = {},
  ) => {
    const url = `/markets/${options.market ?? 'uk'}/checkout/orders/${orderId}/payments`;
    const headers = { 'idempotency-key': options.key ?? freshKey() };
    if (options.client) return options.client.request('POST', url, {}, headers);
    return inject('POST', url, options.cookie, {}, headers, options.app);
  };

  const attemptsFor = async (orderId: string) =>
    (
      await h.sql.query<{
        id: string;
        status: string;
        amount_minor: string;
        currency: string;
        provider: string;
        provider_reference: string | null;
        expires_at: Date;
      }>(
        `SELECT id, status, amount_minor, currency, provider, provider_reference, expires_at
           FROM payments WHERE order_id = $1 ORDER BY created_at`,
        [orderId],
      )
    ).rows;

  // ---- creating an attempt -------------------------------------------------

  describe('creating an attempt', () => {
    it('returns a redirect, the amount and both deadlines', async () => {
      const { client, order } = await customerWithOrder(2);
      const response = await pay(order.id, { client });
      expect(response.statusCode).toBe(201);

      const payment = paymentOf(response);
      expect(payment.status).toBe('processing');
      expect(payment.amountMinor).toBe(order.totalMinor);
      expect(payment.currency).toBe('GBP');
      expect(payment.redirectUrl).toContain('reference=');
      expect(payment.orderExpiresAt).toBe(order.expiresAt);
      // The attempt's own clock, never later than the order's.
      expect(new Date(payment.expiresAt).getTime()).toBeLessThanOrEqual(
        new Date(payment.orderExpiresAt).getTime(),
      );
    });

    it('records the attempt against the order, priced from it', async () => {
      const { client, order } = await customerWithOrder(3);
      await pay(order.id, { client });

      const [attempt] = await attemptsFor(order.id);
      expect(attempt).toBeDefined();
      expect(Number(attempt!.amount_minor)).toBe(order.externalDueMinor);
      expect(attempt!.currency).toBe('GBP');
      expect(attempt!.provider).toBe('fake');
      // Set once the provider has answered; the customer is never told it.
      expect(attempt!.provider_reference).not.toBeNull();
      expect(attempt!.status).toBe('processing');
    });

    it('never returns the provider reference as a field of its own', async () => {
      const { client, order } = await customerWithOrder(1);
      const payment = paymentOf(await pay(order.id, { client }));
      const [attempt] = await attemptsFor(order.id);
      expect(attempt!.provider_reference).not.toBeNull();

      // No field of the payment is the provider's reference. The redirect URL
      // is excluded on purpose: it is the provider's own address for the
      // session and every real provider encodes an identifier in it. What must
      // not happen is our API handing the reference over as data a client can
      // read and use.
      const fields = Object.entries(payment).filter(([name]) => name !== 'redirectUrl');
      expect(fields.map(([, value]) => value)).not.toContain(attempt!.provider_reference);
      expect(Object.keys(payment)).not.toContain('providerReference');
    });

    it('leaves the order awaiting payment: starting is not paying', async () => {
      const { client, order } = await customerWithOrder(1);
      await pay(order.id, { client });
      const { rows } = await h.sql.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [order.id],
      );
      expect(rows[0]!.status).toBe('awaiting_payment');
      const sold = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tickets WHERE status = 'sold'`,
      );
      expect(sold.rows[0]!.n).toBe(0);
    });

    it('refuses a body that tries to say how much to charge', async () => {
      const { client, order } = await customerWithOrder(1);
      const response = await client.request(
        'POST',
        `/markets/uk/checkout/orders/${order.id}/payments`,
        { amountMinor: 1 },
        { 'idempotency-key': freshKey() },
      );
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_FAILED');
    });

    it('requires an idempotency key', async () => {
      const { client, order } = await customerWithOrder(1);
      const response = await client.request(
        'POST',
        `/markets/uk/checkout/orders/${order.id}/payments`,
        {},
      );
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });
  });

  // ---- the payment deadline (D1 = B, D1a) ----------------------------------

  describe('the payment deadline', () => {
    it('lands exactly one margin before the earliest hold expires', async () => {
      const { order } = await customerWithOrder(2);
      const { rows } = await h.sql.query<{ order_expires: Date; hold_expires: Date }>(
        `SELECT o.expires_at AS order_expires, min(r.expires_at) AS hold_expires
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           JOIN reservations r ON r.id = oi.reservation_id
          WHERE o.id = $1
          GROUP BY o.expires_at`,
        [order.id],
      );
      const { order_expires: deadline, hold_expires: hold } = rows[0]!;
      expect(hold.getTime() - deadline.getTime()).toBe(MARGIN_SECONDS * 1000);
    });

    it('always leaves the hold outliving the deadline', async () => {
      // The property the whole phase rests on: paying on time gets the
      // tickets, and `hv_expire_reservations` can stay untouched (D11a = B)
      // because a hold whose order is still payable is never due for sweeping.
      const { order } = await customerWithOrder(2);
      const { rows } = await h.sql.query<{ ok: boolean }>(
        `SELECT bool_and(r.expires_at > o.expires_at) AS ok
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           JOIN reservations r ON r.id = oi.reservation_id
          WHERE o.id = $1`,
        [order.id],
      );
      expect(rows[0]!.ok).toBe(true);
    });

    it('is immutable once the order is placed', async () => {
      const { order } = await customerWithOrder(1);
      await expect(
        h.sql.query(`UPDATE orders SET expires_at = now() + interval '1 hour' WHERE id = $1`, [
          order.id,
        ]),
      ).rejects.toThrow(/fixed when it is placed/);
    });

    it('refuses to create an order whose hold is nearly gone', async () => {
      // A hold with less than the margin left cannot produce a payable order:
      // the deadline would already be in the past. Refused at checkout, with
      // the reason, rather than written and then unusable.
      const brief = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        RESERVATION_TTL_SECONDS: '30',
        PAYMENT_MARGIN_SECONDS: '60',
      });
      try {
        const client = await registeredClient(brief);
        await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 });
        await client.post('/markets/uk/terms/acceptance', { version: termsVersion });
        const response = await client.request(
          'POST',
          '/markets/uk/checkout/orders',
          { items: [{ slug: ukSlug, quantity: 1, optionId: correctOption }], termsVersion },
          { 'idempotency-key': freshKey() },
        );
        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe('PAYMENT_WINDOW_TOO_SHORT');
      } finally {
        await brief.close();
      }
    });
  });

  // ---- the minimum window (D1b) -------------------------------------------

  describe('the minimum remaining window', () => {
    it('refuses to start a payment with too little time left', async () => {
      // The order's real window is about 510 seconds. An app that demands more
      // than that sees exactly the state a latecomer would, without waiting.
      const strict = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        PAYMENT_MIN_WINDOW_SECONDS: '600',
      });
      try {
        const { client, order } = await customerWithOrder(1, strict);
        // The order was created happily: there is time on the clock, just not
        // enough of it to finish at a provider.
        expect(new Date(order.expiresAt).getTime()).toBeGreaterThan(Date.now());

        const response = await pay(order.id, { client, app: strict });
        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe('PAYMENT_WINDOW_TOO_SHORT');
        expect(await attemptsFor(order.id)).toHaveLength(0);
      } finally {
        await strict.close();
      }
    });

    it('says the deadline has passed once it actually has', async () => {
      // A genuinely short-lived order, so the deadline is reached rather than
      // simulated: `expires_at` is immutable and cannot be moved into the
      // past. The floor is lowered out of the way so it is the deadline that
      // answers, and the hold is long enough that setting the order up does
      // not eat the whole window on a loaded machine.
      const brief = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        RESERVATION_TTL_SECONDS: '120',
        PAYMENT_MARGIN_SECONDS: '90',
        PAYMENT_MIN_WINDOW_SECONDS: '1',
      });
      try {
        const { client, order } = await customerWithOrder(1, brief);
        // About thirty seconds of window: 120 seconds of hold, less the margin.
        expect(new Date(order.expiresAt).getTime() - Date.now()).toBeLessThan(31_000);

        // The first attempt is allowed, which is what makes the refusal that
        // follows a deadline and not a floor.
        expect((await pay(order.id, { client, app: brief })).statusCode).toBe(201);

        // Waited on the clock rather than polled: the condition is time
        // passing, not a server state changing, and asking repeatedly would
        // only spend the owner's rate limit on the answer.
        const deadline = new Date(order.expiresAt).getTime();
        while (Date.now() <= deadline + 500) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        const response = await pay(order.id, { client, app: brief });
        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe('PAYMENT_DEADLINE_PASSED');
      } finally {
        await brief.close();
      }
    }, 90_000);
  });

  // ---- repeated Pay (D3b = A) ---------------------------------------------

  describe('asking to pay again', () => {
    it('returns the same attempt for the same idempotency key', async () => {
      const { client, order } = await customerWithOrder(1);
      const key = freshKey();
      const first = paymentOf(await pay(order.id, { client, key }));
      const second = paymentOf(await pay(order.id, { client, key }));
      expect(second.id).toBe(first.id);
      expect(second.redirectUrl).toBe(first.redirectUrl);
      expect(await attemptsFor(order.id)).toHaveLength(1);
    });

    it('returns the live attempt for a different key, rather than a second one', async () => {
      const { client, order } = await customerWithOrder(1);
      const first = paymentOf(await pay(order.id, { client }));
      const again = paymentOf(await pay(order.id, { client }));
      // D3b = A: back to the payment they already have.
      expect(again.id).toBe(first.id);
      expect(again.redirectUrl).toBe(first.redirectUrl);
      expect(await attemptsFor(order.id)).toHaveLength(1);
    });

    it('refuses a key already used for a different order', async () => {
      const { client, order } = await customerWithOrder(1);
      const key = freshKey();
      await pay(order.id, { client, key });

      await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity: 1 });
      const second = orderOf(
        await client.request(
          'POST',
          '/markets/uk/checkout/orders',
          { items: [{ slug: ukSlug, quantity: 1, optionId: correctOption }], termsVersion },
          { 'idempotency-key': freshKey() },
        ),
      );
      const response = await pay(second.id, { client, key });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('refuses a key another customer has already used', async () => {
      const { client, order } = await customerWithOrder(1);
      const key = freshKey();
      await pay(order.id, { client, key });

      // The stranger is asking about their OWN order, with a key that is not
      // theirs. Answering 404 would be a lie about an order they can see; the
      // key is what is wrong, and that is what they are told.
      const { client: stranger, order: theirs } = await customerWithOrder(1);
      const response = await pay(theirs.id, { client: stranger, key });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('IDEMPOTENCY_KEY_REUSED');
      // And nothing of the first customer's was touched or revealed.
      expect(await attemptsFor(theirs.id)).toHaveLength(0);
      expect(await attemptsFor(order.id)).toHaveLength(1);
    });
  });

  // ---- one live attempt (D3 = B) ------------------------------------------

  describe('one live attempt per order', () => {
    it('refuses a second live attempt in raw SQL', async () => {
      const { client, order } = await customerWithOrder(1);
      await pay(order.id, { client });
      const [live] = await attemptsFor(order.id);

      await expect(
        h.sql.query(
          `INSERT INTO payments (order_id, market_id, provider, amount_minor, currency,
                                 idempotency_key, expires_at)
           SELECT o.id, o.market_id, 'fake', o.external_due_minor, o.currency,
                  $2, now() + interval '60 seconds'
             FROM orders o WHERE o.id = $1`,
          [order.id, `${live!.id}-second`],
        ),
      ).rejects.toThrow(/payments_one_live_per_order_idx/);
    });

    it('refuses a second succeeded attempt in raw SQL', async () => {
      const { client, order } = await customerWithOrder(1);
      await pay(order.id, { client });
      const [live] = await attemptsFor(order.id);
      await h.sql.query(`UPDATE payments SET status = 'succeeded' WHERE id = $1`, [live!.id]);

      await expect(
        h.sql.query(
          `INSERT INTO payments (order_id, market_id, provider, amount_minor, currency,
                                 idempotency_key, expires_at, status)
           SELECT o.id, o.market_id, 'fake', o.external_due_minor, o.currency,
                  $2, now() + interval '60 seconds', 'succeeded'
             FROM orders o WHERE o.id = $1`,
          [order.id, `${live!.id}-third`],
        ),
      ).rejects.toThrow(/payments_one_succeeded_per_order_idx/);
    });

    it('produces one attempt when two requests race', async () => {
      const { client, order } = await customerWithOrder(1);
      const results = await Promise.all([
        pay(order.id, { client }),
        pay(order.id, { client }),
        pay(order.id, { client }),
      ]);
      // Every caller is answered — none is refused — and they all describe the
      // same attempt, because the order row is locked before the decision.
      for (const result of results) expect(result.statusCode).toBe(201);
      const ids = new Set(results.map((r) => paymentOf(r).id));
      expect(ids.size).toBe(1);
      expect(await attemptsFor(order.id)).toHaveLength(1);
    });

    it('allows a new attempt once the previous one has failed', async () => {
      const { client, order } = await customerWithOrder(1);
      await pay(order.id, { client });
      const [first] = await attemptsFor(order.id);
      await h.sql.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [first!.id]);

      const second = paymentOf(await pay(order.id, { client }));
      expect(second.id).not.toBe(first!.id);
      expect(await attemptsFor(order.id)).toHaveLength(2);
    });
  });

  // ---- the attempt timeout (D3a) ------------------------------------------

  describe('the attempt timeout', () => {
    it('caps an attempt at the configured lifetime', async () => {
      const { client, order } = await customerWithOrder(1);
      const payment = paymentOf(await pay(order.id, { client }));
      const lifetimeMs =
        new Date(payment.expiresAt).getTime() - new Date(payment.createdAt).getTime();
      expect(lifetimeMs).toBeLessThanOrEqual(ATTEMPT_TTL_SECONDS * 1000);
      expect(lifetimeMs).toBeGreaterThan(0);
    });

    it('never lets an attempt outlive the order deadline', async () => {
      // With a lifetime longer than the order's whole window, the order's
      // clock has to win.
      const patient = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        PAYMENT_ATTEMPT_TTL_SECONDS: '600',
      });
      try {
        const { client, order } = await customerWithOrder(1, patient);
        const payment = paymentOf(await pay(order.id, { client, app: patient }));
        expect(new Date(payment.expiresAt).getTime()).toBe(new Date(order.expiresAt).getTime());
      } finally {
        await patient.close();
      }
    });

    it('finishes a lapsed attempt and starts another', async () => {
      const brief = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        PAYMENT_ATTEMPT_TTL_SECONDS: '1',
      });
      try {
        const { client, order } = await customerWithOrder(1, brief);
        const first = paymentOf(await pay(order.id, { client, app: brief }));

        // Polled rather than slept on a fixed delay: the attempt is genuinely
        // short-lived, and a loaded machine must not turn that into a race.
        const deadline = Date.now() + 15_000;
        let second = first;
        while (second.id === first.id && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          second = paymentOf(await pay(order.id, { client, app: brief }));
        }
        expect(second.id).not.toBe(first.id);

        const rows = await attemptsFor(order.id);
        expect(rows).toHaveLength(2);
        // The lapsed one is terminal — without that the one-live index would
        // block the retry for ever — and it says why.
        expect(rows[0]!.status).toBe('expired');
        expect(rows[1]!.status).toBe('processing');
      } finally {
        await brief.close();
      }
    });
  });

  // ---- amount and currency authority (I4, I5, I6, I7) ---------------------

  describe('the order is the only authority on the amount', () => {
    it('refuses an attempt for any other amount, in raw SQL', async () => {
      const { order } = await customerWithOrder(2);
      await expect(
        h.sql.query(
          `INSERT INTO payments (order_id, market_id, provider, amount_minor, currency,
                                 idempotency_key, expires_at)
           SELECT o.id, o.market_id, 'fake', o.external_due_minor - 1, o.currency,
                  $2, now() + interval '60 seconds'
             FROM orders o WHERE o.id = $1`,
          [order.id, freshKey()],
        ),
      ).rejects.toThrow(/payments_order_amount_fkey/);
    });

    it('refuses an attempt in another currency', async () => {
      const { order } = await customerWithOrder(1);
      await expect(
        h.sql.query(
          `INSERT INTO payments (order_id, market_id, provider, amount_minor, currency,
                                 idempotency_key, expires_at)
           SELECT o.id, o.market_id, 'fake', o.external_due_minor, 'EUR',
                  $2, now() + interval '60 seconds'
             FROM orders o WHERE o.id = $1`,
          [order.id, freshKey()],
        ),
      ).rejects.toThrow(/payments_(market_currency|order_amount)_fkey/);
    });

    it('refuses an attempt filed under another market', async () => {
      const { order } = await customerWithOrder(1);
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'ie'`,
      );
      await expect(
        h.sql.query(
          `INSERT INTO payments (order_id, market_id, provider, amount_minor, currency,
                                 idempotency_key, expires_at)
           SELECT o.id, $3::uuid, 'fake', o.external_due_minor, o.currency,
                  $2, now() + interval '60 seconds'
             FROM orders o WHERE o.id = $1`,
          [order.id, freshKey(), rows[0]!.id],
        ),
      ).rejects.toThrow(/payments_order_market_fkey|payments_market_currency_fkey/);
    });

    it('keeps the amount and the snapshot immutable', async () => {
      const { client, order } = await customerWithOrder(1);
      await pay(order.id, { client });
      const [attempt] = await attemptsFor(order.id);
      await expect(
        h.sql.query(`UPDATE payments SET amount_minor = 1 WHERE id = $1`, [attempt!.id]),
      ).rejects.toThrow(/fixed when it is created/);
      await expect(
        h.sql.query(`UPDATE payments SET expires_at = now() + interval '1 day' WHERE id = $1`, [
          attempt!.id,
        ]),
      ).rejects.toThrow(/fixed when it is created/);
    });

    it('keeps the provider reference once it is set', async () => {
      const { client, order } = await customerWithOrder(1);
      await pay(order.id, { client });
      const [attempt] = await attemptsFor(order.id);
      await expect(
        h.sql.query(`UPDATE payments SET provider_reference = 'other' WHERE id = $1`, [
          attempt!.id,
        ]),
      ).rejects.toThrow(/keeps the provider reference/);
    });

    it('gives hv_app no way to erase an attempt', async () => {
      const { rows } = await h.sql.query<{ del: boolean; upd: boolean }>(
        `SELECT has_table_privilege('hv_app', 'payments', 'DELETE') AS del,
                has_table_privilege('hv_app', 'payments', 'UPDATE') AS upd`,
      );
      expect(rows[0]!.del).toBe(false);
      // UPDATE stays: the status moves.
      expect(rows[0]!.upd).toBe(true);
    });
  });

  // ---- the payment state machine ------------------------------------------

  describe('the attempt state machine', () => {
    it('refuses to reopen a succeeded attempt', async () => {
      const { client, order } = await customerWithOrder(1);
      await pay(order.id, { client });
      const [attempt] = await attemptsFor(order.id);
      await h.sql.query(`UPDATE payments SET status = 'succeeded' WHERE id = $1`, [attempt!.id]);
      await expect(
        h.sql.query(`UPDATE payments SET status = 'pending' WHERE id = $1`, [attempt!.id]),
      ).rejects.toThrow(/payment status cannot change/);
    });

    it('refuses to turn a failed attempt into a successful one', async () => {
      const { client, order } = await customerWithOrder(1);
      await pay(order.id, { client });
      const [attempt] = await attemptsFor(order.id);
      await h.sql.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [attempt!.id]);
      await expect(
        h.sql.query(`UPDATE payments SET status = 'succeeded' WHERE id = $1`, [attempt!.id]),
      ).rejects.toThrow(/payment status cannot change/);
    });
  });

  // ---- the order state machine (D4 = C) -----------------------------------

  describe('the order state machine', () => {
    it('refuses to un-pay an order', async () => {
      const { order } = await customerWithOrder(1);
      await h.sql.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
      await expect(
        h.sql.query(`UPDATE orders SET status = 'awaiting_payment' WHERE id = $1`, [order.id]),
      ).rejects.toThrow(/order status cannot change/);
    });

    it('refuses a late failure after a success', async () => {
      const { order } = await customerWithOrder(1);
      await h.sql.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
      await expect(
        h.sql.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [order.id]),
      ).rejects.toThrow(/order status cannot change/);
    });

    it('allows the transitions Phase 6 needs', async () => {
      for (const status of ['paid', 'paid_unfulfillable', 'failed', 'expired', 'cancelled']) {
        const { order } = await customerWithOrder(1);
        await h.sql.query(`UPDATE orders SET status = $2 WHERE id = $1`, [order.id, status]);
        const { rows } = await h.sql.query<{ status: string }>(
          `SELECT status FROM orders WHERE id = $1`,
          [order.id],
        );
        expect(rows[0]!.status).toBe(status);
      }
    });

    it('leaves the later phases to add their own transitions', async () => {
      const { order } = await customerWithOrder(1);
      await h.sql.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
      // P10 adds this one, in its own migration.
      await expect(
        h.sql.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [order.id]),
      ).rejects.toThrow(/order status cannot change/);
    });
  });

  // ---- stale and invalid order states -------------------------------------

  describe('orders that cannot be paid', () => {
    it('refuses an order that is no longer awaiting payment', async () => {
      const { client, order } = await customerWithOrder(1);
      await h.sql.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
      const response = await pay(order.id, { client });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('ORDER_NOT_PAYABLE');
      expect(await attemptsFor(order.id)).toHaveLength(0);
    });

    it('refuses an order that does not exist', async () => {
      const { client } = await customerWithOrder(1);
      const response = await pay('00000000-0000-7000-8000-000000000000', { client });
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
    });

    it('refuses a malformed order id', async () => {
      const { client } = await customerWithOrder(1);
      const response = await client.request(
        'POST',
        '/markets/uk/checkout/orders/not-a-uuid/payments',
        {},
        { 'idempotency-key': freshKey() },
      );
      expect(response.statusCode).toBe(400);
    });
  });

  // ---- access boundaries --------------------------------------------------

  describe('who may pay for an order', () => {
    it('lets a signed-in customer pay for their own order', async () => {
      const { client, order } = await customerWithOrder(1);
      expect((await pay(order.id, { client })).statusCode).toBe(201);
    });

    it('lets a verified guest pay for their own order', async () => {
      const { cookie, order } = await guestWithOrder(1);
      const response = await pay(order.id, { cookie });
      expect(response.statusCode).toBe(201);
      expect(paymentOf(response).amountMinor).toBe(order.totalMinor);
    });

    it('answers another customer’s order with 404, not 403', async () => {
      const { order } = await customerWithOrder(1);
      const stranger = await registeredClient(h.app);
      const response = await pay(order.id, { client: stranger });
      // Indistinguishable from an order that is not there: a stranger learns
      // nothing about what exists.
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
      expect(await attemptsFor(order.id)).toHaveLength(0);
    });

    it('does not let a guest pay for an account’s order', async () => {
      const { order } = await customerWithOrder(1);
      const { cookie } = await guestWithOrder(1);
      const response = await pay(order.id, { cookie });
      expect(response.statusCode).toBe(404);
    });

    it('does not let an account pay for a guest’s order', async () => {
      const { order } = await guestWithOrder(1);
      const stranger = await registeredClient(h.app);
      expect((await pay(order.id, { client: stranger })).statusCode).toBe(404);
    });

    it('refuses a caller with neither a session nor a guest session', async () => {
      const { order } = await customerWithOrder(1);
      const response = await pay(order.id);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('CHECKOUT_IDENTITY_REQUIRED');
    });

    it('makes a guest prove their address again once verification has lapsed', async () => {
      const { cookie, order } = await guestWithOrder(1);
      // Exactly how checkout treats a lapsed window. Reading an order back
      // afterwards is what the order access token is for (OD-2, P6-8);
      // starting a payment is not a read.
      await h.sql.query(
        `UPDATE guest_sessions SET verified_email_at = now() - interval '2 hours'
          WHERE verified_email IS NOT NULL`,
      );
      const response = await pay(order.id, { cookie });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VERIFICATION_REQUIRED');
      expect(await attemptsFor(order.id)).toHaveLength(0);
    });

    it('refuses an order reached through another market’s path', async () => {
      const { client, order } = await customerWithOrder(1);
      const response = await pay(order.id, { client, market: 'ie' });
      expect(response.statusCode).toBe(404);
    });

    it('refuses a market the environment does not allow', async () => {
      const { client, order } = await customerWithOrder(1);
      const response = await pay(order.id, { client, market: 'de' });
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('MARKET_NOT_AVAILABLE');
    });
  });

  // ---- one order, one market and currency ---------------------------------

  describe('markets stay separate', () => {
    it('prices an Irish order in euro and a UK order in sterling', async () => {
      const client = await registeredClient(h.app);
      await client.post('/markets/ie/cart/items', { slug: ieSlug, quantity: 2 });
      await client.post('/markets/ie/terms/acceptance', { version: ieTermsVersion });
      const order = orderOf(
        await client.request(
          'POST',
          '/markets/ie/checkout/orders',
          {
            items: [{ slug: ieSlug, quantity: 2, optionId: ieOption }],
            termsVersion: ieTermsVersion,
          },
          { 'idempotency-key': freshKey() },
        ),
      );
      const payment = paymentOf(await pay(order.id, { client, market: 'ie' }));
      expect(payment.currency).toBe('EUR');
      expect(payment.amountMinor).toBe(600);
    });
  });

  // ---- the provider ------------------------------------------------------

  describe('the payment provider', () => {
    it('fails closed when none is configured', async () => {
      // The production state today: O13 is open, so there is no provider. The
      // API still serves everything else and refuses to pretend about money.
      const none = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        FAKE_PAYMENT_WEBHOOK_SECRET: undefined,
      });
      try {
        const { client, order } = await customerWithOrder(1, none);
        const response = await pay(order.id, { client, app: none });
        expect(response.statusCode).toBe(400);
        expect(errorCode(response)).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
        // Refused before anything was written.
        expect(await attemptsFor(order.id)).toHaveLength(0);
      } finally {
        await none.close();
      }
    });

    it('records the provider that was used', async () => {
      const { client, order } = await customerWithOrder(1);
      await pay(order.id, { client });
      const [attempt] = await attemptsFor(order.id);
      expect(attempt!.provider).toBe('fake');
    });
  });

  // ---- rate limiting (B19) -----------------------------------------------

  describe('starting a payment is rate limited', () => {
    it('refuses once the owner is over the limit', async () => {
      const { client, order } = await customerWithOrder(1);
      const limit = RATE_LIMITS.paymentsPerOwner.limit;
      for (let i = 0; i < limit; i++) await pay(order.id, { client });
      const over = await pay(order.id, { client });
      expect(over.statusCode).toBe(429);
      expect(errorCode(over)).toBe('RATE_LIMITED');
    });

    it('fails closed when Redis is unreachable', async () => {
      // The identity has to exist before Redis goes away: registering would
      // itself be refused by the fail-closed limiter. Sessions live in
      // PostgreSQL, so the same cookie works against a second app on the same
      // database with an unreachable Redis.
      const { client, order } = await customerWithOrder(1);
      const offline = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        REDIS_URL: 'redis://127.0.0.1:1/0',
      });
      try {
        const response = await offline.inject({
          method: 'POST',
          url: `/markets/uk/checkout/orders/${order.id}/payments`,
          remoteAddress: randomIp(),
          headers: {
            origin: WEB_ORIGIN,
            cookie: `hv_session=${client.cookie}`,
            'idempotency-key': freshKey(),
          },
          payload: {},
        });
        expect(response.statusCode).toBe(503);
        expect(errorCode(response)).toBe('SERVICE_UNAVAILABLE');
        // Refused before anything was written: the limiter runs first.
        expect(await attemptsFor(order.id)).toHaveLength(0);
      } finally {
        await offline.close();
      }
    });
  });
});
