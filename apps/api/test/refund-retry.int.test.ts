/**
 * Refund retry, provider refusal, the duplicate-capture operator action, and
 * the clock the reconciler depends on (task P6-5; owner decisions K-2, K-3,
 * D22.3, D12a).
 *
 * The distinction this file exists to hold is K-2's: **a refund we could not
 * make and a refund the provider refused are not the same thing.** The first is
 * money still owed and is retried forever with the same key; the second is an
 * answer, is terminal, and goes to a person. Getting that backwards either
 * abandons a customer's money or hammers a provider with a request it has
 * already declined.
 */
import { OrderResponseSchema, PaymentResponseSchema } from '@hv/contracts';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import { FAKE_SIGNATURE_HEADER, signWebhook, type FakePaymentProvider } from '@hv/payments';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATABASE } from '../src/database/database.module';
import { PAYMENT_PROVIDER } from '../src/payments/payment-provider.factory';
import { RefundsService } from '../src/payments/refunds.service';
import { RefundsRepository, refundKeys } from '../src/payments/refunds.repository';
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

const WEBHOOK_SECRET = 'integration-test-webhook-secret';
const orderOf = (r: { json: () => unknown }) => OrderResponseSchema.parse(r.json()).order;
const paymentOf = (r: { json: () => unknown }) => PaymentResponseSchema.parse(r.json()).payment;

let keyCounter = 0;
const freshKey = () => `ref-${Date.now().toString(36)}-${keyCounter++}-aaaaaaaa`;
let eventCounter = 0;
const freshEventId = () => `ref-evt-${Date.now().toString(36)}-${eventCounter++}`;

const REASON = { reason: 'Finance confirmed the provider took this twice.' };

describe('refunds after the decision', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let finance: Client & { email: string };
  let support: Client & { email: string };
  let ukSlug: string;
  let termsVersion: string;
  let correctOption: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);

    admin = await registeredClient(h.app, uniqueEmail('ref-admin'));
    await grantRole(h.sql, admin.email, 'super_admin');
    await enrolMfa(admin);
    finance = await registeredClient(h.app, uniqueEmail('ref-finance'));
    await grantRole(h.sql, finance.email, 'finance');
    await enrolMfa(finance);
    support = await registeredClient(h.app, uniqueEmail('ref-support'));
    await grantRole(h.sql, support.email, 'support');
    await enrolMfa(support);

    const version = `ref-fixture-${Date.now()}`;
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

    ukSlug = `ref-uk-${Date.now()}`;
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

  const provider = () => h.app.get<FakePaymentProvider>(PAYMENT_PROVIDER);
  const refundsService = () => h.app.get(RefundsService);
  const refundsRepo = () => h.app.get(RefundsRepository);

  /** Puts the provider's own copy into `succeeded`, discarding its webhook. */
  const completeAtProvider = (reference: string) => {
    provider().complete(reference);
    provider().takeWebhooks();
  };

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

  const successBody = (order: { totalMinor: number }, reference: string) => ({
    id: freshEventId(),
    type: 'payment.succeeded',
    reference,
    state: 'succeeded',
    amountMinor: order.totalMinor,
    currency: 'GBP',
    occurredAt: new Date().toISOString(),
  });

  const refundRows = async (orderId: string) =>
    (
      await h.sql.query<{
        id: string;
        status: string;
        idempotency_key: string;
        provider_refund_reference: string | null;
      }>(
        `SELECT id, status, idempotency_key, provider_refund_reference
           FROM refunds WHERE order_id = $1 ORDER BY created_at`,
        [orderId],
      )
    ).rows;

  /** An order settled by one attempt, plus a second attempt that also captured. */
  async function withSecondCapture() {
    const first = await readyToPay();
    completeAtProvider(first.reference);
    await deliver(successBody(first.order, first.reference));

    // A second attempt of the same order, and a success for it. The order is
    // already paid, so finalisation classifies this as a second capture.
    await h.sql.query(
      `INSERT INTO payments (order_id, market_id, provider, provider_reference, amount_minor,
                             currency, idempotency_key, created_at, expires_at, status)
       SELECT o.id, o.market_id, 'fake', $2, o.external_due_minor, o.currency, $3,
              now() - interval '2 seconds', now() + interval '120 seconds', 'processing'
         FROM orders o WHERE o.id = $1`,
      [first.order.id, `second-${first.order.id}`, `second-key-${first.order.id}`],
    );
    const response = await deliver(successBody(first.order, `second-${first.order.id}`));
    expect(response.statusCode).toBe(200);

    const { rows } = await h.sql.query<{ id: string }>(
      `SELECT id FROM payment_events WHERE last_error = 'second_capture'
         AND payment_id = (SELECT id FROM payments WHERE provider_reference = $1)`,
      [`second-${first.order.id}`],
    );
    return { ...first, eventId: rows[0]!.id };
  }

  // ---- K-2: retryable failure versus definitive refusal --------------------

  describe('a refund the provider will not make yet', () => {
    it('stays raised, and is retried with the same key', async () => {
      const { order, reference } = await readyToPay();
      // Unfulfillable: the holds are gone, so finalisation raises a refund.
      await h.sql.query(
        `UPDATE reservations SET status = 'released', ended_at = now()
          WHERE id IN (SELECT reservation_id FROM order_items WHERE order_id = $1)`,
        [order.id],
      );
      await deliver(successBody(order, reference));

      const raised = await refundRows(order.id);
      expect(raised).toHaveLength(1);
      // The provider never saw this payment succeed, so it refuses to refund
      // it — and that refusal arrives as `provider_rejected`.
      expect(raised[0]!.status).toBe('failed');
      expect(raised[0]!.idempotency_key).toBe(refundKeys.unfulfillable(order.id));
    });

    it('retries an owed refund with the key it already has, and settles it', async () => {
      const { order, payment, reference } = await readyToPay();
      completeAtProvider(reference);

      // Raise a refund directly, the way finalisation would, with the provider
      // already able to make it.
      const refund = await refundsRepo().raiseIfNew(h.app.get(DATABASE), {
        orderId: order.id,
        marketId: (
          await h.sql.query<{ market_id: string }>(`SELECT market_id FROM orders WHERE id = $1`, [
            order.id,
          ])
        ).rows[0]!.market_id,
        paymentId: payment.id,
        provider: 'fake',
        reason: 'unfulfillable',
        idempotencyKey: refundKeys.unfulfillable(order.id),
      });
      expect(refund).not.toBeNull();

      // Ten retries, one refund.
      for (let i = 0; i < 10; i++) await refundsService().retryUnsettled();
      const rows = await refundRows(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('succeeded');
      expect(rows[0]!.provider_refund_reference).not.toBeNull();
    });

    it('never raises a second row or a second key for a failed refund', async () => {
      const { order, reference } = await readyToPay();
      await h.sql.query(
        `UPDATE reservations SET status = 'released', ended_at = now()
          WHERE id IN (SELECT reservation_id FROM order_items WHERE order_id = $1)`,
        [order.id],
      );
      await deliver(successBody(order, reference));
      expect((await refundRows(order.id))[0]!.status).toBe('failed');

      // The retry sweep reads `refunds_unsettled_idx`, partial on `raised`, so
      // a terminal refusal is simply not work any more.
      await refundsService().retryUnsettled();
      const rows = await refundRows(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('failed');
    });

    it('leaves a refund raised when the provider has no record of the payment', async () => {
      const { order, payment, reference } = await readyToPay();
      completeAtProvider(reference);
      const marketId = (
        await h.sql.query<{ market_id: string }>(`SELECT market_id FROM orders WHERE id = $1`, [
          order.id,
        ])
      ).rows[0]!.market_id;
      await h.sql.query(
        `INSERT INTO refunds (order_id, market_id, payment_id, provider, amount_minor, currency,
                              reason, idempotency_key)
         VALUES ($1, $2, $3, 'fake', 500, 'GBP', 'unfulfillable', $4)`,
        [order.id, marketId, payment.id, `unreachable-${order.id}`],
      );

      // A second API against the same database. Its fake provider has never
      // heard of this attempt, which is what an unreachable or restarted
      // provider looks like from here — `unknown_reference`, not a refusal.
      const other = await startApp(h.database);
      try {
        await other.get(RefundsService).retryUnsettled();
      } finally {
        await other.close();
      }

      // Still owed, not failed. This is the distinction K-2 exists to hold.
      const rows = await refundRows(order.id);
      expect(rows.at(-1)!.status).toBe('raised');
    });
  });

  // ---- D-3: the refund must name the provider we are talking to ------------

  describe('a refund for another provider', () => {
    /** Raises a refund directly, so its provider can be chosen. */
    async function raise(orderId: string, paymentId: string, providerCode: string) {
      const marketId = (
        await h.sql.query<{ market_id: string }>(`SELECT market_id FROM orders WHERE id = $1`, [
          orderId,
        ])
      ).rows[0]!.market_id;
      const { rows } = await h.sql.query<{ id: string }>(
        `INSERT INTO refunds (order_id, market_id, payment_id, provider, amount_minor, currency,
                              reason, idempotency_key)
         VALUES ($1, $2, $3, $4, 500, 'GBP', 'unfulfillable', $5)
         RETURNING id`,
        [orderId, marketId, paymentId, providerCode, `d3-${providerCode}-${orderId}`],
      );
      return rows[0]!.id;
    }

    it('is never sent, and never becomes succeeded', async () => {
      const { order, payment, reference } = await readyToPay();
      completeAtProvider(reference);
      // The money came from a provider this deployment is not configured for.
      const refundId = await raise(order.id, payment.id, 'some-other-provider');

      const watch = vi.spyOn(provider(), 'refund');
      try {
        // Scoped to this refund: the sweep also picks up rows other tests in
        // this file left raised, and this invariant is about ONE row.
        await refundsService().send(refundId);
        expect(watch).not.toHaveBeenCalled();
      } finally {
        watch.mockRestore();
      }

      const { rows } = await h.sql.query<{
        status: string;
        provider_refund_reference: string | null;
      }>(`SELECT status, provider_refund_reference FROM refunds WHERE id = $1`, [refundId]);
      // Still owed, and by a provider we cannot currently reach — not failed,
      // and certainly not succeeded.
      expect(rows[0]!.status).toBe('raised');
      expect(rows[0]!.provider_refund_reference).toBeNull();
    });

    it('proceeds when the provider matches', async () => {
      const { order, payment, reference } = await readyToPay();
      completeAtProvider(reference);
      const refundId = await raise(order.id, payment.id, 'fake');

      const watch = vi.spyOn(provider(), 'refund');
      try {
        await refundsService().send(refundId);
        expect(watch).toHaveBeenCalledTimes(1);
      } finally {
        watch.mockRestore();
      }

      const { rows } = await h.sql.query<{ status: string }>(
        `SELECT status FROM refunds WHERE id = $1`,
        [refundId],
      );
      expect(rows[0]!.status).toBe('succeeded');
    });

    it('leaves the mismatch alone however many times it is retried', async () => {
      const { order, payment, reference } = await readyToPay();
      completeAtProvider(reference);
      const refundId = await raise(order.id, payment.id, 'some-other-provider');

      for (let i = 0; i < 5; i++) await refundsService().send(refundId);
      const { rows } = await h.sql.query<{ status: string; n: number }>(
        `SELECT r.status, (SELECT count(*)::int FROM refunds WHERE order_id = $2) AS n
           FROM refunds r WHERE r.id = $1`,
        [refundId, order.id],
      );
      expect(rows[0]!.status).toBe('raised');
      // And no second row was raised to work around it.
      expect(rows[0]!.n).toBe(1);
    });
  });

  // ---- D22.3: the operator action ------------------------------------------

  describe('the duplicate-capture operator action', () => {
    it('is not reachable by a role holding only orders.read', async () => {
      const { order, eventId } = await withSecondCapture();
      const response = await support.post(
        `/admin/markets/uk/orders/${order.id}/payment-events/${eventId}/refund-duplicate`,
        REASON,
      );
      expect(response.statusCode).toBe(403);
    });

    it('refunds the duplicate, once, however many times it is invoked', async () => {
      const { order, eventId } = await withSecondCapture();
      const before = await refundRows(order.id);

      const responses = [];
      for (let i = 0; i < 10; i++) {
        responses.push(
          await finance.post(
            `/admin/markets/uk/orders/${order.id}/payment-events/${eventId}/refund-duplicate`,
            REASON,
          ),
        );
      }
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      expect(responses[0]!.json<{ result: string }>().result).toBe('raised');
      expect(responses[1]!.json<{ result: string }>().result).toBe('already_raised');

      const after = await refundRows(order.id);
      expect(after.length).toBe(before.length + 1);
      expect(after.at(-1)!.idempotency_key).toBe(refundKeys.duplicateCapture(eventId));
    });

    it('leaves the order paid and its tickets sold', async () => {
      const { order, eventId } = await withSecondCapture();
      await finance.post(
        `/admin/markets/uk/orders/${order.id}/payment-events/${eventId}/refund-duplicate`,
        REASON,
      );
      const status = await h.sql.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [order.id],
      );
      expect(status.rows[0]!.status).toBe('paid');
      const sold = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tickets t
           JOIN order_items oi ON oi.reservation_id = t.reservation_id
          WHERE oi.order_id = $1 AND t.status = 'sold'`,
        [order.id],
      );
      expect(sold.rows[0]!.n).toBe(2);
    });

    it('emits no order-outcome event, because the order did not change (I26)', async () => {
      const { order, eventId } = await withSecondCapture();
      const before = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE payload->>'orderId' = $1`,
        [order.id],
      );
      await finance.post(
        `/admin/markets/uk/orders/${order.id}/payment-events/${eventId}/refund-duplicate`,
        REASON,
      );
      const after = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE payload->>'orderId' = $1`,
        [order.id],
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it('refuses an event this system did not classify as a second capture', async () => {
      const { order, reference } = await readyToPay();
      completeAtProvider(reference);
      await deliver(successBody(order, reference));
      // An ordinary, settled delivery.
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT e.id FROM payment_events e JOIN payments p ON p.id = e.payment_id
          WHERE p.order_id = $1 AND e.last_error IS NULL`,
        [order.id],
      );
      const response = await finance.post(
        `/admin/markets/uk/orders/${order.id}/payment-events/${rows[0]!.id}/refund-duplicate`,
        REASON,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json<{ result: string }>().result).toBe('not_a_duplicate_capture');
      expect(await refundRows(order.id)).toHaveLength(0);
    });
  });

  // ---- K-3: the cancelled-order capture ------------------------------------

  describe('a capture against a cancelled order (K-3)', () => {
    it('is recorded, left unprocessed, and acts on nothing', async () => {
      const { order, reference } = await readyToPay();
      await h.sql.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
      completeAtProvider(reference);

      const response = await deliver(successBody(order, reference));
      expect(response.statusCode).toBe(200);

      const { rows } = await h.sql.query<{ processed_at: Date | null; last_error: string | null }>(
        `SELECT e.processed_at, e.last_error FROM payment_events e
           JOIN payments p ON p.id = e.payment_id WHERE p.order_id = $1`,
        [order.id],
      );
      expect(rows[0]!.last_error).toBe('capture_without_settlement');
      // Unprocessed on purpose: the reconciler's index finds it, and no policy
      // exists to act on it.
      expect(rows[0]!.processed_at).toBeNull();

      // Nothing was fulfilled, nothing was refunded, the order did not move.
      expect(await refundRows(order.id)).toHaveLength(0);
      const status = await h.sql.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [order.id],
      );
      expect(status.rows[0]!.status).toBe('cancelled');
    });

    it('is visible to an authorized operator', async () => {
      const { order, reference } = await readyToPay();
      await h.sql.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
      completeAtProvider(reference);
      await deliver(successBody(order, reference));

      const view = (await admin.get(`/admin/markets/uk/orders/${order.id}/payments`)).json<{
        events: { lastError: string | null; processedAt: string | null }[];
      }>();
      const flagged = view.events.find((e) => e.lastError === 'capture_without_settlement');
      expect(flagged).toBeDefined();
      expect(flagged!.processedAt).toBeNull();
    });
  });

  // ---- the clock the reconciler depends on ---------------------------------

  describe('payments.updated_at means "last state change" (D12a)', () => {
    it('is what every production statement that updates a payment guarantees', async () => {
      // The reconciler's worklist filters on `updated_at`, and that is only
      // D12a's "last state change" because `hv_set_updated_at` stamps the
      // column on EVERY update while every statement in the API that updates a
      // payment happens to be a status transition. The second half is a
      // property of the source, not of the schema, so it is checked against the
      // source: if a future slice adds a write that changes something else — a
      // "last checked" timestamp, most likely — this fails here, rather than
      // the reconciler silently re-arming itself on its own writes for five
      // minutes.
      const source = await readApiSource();
      const statements = [...source.matchAll(/UPDATE payments\b[\s\S]*?(?=`|$)/g)].map((m) => m[0]);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement, `this UPDATE does not change status:\n${statement}`).toMatch(
          /SET[\s\S]*?\bstatus\s*=/,
        );
      }
      // Nothing may write a column named for when we last looked at a payment.
      expect(source).not.toMatch(/last_checked|checked_at|last_reconciled/);

      // And the observable half: a payment that is read and reconciled but does
      // not change status keeps its timestamp.
      const { order, payment } = await readyToPay();
      const before = await h.sql.query<{ updated_at: Date; status: string }>(
        `SELECT updated_at, status FROM payments WHERE id = $1`,
        [payment.id],
      );
      // A status check that finds nothing new.
      await admin.post(
        `/admin/markets/uk/orders/${order.id}/payments/${payment.id}/reconcile`,
        REASON,
      );
      const after = await h.sql.query<{ updated_at: Date; status: string }>(
        `SELECT updated_at, status FROM payments WHERE id = $1`,
        [payment.id],
      );
      expect(after.rows[0]!.status).toBe(before.rows[0]!.status);
      expect(after.rows[0]!.updated_at).toEqual(before.rows[0]!.updated_at);
    });

    it('moves only when the status moves', async () => {
      const { order, payment, reference } = await readyToPay();
      const before = await h.sql.query<{ updated_at: Date }>(
        `SELECT updated_at FROM payments WHERE id = $1`,
        [payment.id],
      );
      completeAtProvider(reference);
      await deliver(successBody(order, reference));
      const after = await h.sql.query<{ updated_at: Date; status: string }>(
        `SELECT updated_at, status FROM payments WHERE id = $1`,
        [payment.id],
      );
      expect(after.rows[0]!.status).toBe('succeeded');
      expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(
        before.rows[0]!.updated_at.getTime(),
      );
    });
  });
});

/** Every .ts file under the API source, concatenated. Tests read the source
 * because the property being guarded is a property OF the source. */
async function readApiSource(dir = join(process.cwd(), 'apps/api/src')): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) parts.push(await readApiSource(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      parts.push(await readFile(full, 'utf8'));
    }
  }
  return parts.join('\n');
}
