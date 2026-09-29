/**
 * The internal listener, the trusted status check and the staff payment
 * surfaces (task P6-5; owner decisions OD-5, D12a, D13a, OD-7a, K-a).
 *
 * Two things are being proved here and they are not the same thing.
 *
 * The first is that reconciliation reaches the same outcome as a webhook,
 * because it runs the same finalisation. The second, and the one most of this
 * file is about, is that the internal listener is a genuinely separate trust
 * boundary: the public API does not serve it, a session cookie cannot satisfy
 * it, and a wrong token is refused the same way whatever is wrong with it.
 *
 * The listener is bound on a real socket and driven over real HTTP, not
 * injected. A test that injected into it would prove nothing about which
 * pipeline the request went through, and which pipeline it went through is the
 * entire security argument.
 */
import { ErrorResponseSchema, OrderResponseSchema, PaymentResponseSchema } from '@hv/contracts';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import { FAKE_SIGNATURE_HEADER, signWebhook, type FakePaymentProvider } from '@hv/payments';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalListenerService } from '../src/internal/internal-listener.service';
import { INTERNAL_TOKEN_HEADER, tokenMatches } from '../src/internal/internal-listener';
import type { Redis } from 'ioredis';
import { RATE_LIMITS } from '../src/auth/rate-limiter';
import { REDIS } from '../src/redis/redis.module';
import { PAYMENT_PROVIDERS } from '../src/payments/payment-provider.factory';
import { DEV_PLACEHOLDER_INTERNAL_TOKEN } from '../src/config/env';
import {
  type Client,
  type Harness,
  enrolMfa,
  grantRole,
  randomIp,
  registeredClient,
  startApp,
  startHarness,
  uniqueEmail,
} from './support';

const orderOf = (r: { json: () => unknown }) => OrderResponseSchema.parse(r.json()).order;
const paymentOf = (r: { json: () => unknown }) => PaymentResponseSchema.parse(r.json()).payment;
const errorCode = (r: { json: () => unknown }) => ErrorResponseSchema.parse(r.json()).error.code;

let keyCounter = 0;
let eventSeq = 0;
const freshKey = () => `rec-${Date.now().toString(36)}-${keyCounter++}-aaaaaaaa`;

const REASON = { reason: 'Customer says they paid; checking with the provider.' };

describe('payment reconciliation', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let finance: Client & { email: string };
  let support: Client & { email: string };
  let ukSlug: string;
  let termsVersion: string;
  let correctOption: string;
  /** Where the internal listener actually bound. The harness asks for port 0. */
  let internalUrl: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);

    admin = await registeredClient(h.app, uniqueEmail('rec-admin'));
    await grantRole(h.sql, admin.email, 'super_admin');
    await enrolMfa(admin);

    finance = await registeredClient(h.app, uniqueEmail('rec-finance'));
    await grantRole(h.sql, finance.email, 'finance');
    await enrolMfa(finance);

    support = await registeredClient(h.app, uniqueEmail('rec-support'));
    await grantRole(h.sql, support.email, 'support');
    await enrolMfa(support);

    const version = `rec-fixture-${Date.now()}`;
    const created = (
      await admin.post('/admin/markets/uk/terms', {
        version,
        publish: true,
        reason: 'Integration test fixture.',
      })
    ).json<{ version: { id: string } }>().version;
    await admin.post(`/admin/markets/uk/terms/${created.id}/activate`, {
      reason: 'Integration test fixture.',
    });
    termsVersion = version;

    ukSlug = `rec-uk-${Date.now()}`;
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: ukSlug,
      state: 'live',
      totalTickets: 2000,
      maxPerPerson: 10,
      ticketPriceMinor: 250,
    });
    const options = await h.sql.query<{ id: string }>(
      `SELECT o.id FROM skill_question_options o
         JOIN draws d ON d.skill_question_id = o.skill_question_id
        WHERE d.slug = $1 AND o.is_correct`,
      [ukSlug],
    );
    correctOption = options.rows[0]!.id;

    const port = h.app.get(InternalListenerService).port();
    if (port === undefined) throw new Error('the internal listener did not bind');
    internalUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await h?.close();
  });

  let ip: string;
  beforeEach(() => {
    ip = randomIp();
  });

  // ---- fixtures ------------------------------------------------------------

  async function readyToPay(quantity = 2) {
    const client = await registeredClient(h.app);
    await client.post('/markets/uk/cart/items', { slug: ukSlug, quantity });
    await client.post('/markets/uk/terms/acceptance', { version: termsVersion });
    const order = orderOf(
      await client.request(
        'POST',
        '/markets/uk/checkout/orders',
        { items: [{ slug: ukSlug, quantity, optionId: correctOption }], termsVersion },
        { 'idempotency-key': freshKey() },
      ),
    );
    const payment = paymentOf(
      await client.request(
        'POST',
        `/markets/uk/checkout/orders/${order.id}/payments`,
        {},
        { 'idempotency-key': freshKey() },
      ),
    );
    const { rows } = await h.sql.query<{ provider_reference: string }>(
      `SELECT provider_reference FROM payments WHERE id = $1`,
      [payment.id],
    );
    return { client, order, payment, reference: rows[0]!.provider_reference };
  }

  const provider = () =>
    h.app.get<ReadonlyMap<string, FakePaymentProvider>>(PAYMENT_PROVIDERS).get('fake')!;

  /** A real HTTP call to the internal socket. Never an injection. */
  async function internal(
    paymentId: string,
    headers: Record<string, string> = { [INTERNAL_TOKEN_HEADER]: DEV_PLACEHOLDER_INTERNAL_TOKEN },
  ) {
    const response = await fetch(`${internalUrl}/internal/payments/${paymentId}/reconcile`, {
      method: 'POST',
      headers,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const orderStatus = async (orderId: string) =>
    (await h.sql.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [orderId]))
      .rows[0]!.status;

  const paymentStatus = async (paymentId: string) =>
    (
      await h.sql.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [
        paymentId,
      ])
    ).rows[0]!.status;

  const auditRows = async (action: string, orderId: string) =>
    (
      await h.sql.query<{
        actor_type: string;
        actor_user_id: string | null;
        reason: string | null;
      }>(
        `SELECT actor_type, actor_user_id, reason FROM audit_log
          WHERE action = $1 AND entity_id = $2 ORDER BY occurred_at`,
        [action, orderId],
      )
    ).rows;

  /** An order settled by one attempt, plus a second attempt that also captured. */
  async function withSecondCapture() {
    const first = await readyToPay();
    provider().complete(first.reference);
    provider().takeWebhooks();
    await deliver(successBody(first.order, first.reference));

    // A second attempt of the same order, and a success for it. The order is
    // already paid, so finalisation classifies this as a second capture.
    //
    // The reference is MINTED BY THE PROVIDER through its ordinary port method,
    // not invented here, because a status check has to be able to ask about it.
    // The API cannot produce this state — a paid order refuses a new attempt,
    // and only one attempt may be live — which is precisely why it is an
    // anomaly, so the row itself goes in directly.
    const created = await provider().createPayment({
      amount: { amountMinor: first.order.totalMinor, currency: 'GBP' },
      orderReference: first.order.orderNumber,
      idempotencyKey: `second-provider-${first.order.id}`,
      returnUrl: 'http://127.0.0.1:3000/return',
      cancelUrl: 'http://127.0.0.1:3000/cancel',
    });
    const secondReference = created.providerReference;
    const { rows } = await h.sql.query<{ id: string }>(
      `INSERT INTO payments (order_id, market_id, provider, provider_reference, amount_minor,
                             currency, idempotency_key, created_at, expires_at, status)
       SELECT o.id, o.market_id, 'fake', $2, o.external_due_minor, o.currency, $3,
              now() - interval '2 seconds', now() + interval '120 seconds', 'processing'
         FROM orders o WHERE o.id = $1
       RETURNING id`,
      [first.order.id, secondReference, `second-key-${first.order.id}`],
    );
    // The provider's own copy really succeeded, so a later status check finds
    // a success rather than a reference it has never heard of.
    provider().complete(secondReference);
    provider().takeWebhooks();
    await deliver(successBody(first.order, secondReference));
    return { ...first, secondPaymentId: rows[0]!.id, secondReference };
  }

  const anomalyRows = async (orderId: string) =>
    (
      await h.sql.query<{
        actor_type: string;
        actor_user_id: string | null;
        reason: string | null;
        after: Record<string, unknown>;
      }>(
        `SELECT actor_type, actor_user_id, reason, after FROM audit_log
          WHERE action = 'payment.anomaly_detected' AND entity_id = $1
          ORDER BY occurred_at`,
        [orderId],
      )
    ).rows;

  const eventCount = async (orderId: string) =>
    (
      await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment_events e
           JOIN payments p ON p.id = e.payment_id WHERE p.order_id = $1`,
        [orderId],
      )
    ).rows[0]!.n;

  const successBody = (order: { totalMinor: number }, reference: string) => ({
    id: `rec-evt-${Date.now().toString(36)}-${eventSeq++}`,
    type: 'payment.succeeded',
    reference,
    state: 'succeeded',
    amountMinor: order.totalMinor,
    currency: 'GBP',
    occurredAt: new Date().toISOString(),
  });

  const deliver = (body: Record<string, unknown>) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return h.app.inject({
      method: 'POST',
      url: '/webhooks/payments/fake',
      remoteAddress: ip,
      headers: {
        'content-type': 'application/json',
        [FAKE_SIGNATURE_HEADER]: signWebhook('integration-test-webhook-secret', raw),
      },
      payload: raw,
    });
  };

  // ---- the listener is a separate trust boundary ---------------------------

  describe('the internal listener', () => {
    it('is not served by the public API', async () => {
      const { payment } = await readyToPay();
      // The route was never registered on the public instance, so this is a
      // fact about what exists rather than about what is filtered.
      const response = await h.app.inject({
        method: 'POST',
        url: `/internal/payments/${payment.id}/reconcile`,
        remoteAddress: ip,
        headers: { origin: 'http://127.0.0.1:3000', [INTERNAL_TOKEN_HEADER]: 'anything' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses a request with no token', async () => {
      const { payment } = await readyToPay();
      expect((await internal(payment.id, {})).status).toBe(401);
    });

    it('refuses a wrong token, and a wrong-length one, identically', async () => {
      const { payment } = await readyToPay();
      const wrongValue = await internal(payment.id, {
        [INTERNAL_TOKEN_HEADER]: 'y'.repeat(DEV_PLACEHOLDER_INTERNAL_TOKEN.length),
      });
      const wrongLength = await internal(payment.id, { [INTERNAL_TOKEN_HEADER]: 'y' });
      const missing = await internal(payment.id, {});
      // Same status, same body. Nothing distinguishes which mistake was made,
      // including how long the real secret is.
      expect(wrongValue.status).toBe(401);
      expect(wrongLength.status).toBe(401);
      expect(wrongValue.body).toEqual(wrongLength.body);
      expect(wrongValue.body).toEqual(missing.body);
    });

    it('compares tokens without leaking length through an early return', () => {
      // Both sides are hashed, so every comparison is the same 32 bytes.
      expect(
        tokenMatches('secret-value-that-is-long-enough', 'secret-value-that-is-long-enough'),
      ).toBe(true);
      expect(tokenMatches('short', 'secret-value-that-is-long-enough')).toBe(false);
      expect(tokenMatches(undefined, 'secret-value-that-is-long-enough')).toBe(false);
    });

    it('cannot be authenticated with a customer session cookie', async () => {
      const { client, payment } = await readyToPay();
      // A real, valid session for the very customer who owns this payment.
      expect(client.cookie).toBeTruthy();
      const response = await internal(payment.id, { cookie: `hv_session=${client.cookie}` });
      expect(response.status).toBe(401);
    });

    it('accepts the configured token', async () => {
      const { payment } = await readyToPay();
      expect((await internal(payment.id)).status).toBe(200);
    });

    it('rejects a payment id that is not a uuid before touching the database', async () => {
      const response = await internal('not-a-uuid');
      expect(response.status).toBe(400);
    });

    it('answers 404 for an attempt that does not exist', async () => {
      const response = await internal('00000000-0000-4000-8000-000000000000');
      expect(response.status).toBe(404);
      expect(response.body.result).toBe('unknown_payment');
    });

    it('serves only the reconcile route', async () => {
      const other = await fetch(`${internalUrl}/internal/payments`, {
        method: 'POST',
        headers: { [INTERNAL_TOKEN_HEADER]: DEV_PLACEHOLDER_INTERNAL_TOKEN },
      });
      expect(other.status).toBe(404);
      const health = await fetch(`${internalUrl}/health`, {
        headers: { [INTERNAL_TOKEN_HEADER]: DEV_PLACEHOLDER_INTERNAL_TOKEN },
      });
      expect(health.status).toBe(404);
    });
  });

  // ---- the check itself ----------------------------------------------------

  describe('the trusted status check', () => {
    it('finalises a payment the provider says succeeded', async () => {
      const { order, payment, reference } = await readyToPay();
      provider().complete(reference);

      const response = await internal(payment.id);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ result: 'checked', outcome: 'paid' });
      expect(await orderStatus(order.id)).toBe('paid');
      expect(await paymentStatus(payment.id)).toBe('succeeded');
    });

    it('does nothing at all while the customer is still at the provider', async () => {
      const { order, payment } = await readyToPay();
      const response = await internal(payment.id);
      expect(response.body).toEqual({ result: 'checked', outcome: 'refused' });
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
      expect(await paymentStatus(payment.id)).toBe('processing');
    });

    it('never marks an order paid because the provider reports a failure', async () => {
      const { order, payment, reference } = await readyToPay();
      provider().fail(reference);

      const response = await internal(payment.id);
      expect(response.body).toEqual({ result: 'checked', outcome: 'refused' });
      // The order stays payable: a failed attempt is not a failed order (K-c).
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
    });

    it('writes nothing when the provider cannot be reached', async () => {
      const { order, payment } = await readyToPay();
      const before = await paymentStatus(payment.id);

      // A second API against the SAME database, whose fake provider has never
      // heard of this attempt — which is what a restarted or unreachable
      // provider looks like from here. The reference cannot simply be rewritten
      // to something unknown: `hv_payments_guard` gives an attempt its
      // reference once and keeps it, and that is correct.
      const other = await startApp(h.database);
      try {
        const port = other.get(InternalListenerService).port()!;
        const response = await fetch(
          `http://127.0.0.1:${port}/internal/payments/${payment.id}/reconcile`,
          { method: 'POST', headers: { [INTERNAL_TOKEN_HEADER]: DEV_PLACEHOLDER_INTERNAL_TOKEN } },
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ result: 'provider_unavailable' });
      } finally {
        await other.close();
      }

      // Not the payment, not the order, not a ticket.
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
      expect(await paymentStatus(payment.id)).toBe(before);
    });

    it('does nothing for an attempt the provider never named', async () => {
      const { client, order } = await readyToPay();
      void client;
      // An attempt that failed before the provider answered has no reference,
      // so there is nothing to ask about.
      const { rows } = await h.sql.query<{ id: string }>(
        `INSERT INTO payments (order_id, market_id, provider, amount_minor, currency,
                               idempotency_key, expires_at, status)
         SELECT o.id, o.market_id, 'fake', o.external_due_minor, o.currency,
                $2, now() + interval '120 seconds', 'failed'
           FROM orders o WHERE o.id = $1
         RETURNING id`,
        [order.id, `no-reference-${order.id}`],
      );
      const response = await internal(rows[0]!.id);
      expect(response.status).toBe(200);
      expect(response.body.result).toBe('no_provider_reference');
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
    });

    it('is idempotent: ten checks of the same payment sell one set of tickets', async () => {
      const { order, payment, reference } = await readyToPay(3);
      provider().complete(reference);

      const results = await Promise.all(Array.from({ length: 10 }, () => internal(payment.id)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await orderStatus(order.id)).toBe('paid');

      const sold = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tickets t
           JOIN order_items oi ON oi.reservation_id = t.reservation_id
          WHERE oi.order_id = $1 AND t.status = 'sold'`,
        [order.id],
      );
      expect(sold.rows[0]!.n).toBe(3);
      // One order.paid, not ten.
      expect(await auditRows('order.paid', order.id)).toHaveLength(1);
      const outbox = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE topic = 'order.paid' AND payload->>'orderId' = $1`,
        [order.id],
      );
      expect(outbox.rows[0]!.n).toBe(1);
    });

    it('creates no payment_events row for a status check', async () => {
      const { order, payment, reference } = await readyToPay();
      provider().complete(reference);
      await internal(payment.id);

      // Replay protection is UNIQUE (provider, provider_event_id). Filling it
      // with rows the provider never sent would weaken the one thing that
      // makes a duplicate webhook a no-op.
      const events = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment_events e
           JOIN payments p ON p.id = e.payment_id WHERE p.order_id = $1`,
        [order.id],
      );
      expect(events.rows[0]!.n).toBe(0);
    });
  });

  // ---- the customer's own status page --------------------------------------

  describe('the customer status route', () => {
    it('reports the order, not just the attempt', async () => {
      const { client, order, payment, reference } = await readyToPay();
      // Settled by the authoritative path, which is the only thing that
      // settles anything. This test used to call `provider().complete` and
      // then rely on the GET itself to discover it; ADR-0035 took that
      // authority away, so the fact is established first and the route is
      // asked to report it.
      await deliver(successBody(order, reference));

      const response = await client.get(
        `/markets/uk/checkout/orders/${order.id}/payments/${payment.id}`,
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<{ payment: { status: string; order: { status: string } } }>();
      expect(body.payment.status).toBe('succeeded');
      // The ORDER's status travels with the attempt, which is the point of the
      // test and is unchanged: an attempt the provider called succeeded has
      // delivered nothing until the order says so.
      expect(body.payment.order.status).toBe('paid');
    });

    it('never claims an outcome the database has not established', async () => {
      const { client, order, payment } = await readyToPay();
      // The provider has not been told anything, so nothing is settled.
      const body = (
        await client.get(`/markets/uk/checkout/orders/${order.id}/payments/${payment.id}`)
      ).json<{ payment: { status: string; order: { status: string } } }>();
      expect(body.payment.status).toBe('processing');
      expect(body.payment.order.status).toBe('awaiting_payment');
    });

    it('never reveals the provider reference', async () => {
      const { client, order, payment, reference } = await readyToPay();
      const raw = (
        await client.get(`/markets/uk/checkout/orders/${order.id}/payments/${payment.id}`)
      ).body;
      expect(raw).not.toContain(reference);
    });

    it('is a 404 for somebody else, exactly as the order is', async () => {
      const { order, payment } = await readyToPay();
      const stranger = await registeredClient(h.app);
      const response = await stranger.get(
        `/markets/uk/checkout/orders/${order.id}/payments/${payment.id}`,
      );
      expect(response.statusCode).toBe(404);
    });

    it('is a 404 for an attempt of another order', async () => {
      const mine = await readyToPay();
      const theirs = await readyToPay();
      const response = await mine.client.get(
        `/markets/uk/checkout/orders/${mine.order.id}/payments/${theirs.payment.id}`,
      );
      expect(response.statusCode).toBe(404);
    });
  });

  // ---- the customer status route is a read (ADR-0035) ----------------------

  /**
   * What this block exists to prevent coming back.
   *
   * `status` used to call `reconcile` whenever the attempt was pending or
   * processing. That is an outbound call on our merchant account followed by
   * `finalization.confirm` — the same code a verified webhook reaches — so a
   * customer refreshing their own page could capture money, sell tickets,
   * release holds, raise a refund and write the outbox row that becomes an
   * email. None of that is what a GET promises, and none of it was needed:
   * the webhook and the P6-5 reconciler already advance payments.
   *
   * Every assertion here is about an absence, which is the hardest kind to
   * keep. The provider's own counter is used rather than a spy, so this holds
   * even if the call moves somewhere a spy would not be watching.
   */
  describe('the customer status route performs no provider work', () => {
    const statusUrl = (o: { id: string }, p: { id: string }) =>
      `/markets/uk/checkout/orders/${o.id}/payments/${p.id}`;

    it('asks the provider nothing, however often it is asked', async () => {
      const { client, order, payment } = await readyToPay();
      // Live, which is exactly the condition that used to trigger a check.
      expect(await paymentStatus(payment.id)).toBe('processing');

      const before = provider().statusCheckCount;
      for (let i = 0; i < 5; i++) {
        expect((await client.get(statusUrl(order, payment))).statusCode).toBe(200);
      }
      expect(provider().statusCheckCount).toBe(before);
    });

    it('does not settle an order the provider has already succeeded', async () => {
      const { client, order, payment, reference } = await readyToPay();
      // The money is taken and the webhook has not arrived. This is the window
      // a customer refreshes in, and the window in which the old behaviour
      // finalised the order from a GET.
      provider().complete(reference);
      provider().takeWebhooks('withheld');

      const beforeAudits = (
        await h.sql.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`,
          [order.id],
        )
      ).rows[0]!.n;
      // Every outbox row in this database, not only this order's: a read has
      // no business writing any of them, and an unfiltered count cannot be
      // fooled by a payload shape changing.
      const outboxRows = async () =>
        (await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox`)).rows[0]!.n;
      const beforeOutbox = await outboxRows();
      const beforePayment = (
        await h.sql.query<{ status: string; updated_at: Date; provider_reference: string }>(
          `SELECT status, updated_at, provider_reference FROM payments WHERE id = $1`,
          [payment.id],
        )
      ).rows[0];

      for (let i = 0; i < 5; i++) {
        const body = (await client.get(statusUrl(order, payment))).json<{
          payment: { status: string; order: { status: string } };
        }>();
        // It reports the database's answer, not the provider's.
        expect(body.payment.status).toBe('processing');
        expect(body.payment.order.status).toBe('awaiting_payment');
      }

      // The order did not move.
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
      // The payment row is byte-identical, updated_at included.
      expect(
        (
          await h.sql.query<{ status: string; updated_at: Date; provider_reference: string }>(
            `SELECT status, updated_at, provider_reference FROM payments WHERE id = $1`,
            [payment.id],
          )
        ).rows[0],
      ).toEqual(beforePayment);
      // No ticket sold, and none released either.
      const tickets = await h.sql.query<{ status: string; n: number }>(
        `SELECT t.status, count(*)::int AS n FROM tickets t
           JOIN order_items oi ON oi.reservation_id = t.reservation_id
          WHERE oi.order_id = $1 GROUP BY t.status`,
        [order.id],
      );
      expect(tickets.rows.map((r) => r.status).sort()).toEqual(['reserved']);
      // No refund, no audit record, no outbox event.
      expect(
        (
          await h.sql.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM refunds WHERE order_id = $1`,
            [order.id],
          )
        ).rows[0]!.n,
      ).toBe(0);
      expect(
        (
          await h.sql.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`,
            [order.id],
          )
        ).rows[0]!.n,
      ).toBe(beforeAudits);
      expect(await outboxRows()).toBe(beforeOutbox);
    });

    it('still lets the webhook settle the very same payment afterwards', async () => {
      const { client, order, payment, reference } = await readyToPay();
      provider().complete(reference);
      provider().takeWebhooks('withheld');
      for (let i = 0; i < 3; i++) await client.get(statusUrl(order, payment));
      expect(await orderStatus(order.id)).toBe('awaiting_payment');

      // Nothing the reads did gets in the authoritative path's way.
      await deliver(successBody(order, reference));
      expect(await orderStatus(order.id)).toBe('paid');
      expect(await paymentStatus(payment.id)).toBe('succeeded');

      const body = (await client.get(statusUrl(order, payment))).json<{
        payment: { status: string; order: { status: string } };
      }>();
      expect(body.payment.status).toBe('succeeded');
      expect(body.payment.order.status).toBe('paid');
    });

    it('still lets the scheduled reconciliation settle it', async () => {
      const { client, order, payment, reference } = await readyToPay();
      provider().complete(reference);
      provider().takeWebhooks('withheld');
      for (let i = 0; i < 3; i++) await client.get(statusUrl(order, payment));
      expect(await orderStatus(order.id)).toBe('awaiting_payment');

      // The other authoritative path, reached the way the worker reaches it.
      expect((await internal(payment.id)).status).toBe(200);
      expect(await orderStatus(order.id)).toBe('paid');
    });
  });

  // ---- D-1: the status route's provider-call budget ------------------------

  describe('the status route is rate limited (B19 endpoint abuse)', () => {
    it('refuses one owner once they are over the limit, and stops asking the provider', async () => {
      const { client, order, payment } = await readyToPay();
      const limit = RATE_LIMITS.paymentStatusPerOwner.limit;
      const url = `/markets/uk/checkout/orders/${order.id}/payments/${payment.id}`;

      // Watching from the FIRST call, not only from the one that is refused.
      // The old version installed the spy after the loop, so it could only say
      // that a 429 stops short of the provider. Since ADR-0035 the stronger
      // statement is available and worth making: none of the calls reaches the
      // provider, whether they are allowed or refused.
      const watch = vi.spyOn(provider(), 'getPaymentStatus');
      try {
        for (let i = 0; i < limit; i++) expect((await client.get(url)).statusCode).toBe(200);
        expect(watch, 'an allowed read must not reach the provider').not.toHaveBeenCalled();

        const over = await client.get(url);
        expect(over.statusCode).toBe(429);
        expect(errorCode(over)).toBe('RATE_LIMITED');
        expect(over.headers['retry-after']).toBeDefined();

        // The limiter still runs before ownership and before the row is read,
        // which is what fail-closed depends on.
        expect(watch).not.toHaveBeenCalled();
      } finally {
        watch.mockRestore();
      }
    });

    it('gives each owner its own bucket', async () => {
      const first = await readyToPay();
      const second = await readyToPay();
      const limit = RATE_LIMITS.paymentStatusPerOwner.limit;
      const url = (o: { id: string }, p: { id: string }) =>
        `/markets/uk/checkout/orders/${o.id}/payments/${p.id}`;

      for (let i = 0; i <= limit; i++) await first.client.get(url(first.order, first.payment));
      expect((await first.client.get(url(first.order, first.payment))).statusCode).toBe(429);

      // Unaffected. One customer cannot spend another's allowance, and so
      // cannot spend the provider budget on their behalf either.
      expect((await second.client.get(url(second.order, second.payment))).statusCode).toBe(200);
    });

    it('fails closed when the rate limiter is unreachable', async () => {
      const { client, order, payment } = await readyToPay();
      const redis = h.app.get<Redis>(REDIS);
      const real = redis.multi.bind(redis);
      // A Redis outage must refuse the read rather than leave the provider
      // budget unguarded — the same fail-closed rule initiation follows.
      (redis as unknown as { multi: unknown }).multi = () => {
        throw new Error('redis is down');
      };
      try {
        const response = await client.get(
          `/markets/uk/checkout/orders/${order.id}/payments/${payment.id}`,
        );
        expect(response.statusCode).toBe(503);
        expect(errorCode(response)).toBe('SERVICE_UNAVAILABLE');
      } finally {
        (redis as unknown as { multi: unknown }).multi = real;
      }
    });
  });

  // ---- D-2: anomalies found by reconciliation are durable ------------------

  describe('reconciliation records what it finds', () => {
    it('audits a second capture the worker path discovers', async () => {
      const { order, secondPaymentId } = await withSecondCapture();

      // The worker's route in: the internal listener, no human actor.
      expect((await internal(secondPaymentId)).status).toBe(200);

      const rows = await anomalyRows(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_type).toBe('system');
      expect(rows[0]!.actor_user_id).toBeNull();
      expect(rows[0]!.reason).toBe('second_capture');
      expect(rows[0]!.after).toMatchObject({
        paymentId: secondPaymentId,
        orderId: order.id,
        provider: 'fake',
        outcome: 'second_capture',
        source: 'reconciliation',
      });
    });

    it('audits a capture with no settlement the worker path discovers', async () => {
      const { order, payment, reference } = await readyToPay();
      await h.sql.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
      provider().complete(reference);

      expect((await internal(payment.id)).status).toBe(200);

      const rows = await anomalyRows(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe('capture_without_settlement');
      expect(rows[0]!.after).toMatchObject({ outcome: 'capture_without_settlement' });
      // K-3 is untouched: the cancelled order did not move.
      expect(await orderStatus(order.id)).toBe('cancelled');
    });

    it('is not discovered by the customer status route, which no longer looks', async () => {
      const { client, order, secondPaymentId } = await withSecondCapture();
      // This used to assert the opposite: a customer refreshing their own page
      // was how a second capture got found, and the row was written with
      // actor 'system' because no human had looked. ADR-0035 ends that. The
      // route answers, and finds nothing, because it asks nobody.
      const response = await client.get(
        `/markets/uk/checkout/orders/${order.id}/payments/${secondPaymentId}`,
      );
      expect(response.statusCode).toBe(200);
      expect(await anomalyRows(order.id)).toHaveLength(0);

      // The anomaly is still found, by the path that is supposed to find it.
      // Nothing is lost by the route not looking — it is only found later, by
      // a scheduled check rather than by whoever happened to refresh.
      expect((await internal(secondPaymentId)).status).toBe(200);
      const rows = await anomalyRows(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_type).toBe('system');
    });

    it('does not restate the same anomaly on every look', async () => {
      const { order, secondPaymentId } = await withSecondCapture();
      for (let i = 0; i < 5; i++) await internal(secondPaymentId);
      // One record per payment per anomaly. The worklist keeps a stuck attempt
      // in scope for five minutes, and a fact that has not changed is not news.
      expect(await anomalyRows(order.id)).toHaveLength(1);
    });

    it('creates no payment_event for a reconciliation-only discovery', async () => {
      const { order, secondPaymentId } = await withSecondCapture();
      const before = await eventCount(order.id);
      await internal(secondPaymentId);
      // Replay protection is UNIQUE (provider, provider_event_id); a row the
      // provider never sent would weaken it.
      expect(await eventCount(order.id)).toBe(before);
    });

    it('leaves the flagged webhook event unprocessed', async () => {
      const { order, secondPaymentId } = await withSecondCapture();
      await internal(secondPaymentId);
      const { rows } = await h.sql.query<{ processed_at: Date | null }>(
        `SELECT e.processed_at FROM payment_events e
           JOIN payments p ON p.id = e.payment_id
          WHERE p.order_id = $1 AND e.last_error = 'second_capture'`,
        [order.id],
      );
      // Auditing that something is owed is not the same as dealing with it.
      expect(rows[0]!.processed_at).toBeNull();
    });

    it('keeps the admin actor record, and adds the anomaly once', async () => {
      const { order, secondPaymentId } = await withSecondCapture();
      const response = await finance.post(
        `/admin/markets/uk/orders/${order.id}/payments/${secondPaymentId}/reconcile`,
        REASON,
      );
      expect(response.statusCode).toBe(200);

      // Two different facts: a person asked, and something is wrong.
      const asked = await auditRows('payment.reconciled', order.id);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.actor_type).toBe('user');
      expect(asked[0]!.actor_user_id).not.toBeNull();

      const anomalies = await anomalyRows(order.id);
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]!.actor_type).toBe('system');

      // Asking again adds another request record and no second anomaly.
      await finance.post(
        `/admin/markets/uk/orders/${order.id}/payments/${secondPaymentId}/reconcile`,
        REASON,
      );
      expect(await auditRows('payment.reconciled', order.id)).toHaveLength(2);
      expect(await anomalyRows(order.id)).toHaveLength(1);
    });

    it('writes no anomaly for an ordinary check that finds nothing', async () => {
      const { order, payment } = await readyToPay();
      await internal(payment.id);
      expect(await anomalyRows(order.id)).toHaveLength(0);
    });
  });

  // ---- staff surfaces ------------------------------------------------------

  describe('the staff view', () => {
    it('is open to any role holding orders.read', async () => {
      const { order } = await readyToPay();
      const response = await support.get(`/admin/markets/uk/orders/${order.id}/payments`);
      expect(response.statusCode).toBe(200);
      const body = response.json<{ attempts: unknown[] }>();
      expect(body.attempts).toHaveLength(1);
    });

    it('shows no provider reference and no sealed payload', async () => {
      const { order, reference } = await readyToPay();
      const raw = (await admin.get(`/admin/markets/uk/orders/${order.id}/payments`)).body;
      expect(raw).not.toContain(reference);
      expect(raw).not.toContain('payload_sealed');
      expect(raw).not.toContain('payloadBase64');
    });

    it('refuses an order of another market', async () => {
      const { order } = await readyToPay();
      const response = await admin.get(`/admin/markets/ie/orders/${order.id}/payments`);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('the staff reconcile action', () => {
    it('is refused to a role holding only orders.read', async () => {
      const { order, payment } = await readyToPay();
      const response = await support.post(
        `/admin/markets/uk/orders/${order.id}/payments/${payment.id}/reconcile`,
        REASON,
      );
      expect(errorCode(response)).toBe('FORBIDDEN');
    });

    it('requires fresh step-up MFA', async () => {
      const { order, payment } = await readyToPay();
      const noMfa = await registeredClient(h.app, uniqueEmail('rec-nomfa'));
      await grantRole(h.sql, noMfa.email, 'finance');
      const response = await noMfa.post(
        `/admin/markets/uk/orders/${order.id}/payments/${payment.id}/reconcile`,
        REASON,
      );
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('STEP_UP_REQUIRED');
    });

    it('requires a reason', async () => {
      const { order, payment } = await readyToPay();
      for (const body of [{}, { reason: '' }, { reason: ' ' }]) {
        const response = await finance.post(
          `/admin/markets/uk/orders/${order.id}/payments/${payment.id}/reconcile`,
          body,
        );
        expect(response.statusCode).toBe(400);
      }
    });

    it('reaches the same finalisation, and audits who asked', async () => {
      const { order, payment, reference } = await readyToPay();
      provider().complete(reference);

      const response = await finance.post(
        `/admin/markets/uk/orders/${order.id}/payments/${payment.id}/reconcile`,
        REASON,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ result: 'checked', outcome: 'paid' });
      expect(await orderStatus(order.id)).toBe('paid');

      const audits = await auditRows('payment.reconciled', order.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actor_type).toBe('user');
      expect(audits[0]!.actor_user_id).not.toBeNull();
      expect(audits[0]!.reason).toBe(REASON.reason);
    });

    it('audits a check that changed nothing, because asking is itself a fact', async () => {
      const { order, payment } = await readyToPay();
      await finance.post(
        `/admin/markets/uk/orders/${order.id}/payments/${payment.id}/reconcile`,
        REASON,
      );
      expect(await auditRows('payment.reconciled', order.id)).toHaveLength(1);
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
    });

    it('cannot reach an order through the wrong market', async () => {
      const { order, payment, reference } = await readyToPay();
      provider().complete(reference);
      const response = await admin.post(
        `/admin/markets/ie/orders/${order.id}/payments/${payment.id}/reconcile`,
        REASON,
      );
      expect(response.statusCode).toBe(404);
      // And nothing happened to the order it could not reach.
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
    });

    it('cannot reconcile a payment belonging to a different order', async () => {
      const mine = await readyToPay();
      const theirs = await readyToPay();
      const response = await admin.post(
        `/admin/markets/uk/orders/${mine.order.id}/payments/${theirs.payment.id}/reconcile`,
        REASON,
      );
      expect(response.statusCode).toBe(404);
    });
  });
});
