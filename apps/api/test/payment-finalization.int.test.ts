/**
 * Payment finalisation and Gate 4, against real PostgreSQL (migration 0022,
 * task P6-4).
 *
 * This is where money becomes inventory, and the file is mostly about what must
 * be true at the moment that happens and what must never be half-done. The
 * half-states are all unacceptable: an order paid whose tickets are not sold,
 * tickets sold on an order that is not paid, a partial sale, either without the
 * audit entry, or an announcement committed without the change it announces.
 *
 * Several tests attack the invariants in raw SQL with the application bypassed.
 * An invariant only reachable through the happy path was never one.
 *
 * **On the racing tests, precisely.** They fire ten deliveries with
 * `Promise.all` through `app.inject`, which is how Gates 1 and 2 are written
 * too — no test under `apps/api/test` uses the `createBarrier` helper, and this
 * file opens no dedicated connections. So they prove the FINAL-STATE invariant
 * — one transition, one sale, one audit row, one outbox row — and they would
 * reach that same state if the deliveries ran one after another. They do not,
 * on their own, prove contention. Making them prove it means a barrier and N
 * connections, which §15 asks for and this file does not yet do.
 */
import { ErrorResponseSchema, OrderResponseSchema, PaymentResponseSchema } from '@hv/contracts';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import { ORDER_OUTCOME_TOPICS } from '@hv/domain';
import { FAKE_SIGNATURE_HEADER, signWebhook, type FakePaymentProvider } from '@hv/payments';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAYMENT_PROVIDERS } from '../src/payments/payment-provider.factory';
import { RefundsService } from '../src/payments/refunds.service';
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

const KEY = 'a1'.repeat(16) + 'b2'.repeat(16);
const WEBHOOK_SECRET = 'integration-test-webhook-secret';

const orderOf = (r: { json: () => unknown }) => OrderResponseSchema.parse(r.json()).order;
const paymentOf = (r: { json: () => unknown }) => PaymentResponseSchema.parse(r.json()).payment;
const errorCode = (r: { json: () => unknown }) => ErrorResponseSchema.parse(r.json()).error.code;

let keyCounter = 0;
const freshKey = () => `fin-${Date.now().toString(36)}-${keyCounter++}-aaaaaaaa`;
let eventCounter = 0;
const freshEventId = () => `fin-evt-${Date.now().toString(36)}-${eventCounter++}`;

describe('finalising a payment', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let ukSlug: string;
  let termsVersion: string;
  let correctOption: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);

    admin = await registeredClient(h.app, uniqueEmail('fin-admin'));
    await grantRole(h.sql, admin.email, 'super_admin');
    await enrolMfa(admin);

    const version = `fin-fixture-${Date.now()}`;
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

    ukSlug = `fin-uk-${Date.now()}`;
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
  });

  afterAll(async () => {
    await h?.close();
  });

  let ip: string;
  beforeEach(() => {
    ip = randomIp();
  });

  // ---- fixtures ------------------------------------------------------------

  /** A customer, an order, and a live payment attempt ready to be confirmed. */
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
    const reservations = await h.sql.query<{ reservation_id: string }>(
      `SELECT reservation_id FROM order_items WHERE order_id = $1`,
      [order.id],
    );
    return {
      client,
      order,
      payment,
      reference: rows[0]!.provider_reference,
      reservationIds: reservations.rows.map((r) => r.reservation_id),
    };
  }

  /**
   * A signed success for this attempt.
   *
   * The amount comes from the ORDER, so it cannot disagree by accident. An
   * earlier version hardcoded a two-ticket total, and every test with a
   * different quantity was quietly asserting against an amount mismatch
   * instead of a success.
   */
  function successBody(
    order: { totalMinor: number },
    reference: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: freshEventId(),
      type: 'payment.succeeded',
      reference,
      state: 'succeeded',
      amountMinor: order.totalMinor,
      currency: 'GBP',
      occurredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  const deliver = (body: Record<string, unknown>) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return h.app.inject({
      method: 'POST',
      url: '/webhooks/payments/fake',
      remoteAddress: ip,
      headers: {
        'content-type': 'application/json',
        [FAKE_SIGNATURE_HEADER]: signWebhook(WEBHOOK_SECRET, raw),
      },
      payload: raw,
    });
  };

  const orderRow = async (orderId: string) =>
    (
      await h.sql.query<{ status: string; expires_at: Date }>(
        `SELECT status, expires_at FROM orders WHERE id = $1`,
        [orderId],
      )
    ).rows[0]!;

  const paymentStatus = async (paymentId: string) =>
    (
      await h.sql.query<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [
        paymentId,
      ])
    ).rows[0]!.status;

  const reservationRow = async (id: string) =>
    (
      await h.sql.query<{ status: string; ended_at: Date | null }>(
        `SELECT status, ended_at FROM reservations WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  const ticketStatuses = async (reservationId: string) =>
    (
      await h.sql.query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM tickets WHERE reservation_id = $1 GROUP BY status`,
        [reservationId],
      )
    ).rows;

  const auditRows = async (orderId: string) =>
    (
      await h.sql.query<{ action: string; actor_type: string; before: unknown; after: unknown }>(
        `SELECT action, actor_type, before, after FROM audit_log
          WHERE entity_type = 'order' AND entity_id = $1 ORDER BY occurred_at`,
        [orderId],
      )
    ).rows;

  const outboxRows = async (orderId: string) =>
    (
      await h.sql.query<{ topic: string; payload: { orderId?: string } }>(
        `SELECT topic, payload FROM outbox WHERE payload->>'orderId' = $1`,
        [orderId],
      )
    ).rows;

  /**
   * The refund service as the running app has it.
   *
   * D22.3 is an invoked action, not something a provider message triggers, so
   * it is exercised the way reconciliation will call it — through the real
   * container, with the real provider wired in.
   */
  const refundsService = () => h.app.get(RefundsService);

  /**
   * Tells the provider the customer finished paying.
   *
   * The fake keeps its own view of every payment, and it will not refund one it
   * never saw succeed — which is exactly what a real provider does. Most tests
   * here hand-craft a signed event without driving the provider, so its view
   * stays `pending`; any test that needs the refund actually sent has to say so.
   */
  const completeAtProvider = (providerReference: string) => {
    const provider = h.app
      .get<ReadonlyMap<string, FakePaymentProvider>>(PAYMENT_PROVIDERS)
      .get('fake')!;
    provider.complete(providerReference);
    // The provider's own queued webhook is discarded: these tests deliver their
    // own bodies, and leaving it queued would leak into a later `takeWebhooks`.
    provider.takeWebhooks();
  };

  const refundRows = async (orderId: string) =>
    (
      await h.sql.query<{
        id: string;
        payment_id: string | null;
        amount_minor: string;
        currency: string;
        destination: string;
        status: string;
        reason: string;
        actor_id: string | null;
        idempotency_key: string;
        provider_refund_reference: string | null;
      }>(
        `SELECT id, payment_id, amount_minor, currency, destination, status, reason, actor_id,
                idempotency_key, provider_refund_reference
           FROM refunds WHERE order_id = $1 ORDER BY created_at`,
        [orderId],
      )
    ).rows;

  const capCount = async (reservationId: string) =>
    Number(
      (
        await h.sql.query<{ count: number }>(
          `SELECT c.count FROM draw_entrant_counts c
             JOIN reservations r
               ON r.draw_id = c.draw_id
              AND r.entrant_type = c.entrant_type
              AND r.entrant_ref = c.entrant_ref
            WHERE r.id = $1`,
          [reservationId],
        )
      ).rows[0]?.count ?? 0,
    );

  // ---- the successful path -------------------------------------------------

  describe('a confirmed payment', () => {
    it('pays the order, sells the tickets and closes the hold', async () => {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      const response = await deliver(successBody(order, reference));
      expect(response.statusCode).toBe(200);

      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await paymentStatus(payment.id)).toBe('succeeded');

      for (const id of reservationIds) {
        // D9 = A: closed as released, and no new reservation status was
        // invented for this.
        const reservation = await reservationRow(id);
        expect(reservation.status).toBe('released');
        expect(reservation.ended_at).not.toBeNull();
        // Every ticket sold, none left reserved or handed back.
        expect(await ticketStatuses(id)).toEqual([{ status: 'sold', n: 2 }]);
      }
    });

    it('keeps the cap consumed, because the tickets were bought', async () => {
      const { order, reference, reservationIds } = await readyToPay(3);
      const before = await capCount(reservationIds[0]!);
      expect(before).toBe(3);

      await deliver(successBody(order, reference));

      // The NB-1 invariant from 0010: closing a hold whose tickets are sold
      // frees nothing and returns no allowance, so a buyer cannot buy their cap
      // and then buy it again.
      expect(await capCount(reservationIds[0]!)).toBe(3);
    });

    it('writes one audit entry, by the system, with the transition', async () => {
      const { order, reference } = await readyToPay(1);
      await deliver(successBody(order, reference));

      const audit = await auditRows(order.id);
      const paid = audit.filter((row) => row.action === 'order.paid');
      expect(paid).toHaveLength(1);
      // No human did this: a provider said something and the system acted.
      expect(paid[0]!.actor_type).toBe('system');
      expect(paid[0]!.before).toEqual({ status: 'awaiting_payment' });
      expect(paid[0]!.after).toEqual({ status: 'paid' });
    });

    it('announces it once, on a locked topic, with nothing sensitive in it', async () => {
      const { order, reference } = await readyToPay(1);
      await deliver(successBody(order, reference));

      const rows = await outboxRows(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.topic).toBe('order.paid');
      expect(ORDER_OUTCOME_TOPICS).toContain(rows[0]!.topic);
      // The order row holds what is needed; this is a notification.
      const payload = JSON.stringify(rows[0]!.payload);
      expect(payload).not.toContain(reference);
      expect(payload).toContain(order.orderNumber);
    });

    it('settles the provider event in the same breath', async () => {
      const { order, reference } = await readyToPay(1);
      const body = successBody(order, reference);
      await deliver(body);

      const { rows } = await h.sql.query<{ processed_at: Date | null; last_error: string | null }>(
        `SELECT processed_at, last_error FROM payment_events WHERE provider_event_id = $1`,
        [body.id],
      );
      expect(rows[0]!.processed_at).not.toBeNull();
      expect(rows[0]!.last_error).toBeNull();
    });
  });

  // ---- idempotency ---------------------------------------------------------

  describe('doing it twice', () => {
    it('sells the tickets once when the same event arrives again', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      const body = successBody(order, reference);

      await deliver(body);
      await deliver(body);
      await deliver(body);

      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);
      expect(
        await auditRows(order.id).then((r) => r.filter((x) => x.action === 'order.paid')),
      ).toHaveLength(1);
      expect(await outboxRows(order.id)).toHaveLength(1);
    });

    it('does nothing for a second, different success event on a paid order', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      await deliver(successBody(order, reference));

      // A different event id, so replay protection does not answer — the order's
      // status does.
      await deliver(successBody(order, reference));

      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);
      expect(
        await auditRows(order.id).then((r) => r.filter((x) => x.action === 'order.paid')),
      ).toHaveLength(1);
      expect(await outboxRows(order.id)).toHaveLength(1);
    });

    it('sells exactly once when ten deliveries of one event race', async () => {
      // Gate 4: the same webhook ten times in parallel produces one payment
      // transition and one ticket sale.
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      const body = successBody(order, reference);

      const results = await Promise.all(Array.from({ length: 10 }, () => deliver(body)));
      for (const response of results) expect(response.statusCode).toBe(200);

      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await paymentStatus(payment.id)).toBe('succeeded');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);
      expect(
        await auditRows(order.id).then((r) => r.filter((x) => x.action === 'order.paid')),
      ).toHaveLength(1);
      expect(await outboxRows(order.id)).toHaveLength(1);
    });

    it('sells exactly once when ten DIFFERENT success events race', async () => {
      // Harder than the above: replay protection cannot help, because every
      // event id is new. The order lock and the conditional transition are what
      // must hold.
      const { order, reference, reservationIds } = await readyToPay(2);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => deliver(successBody(order, reference))),
      );
      for (const response of results) expect(response.statusCode).toBe(200);

      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);
      const paid = (await auditRows(order.id)).filter((x) => x.action === 'order.paid');
      expect(paid).toHaveLength(1);
      expect(await outboxRows(order.id)).toHaveLength(1);
      // And exactly one succeeded payment exists for the order, structurally.
      const succeeded = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payments WHERE order_id = $1 AND status = 'succeeded'`,
        [order.id],
      );
      expect(succeeded.rows[0]!.n).toBe(1);
    });

    it('handles out-of-order delivery: success then failure leaves it paid', async () => {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      await deliver(successBody(order, reference));
      // A late failure must never un-sell anything. Success is terminal.
      await deliver(successBody(order, reference, { state: 'failed', type: 'payment.failed' }));

      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await paymentStatus(payment.id)).toBe('succeeded');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);
    });

    it('handles out-of-order delivery: failure then success pays it', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      // A failure event asks for nothing to be done; the order stays payable.
      await deliver(successBody(order, reference, { state: 'failed', type: 'payment.failed' }));
      expect((await orderRow(order.id)).status).toBe('awaiting_payment');

      await deliver(successBody(order, reference));
      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);
    });
  });

  // ---- what must never finalise -------------------------------------------

  describe('confirmations that must not finalise', () => {
    it('refuses a failed provider status outright', async () => {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      await deliver(successBody(order, reference, { state: 'failed', type: 'payment.failed' }));

      // The worst defect this code could have would be treating this as a
      // success. The order is untouched and no ticket moved.
      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
      expect(await paymentStatus(payment.id)).toBe('processing');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'reserved', n: 2 }]);
      expect(await outboxRows(order.id)).toHaveLength(0);
    });

    it('refuses an amount that is not the order’s', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      const body = successBody(order, reference, { amountMinor: 499 });
      await deliver(body);

      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'reserved', n: 2 }]);
      const { rows } = await h.sql.query<{ last_error: string | null }>(
        `SELECT last_error FROM payment_events WHERE provider_event_id = $1`,
        [body.id],
      );
      expect(rows[0]!.last_error).toBe('amount_mismatch');
    });

    it('refuses a currency that is not the order’s', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      const body = successBody(order, reference, { currency: 'EUR' });
      await deliver(body);

      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'reserved', n: 2 }]);
      const { rows } = await h.sql.query<{ last_error: string | null }>(
        `SELECT last_error FROM payment_events WHERE provider_event_id = $1`,
        [body.id],
      );
      expect(rows[0]!.last_error).toBe('currency_mismatch');
    });

    it('D21: an expired attempt with a LIVE hold is unfulfillable and refunded', async () => {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      // The customer clicked Pay again, so this attempt timed out, and then the
      // provider confirmed it anyway. The tickets are still here — and they are
      // not going to this customer, because the payment that would have bought
      // them is one we had already given up on (D21).
      await h.sql.query(`UPDATE payments SET status = 'expired' WHERE id = $1`, [payment.id]);

      // Stated explicitly: a LIVE hold is the whole difference between this case
      // and the one below it.
      expect((await reservationRow(reservationIds[0]!)).status).toBe('active');
      const capBefore = await capCount(reservationIds[0]!);
      expect(capBefore).toBe(2);

      await deliver(successBody(order, reference));

      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
      // The terminal attempt is NOT resurrected.
      expect(await paymentStatus(payment.id)).toBe('expired');
      // The tickets go back to the pool, and the cap allowance with them: this
      // customer bought nothing.
      expect((await reservationRow(reservationIds[0]!)).status).toBe('released');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([]);
      expect(await capCount(reservationIds[0]!)).toBe(0);

      // Refunded in full, to the instrument the money came from.
      const refunds = await refundRows(order.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.reason).toBe('unfulfillable');
      expect(refunds[0]!.destination).toBe('provider');
      expect(refunds[0]!.payment_id).toBe(payment.id);
      expect(refunds[0]!.actor_id).toBeNull();
      expect(Number(refunds[0]!.amount_minor)).toBe(order.totalMinor);

      const outbox = await outboxRows(order.id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.topic).toBe('order.unfulfillable');
      expect(
        (await auditRows(order.id)).filter((r) => r.action === 'order.paid_unfulfillable'),
      ).toHaveLength(1);
    });

    it('D21: a duplicate late-success delivery refunds once', async () => {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`UPDATE payments SET status = 'expired' WHERE id = $1`, [payment.id]);

      // Three separate event ids, so replay protection cannot answer and the
      // idempotency of the decision itself has to.
      await deliver(successBody(order, reference));
      await deliver(successBody(order, reference));
      await deliver(successBody(order, reference));

      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
      expect(await refundRows(order.id)).toHaveLength(1);
      expect(await outboxRows(order.id)).toHaveLength(1);
      expect(
        (await auditRows(order.id)).filter((r) => r.action === 'order.paid_unfulfillable'),
      ).toHaveLength(1);
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([]);
    });

    it('reaches the unfulfillable path when the hold is gone AND the attempt expired', async () => {
      // The correction. Both things are wrong at once: the tickets have gone and
      // the attempt had already been given up on.
      //
      // Whether the tickets can still be delivered is a fact about the world;
      // whether our attempt row is live is a fact about our bookkeeping. Asking
      // the bookkeeping question first reported this as `attempt_not_live` and
      // never reached the `paid_unfulfillable` outcome B10 already defines for
      // it — so the order sat `awaiting_payment` with the money taken and the
      // tickets gone, and nothing downstream knew.
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`SELECT hv_end_reservation($1::uuid, 'expired')`, [reservationIds[0]!]);
      await h.sql.query(`UPDATE payments SET status = 'expired' WHERE id = $1`, [payment.id]);

      const body = successBody(order, reference);
      await deliver(body);

      // The order now records the truth: paid, and not deliverable.
      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
      const outbox = await outboxRows(order.id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.topic).toBe('order.unfulfillable');
      const audit = (await auditRows(order.id)).filter(
        (r) => r.action === 'order.paid_unfulfillable',
      );
      expect(audit).toHaveLength(1);

      // The attempt itself stays terminal: `hv_payments_guard` refuses to
      // revive it, and the conditional update leaves it alone rather than
      // failing the transaction. The ORDER carries the outcome, which is what
      // the customer and the refund both need.
      expect(await paymentStatus(payment.id)).toBe('expired');

      // The event was handled, so it carries no error — `last_error` says why
      // something could NOT be done, and an unfulfillable outcome is a decision
      // rather than a failure. Why it could not be fulfilled is on the audit
      // row, which is where an operator would look.
      const { rows } = await h.sql.query<{ processed_at: Date | null; last_error: string | null }>(
        `SELECT processed_at, last_error FROM payment_events WHERE provider_event_id = $1`,
        [body.id],
      );
      expect(rows[0]!.processed_at).not.toBeNull();
      expect(rows[0]!.last_error).toBeNull();

      const reasons = await h.sql.query<{ reason: string | null }>(
        `SELECT reason FROM audit_log
          WHERE entity_id = $1 AND action = 'order.paid_unfulfillable'`,
        [order.id],
      );
      expect(reasons.rows[0]!.reason).toBe('reservation_ended');
    });

    it('reaches the unfulfillable path for a released hold with a live attempt', async () => {
      // The same outcome by the other route, so the correction did not make
      // fulfillability depend on the attempt in the opposite direction either.
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`SELECT hv_end_reservation($1::uuid, 'released')`, [reservationIds[0]!]);

      await deliver(successBody(order, reference));

      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
      // A live attempt CAN carry the money, so here it does.
      expect(await paymentStatus(payment.id)).toBe('succeeded');
    });

    it('does nothing to an order that is already paid', async () => {
      const { order, reference } = await readyToPay(1);
      await deliver(successBody(order, reference));
      expect((await orderRow(order.id)).status).toBe('paid');

      const before = await auditRows(order.id);
      await deliver(successBody(order, reference));
      expect(await auditRows(order.id)).toHaveLength(before.length);
    });

    it('does nothing to an order that was cancelled', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);

      await deliver(successBody(order, reference));
      expect((await orderRow(order.id)).status).toBe('cancelled');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'reserved', n: 2 }]);
    });
  });

  // ---- the hold has to be live (I9, I19, D10 = B) --------------------------

  describe('the hold has to be live', () => {
    it('becomes unfulfillable when the hold has already been swept', async () => {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      // The sweep got there first: the tickets are back in the pool.
      await h.sql.query(`SELECT hv_end_reservation($1::uuid, 'expired')`, [reservationIds[0]!]);

      await deliver(successBody(order, reference));

      // The money is real and the tickets are gone. The order says exactly
      // that, and no new status was invented for it.
      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
      expect(await paymentStatus(payment.id)).toBe('succeeded');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([]);

      const audit = (await auditRows(order.id)).filter(
        (r) => r.action === 'order.paid_unfulfillable',
      );
      expect(audit).toHaveLength(1);
      const outbox = await outboxRows(order.id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.topic).toBe('order.unfulfillable');
    });

    it('raises exactly one full refund to the original instrument', async () => {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`SELECT hv_end_reservation($1::uuid, 'expired')`, [reservationIds[0]!]);
      await deliver(successBody(order, reference));
      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');

      // The three properties that together say "the system sent this person's
      // money back the way it arrived" (D15a, D15b).
      const refunds = await refundRows(order.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.destination).toBe('provider');
      expect(refunds[0]!.payment_id).toBe(payment.id);
      expect(refunds[0]!.actor_id).toBeNull();
      expect(Number(refunds[0]!.amount_minor)).toBe(order.totalMinor);
      // Derived from the order, so it can only ever be raised once.
      expect(refunds[0]!.idempotency_key).toBe(`refund:order:${order.id}:unfulfillable`);
    });

    it('refuses the sale in the database when the hold has expired but not been swept', async () => {
      // D10 = B, attacked with the application bypassed, in the exact state
      // that makes the guard necessary: expiry is logical, so for up to thirty
      // seconds the row still says `active` while the hold is dead.
      //
      // The hold is made genuinely short-lived rather than edited into the
      // past, because a reservation's terms — including its expiry — are
      // immutable by trigger. Nothing sweeps it: the expiry worker does not
      // run in these tests, and the API sweeps a draw only when it allocates
      // on it, which is why this uses a draw of its own.
      const slug = `fin-brief-${Date.now()}`;
      await insertFixtureDraw(h.sql, {
        market: 'uk',
        slug,
        state: 'live',
        totalTickets: 50,
        maxPerPerson: 10,
        ticketPriceMinor: 250,
      });
      const brief = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        RESERVATION_TTL_SECONDS: '2',
      });
      try {
        const client = await registeredClient(brief);
        await client.post('/markets/uk/cart/items', { slug, quantity: 2 });
        const { rows } = await h.sql.query<{ id: string }>(
          `SELECT r.id FROM reservations r JOIN draws d ON d.id = r.draw_id WHERE d.slug = $1`,
          [slug],
        );
        const reservationId = rows[0]!.id;

        // Polled rather than slept on a fixed delay: a loaded machine must not
        // turn a short-lived hold into a race.
        const giveUp = Date.now() + 20_000;
        let lapsed = false;
        while (!lapsed && Date.now() < giveUp) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const state = await h.sql.query<{ lapsed: boolean; status: string }>(
            `SELECT expires_at <= now() AS lapsed, status FROM reservations WHERE id = $1`,
            [reservationId],
          );
          lapsed = state.rows[0]!.lapsed && state.rows[0]!.status === 'active';
        }
        expect(lapsed).toBe(true);

        // Its tickets are still reserved, so there is genuinely something to
        // sell and the guard is what refuses it.
        expect(await ticketStatuses(reservationId)).toEqual([{ status: 'reserved', n: 2 }]);
        await expect(
          h.sql.query(
            `UPDATE tickets SET status = 'sold' WHERE reservation_id = $1 AND status = 'reserved'`,
            [reservationId],
          ),
        ).rejects.toThrow(/can only be sold by a live reservation/);
      } finally {
        await brief.close();
      }
    }, 60_000);

    it('refuses the sale in the database when the hold has ended', async () => {
      const { reservationIds } = await readyToPay(2);
      // Ended, but its tickets deliberately left reserved so the guard is what
      // answers rather than there being nothing to sell.
      await h.sql.query(
        `UPDATE reservations SET status = 'released', ended_at = now() WHERE id = $1`,
        [reservationIds[0]!],
      );
      await expect(
        h.sql.query(
          `UPDATE tickets SET status = 'sold' WHERE reservation_id = $1 AND status = 'reserved'`,
          [reservationIds[0]!],
        ),
      ).rejects.toThrow(/can only be sold by a live reservation/);
    });

    it('still allows a live hold to sell, so the guard is not simply refusing', async () => {
      const { reservationIds } = await readyToPay(1);
      await h.sql.query(
        `UPDATE tickets SET status = 'sold' WHERE reservation_id = $1 AND status = 'reserved'`,
        [reservationIds[0]!],
      );
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 1 }]);
    });
  });

  // ---- the order state machine (D4 = C) -----------------------------------

  describe('the order transition is enforced twice', () => {
    it('refuses to un-pay a finalised order in raw SQL', async () => {
      const { order, reference } = await readyToPay(1);
      await deliver(successBody(order, reference));
      await expect(
        h.sql.query(`UPDATE orders SET status = 'awaiting_payment' WHERE id = $1`, [order.id]),
      ).rejects.toThrow(/order status cannot change/);
    });

    it('refuses to move a paid order to failed', async () => {
      const { order, reference } = await readyToPay(1);
      await deliver(successBody(order, reference));
      await expect(
        h.sql.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [order.id]),
      ).rejects.toThrow(/order status cannot change/);
    });

    it('refuses to reopen a succeeded payment', async () => {
      const { order, payment, reference } = await readyToPay(1);
      await deliver(successBody(order, reference));
      await expect(
        h.sql.query(`UPDATE payments SET status = 'pending' WHERE id = $1`, [payment.id]),
      ).rejects.toThrow(/payment status cannot change/);
    });
  });

  // ---- D22.1: telling a duplicate from a second capture -------------------
  //
  // A duplicate webhook and a second capture arrive in exactly the same shape:
  // a verified success for an order that is already paid. Deciding on the
  // order's status alone made them indistinguishable, and the second one —
  // money taken twice — left no trace in `payments` at all.
  //
  // These tests are about DETECTION. What happens to money captured twice is
  // D22.3 and how it is accounted for is D22.2; neither is decided here, and
  // nothing below expects a refund or a second payment row.

  describe('D22.1: a success for an order that is already settled', () => {
    /** The event rows for one provider event id. */
    const eventRows = async (providerEventId: string) =>
      (
        await h.sql.query<{ processed_at: Date | null; last_error: string | null }>(
          `SELECT processed_at, last_error FROM payment_events WHERE provider_event_id = $1`,
          [providerEventId],
        )
      ).rows;

    const succeededCount = async (orderId: string) =>
      Number(
        (
          await h.sql.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM payments WHERE order_id = $1 AND status = 'succeeded'`,
            [orderId],
          )
        ).rows[0]!.n,
      );

    it('A: the same attempt again is an ordinary duplicate', async () => {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      await deliver(successBody(order, reference));
      expect((await orderRow(order.id)).status).toBe('paid');

      const auditBefore = await auditRows(order.id);
      const outboxBefore = await outboxRows(order.id);

      // A second, DIFFERENT event id for the SAME attempt, so replay protection
      // cannot answer and the classification has to.
      const again = successBody(order, reference);
      const response = await deliver(again);
      expect(response.statusCode).toBe(200);

      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await succeededCount(order.id)).toBe(1);
      expect(await paymentStatus(payment.id)).toBe('succeeded');
      expect(await auditRows(order.id)).toHaveLength(auditBefore.length);
      expect(await outboxRows(order.id)).toHaveLength(outboxBefore.length);
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);

      // Nothing is owed on it, so it is settled with no error.
      const [event] = await eventRows(again.id);
      expect(event!.processed_at).not.toBeNull();
      expect(event!.last_error).toBeNull();
    });

    it('B: a DIFFERENT attempt after the order is paid is flagged as a second capture', async () => {
      const { client, order, payment, reference, reservationIds } = await readyToPay(2);

      // A second attempt for the same order, which is only possible once the
      // first is terminal. The customer clicked Pay again; attempt one timed
      // out; and then BOTH were captured at the provider.
      await h.sql.query(`UPDATE payments SET status = 'expired' WHERE id = $1`, [payment.id]);
      const second = paymentOf(
        await client.request(
          'POST',
          `/markets/uk/checkout/orders/${order.id}/payments`,
          {},
          { 'idempotency-key': freshKey() },
        ),
      );
      const { rows: secondRef } = await h.sql.query<{ provider_reference: string }>(
        `SELECT provider_reference FROM payments WHERE id = $1`,
        [second.id],
      );

      // The second attempt succeeds and settles the order.
      await deliver(successBody(order, secondRef[0]!.provider_reference));
      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await paymentStatus(second.id)).toBe('succeeded');

      const auditBefore = await auditRows(order.id);
      const outboxBefore = await outboxRows(order.id);

      // Now the FIRST attempt's capture arrives. Same shape as a duplicate.
      const late = successBody(order, reference);
      const response = await deliver(late);
      expect(response.statusCode).toBe(200);

      // Detected, named, and left for someone to deal with.
      const [event] = await eventRows(late.id);
      expect(event!.last_error).toBe('second_capture');
      // Unprocessed on purpose: something is owed on this, and the
      // reconciler's index is what should find it.
      expect(event!.processed_at).toBeNull();

      // And nothing was resolved, because resolving it is D22.2 and D22.3.
      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await succeededCount(order.id)).toBe(1);
      expect(await paymentStatus(payment.id)).toBe('expired');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);
      expect(await auditRows(order.id)).toHaveLength(auditBefore.length);
      expect(await outboxRows(order.id)).toHaveLength(outboxBefore.length);
    });

    it('B: is distinguishable from A in one query', async () => {
      // The point of the whole change: an operator, or the reconciler, can ask
      // for second captures without reading every event ever received.
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment_events
          WHERE last_error = 'second_capture' AND processed_at IS NULL`,
      );
      expect(rows[0]!.n).toBeGreaterThan(0);
    });

    it('C: a capture against an order settled by nothing is named too', async () => {
      // The order was cancelled before the provider spoke, so the capture
      // matches no settlement at all. Distinct from a second capture: there is
      // no other payment, and nothing was delivered either.
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);

      const late = successBody(order, reference);
      expect((await deliver(late)).statusCode).toBe(200);

      const [event] = await eventRows(late.id);
      expect(event!.last_error).toBe('capture_without_settlement');
      expect(event!.processed_at).toBeNull();

      // Safely recorded, and nothing touched.
      expect((await orderRow(order.id)).status).toBe('cancelled');
      expect(await succeededCount(order.id)).toBe(0);
      expect(await paymentStatus(payment.id)).toBe('processing');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'reserved', n: 2 }]);
      expect(await outboxRows(order.id)).toHaveLength(0);
    });

    it('creates no payment row for any of them', async () => {
      // D22.2 decides whether a second capture gets an accounting record. Until
      // it does, detection invents nothing.
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payments WHERE provider_reference IS NULL`,
      );
      expect(rows[0]!.n).toBe(0);
    });
  });

  // ---- D22.3 and D23: refunding what cannot be kept -----------------------

  describe('D22.3: refunding a confirmed duplicate capture', () => {
    /** An order paid by attempt two, with attempt one's capture arriving late. */
    async function orderWithDuplicateCapture() {
      const { client, order, payment, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`UPDATE payments SET status = 'expired' WHERE id = $1`, [payment.id]);
      const second = paymentOf(
        await client.request(
          'POST',
          `/markets/uk/checkout/orders/${order.id}/payments`,
          {},
          { 'idempotency-key': freshKey() },
        ),
      );
      const { rows } = await h.sql.query<{ provider_reference: string }>(
        `SELECT provider_reference FROM payments WHERE id = $1`,
        [second.id],
      );
      await deliver(successBody(order, rows[0]!.provider_reference));
      expect((await orderRow(order.id)).status).toBe('paid');

      // Now attempt one's capture, which D22.1 flags.
      const late = successBody(order, reference);
      await deliver(late);
      const { rows: events } = await h.sql.query<{ id: string; last_error: string | null }>(
        `SELECT id, last_error FROM payment_events WHERE provider_event_id = $1`,
        [late.id],
      );
      expect(events[0]!.last_error).toBe('second_capture');
      return { order, firstPayment: payment, second, eventId: events[0]!.id, reservationIds };
    }

    it('refunds it in full, once, and leaves the order paid', async () => {
      const { order, firstPayment, second, eventId, reservationIds } =
        await orderWithDuplicateCapture();

      const outcome = await refundsService().refundDuplicateCapture(eventId);
      expect(outcome.kind).toBe('raised');

      const refunds = await refundRows(order.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.reason).toBe('duplicate_capture');
      expect(refunds[0]!.destination).toBe('provider');
      // Against the instrument that took the DUPLICATE money, not the one that
      // settled the order.
      expect(refunds[0]!.payment_id).toBe(firstPayment.id);
      expect(Number(refunds[0]!.amount_minor)).toBe(order.totalMinor);
      expect(refunds[0]!.idempotency_key).toBe(`refund:event:${eventId}:duplicate_capture`);

      // The order is untouched: this money was never another payment for it.
      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await paymentStatus(second.id)).toBe('succeeded');
      expect(await paymentStatus(firstPayment.id)).toBe('expired');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);
      // Still exactly one succeeded payment.
      const succeeded = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payments WHERE order_id = $1 AND status = 'succeeded'`,
        [order.id],
      );
      expect(succeeded.rows[0]!.n).toBe(1);
    });

    it('is idempotent when invoked again', async () => {
      const { order, eventId } = await orderWithDuplicateCapture();
      const first = await refundsService().refundDuplicateCapture(eventId);
      const again = await refundsService().refundDuplicateCapture(eventId);
      const third = await refundsService().refundDuplicateCapture(eventId);

      expect(first.kind).toBe('raised');
      expect(again.kind).toBe('already_raised');
      expect(third.kind).toBe('already_raised');
      expect(await refundRows(order.id)).toHaveLength(1);
      // And no order outcome was announced: the order did not change.
      expect(await outboxRows(order.id)).toHaveLength(1);
      expect(
        (await auditRows(order.id)).filter(
          (r) => r.action === 'payment.duplicate_capture_refunded',
        ),
      ).toHaveLength(1);
    });

    it('settles the exception, so it stops showing as work outstanding', async () => {
      const { eventId } = await orderWithDuplicateCapture();
      const before = await h.sql.query<{ processed_at: Date | null }>(
        `SELECT processed_at FROM payment_events WHERE id = $1`,
        [eventId],
      );
      expect(before.rows[0]!.processed_at).toBeNull();

      await refundsService().refundDuplicateCapture(eventId);
      const after = await h.sql.query<{ processed_at: Date | null; last_error: string | null }>(
        `SELECT processed_at, last_error FROM payment_events WHERE id = $1`,
        [eventId],
      );
      expect(after.rows[0]!.processed_at).not.toBeNull();
      // The classification stays: the record of what it was does not change.
      expect(after.rows[0]!.last_error).toBe('second_capture');
    });

    it('refuses to refund an event that is not a flagged duplicate', async () => {
      // A plain successful payment's event. Nothing about it says duplicate, so
      // this action will not touch it — which is what keeps an ordinary
      // duplicate webhook and a genuine second capture apart here too.
      const { order, reference } = await readyToPay(1);
      const body = successBody(order, reference);
      await deliver(body);
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT id FROM payment_events WHERE provider_event_id = $1`,
        [body.id],
      );

      const outcome = await refundsService().refundDuplicateCapture(rows[0]!.id);
      expect(outcome.kind).toBe('not_a_duplicate_capture');
      expect(await refundRows(order.id)).toHaveLength(0);
    });
  });

  describe('D23: a success that arrives after the order expired', () => {
    /** An order that lapsed unpaid, with its holds gone, then a late capture. */
    async function expiredOrderWithLateCapture() {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      // The holds go first, as they would when the sweep collects them.
      await h.sql.query(`SELECT hv_end_reservation($1::uuid, 'expired')`, [reservationIds[0]!]);
      // Then the order lapses. This is the state P6-5's sweep will create.
      await h.sql.query(`UPDATE orders SET status = 'expired' WHERE id = $1`, [order.id]);
      return { order, payment, reference, reservationIds };
    }

    it('records it as paid and unfulfillable, and refunds it', async () => {
      const { order, payment, reference, reservationIds } = await expiredOrderWithLateCapture();

      await deliver(successBody(order, reference));

      // The order stops standing as a record of a customer who never paid.
      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
      // This attempt was never terminal — the deadline passed, but nothing
      // expired the attempt itself — so recording that it took the money is not
      // a resurrection. The next test covers the attempt that WAS terminal.
      expect(await paymentStatus(payment.id)).toBe('succeeded');
      // The tickets went when the order did, and stay gone.
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([]);

      const refunds = await refundRows(order.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.reason).toBe('unfulfillable');
      expect(refunds[0]!.destination).toBe('provider');
      expect(refunds[0]!.payment_id).toBe(payment.id);

      const outbox = await outboxRows(order.id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.topic).toBe('order.unfulfillable');
      expect(
        (await auditRows(order.id)).filter((r) => r.action === 'order.paid_unfulfillable'),
      ).toHaveLength(1);
    });

    it('does not resurrect a terminal attempt', async () => {
      // The other half of D23: the customer clicked Pay again at some point, so
      // this attempt is terminal, and then the deadline passed and the provider
      // confirmed it. `hv_payments_guard` refuses to revive it and the owner
      // decided it stays refused — the ORDER carries the outcome instead.
      const { order, payment, reference, reservationIds } = await expiredOrderWithLateCapture();
      await h.sql.query(`UPDATE payments SET status = 'expired' WHERE id = $1`, [payment.id]);

      await deliver(successBody(order, reference));

      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
      expect(await paymentStatus(payment.id)).toBe('expired');
      expect(await refundRows(order.id)).toHaveLength(1);
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([]);
    });

    it('is idempotent across repeated deliveries', async () => {
      const { order, reference } = await expiredOrderWithLateCapture();
      await deliver(successBody(order, reference));
      await deliver(successBody(order, reference));
      await deliver(successBody(order, reference));

      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
      expect(await refundRows(order.id)).toHaveLength(1);
      expect(await outboxRows(order.id)).toHaveLength(1);
      expect(
        (await auditRows(order.id)).filter((r) => r.action === 'order.paid_unfulfillable'),
      ).toHaveLength(1);
    });

    it('permits expired -> paid_unfulfillable and nothing else out of expired', async () => {
      // The exact invariant migration 0024 changed, and its limits.
      const { order } = await expiredOrderWithLateCapture();
      for (const status of ['paid', 'failed', 'cancelled', 'refunded']) {
        await expect(
          h.sql.query(`UPDATE orders SET status = $2 WHERE id = $1`, [order.id, status]),
        ).rejects.toThrow(/order status cannot change/);
      }
      await h.sql.query(`UPDATE orders SET status = 'paid_unfulfillable' WHERE id = $1`, [
        order.id,
      ]);
      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
    });

    it('leaves a cancelled order alone, because nobody decided that case', async () => {
      const { order, payment, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);

      const body = successBody(order, reference);
      await deliver(body);

      // Recorded for a person. Guessing at money against an order somebody
      // cancelled would be inventing policy, and D23 covers only `expired`.
      const { rows } = await h.sql.query<{ last_error: string | null; processed_at: Date | null }>(
        `SELECT last_error, processed_at FROM payment_events WHERE provider_event_id = $1`,
        [body.id],
      );
      expect(rows[0]!.last_error).toBe('capture_without_settlement');
      expect(rows[0]!.processed_at).toBeNull();
      expect((await orderRow(order.id)).status).toBe('cancelled');
      expect(await refundRows(order.id)).toHaveLength(0);
      expect(await paymentStatus(payment.id)).toBe('processing');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'reserved', n: 2 }]);
    });
  });

  describe('refund records keep their shape', () => {
    it('cannot be rewritten once raised', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`SELECT hv_end_reservation($1::uuid, 'expired')`, [reservationIds[0]!]);
      await deliver(successBody(order, reference));
      const [refund] = await refundRows(order.id);

      await expect(
        h.sql.query(`UPDATE refunds SET amount_minor = 1 WHERE id = $1`, [refund!.id]),
      ).rejects.toThrow(/fixed when it is raised/);
      await expect(
        h.sql.query(`UPDATE refunds SET reason = 'something else' WHERE id = $1`, [refund!.id]),
      ).rejects.toThrow(/fixed when it is raised/);
    });

    it('is settled by the provider, and moves out of raised exactly once', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      // The customer really did complete the payment at the provider, so the
      // provider will agree to refund it. Without this the fake refuses — it
      // will not refund a payment it never saw succeed — and the refund stays
      // `raised`, which is correct behaviour and would test nothing about
      // settlement.
      completeAtProvider(reference);
      await h.sql.query(`SELECT hv_end_reservation($1::uuid, 'expired')`, [reservationIds[0]!]);
      await deliver(successBody(order, reference));

      const [refund] = await refundRows(order.id);
      expect(refund!.status).toBe('succeeded');
      expect(refund!.provider_refund_reference).not.toBeNull();
      // One move out of `raised`, and no coming back.
      await expect(
        h.sql.query(`UPDATE refunds SET status = 'failed' WHERE id = $1`, [refund!.id]),
      ).rejects.toThrow(/refund status cannot change/);
    });

    it('goes terminal when the provider refuses it outright', async () => {
      // **Updated for K-2 (2026-09-28).** This test previously asserted that
      // the row stayed `raised` here, because P6-4 treated every provider error
      // the same way. The owner then separated them: a provider that could not
      // be REACHED leaves money still owed and is retried with the same key,
      // while one that understood and REFUSED has given an answer, and
      // repeating it verbatim would earn the same refusal forever.
      //
      // This is the second case. The provider never saw this payment complete,
      // so it refuses — `provider_rejected`, which the port itself documents as
      // "not retryable without changing something". The refund becomes terminal
      // and goes to a person; what happens next is an operator policy that does
      // not exist yet and is deliberately not invented.
      //
      // The first case — an unreachable provider, which must stay `raised` —
      // is covered in refund-retry.int.test.ts.
      const { order, reference, reservationIds } = await readyToPay(2);
      await h.sql.query(`SELECT hv_end_reservation($1::uuid, 'expired')`, [reservationIds[0]!]);
      await deliver(successBody(order, reference));

      const [refund] = await refundRows(order.id);
      expect(refund!.status).toBe('failed');
      // No money moved, so no reference was ever named.
      expect(refund!.provider_refund_reference).toBeNull();
      // And the order outcome stands regardless. What the provider said about
      // the refund has no bearing on what the order records about the customer.
      expect((await orderRow(order.id)).status).toBe('paid_unfulfillable');
      // Exactly one row. A refusal never produces a second attempt or key.
      expect(await refundRows(order.id)).toHaveLength(1);
    });

    it('gives hv_app no way to erase one', async () => {
      const { rows } = await h.sql.query<{ del: boolean; upd: boolean }>(
        `SELECT has_table_privilege('hv_app', 'refunds', 'DELETE') AS del,
                has_table_privilege('hv_app', 'refunds', 'UPDATE') AS upd`,
      );
      expect(rows[0]!.del).toBe(false);
      expect(rows[0]!.upd).toBe(true);
    });
  });

  // ---- Gate 4.13: the deadline invariant ----------------------------------

  describe('Gate 4.13: the deadline always lands before the hold expires', () => {
    it('holds for every order created', async () => {
      // The invariant that makes D11a = B safe: a hold whose order is still
      // payable is never due for sweeping, so the expiry sweep needs no
      // payment-specific predicate. Named so a future change to D1 fails here
      // first rather than in production.
      for (const quantity of [1, 2, 5]) await readyToPay(quantity);

      const { rows } = await h.sql.query<{ violations: number }>(
        `SELECT count(*)::int AS violations
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           JOIN reservations r ON r.id = oi.reservation_id
          WHERE o.expires_at >= r.expires_at`,
      );
      expect(rows[0]!.violations).toBe(0);
    });
  });

  // ---- Gate 4.11: the topic vocabulary ------------------------------------

  describe('Gate 4.11: only order.* topics, and no refund topic', () => {
    it('emits nothing outside the locked vocabulary', async () => {
      const paid = await readyToPay(1);
      await deliver(successBody(paid.order, paid.reference));

      const doomed = await readyToPay(1);
      await h.sql.query(`SELECT hv_end_reservation($1::uuid, 'expired')`, [
        doomed.reservationIds[0]!,
      ]);
      await deliver(successBody(doomed.order, doomed.reference));

      const { rows } = await h.sql.query<{ topic: string }>(`SELECT DISTINCT topic FROM outbox`);
      const written = rows.map((r) => r.topic).filter((t) => t !== 'email.verification_code');
      expect(written.length).toBeGreaterThan(0);
      for (const topic of written) {
        expect(ORDER_OUTCOME_TOPICS).toContain(topic);
        expect(topic.startsWith('order.')).toBe(true);
        expect(topic).not.toContain('refund');
      }
    });

    it('registers no refund-completion handler anywhere', async () => {
      // D16a: nothing in Phase 6 completes a refund, so nothing may announce
      // one. P10 names that topic when it builds the consumer.
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE topic LIKE '%refund%'`,
      );
      expect(rows[0]!.n).toBe(0);
    });
  });

  // ---- nothing a browser does finalises anything --------------------------

  describe('a browser cannot pay for anything', () => {
    it('leaves the order awaiting payment however the customer returns', async () => {
      const { client, order, reservationIds } = await readyToPay(2);

      // Everything a returning browser could plausibly do. None of it is a
      // verified webhook or a trusted status check, so none of it decides
      // anything (ADR-0006, D6).
      for (const url of [
        `/markets/uk/checkout/orders/${order.id}`,
        `/markets/uk/checkout/orders/${order.id}?status=success`,
        `/markets/uk/checkout/orders/${order.id}?paid=true`,
      ]) {
        const response = await client.get(url);
        expect(response.statusCode).toBe(200);
      }

      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'reserved', n: 2 }]);
      expect(await outboxRows(order.id)).toHaveLength(0);
    });

    it('cannot be finalised by posting to the payment route again', async () => {
      const { client, order, reservationIds } = await readyToPay(2);
      const again = await client.request(
        'POST',
        `/markets/uk/checkout/orders/${order.id}/payments`,
        {},
        { 'idempotency-key': freshKey() },
      );
      expect(again.statusCode).toBe(201);
      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'reserved', n: 2 }]);
    });

    it('cannot be finalised by an unsigned webhook', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      const raw = Buffer.from(JSON.stringify(successBody(order, reference)), 'utf8');
      const response = await h.app.inject({
        method: 'POST',
        url: '/webhooks/payments/fake',
        remoteAddress: ip,
        headers: { 'content-type': 'application/json' },
        payload: raw,
      });
      expect(response.statusCode).toBe(400);
      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'reserved', n: 2 }]);
    });
  });

  // ---- failures of ours stay retryable ------------------------------------

  describe('a failure of ours is retryable', () => {
    it('answers 5xx and commits nothing when finalisation cannot run', async () => {
      const { order, reference, reservationIds } = await readyToPay(2);
      const body = successBody(order, reference);

      const unreachable = new URL(h.database.url);
      unreachable.pathname = '/highland_vault_does_not_exist';
      const broken = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        DATABASE_URL: unreachable.toString(),
      });
      try {
        const raw = Buffer.from(JSON.stringify(body), 'utf8');
        const response = await broken.inject({
          method: 'POST',
          url: '/webhooks/payments/fake',
          remoteAddress: randomIp(),
          headers: {
            'content-type': 'application/json',
            [FAKE_SIGNATURE_HEADER]: signWebhook(WEBHOOK_SECRET, raw),
          },
          payload: raw,
        });
        expect(response.statusCode).toBe(500);
        expect(errorCode(response)).toBe('INTERNAL_ERROR');
      } finally {
        await broken.close();
      }

      // Nothing happened, and the same event still finalises cleanly when it is
      // retried against a working API.
      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
      await deliver(body);
      expect((await orderRow(order.id)).status).toBe('paid');
      expect(await ticketStatuses(reservationIds[0]!)).toEqual([{ status: 'sold', n: 2 }]);
    });
  });
});
