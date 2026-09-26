/**
 * Provider webhook intake against real PostgreSQL and Redis (migration 0021,
 * task P6-3).
 *
 * The boundary is the whole point of this file. Nothing that arrives is trusted
 * until its signature verifies over the exact bytes, and after that its
 * contents are still a claim: several tests send a perfectly signed event whose
 * amount or currency disagrees with the order, and assert it changes nothing.
 *
 * P6-3 stores and acknowledges. Every test here asserts, positively, that the
 * order did not move and that no outbox event was written — finalisation is
 * P6-4, and the separation is a locked decision rather than an accident of
 * sequencing.
 */
import { ErrorResponseSchema, OrderResponseSchema, PaymentResponseSchema } from '@hv/contracts';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import {
  ORDER_OUTCOME_TOPICS,
  SecretBox,
  isSealedPayload,
  openPayload,
  type SealedPayload,
} from '@hv/domain';
import { FAKE_SIGNATURE_HEADER, signWebhook } from '@hv/payments';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
/** The harness's fake-provider signing key; the same value `support.ts` configures. */
const WEBHOOK_SECRET = 'integration-test-webhook-secret';

const orderOf = (r: { json: () => unknown }) => OrderResponseSchema.parse(r.json()).order;
const paymentOf = (r: { json: () => unknown }) => PaymentResponseSchema.parse(r.json()).payment;
const errorCode = (r: { json: () => unknown }) => ErrorResponseSchema.parse(r.json()).error.code;

let keyCounter = 0;
const freshKey = () => `hook-${Date.now().toString(36)}-${keyCounter++}-aaaaaaaa`;
let eventCounter = 0;
const freshEventId = () => `evt-${Date.now().toString(36)}-${eventCounter++}`;

describe('receiving a provider webhook', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let ukSlug: string;
  let termsVersion: string;
  let correctOption: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);

    admin = await registeredClient(h.app, uniqueEmail('hook-admin'));
    await grantRole(h.sql, admin.email, 'super_admin');
    await enrolMfa(admin);

    const version = `hook-fixture-${Date.now()}`;
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

    ukSlug = `hook-uk-${Date.now()}`;
    await insertFixtureDraw(h.sql, {
      market: 'uk',
      slug: ukSlug,
      state: 'live',
      totalTickets: 500,
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

  /** A customer with an order and one live payment attempt. */
  async function readyAttempt(quantity = 2, app: NestFastifyApplication = h.app) {
    const client = await registeredClient(app);
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

  /** The wire body the fake provider sends, so a test can shape one precisely. */
  function eventBody(overrides: Record<string, unknown> = {}) {
    return {
      id: freshEventId(),
      type: 'payment.succeeded',
      reference: 'unset',
      state: 'succeeded',
      amountMinor: 500,
      currency: 'GBP',
      occurredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  /** POSTs bytes to the webhook route, signed unless told otherwise. */
  const deliver = (
    rawBody: Buffer,
    options: {
      signature?: string | null;
      provider?: string;
      origin?: string;
      app?: NestFastifyApplication;
    } = {},
  ) => {
    const signature =
      options.signature === undefined ? signWebhook(WEBHOOK_SECRET, rawBody) : options.signature;
    return (options.app ?? h.app).inject({
      method: 'POST',
      url: `/webhooks/payments/${options.provider ?? 'fake'}`,
      remoteAddress: ip,
      headers: {
        'content-type': 'application/json',
        ...(options.origin ? { origin: options.origin } : {}),
        ...(signature === null ? {} : { [FAKE_SIGNATURE_HEADER]: signature }),
      },
      payload: rawBody,
    });
  };

  /** Signs and delivers an event body. */
  const deliverEvent = (body: Record<string, unknown>, options = {}) =>
    deliver(Buffer.from(JSON.stringify(body), 'utf8'), options);

  const eventsFor = async (providerEventId: string) =>
    (
      await h.sql.query<{
        id: string;
        provider: string;
        event_type: string;
        provider_reference: string | null;
        payment_id: string | null;
        amount_minor: string | null;
        currency: string | null;
        provider_status: string | null;
        payload_sealed: unknown;
        processed_at: Date | null;
        last_error: string | null;
      }>(
        `SELECT id, provider, event_type, provider_reference, payment_id, amount_minor, currency,
                provider_status, payload_sealed, processed_at, last_error
           FROM payment_events WHERE provider_event_id = $1`,
        [providerEventId],
      )
    ).rows;

  const orderStatus = async (orderId: string) =>
    (await h.sql.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [orderId]))
      .rows[0]!.status;

  const outboxCount = async () =>
    Number((await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox`)).rows[0]!.n);

  // ---- signature verification over the exact bytes -------------------------

  describe('the signature covers the exact bytes', () => {
    it('accepts a correctly signed event', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      const response = await deliverEvent(body);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: true });
    });

    it('refuses a body altered after signing', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const tampered = Buffer.from(raw.toString('utf8').replace('500', '100'), 'utf8');

      const response = await deliver(tampered, { signature: signWebhook(WEBHOOK_SECRET, raw) });
      expect(response.statusCode).toBe(400);
      // Nothing was recorded: without a verified signature there is no event,
      // only bytes somebody sent.
      expect(await eventsFor(body.id)).toHaveLength(0);
    });

    it('refuses a body that is only re-serialised', async () => {
      // The same JSON with its keys in another order. Semantically identical,
      // different bytes — which is exactly why the handler must never parse and
      // re-serialise before verifying.
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      const signed = Buffer.from(JSON.stringify(body), 'utf8');
      const reordered = Buffer.from(
        JSON.stringify({
          occurredAt: body.occurredAt,
          currency: body.currency,
          amountMinor: body.amountMinor,
          state: body.state,
          reference: body.reference,
          type: body.type,
          id: body.id,
        }),
        'utf8',
      );
      expect(reordered.equals(signed)).toBe(false);

      const response = await deliver(reordered, {
        signature: signWebhook(WEBHOOK_SECRET, signed),
      });
      expect(response.statusCode).toBe(400);
      expect(await eventsFor(body.id)).toHaveLength(0);
    });

    it('refuses a missing signature', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      const response = await deliverEvent(body, { signature: null });
      expect(response.statusCode).toBe(400);
      expect(await eventsFor(body.id)).toHaveLength(0);
    });

    it('refuses a signature made with another key', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      const response = await deliver(raw, { signature: signWebhook('not-the-key', raw) });
      expect(response.statusCode).toBe(400);
      expect(await eventsFor(body.id)).toHaveLength(0);
    });

    it('refuses a truncated signature without a server error', async () => {
      const { reference } = await readyAttempt();
      const response = await deliverEvent(eventBody({ reference }), { signature: 'abc' });
      expect(response.statusCode).toBe(400);
    });

    it('says nothing about why it was refused', async () => {
      const { reference } = await readyAttempt();
      const bad = await deliverEvent(eventBody({ reference }), { signature: null });
      const malformed = await deliver(Buffer.from('not json', 'utf8'));
      // One answer for both: a caller cannot tell a wrong signature from an
      // unreadable body, and so cannot work towards a valid one.
      expect(errorCode(bad)).toBe(errorCode(malformed));
      expect(ErrorResponseSchema.parse(bad.json()).error.message).toBe(
        ErrorResponseSchema.parse(malformed.json()).error.message,
      );
    });
  });

  // ---- malformed and oversized ---------------------------------------------

  describe('bodies that cannot be read', () => {
    it('refuses a body that is not JSON', async () => {
      const response = await deliver(Buffer.from('not json at all', 'utf8'));
      expect(response.statusCode).toBe(400);
    });

    it('refuses a JSON body that is not a payment event', async () => {
      const response = await deliverEvent({ hello: 'world' });
      expect(response.statusCode).toBe(400);
    });

    it('refuses an event claiming an unsupported currency', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference, currency: 'USD' });
      const response = await deliverEvent(body);
      // Refused by the provider port before it becomes an event at all: an
      // amount in a currency this platform does not trade in is not a claim
      // worth recording.
      expect(response.statusCode).toBe(400);
      expect(await eventsFor(body.id)).toHaveLength(0);
    });

    it('refuses a body over the webhook limit', async () => {
      const { reference } = await readyAttempt();
      // Well past the webhook's own limit, which is deliberately under the
      // API's global one so this is our refusal rather than the framework's.
      const body = eventBody({ reference, padding: 'x'.repeat(40 * 1024) });
      const response = await deliverEvent(body);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(await eventsFor(body.id)).toHaveLength(0);
    });

    it('refuses an unknown provider without saying which exist', async () => {
      const { reference } = await readyAttempt();
      const response = await deliverEvent(eventBody({ reference }), { provider: 'someprovider' });
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
    });

    it('refuses a provider code that is not shaped like one', async () => {
      const { reference } = await readyAttempt();
      const response = await deliverEvent(eventBody({ reference }), { provider: 'NotAProvider' });
      expect(response.statusCode).toBe(400);
    });
  });

  // ---- the browser origin check (D5 = B) -----------------------------------

  describe('the browser origin check', () => {
    it('does not apply to the webhook route', async () => {
      // A provider sends no Origin, and could not honestly send one. This is
      // the request that the global CSRF hook would otherwise refuse before any
      // signature was looked at.
      const { reference } = await readyAttempt();
      const response = await deliverEvent(eventBody({ reference }));
      expect(response.statusCode).toBe(200);
    });

    it('ignores a hostile origin, because the signature decides', async () => {
      const { reference } = await readyAttempt();
      const response = await deliverEvent(eventBody({ reference }), {
        origin: 'https://evil.example.com',
      });
      expect(response.statusCode).toBe(200);
    });

    it('still refuses every other route without an origin', async () => {
      const client = await registeredClient(h.app);
      const response = await h.app.inject({
        method: 'POST',
        url: '/markets/uk/cart/items',
        remoteAddress: ip,
        headers: { cookie: `hv_session=${client.cookie}` },
        payload: { slug: ukSlug, quantity: 1 },
      });
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('does not exempt a path that merely looks like the webhook route', async () => {
      // The exemption is an exact route pattern, so a near miss never reaches
      // it — the router answers first.
      for (const url of ['/webhooksfake', '/webhooks/payments', '/webhooks/payments/fake/extra']) {
        const response = await h.app.inject({
          method: 'POST',
          url,
          remoteAddress: ip,
          payload: {},
        });
        expect(response.statusCode).not.toBe(200);
      }
    });

    it('applies the security headers to webhook responses too', async () => {
      const { reference } = await readyAttempt();
      const response = await deliverEvent(eventBody({ reference }));
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  // ---- persistence and replay protection (I3) ------------------------------

  describe('what is recorded', () => {
    it('stores the normalised facts and the matched attempt', async () => {
      const { payment, reference } = await readyAttempt(2);
      const body = eventBody({ reference, amountMinor: 500 });
      await deliverEvent(body);

      const [event] = await eventsFor(body.id);
      expect(event).toBeDefined();
      expect(event!.provider).toBe('fake');
      expect(event!.event_type).toBe('payment.succeeded');
      expect(event!.provider_reference).toBe(reference);
      expect(event!.payment_id).toBe(payment.id);
      expect(Number(event!.amount_minor)).toBe(500);
      expect(event!.currency).toBe('GBP');
      expect(event!.provider_status).toBe('succeeded');
    });

    it('seals the original bytes, and they open to exactly what arrived', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');
      await deliver(raw);

      const [event] = await eventsFor(body.id);
      expect(isSealedPayload(event!.payload_sealed)).toBe(true);

      // Opened with the key and the event's own identity as associated data.
      const box = new SecretBox(KEY, 'k1');
      const opened = openPayload<{ raw: string }>(
        box,
        `payment_event:fake:${body.id}`,
        event!.payload_sealed,
      );
      expect(Buffer.from(opened.raw, 'base64').equals(raw)).toBe(true);
    });

    it('does not let a sealed payload be read with the wrong context', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      await deliverEvent(body);
      const [event] = await eventsFor(body.id);

      const box = new SecretBox(KEY, 'k1');
      // Bound to this event. A payload copied onto another row will not open.
      expect(() =>
        openPayload(
          box,
          'payment_event:fake:someone-elses-event',
          event!.payload_sealed as SealedPayload,
        ),
      ).toThrow();
    });

    it('stores nothing readable: the plaintext is not in the row', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      await deliverEvent(body);
      const [event] = await eventsFor(body.id);
      expect(JSON.stringify(event!.payload_sealed)).not.toContain(reference);
      expect(JSON.stringify(event!.payload_sealed)).not.toContain('payment.succeeded');
    });

    it('records a duplicate delivery once', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');

      const first = await deliver(raw);
      const second = await deliver(raw);
      const third = await deliver(raw);
      // Every delivery is acknowledged; only one is recorded (I3).
      for (const response of [first, second, third]) expect(response.statusCode).toBe(200);
      expect(await eventsFor(body.id)).toHaveLength(1);
    });

    it('records one row when the same event arrives ten times at once', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      const raw = Buffer.from(JSON.stringify(body), 'utf8');

      const results = await Promise.all(Array.from({ length: 10 }, () => deliver(raw)));
      for (const response of results) expect(response.statusCode).toBe(200);
      // The database decides, not a read-then-insert: ten simultaneous
      // deliveries all reach the INSERT and exactly one row survives.
      expect(await eventsFor(body.id)).toHaveLength(1);
    });

    it('keeps the first content when an event id arrives with different facts', async () => {
      // A provider reusing an event id for different content is either a bug or
      // an attack. The first record stands: replay protection is keyed on the
      // id, so the second delivery is a duplicate whatever it says.
      const { reference } = await readyAttempt();
      const id = freshEventId();
      await deliverEvent(eventBody({ id, reference, amountMinor: 500 }));
      await deliverEvent(eventBody({ id, reference, amountMinor: 999, state: 'failed' }));

      const rows = await eventsFor(id);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.amount_minor)).toBe(500);
      expect(rows[0]!.provider_status).toBe('succeeded');
    });

    it('refuses to rewrite a recorded event in raw SQL', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      await deliverEvent(body);
      const [event] = await eventsFor(body.id);

      await expect(
        h.sql.query(`UPDATE payment_events SET amount_minor = 1 WHERE id = $1`, [event!.id]),
      ).rejects.toThrow(/fixed as it arrived/);
      await expect(
        h.sql.query(`UPDATE payment_events SET provider_status = 'failed' WHERE id = $1`, [
          event!.id,
        ]),
      ).rejects.toThrow(/fixed as it arrived/);
    });

    it('lets retention clear a sealed payload, and nothing else', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({ reference });
      await deliverEvent(body);
      const [event] = await eventsFor(body.id);

      // OD-7a: the payload is cleared after ninety days, and the row stays,
      // because the row is the replay record.
      await h.sql.query(`UPDATE payment_events SET payload_sealed = NULL WHERE id = $1`, [
        event!.id,
      ]);
      const [cleared] = await eventsFor(body.id);
      expect(cleared!.payload_sealed).toBeNull();

      // And it cannot be put back, or swapped for another.
      await expect(
        h.sql.query(`UPDATE payment_events SET payload_sealed = $2::jsonb WHERE id = $1`, [
          event!.id,
          JSON.stringify({ v: 1, kid: 'k1', sealed: 'other' }),
        ]),
      ).rejects.toThrow(/cleared, never rewritten/);
    });

    it('gives hv_app no way to erase an event', async () => {
      const { rows } = await h.sql.query<{ del: boolean; upd: boolean }>(
        `SELECT has_table_privilege('hv_app', 'payment_events', 'DELETE') AS del,
                has_table_privilege('hv_app', 'payment_events', 'UPDATE') AS upd`,
      );
      // Deleting would reopen replay protection for anything a provider
      // re-sends, so the row is permanent and retention clears the payload.
      expect(rows[0]!.del).toBe(false);
      // UPDATE stays, narrowed by the guard to the three fields that move.
      expect(rows[0]!.upd).toBe(true);
    });
  });

  // ---- what the provider claims is only a claim ----------------------------

  describe('the order decides, not the provider', () => {
    it('records an amount mismatch and changes nothing', async () => {
      const { order, reference } = await readyAttempt(2);
      const body = eventBody({ reference, amountMinor: 1 });
      const response = await deliverEvent(body);
      expect(response.statusCode).toBe(200);

      const [event] = await eventsFor(body.id);
      expect(event!.last_error).toBe('amount_mismatch');
      // Settled: it must never become a finalisation, so nothing will act on it.
      expect(event!.processed_at).not.toBeNull();
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
    });

    it('records a currency mismatch and changes nothing', async () => {
      const { order, reference } = await readyAttempt(2);
      const body = eventBody({ reference, currency: 'EUR', amountMinor: 500 });
      const response = await deliverEvent(body);
      expect(response.statusCode).toBe(200);

      const [event] = await eventsFor(body.id);
      expect(event!.last_error).toBe('currency_mismatch');
      expect(event!.processed_at).not.toBeNull();
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
    });

    it('keeps an event for a reference it never issued', async () => {
      const body = eventBody({ reference: 'fake_payment_never-issued' });
      const response = await deliverEvent(body);
      // Acknowledged, and indistinguishable from any other acceptance: a caller
      // cannot use this endpoint to learn which references exist.
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: true });

      const [event] = await eventsFor(body.id);
      expect(event!.payment_id).toBeNull();
      expect(event!.last_error).toBe('unknown_reference');
      expect(event!.processed_at).not.toBeNull();
    });

    it('keeps an event type it does not recognise', async () => {
      const { reference } = await readyAttempt();
      const body = eventBody({
        reference,
        type: 'payment.disputed',
        state: 'processing',
        amountMinor: 500,
      });
      const response = await deliverEvent(body);
      expect(response.statusCode).toBe(200);

      const [event] = await eventsFor(body.id);
      // Stored as sent, settled because it decides nothing, never dropped.
      expect(event!.event_type).toBe('payment.disputed');
      expect(event!.last_error).toBe('not_actionable');
      expect(event!.processed_at).not.toBeNull();
    });

    it('leaves an actionable event for finalisation', async () => {
      const { order, reference } = await readyAttempt(2);
      const body = eventBody({ reference, amountMinor: 500 });
      await deliverEvent(body);

      const [event] = await eventsFor(body.id);
      // Unsettled on purpose: it should move an order, and moving one is P6-4's.
      expect(event!.processed_at).toBeNull();
      expect(event!.last_error).toBeNull();
      // And P6-3 did not move it.
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
    });
  });

  // ---- P6-3 finalises nothing ---------------------------------------------

  describe('intake finalises nothing', () => {
    it('sells no ticket and moves no order, however the event reads', async () => {
      const soldBefore = Number(
        (
          await h.sql.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM tickets WHERE status = 'sold'`,
          )
        ).rows[0]!.n,
      );

      for (const state of ['succeeded', 'failed', 'expired'] as const) {
        const { order, reference } = await readyAttempt(2);
        await deliverEvent(eventBody({ reference, state, amountMinor: 500 }));
        expect(await orderStatus(order.id)).toBe('awaiting_payment');
      }

      const soldAfter = Number(
        (
          await h.sql.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM tickets WHERE status = 'sold'`,
          )
        ).rows[0]!.n,
      );
      expect(soldAfter).toBe(soldBefore);
    });

    it('leaves the payment attempt where it was', async () => {
      const { payment, reference } = await readyAttempt(2);
      await deliverEvent(eventBody({ reference, amountMinor: 500 }));
      const { rows } = await h.sql.query<{ status: string }>(
        `SELECT status FROM payments WHERE id = $1`,
        [payment.id],
      );
      // Confirming a payment is finalisation's job, and it has not run.
      expect(rows[0]!.status).toBe('processing');
    });

    it('writes no outbox event', async () => {
      const before = await outboxCount();
      const { reference } = await readyAttempt(2);
      await deliverEvent(eventBody({ reference, amountMinor: 500 }));
      // Announcing an outcome belongs with deciding one (P6-4).
      expect(await outboxCount()).toBe(before);
    });
  });

  // ---- the locked topic vocabulary (D16b) ---------------------------------

  describe('the order.* topic vocabulary', () => {
    it('is the four locked names, all under order.*', () => {
      expect([...ORDER_OUTCOME_TOPICS]).toEqual([
        'order.paid',
        'order.payment_failed',
        'order.expired',
        'order.unfulfillable',
      ]);
      for (const topic of ORDER_OUTCOME_TOPICS) {
        expect(topic.startsWith('order.')).toBe(true);
        // outbox_topic_format: lowercase, underscores and dots only.
        expect(topic).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/);
      }
    });

    it('names no refund-completion topic anywhere in Phase 6', () => {
      // D16a: nothing in Phase 6 completes a refund, so nothing may emit one.
      // P10 names it when it builds the consumer.
      for (const topic of ORDER_OUTCOME_TOPICS) {
        expect(topic).not.toContain('refund');
      }
    });

    it('registers no Phase 6 topic in the outbox yet', async () => {
      const { rows } = await h.sql.query<{ topic: string }>(
        `SELECT DISTINCT topic FROM outbox WHERE topic LIKE 'order.%' OR topic LIKE '%refund%'`,
      );
      // P6-3 writes none of them; a row here would mean intake had started
      // announcing outcomes it does not decide.
      expect(rows).toEqual([]);
    });
  });

  // ---- failures of ours are retryable (D6 = C) ----------------------------

  describe('failure classification', () => {
    it('answers 5xx when our own processing fails, so the provider retries', async () => {
      // The provider's message is perfect; our database is not there. That is
      // our fault, and a provider must be told to try again rather than be told
      // its message was bad — misclassifying this loses a payment
      // confirmation, which is then only recoverable by a re-check.
      const { reference } = await readyAttempt();
      const body = eventBody({ reference, amountMinor: 500 });
      const unreachable = new URL(h.database.url);
      unreachable.pathname = '/highland_vault_does_not_exist';
      const broken = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        DATABASE_URL: unreachable.toString(),
      });
      try {
        const response = await deliverEvent(body, { app: broken });
        expect(response.statusCode).toBe(500);
        expect(errorCode(response)).toBe('INTERNAL_ERROR');
        // And nothing was recorded, so a retry is a first attempt rather than
        // a duplicate.
        expect(await eventsFor(body.id)).toHaveLength(0);
      } finally {
        await broken.close();
      }
    });

    it('does not answer 5xx for a message the provider got wrong', async () => {
      // The other half of D6 = C: a bad signature will be just as bad next
      // time, so it is refused rather than invited back.
      const { reference } = await readyAttempt();
      const response = await deliverEvent(eventBody({ reference }), { signature: null });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    });

    it('has no provider at all when none is configured', async () => {
      const none = await startApp(h.database, {
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        FAKE_PAYMENT_WEBHOOK_SECRET: undefined,
      });
      try {
        const { reference } = await readyAttempt();
        const response = await deliverEvent(eventBody({ reference }), { app: none });
        // Production's state today: nothing to verify a signature against, so
        // nothing is accepted.
        expect(response.statusCode).toBe(404);
      } finally {
        await none.close();
      }
    });
  });

  // ---- no customer route exposes a payload --------------------------------

  describe('sealed payloads stay out of customer responses', () => {
    it('is absent from the order a customer reads back', async () => {
      const { client, order, reference } = await readyAttempt(2);
      const body = eventBody({ reference, amountMinor: 500 });
      await deliverEvent(body);

      const response = await client.get(`/markets/uk/checkout/orders/${order.id}`);
      expect(response.statusCode).toBe(200);
      const payload = response.payload;
      expect(payload).not.toContain('payload_sealed');
      expect(payload).not.toContain('sealed');
      expect(payload).not.toContain(reference);
    });
  });
});
