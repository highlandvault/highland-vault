/**
 * The payments queue: order expiry, attempt expiry and the reconciler
 * (task P6-5), against real PostgreSQL.
 *
 * What these tests are mostly about is what the sweeps must NOT do. Expiring an
 * order is the one place in Phase 6 where the system decides against a customer
 * without anybody saying anything, so the boundaries matter more than the happy
 * path: it must not touch an order that was paid a moment ago, it must not
 * consult a provider first (D11a = B), and expiring an ATTEMPT must not end the
 * ORDER, because under D3 = B the customer may still try again.
 */
import { randomUUID } from 'node:crypto';
import { createDb, type Database } from '@hv/db';
import {
  createTestDatabase,
  enableMarketsForTesting,
  insertFixtureDraw,
  insertFixtureUser,
  type TestDatabase,
} from '@hv/db/testing';
import { ORDER_EXPIRED_TOPIC, ORDER_OUTCOME_TOPICS } from '@hv/domain';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expireAttempts, expireOrders } from '../src/payments/payment-expiry';
import { reconcileCandidates, reconcileOnce } from '../src/payments/reconciler';
import { orderOutcomeHandlers } from '../src/outbox/order-outcomes';
import { outboxHandlers } from '../src/outbox/outbox.service';
import { createTopicDispatcher, type OutboxHandler } from '../src/outbox/outbox';
import { VERIFICATION_EMAIL_TOPIC } from '../src/mail/verification-email';
import { parseWorkerEnv } from '../src/config/env';

/** Base32 as `orders_order_number_format` requires: HV- then ten of [A-Z2-7]. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let numbered = 0;
const orderNumber = () => {
  numbered += 1;
  let n = numbered + Date.now() * 32;
  let body = '';
  for (let i = 0; i < 10; i++) {
    body = ALPHABET[n % 32] + body;
    n = Math.floor(n / 32);
  }
  return `HV-${body}`;
};

describe('the payments queue', () => {
  let database: TestDatabase;
  let db: Database;
  let sql: pg.Pool;
  // The draw exists so the market fixture is complete; these tests work on
  // orders and payments, which do not reference it.
  let termsVersionId: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.url, applicationName: 'hv-test-payments', max: 6 });
    sql = new pg.Pool({ connectionString: database.url, max: 3 });
    await enableMarketsForTesting(sql, ['uk']);
    await insertFixtureDraw(sql, {
      market: 'uk',
      slug: 'payments',
      state: 'live',
      totalTickets: 100,
      maxPerPerson: 10,
      ticketPriceMinor: 250,
    });
    // An order needs a published terms version to point at. Nothing here tests
    // terms, so the smallest real row will do.
    const terms = await sql.query<{ id: string }>(
      `INSERT INTO terms_versions (market_id, version, published_at)
       SELECT id, 'payments-fixture', now() FROM markets WHERE code = 'uk'
       RETURNING id`,
    );
    termsVersionId = terms.rows[0]!.id;
  });

  afterEach(async () => {
    await db?.destroy();
    await sql?.end();
    await database?.drop();
  });

  // ---- fixtures ------------------------------------------------------------

  /** An order awaiting payment, whose deadline is `seconds` away (negative = past). */
  async function order(seconds: number, status = 'awaiting_payment'): Promise<string> {
    const userId = await insertFixtureUser(sql, `order-${randomUUID()}@example.com`);
    const { rows } = await sql.query<{ id: string }>(
      `INSERT INTO orders (order_number, market_id, currency, user_id, terms_version_id,
                           status, total_minor, wallet_applied_minor, external_due_minor,
                           idempotency_key, idempotency_digest, created_at, expires_at)
       SELECT $5, m.id, m.currency, $1::uuid, $2::uuid, $3, 500, 0, 500,
              $4::text, sha256(convert_to($4::text, 'UTF8')),
              now() - make_interval(secs => GREATEST(1, -$6::int) + 1),
              now() + make_interval(secs => $6)
         FROM markets m WHERE m.code = 'uk'
       RETURNING id`,
      [userId, termsVersionId, status, `key-${randomUUID()}`, orderNumber(), seconds],
    );
    return rows[0]!.id;
  }

  /** A payment attempt on that order, expiring `seconds` from now. */
  async function attempt(orderId: string, seconds: number, status = 'processing'): Promise<string> {
    const { rows } = await sql.query<{ id: string }>(
      `INSERT INTO payments (order_id, market_id, provider, provider_reference, amount_minor,
                             currency, idempotency_key, created_at, expires_at, status)
       SELECT o.id, o.market_id, 'fake', $4, o.external_due_minor, o.currency, $2,
              now() - make_interval(secs => GREATEST(1, -$3::int) + 1),
              now() + make_interval(secs => $3), $5
         FROM orders o WHERE o.id = $1
       RETURNING id`,
      [orderId, `pay-${randomUUID()}`, seconds, `ref-${randomUUID()}`, status],
    );
    return rows[0]!.id;
  }

  const statusOf = async (table: 'orders' | 'payments', id: string) =>
    (await sql.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id]))
      .rows[0]!.status;

  const outboxFor = async (orderId: string) =>
    (
      await sql.query<{ topic: string }>(
        `SELECT topic FROM outbox WHERE payload->>'orderId' = $1 ORDER BY created_at`,
        [orderId],
      )
    ).rows.map((r) => r.topic);

  const auditFor = async (orderId: string) =>
    (
      await sql.query<{ action: string; actor_type: string }>(
        `SELECT action, actor_type FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at`,
        [orderId],
      )
    ).rows;

  // ---- order expiry --------------------------------------------------------

  describe('order expiry', () => {
    it('expires a lapsed order, announcing it once', async () => {
      const id = await order(-1);
      expect(await expireOrders(db)).toEqual({ expired: 1 });

      expect(await statusOf('orders', id)).toBe('expired');
      expect(await outboxFor(id)).toEqual([ORDER_EXPIRED_TOPIC]);
      const audit = await auditFor(id);
      expect(audit).toEqual([{ action: 'order.expired', actor_type: 'system' }]);
    });

    it('leaves an order whose deadline has not passed', async () => {
      const id = await order(600);
      expect(await expireOrders(db)).toEqual({ expired: 0 });
      expect(await statusOf('orders', id)).toBe('awaiting_payment');
    });

    it('never touches an order that is already settled', async () => {
      for (const status of ['paid', 'paid_unfulfillable', 'failed', 'cancelled', 'expired']) {
        const id = await order(-1, status);
        await expireOrders(db);
        expect(await statusOf('orders', id)).toBe(status);
        expect(await outboxFor(id)).toEqual([]);
      }
    });

    it('is idempotent: ten runs expire an order once and announce it once', async () => {
      const id = await order(-1);
      const results = await Promise.all(Array.from({ length: 10 }, () => expireOrders(db)));
      expect(results.reduce((n, r) => n + r.expired, 0)).toBe(1);
      expect(await outboxFor(id)).toEqual([ORDER_EXPIRED_TOPIC]);
      expect(await auditFor(id)).toHaveLength(1);
    });

    it('loses the race to a finalisation that paid the order', async () => {
      const id = await order(-1);
      // The customer's payment lands between this sweep's read and its write.
      // The conditional UPDATE is what makes the paid order win.
      await sql.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [id]);
      expect(await expireOrders(db)).toEqual({ expired: 0 });
      expect(await statusOf('orders', id)).toBe('paid');
    });

    it('batches, and finishes the whole backlog', async () => {
      const ids = await Promise.all(Array.from({ length: 5 }, () => order(-1)));
      expect(await expireOrders(db, 2)).toEqual({ expired: 5 });
      for (const id of ids) expect(await statusOf('orders', id)).toBe('expired');
    });
  });

  // ---- attempt expiry ------------------------------------------------------

  describe('attempt expiry', () => {
    it('closes a lapsed attempt without touching its order', async () => {
      const orderId = await order(600);
      const paymentId = await attempt(orderId, -1);

      expect(await expireAttempts(db)).toEqual({ expired: 1 });
      expect(await statusOf('payments', paymentId)).toBe('expired');
      // D3 = B: the customer may still pay. The order is untouched and so is
      // its announcement history.
      expect(await statusOf('orders', orderId)).toBe('awaiting_payment');
      expect(await outboxFor(orderId)).toEqual([]);
      expect(await auditFor(orderId)).toEqual([]);
    });

    it('frees the one-live-attempt slot so the customer can try again', async () => {
      const orderId = await order(600);
      await attempt(orderId, -1);
      await expireAttempts(db);
      // The partial unique index counts only live attempts, so a second one
      // can now be inserted. Before the sweep this would violate it.
      await expect(attempt(orderId, 120)).resolves.toBeTruthy();
    });

    it('never resurrects or overwrites a terminal attempt', async () => {
      const orderId = await order(600);
      for (const status of ['succeeded', 'failed', 'expired']) {
        const paymentId = await attempt(orderId, -1, status);
        await expireAttempts(db);
        expect(await statusOf('payments', paymentId)).toBe(status);
        await sql.query(`DELETE FROM payments WHERE id = $1`, [paymentId]);
      }
    });

    it('leaves an attempt that still has time', async () => {
      const orderId = await order(600);
      const paymentId = await attempt(orderId, 120);
      expect(await expireAttempts(db)).toEqual({ expired: 0 });
      expect(await statusOf('payments', paymentId)).toBe('processing');
    });

    it('races the customer’s own retry to a single transition', async () => {
      const orderId = await order(600);
      const paymentId = await attempt(orderId, -1);
      const runs = await Promise.all(Array.from({ length: 10 }, () => expireAttempts(db)));
      expect(runs.reduce((n, r) => n + r.expired, 0)).toBe(1);
      expect(await statusOf('payments', paymentId)).toBe('expired');
    });
  });

  // ---- the reconciler ------------------------------------------------------

  describe('the reconciler', () => {
    it('selects live attempts changed within the lookback, oldest first', async () => {
      const orderId = await order(600);
      const recent = await attempt(orderId, 120);
      expect(await reconcileCandidates(db)).toEqual([recent]);
    });

    it('ignores an attempt whose last state change is older than the lookback', async () => {
      // `updated_at` cannot be backdated: `hv_set_updated_at` stamps it on
      // every UPDATE, so the column always says when the row really changed.
      // That is exactly the property the reconciler depends on, so the window
      // is tested by letting real time pass instead of by faking the clock.
      const older = await attempt(await order(600), 120);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const newer = await attempt(await order(600), 120);

      // D12a: older cases go to the operator endpoint, not to this job.
      expect(await reconcileCandidates(db, 1)).toEqual([newer]);
      // And both are in scope over the real five-minute window, oldest first.
      expect(await reconcileCandidates(db)).toEqual([older, newer]);
    });

    it('ignores terminal attempts', async () => {
      const orderId = await order(600);
      for (const status of ['succeeded', 'failed', 'expired']) {
        await attempt(orderId, 120, status);
      }
      expect(await reconcileCandidates(db)).toEqual([]);
    });

    it('calls the internal listener once per candidate, and writes nothing itself', async () => {
      const orderId = await order(600);
      const paymentId = await attempt(orderId, 120);
      const before = await sql.query<{ updated_at: Date }>(
        `SELECT updated_at FROM payments WHERE id = $1`,
        [paymentId],
      );

      const calls: string[] = [];
      const run = await reconcileOnce(db, {
        baseUrl: 'http://internal.test',
        token: 'x'.repeat(32),
        fetch: (input) => {
          calls.push(input instanceof Request ? input.url : String(input));
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
      });

      expect(run).toEqual({ checked: 1, failed: 0 });
      expect(calls).toEqual([`http://internal.test/internal/payments/${paymentId}/reconcile`]);
      // The critical invariant: examining a payment does not touch its row, so
      // `updated_at` still means "last state change" and the worklist does not
      // re-arm itself on its own writes.
      const after = await sql.query<{ updated_at: Date }>(
        `SELECT updated_at FROM payments WHERE id = $1`,
        [paymentId],
      );
      expect(after.rows[0]!.updated_at).toEqual(before.rows[0]!.updated_at);
    });

    it('sends the token, and nothing else', async () => {
      const orderId = await order(600);
      await attempt(orderId, 120);
      let seen: Headers | undefined;
      await reconcileOnce(db, {
        baseUrl: 'http://internal.test',
        token: 'secret-token-of-at-least-32-chars',
        fetch: (_input, init) => {
          seen = new Headers(init?.headers);
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
      });
      expect(seen?.get('x-hv-internal-token')).toBe('secret-token-of-at-least-32-chars');
      expect(seen?.get('cookie')).toBeNull();
    });

    it('does not abandon the batch when one payment fails', async () => {
      const orderId = await order(600);
      await attempt(orderId, 120);
      const second = await order(600);
      await attempt(second, 120);
      const third = await order(600);
      await attempt(third, 120);

      let n = 0;
      const run = await reconcileOnce(db, {
        baseUrl: 'http://internal.test',
        token: 'x'.repeat(32),
        fetch: () => {
          n += 1;
          if (n === 2) return Promise.reject(new Error('connection refused'));
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
      });
      expect(run).toEqual({ checked: 2, failed: 1 });
    });

    it('reports every failure when the API is unavailable, and changes nothing', async () => {
      const orderId = await order(600);
      const paymentId = await attempt(orderId, 120);
      const run = await reconcileOnce(db, {
        baseUrl: 'http://internal.test',
        token: 'x'.repeat(32),
        fetch: () => Promise.reject(new Error('ECONNREFUSED')),
      });
      expect(run).toEqual({ checked: 0, failed: 1 });
      expect(await statusOf('payments', paymentId)).toBe('processing');
      expect(await statusOf('orders', orderId)).toBe('awaiting_payment');
    });

    it('counts a 503 as a failure rather than an answer', async () => {
      const orderId = await order(600);
      await attempt(orderId, 120);
      const run = await reconcileOnce(db, {
        baseUrl: 'http://internal.test',
        token: 'x'.repeat(32),
        fetch: () => Promise.resolve(new Response('{}', { status: 503 })),
      });
      expect(run).toEqual({ checked: 0, failed: 1 });
    });
  });

  // ---- outbox handlers -----------------------------------------------------

  describe('order outcome handlers', () => {
    it('registers a handler for all four topics (G4.11)', () => {
      const handlers = orderOutcomeHandlers();
      expect(Object.keys(handlers).sort()).toEqual([...ORDER_OUTCOME_TOPICS].sort());
    });

    it('wires all four into the dispatcher the worker actually runs (G4.11)', async () => {
      // The helper test above proves the helper. This proves the WIRING: if the
      // spread were removed from `outboxHandlers`, the helper would still
      // return four entries and this would fail, which is the point.
      //
      // `createTopicDispatcher` throws on an unregistered topic — an
      // unhandled event fails and backs off rather than being dropped — so
      // dispatching each topic through the live map is the real assertion.
      const relay: OutboxHandler = () => Promise.resolve('deferred');
      const handlers = outboxHandlers(relay);

      expect(Object.keys(handlers).sort()).toEqual(
        [VERIFICATION_EMAIL_TOPIC, ...ORDER_OUTCOME_TOPICS].sort(),
      );

      const dispatch = createTopicDispatcher(handlers);
      for (const topic of ORDER_OUTCOME_TOPICS) {
        const event = {
          id: randomUUID(),
          topic,
          payload: { orderId: randomUUID(), orderNumber: 'HV-TEST-2' },
          attempts: 1,
        };
        await expect(
          dispatch(event),
          `${topic} is not registered in the worker's dispatcher`,
        ).resolves.toBe('published');
      }
      // And the verification relay is still there: adding the order topics
      // must not have displaced what was already registered.
      await expect(
        dispatch({
          id: randomUUID(),
          topic: VERIFICATION_EMAIL_TOPIC,
          payload: {},
          attempts: 1,
        }),
      ).resolves.toBe('deferred');
    });

    it('fails an event whose topic nobody registered', () => {
      // The property the test above depends on, asserted directly: a missing
      // registration is a stuck queue, not a silent drop.
      //
      // It throws SYNCHRONOUSLY, before any promise exists — which is why the
      // assertions above would fail loudly rather than hang if a topic were
      // unregistered, and why this is not `rejects`.
      const dispatch = createTopicDispatcher(outboxHandlers(() => Promise.resolve('deferred')));
      expect(() =>
        dispatch({ id: randomUUID(), topic: 'order.invented', payload: {}, attempts: 1 }),
      ).toThrow(/no handler registered/);
    });

    it('publishes, and is safe to run twice on the same event', async () => {
      const handlers = orderOutcomeHandlers();
      const event = {
        id: randomUUID(),
        topic: ORDER_EXPIRED_TOPIC,
        payload: { orderId: randomUUID(), orderNumber: 'HV-TEST-1' },
        attempts: 1,
      };
      expect(await handlers[ORDER_EXPIRED_TOPIC]!(event)).toBe('published');
      expect(await handlers[ORDER_EXPIRED_TOPIC]!(event)).toBe('published');
    });
  });

  // ---- configuration -------------------------------------------------------

  describe('worker configuration', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      SMTP_URL: 'smtp://localhost:1025',
      MAIL_FROM: 'noreply@example.com',
      OUTBOX_ENCRYPTION_KEY: 'a3f1'.repeat(16),
      INTERNAL_API_URL: 'http://api.internal:4001',
      INTERNAL_API_TOKEN: 'a-real-looking-internal-token-value',
    };

    it('never carries a payment-provider secret', () => {
      const env = parseWorkerEnv(base);
      // K-a: the API owns the provider call. Any key here that could hold a
      // provider credential would be a way for one to reach this process.
      const keys = Object.keys(env).join(' ').toLowerCase();
      expect(keys).not.toContain('provider');
      expect(keys).not.toContain('payment_webhook');
      // And a provider secret offered to it is simply not part of the shape.
      const withSecret = parseWorkerEnv({ ...base, FAKE_PAYMENT_WEBHOOK_SECRET: 'nope' });
      expect(withSecret).not.toHaveProperty('FAKE_PAYMENT_WEBHOOK_SECRET');
    });

    it('requires the internal API in production', () => {
      for (const key of ['INTERNAL_API_URL', 'INTERNAL_API_TOKEN'] as const) {
        const { [key]: _removed, ...without } = base;
        expect(() => parseWorkerEnv(without)).toThrow();
      }
    });

    it('accepts a worker without the internal API outside production', () => {
      const { INTERNAL_API_URL: _u, INTERNAL_API_TOKEN: _t, ...without } = base;
      const env = parseWorkerEnv({ ...without, NODE_ENV: 'development' });
      expect(env.INTERNAL_API_URL).toBeUndefined();
    });

    it('refuses an internal token shorter than 32 bytes', () => {
      expect(() => parseWorkerEnv({ ...base, INTERNAL_API_TOKEN: 'too-short' })).toThrow();
    });
  });
});
