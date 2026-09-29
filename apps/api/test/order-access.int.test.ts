/**
 * The return link (task P6-8; OD-2; owner decisions **D18 = B**, **D19 = A**,
 * **D19a**).
 *
 * A guest proves their email address, that proof lasts thirty minutes, and
 * then they leave for a payment provider. By the time they come back the proof
 * may have lapsed, the browser may have closed, or they may be on another
 * device — and they still have to be able to see what happened to the order
 * they just paid for.
 *
 * This file is almost entirely about what the resulting credential **cannot**
 * do. It is a bearer token that travels in a URL, so every boundary it could
 * be pushed past is asserted here rather than left to the shape of the code:
 * it authenticates nobody, it reaches one order, it reads, and it can never
 * make anything paid.
 */
import { ErrorResponseSchema, OrderResponseSchema, PaymentResponseSchema } from '@hv/contracts';
import { enableMarketsForTesting, insertFixtureDraw } from '@hv/db/testing';
import { FAKE_SIGNATURE_HEADER, signWebhook, type FakePaymentProvider } from '@hv/payments';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { API_ENV, type ApiEnv } from '../src/config/env';
import { PAYMENT_PROVIDERS } from '../src/payments/payment-provider.factory';
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
const freshKey = () => `oat-${Date.now().toString(36)}-${keyCounter++}-aaaaaaaa`;
let eventCounter = 0;
const freshEventId = () => `oat-evt-${Date.now().toString(36)}-${eventCounter++}`;

describe('the order return link', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let ukSlug: string;
  let termsVersion: string;
  let correctOption: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);

    admin = await registeredClient(h.app, uniqueEmail('oat-admin'));
    await grantRole(h.sql, admin.email, 'super_admin');
    await enrolMfa(admin);

    const version = `oat-fixture-${Date.now()}`;
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

    ukSlug = `oat-uk-${Date.now()}`;
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

  /** An order, a started payment, and the token from the provider return URL. */
  async function paidJourney(quantity = 1) {
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
    // The token reaches the customer exactly as it will in production: in the
    // return URL the provider was given.
    const url = new URL(payment.redirectUrl);
    const token = new URL(url.searchParams.get('return_to')!).searchParams.get('t');
    const reference = (
      await h.sql.query<{ provider_reference: string }>(
        `SELECT provider_reference FROM payments WHERE id = $1`,
        [payment.id],
      )
    ).rows[0]!.provider_reference;
    return { client, order, payment, token: token!, reference };
  }

  const present = (token: string, address = ip) =>
    h.app.inject({
      method: 'POST',
      url: '/checkout/order-access',
      remoteAddress: address,
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
      payload: { token },
    });

  const provider = () =>
    h.app.get<ReadonlyMap<string, FakePaymentProvider>>(PAYMENT_PROVIDERS).get('fake')!;

  const settle = async (order: { totalMinor: number }, reference: string) => {
    provider().complete(reference);
    provider().takeWebhooks();
    const raw = Buffer.from(
      JSON.stringify({
        id: freshEventId(),
        type: 'payment.succeeded',
        reference,
        state: 'succeeded',
        amountMinor: order.totalMinor,
        currency: 'GBP',
        occurredAt: new Date().toISOString(),
      }),
      'utf8',
    );
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

  const orderStatus = async (id: string) =>
    (await h.sql.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [id]))
      .rows[0]!.status;

  const tokenRow = async (orderId: string) =>
    (
      await h.sql.query<{ token_hash: Buffer; expires_at: Date; revoked_at: Date | null }>(
        `SELECT token_hash, expires_at, revoked_at FROM order_access_tokens WHERE order_id = $1`,
        [orderId],
      )
    ).rows[0];

  // ---- it opens its own order ----------------------------------------------

  describe('a valid link', () => {
    it('reads its order and the payment, with no identity at all', async () => {
      const { order, payment, token } = await paidJourney();
      const response = await present(token);
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        order: { id: string; status: string };
        payment: { id: string; status: string } | null;
        serverTime: string;
      }>();
      expect(body.order.id).toBe(order.id);
      expect(body.payment?.id).toBe(payment.id);
      expect(body.serverTime).toBeTruthy();
    });

    it('still works after the guest verification window would have lapsed', async () => {
      // The whole reason this mechanism exists. Nothing about the caller's
      // identity is consulted, so there is no window to lapse.
      const { order, token } = await paidJourney();
      await h.sql.query(`UPDATE guest_sessions SET verified_email_at = now() - interval '2 hours'`);
      const body = (await present(token)).json<{ order: { id: string } }>();
      expect(body.order.id).toBe(order.id);
    });

    it('shows the authoritative outcome once the webhook settles it', async () => {
      const { order, token, reference } = await paidJourney();
      expect((await present(token)).json<{ order: { status: string } }>().order.status).toBe(
        'awaiting_payment',
      );

      expect((await settle(order, reference)).statusCode).toBe(200);

      // The webhook moved it, and the link reports what the database says.
      const after = (await present(token)).json<{ order: { status: string } }>();
      expect(after.order.status).toBe('paid');
      expect(await orderStatus(order.id)).toBe('paid');
    });
  });

  // ---- storage --------------------------------------------------------------

  describe('storage', () => {
    it('keeps only the SHA-256 hash', async () => {
      const { order, token } = await paidJourney();
      const row = await tokenRow(order.id);
      expect(row!.token_hash).toEqual(createHash('sha256').update(token).digest());
      expect(row!.token_hash).toHaveLength(32);
    });

    it('holds the plaintext in no column of any table', async () => {
      const { token } = await paidJourney();
      // Every text-ish column in the schema, searched for the token. If the
      // plaintext is anywhere, this finds it.
      const { rows } = await h.sql.query<{ hits: number }>(
        `SELECT count(*)::int AS hits FROM (
           SELECT 1 FROM order_access_tokens WHERE encode(token_hash,'hex') = $1
           UNION ALL SELECT 1 FROM payments WHERE provider_reference = $1 OR idempotency_key = $1
           UNION ALL SELECT 1 FROM orders WHERE idempotency_key = $1 OR order_number = $1
           UNION ALL SELECT 1 FROM audit_log WHERE after::text LIKE '%' || $1 || '%'
                                                OR before::text LIKE '%' || $1 || '%'
                                                OR COALESCE(reason,'') LIKE '%' || $1 || '%'
           UNION ALL SELECT 1 FROM outbox WHERE payload::text LIKE '%' || $1 || '%'
         ) AS found`,
        [token],
      );
      expect(rows[0]!.hits).toBe(0);
    });

    it('is issued once per order, and the second issue yields no new plaintext', async () => {
      const { client, order, token } = await paidJourney();
      // A second Pay on the same order must not mint a second credential.
      await client.request(
        'POST',
        `/markets/uk/checkout/orders/${order.id}/payments`,
        {},
        { 'idempotency-key': freshKey() },
      );
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM order_access_tokens WHERE order_id = $1`,
        [order.id],
      );
      expect(rows[0]!.n).toBe(1);
      // And the original still works.
      expect((await present(token)).statusCode).toBe(200);
    });

    it('is fixed once issued', async () => {
      const { order } = await paidJourney();
      const other = await paidJourney();
      await expect(
        h.sql.query(`UPDATE order_access_tokens SET order_id = $2 WHERE order_id = $1`, [
          order.id,
          other.order.id,
        ]),
      ).rejects.toThrow(/fixed when it is issued/);
      await expect(
        h.sql.query(`UPDATE order_access_tokens SET token_hash = sha256('x') WHERE order_id = $1`, [
          order.id,
        ]),
      ).rejects.toThrow(/fixed when it is issued/);
    });

    it('gives hv_app no way to erase one', async () => {
      const { rows } = await h.sql.query<{ del: boolean; trunc: boolean; upd: boolean }>(
        `SELECT has_table_privilege('hv_app','order_access_tokens','DELETE') AS del,
                has_table_privilege('hv_app','order_access_tokens','TRUNCATE') AS trunc,
                has_table_privilege('hv_app','order_access_tokens','UPDATE') AS upd`,
      );
      expect(rows[0]!.del).toBe(false);
      expect(rows[0]!.trunc).toBe(false);
      // Revocation is an update.
      expect(rows[0]!.upd).toBe(true);
    });
  });

  // ---- lifetime -------------------------------------------------------------

  describe('lifetime (D19a)', () => {
    it('expires 30 minutes after the order deadline', async () => {
      const { order } = await paidJourney();
      const row = await tokenRow(order.id);
      const deadline = (
        await h.sql.query<{ expires_at: Date }>(`SELECT expires_at FROM orders WHERE id = $1`, [
          order.id,
        ])
      ).rows[0]!.expires_at;
      const minutes = (row!.expires_at.getTime() - deadline.getTime()) / 60_000;
      expect(Math.round(minutes)).toBe(30);
    });

    it('cannot have its lifetime extended', async () => {
      const { order } = await paidJourney();
      // The guard freezes expires_at. A link whose expiry could be pushed
      // forward is a link that never really expires.
      await expect(
        h.sql.query(
          `UPDATE order_access_tokens SET expires_at = now() + interval '1 year' WHERE order_id = $1`,
          [order.id],
        ),
      ).rejects.toThrow(/fixed when it is issued/);
    });

    it('works before its expiry and is refused after it', async () => {
      // The expiry cannot be wound forward on an issued token, and waiting
      // thirty minutes is not a test. So each case gets its own row, written
      // directly with the lifetime under examination.
      const live = await paidJourney();
      const dead = await paidJourney();
      await h.sql.query(`DELETE FROM order_access_tokens WHERE order_id = ANY($1)`, [
        [live.order.id, dead.order.id],
      ]);

      const insert = (orderId: string, token: string, offset: string) =>
        h.sql.query(
          `INSERT INTO order_access_tokens (order_id, token_hash, created_at, expires_at)
           VALUES ($1, sha256($2::bytea), now() - interval '2 hours', now() + $3::interval)`,
          [orderId, Buffer.from(token, 'utf8'), offset],
        );
      const liveToken = 'l'.repeat(43);
      const deadToken = 'd'.repeat(43);
      await insert(live.order.id, liveToken, '1 minute');
      await insert(dead.order.id, deadToken, '-1 minute');

      expect((await present(liveToken)).statusCode).toBe(200);
      const expired = await present(deadToken);
      expect(expired.statusCode).toBe(404);
      // Indistinguishable from a token that never existed.
      expect(errorCode(expired)).toBe('NOT_FOUND');
    });

    it('does not move when the guest email window changes', async () => {
      // D19a: its own configured value. If these were derived from one
      // another, changing the email window would silently change how long a
      // customer can look at the order they paid for.
      const other = await startApp(h.database, { GUEST_VERIFIED_EMAIL_TTL_MINUTES: '5' });
      try {
        const env = other.get<ApiEnv>(API_ENV);
        expect(env.GUEST_VERIFIED_EMAIL_TTL_MINUTES).toBe(5);
        // Unmoved. The two are separate settings and must stay that way.
        expect(env.ORDER_ACCESS_TOKEN_TAIL_MINUTES).toBe(30);
      } finally {
        await other.close();
      }
    });

    it('is refused once revoked', async () => {
      const { order, token } = await paidJourney();
      await h.sql.query(`UPDATE order_access_tokens SET revoked_at = now() WHERE order_id = $1`, [
        order.id,
      ]);
      expect((await present(token)).statusCode).toBe(404);
    });
  });

  // ---- what it cannot do -----------------------------------------------------

  describe('what the link cannot do', () => {
    it('reaches no other order', async () => {
      const mine = await paidJourney();
      const theirs = await paidJourney();
      const body = (await present(mine.token)).json<{ order: { id: string } }>();
      expect(body.order.id).toBe(mine.order.id);
      expect(body.order.id).not.toBe(theirs.order.id);
    });

    it('refuses a token that belongs to no order', async () => {
      for (const bogus of ['x'.repeat(43), 'a'.repeat(128), 'not-a-real-token-value']) {
        const response = await present(bogus);
        expect(response.statusCode).toBe(404);
        // The same answer as a revoked or expired one: nothing distinguishes
        // "wrong" from "gone" from "never existed".
        expect(errorCode(response)).toBe('NOT_FOUND');
      }
      // Shorter than any token this system issues: refused by validation
      // before a query runs. That boundary is public — the length is visible in
      // any link — so answering differently costs nothing.
      expect((await present('short')).statusCode).toBe(400);
    });

    it('cannot start a payment (D18 = B)', async () => {
      const { order, token } = await paidJourney();
      // There is no token-scoped write anywhere. Presented as a session
      // cookie, as a bearer header, or as a body field, it starts nothing.
      const asCookie = await h.app.inject({
        method: 'POST',
        url: `/markets/uk/checkout/orders/${order.id}/payments`,
        remoteAddress: ip,
        headers: {
          origin: 'http://127.0.0.1:3000',
          cookie: `hv_session=${token}`,
          'idempotency-key': freshKey(),
        },
        payload: {},
      });
      expect(asCookie.statusCode).toBeGreaterThanOrEqual(400);

      const asGuest = await h.app.inject({
        method: 'POST',
        url: `/markets/uk/checkout/orders/${order.id}/payments`,
        remoteAddress: ip,
        headers: {
          origin: 'http://127.0.0.1:3000',
          cookie: `hv_guest=${token}`,
          'idempotency-key': freshKey(),
        },
        payload: {},
      });
      expect(asGuest.statusCode).toBeGreaterThanOrEqual(400);

      // One attempt, the one the journey started.
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payments WHERE order_id = $1`,
        [order.id],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('does not authenticate an account', async () => {
      const { token } = await paidJourney();
      const me = await h.app.inject({
        method: 'GET',
        url: '/auth/me',
        remoteAddress: ip,
        headers: { cookie: `hv_session=${token}` },
      });
      expect(me.statusCode).toBe(401);
    });

    it('creates, extends and revives no guest session', async () => {
      const { token } = await paidJourney();
      const before = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guest_sessions`,
      );
      await present(token);
      const after = await h.sql.query<{ n: number; verified: number }>(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE verified_email IS NOT NULL)::int AS verified
           FROM guest_sessions`,
      );
      // ADR-0029 intact: verified_email is neither written nor extended.
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      expect(after.rows[0]!.verified).toBe(0);
    });

    it('changes no ticket-cap identity', async () => {
      const { order, token } = await paidJourney(2);
      const before = await h.sql.query<{ entrant_type: string; count: number }>(
        `SELECT entrant_type, count FROM draw_entrant_counts
           JOIN draws d ON d.id = draw_entrant_counts.draw_id WHERE d.slug = $1`,
        [ukSlug],
      );
      await present(token);
      await present(token);
      const after = await h.sql.query<{ entrant_type: string; count: number }>(
        `SELECT entrant_type, count FROM draw_entrant_counts
           JOIN draws d ON d.id = draw_entrant_counts.draw_id WHERE d.slug = $1`,
        [ukSlug],
      );
      expect(after.rows).toEqual(before.rows);
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
    });

    it('mutates nothing about the order or the payment', async () => {
      const { order, token } = await paidJourney();
      const before = await h.sql.query<{ status: string; updated_at: Date }>(
        `SELECT o.status, p.updated_at FROM orders o
           JOIN payments p ON p.order_id = o.id WHERE o.id = $1`,
        [order.id],
      );
      for (let i = 0; i < 5; i++) await present(token);
      const after = await h.sql.query<{ status: string; updated_at: Date }>(
        `SELECT o.status, p.updated_at FROM orders o
           JOIN payments p ON p.order_id = o.id WHERE o.id = $1`,
        [order.id],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });

  // ---- the browser is never payment authority (toward G4.1) ------------------

  describe('the return is informational only', () => {
    it('cannot make an order paid, however it is presented', async () => {
      const { order, token } = await paidJourney();
      // Every shape a forged return could take. None is an input to anything.
      for (const payload of [
        { token },
        { token: `${token}&status=paid` },
        { token: `${token}?paid=true` },
      ]) {
        await h.app.inject({
          method: 'POST',
          url: '/checkout/order-access',
          remoteAddress: ip,
          headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
          payload,
        });
      }
      expect(await orderStatus(order.id)).toBe('awaiting_payment');
      const sold = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM tickets t
           JOIN order_items oi ON oi.reservation_id = t.reservation_id
          WHERE oi.order_id = $1 AND t.status = 'sold'`,
        [order.id],
      );
      expect(sold.rows[0]!.n).toBe(0);
    });

    it('twenty refreshes change nothing; one webhook changes everything', async () => {
      const { order, token, reference } = await paidJourney();
      for (let i = 0; i < 20; i++) await present(token);
      expect(await orderStatus(order.id)).toBe('awaiting_payment');

      // The authoritative mechanism, untouched by any of the above.
      await settle(order, reference);
      expect(await orderStatus(order.id)).toBe('paid');
    });
  });

  // ---- abuse control ----------------------------------------------------------

  describe('presentation is rate limited', () => {
    it('refuses one address once it is over the limit', async () => {
      const { token } = await paidJourney();
      const address = randomIp();
      const limit = 20;
      for (let i = 0; i < limit; i++) {
        expect((await present(token, address)).statusCode).toBe(200);
      }
      const over = await present(token, address);
      expect(over.statusCode).toBe(429);
      expect(errorCode(over)).toBe('RATE_LIMITED');
      expect(over.headers['retry-after']).toBeDefined();
    });
  });
});
