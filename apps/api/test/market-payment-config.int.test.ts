/**
 * Per-market payment configuration (task P6-7; B10; owner decision D17 = A).
 *
 * Two things are being proved, and the second is the one that matters.
 *
 * The first is that a market's provider comes from its own configuration row —
 * initiation, reconciliation and refunds all resolve it per market, and a
 * market with none fails closed rather than falling back to whatever the
 * deployment happens to have built.
 *
 * The second is that **configuration is not discoverable**. The table says
 * which provider a market settles through and under which credential
 * reference; a customer must not be able to learn any of it, and the webhook
 * route must not become a way to enumerate which markets are configured. That
 * is why webhook resolution reads the environment and never the table, and most
 * of the security block below exists to hold that line.
 */
import { ErrorResponseSchema, OrderResponseSchema } from '@hv/contracts';
import {
  configurePaymentsForTesting,
  enableMarketsForTesting,
  insertFixtureDraw,
} from '@hv/db/testing';
import { FAKE_SIGNATURE_HEADER, signWebhook, type FakePaymentProvider } from '@hv/payments';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAYMENT_PROVIDERS } from '../src/payments/payment-provider.factory';
import { PaymentProviderRegistry } from '../src/payments/payment-provider.registry';
import { PaymentsReconcileService } from '../src/payments/payments-reconcile.service';
import { RefundsService } from '../src/payments/refunds.service';
import type { Database } from '@hv/db';
import { DATABASE } from '../src/database/database.module';
import {
  type Client,
  type Harness,
  enrolMfa,
  grantRole,
  randomIp,
  registeredClient,
  startHarness,
  uniqueEmail,
} from './support';

const orderOf = (r: { json: () => unknown }) => OrderResponseSchema.parse(r.json()).order;
const errorCode = (r: { json: () => unknown }) => ErrorResponseSchema.parse(r.json()).error.code;

let keyCounter = 0;
const freshKey = () => `cfg-${Date.now().toString(36)}-${keyCounter++}-aaaaaaaa`;

const REASON = { reason: 'Local development configuration for the integration suite.' };
const CONFIGURE = { providerCode: 'fake', configRef: 'test-fixture-fake', ...REASON };

describe('per-market payment configuration', () => {
  let h: Harness;
  let superAdmin: Client & { email: string };
  let admin: Client & { email: string };
  let finance: Client & { email: string };
  let ukSlug: string;
  let ieSlug: string;
  let termsVersion: string;
  let ieTermsVersion: string;
  let correctOption: string;
  let ieCorrectOption: string;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);

    superAdmin = await registeredClient(h.app, uniqueEmail('cfg-super'));
    await grantRole(h.sql, superAdmin.email, 'super_admin');
    await enrolMfa(superAdmin);

    // `admin` holds every staff permission except config.manage, which 0006
    // grants to super_admin alone. That is what makes D17 structural.
    admin = await registeredClient(h.app, uniqueEmail('cfg-admin'));
    await grantRole(h.sql, admin.email, 'admin');
    await enrolMfa(admin);

    finance = await registeredClient(h.app, uniqueEmail('cfg-finance'));
    await grantRole(h.sql, finance.email, 'finance');
    await enrolMfa(finance);

    const mk = async (market: 'uk' | 'ie') => {
      const version = `cfg-${market}-${Date.now()}`;
      const created = (
        await superAdmin.post(`/admin/markets/${market}/terms`, {
          version,
          publish: true,
          reason: 'Integration test fixture.',
        })
      ).json<{ version: { id: string } }>().version;
      await superAdmin.post(`/admin/markets/${market}/terms/${created.id}/activate`, {
        reason: 'Integration test fixture.',
      });
      const slug = `cfg-${market}-${Date.now()}`;
      await insertFixtureDraw(h.sql, {
        market,
        slug,
        state: 'live',
        totalTickets: 500,
        maxPerPerson: 10,
        ticketPriceMinor: 250,
      });
      const options = await h.sql.query<{ id: string }>(
        `SELECT o.id FROM skill_question_options o
           JOIN draws d ON d.skill_question_id = o.skill_question_id
          WHERE d.slug = $1 AND o.is_correct`,
        [slug],
      );
      return { version, slug, option: options.rows[0]!.id };
    };
    const uk = await mk('uk');
    const ie = await mk('ie');
    ukSlug = uk.slug;
    termsVersion = uk.version;
    correctOption = uk.option;
    ieSlug = ie.slug;
    ieTermsVersion = ie.version;
    ieCorrectOption = ie.option;
  });

  afterAll(async () => {
    await h?.close();
  });

  let ip: string;
  beforeEach(async () => {
    ip = randomIp();
    // Every test starts from both markets configured, whatever the last one did.
    await configurePaymentsForTesting(h.sql, ['uk', 'ie']);
  });

  // ---- fixtures ------------------------------------------------------------

  async function orderIn(market: 'uk' | 'ie') {
    const slug = market === 'uk' ? ukSlug : ieSlug;
    const version = market === 'uk' ? termsVersion : ieTermsVersion;
    const option = market === 'uk' ? correctOption : ieCorrectOption;
    const client = await registeredClient(h.app);
    await client.post(`/markets/${market}/cart/items`, { slug, quantity: 1 });
    await client.post(`/markets/${market}/terms/acceptance`, { version });
    const order = orderOf(
      await client.request(
        'POST',
        `/markets/${market}/checkout/orders`,
        { items: [{ slug, quantity: 1, optionId: option }], termsVersion: version },
        { 'idempotency-key': freshKey() },
      ),
    );
    return { client, order };
  }

  const pay = (client: Client, market: string, orderId: string) =>
    client.request(
      'POST',
      `/markets/${market}/checkout/orders/${orderId}/payments`,
      {},
      {
        'idempotency-key': freshKey(),
      },
    );

  const clearConfig = (market: string) =>
    h.sql.query(
      `UPDATE market_payment_configs c SET provider_code = NULL, config_ref = NULL
         FROM markets m WHERE m.id = c.market_id AND m.code = $1`,
      [market],
    );

  const setProvider = (market: string, code: string) =>
    h.sql.query(
      `UPDATE market_payment_configs c SET provider_code = $2, config_ref = 'ref'
         FROM markets m WHERE m.id = c.market_id AND m.code = $1`,
      [market, code],
    );

  const registry = () => h.app.get(PaymentProviderRegistry);
  const db = (): Database => h.app.get<Database>(DATABASE);
  const marketId = async (code: string) =>
    (await h.sql.query<{ id: string }>(`SELECT id FROM markets WHERE code = $1`, [code])).rows[0]!
      .id;

  // ---- the database ---------------------------------------------------------

  describe('the table', () => {
    it('has one row per market, created by the migration', async () => {
      const { rows } = await h.sql.query<{ n: number; markets: number }>(
        `SELECT (SELECT count(*)::int FROM market_payment_configs) AS n,
                (SELECT count(*)::int FROM markets) AS markets`,
      );
      expect(rows[0]!.n).toBe(rows[0]!.markets);
    });

    it('holds no column that could carry a secret', async () => {
      const { rows } = await h.sql.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'market_payment_configs' ORDER BY column_name`,
      );
      const names = rows.map((r) => r.column_name);
      expect(names).toEqual([
        'config_ref',
        'created_at',
        'market_id',
        'provider_code',
        'updated_at',
      ]);
      for (const forbidden of ['secret', 'key', 'token', 'password', 'credential']) {
        expect(names.join(' ')).not.toContain(forbidden);
      }
    });

    it('names no provider in the schema (Gate 4.9)', async () => {
      // A CHECK that listed provider codes would hard-code the choice ADR-0006
      // exists to defer. The constraint may describe a shape, never a name.
      const { rows } = await h.sql.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'market_payment_configs'::regclass AND contype = 'c'`,
      );
      const defs = rows.map((r) => r.def).join(' ');
      expect(defs).not.toContain("'fake'");
      expect(defs).toContain('~');
    });

    it('refuses half a configuration', async () => {
      await expect(
        h.sql.query(
          `UPDATE market_payment_configs SET provider_code = 'fake', config_ref = NULL
             WHERE market_id = $1`,
          [await marketId('uk')],
        ),
      ).rejects.toThrow(/pair_complete/);
      await expect(
        h.sql.query(
          `UPDATE market_payment_configs SET provider_code = NULL, config_ref = 'x'
             WHERE market_id = $1`,
          [await marketId('uk')],
        ),
      ).rejects.toThrow(/pair_complete/);
    });

    it('refuses a provider code that is not shaped like one', async () => {
      await expect(
        h.sql.query(
          `UPDATE market_payment_configs SET provider_code = 'NotAProvider', config_ref = 'x'
             WHERE market_id = $1`,
          [await marketId('uk')],
        ),
      ).rejects.toThrow(/provider_format/);
    });

    it('keeps a configuration with its market', async () => {
      await expect(
        h.sql.query(`UPDATE market_payment_configs SET market_id = $2 WHERE market_id = $1`, [
          await marketId('uk'),
          await marketId('ie'),
        ]),
      ).rejects.toThrow(/stays with its market/);
    });

    it('gives hv_app no way to create or erase one', async () => {
      const { rows } = await h.sql.query<{ ins: boolean; del: boolean; upd: boolean }>(
        `SELECT has_table_privilege('hv_app','market_payment_configs','INSERT') AS ins,
                has_table_privilege('hv_app','market_payment_configs','DELETE') AS del,
                has_table_privilege('hv_app','market_payment_configs','UPDATE') AS upd`,
      );
      // The same rule markets and market_settings follow: the application
      // changes the decision, it does not invent or delete markets.
      expect(rows[0]!.ins).toBe(false);
      expect(rows[0]!.del).toBe(false);
      expect(rows[0]!.upd).toBe(true);
      const trunc = await h.sql.query<{ t: boolean }>(
        `SELECT has_table_privilege('hv_app','market_payment_configs','TRUNCATE') AS t`,
      );
      expect(trunc.rows[0]!.t).toBe(false);
    });
  });

  // ---- provider resolution --------------------------------------------------

  describe('resolving a provider', () => {
    it('resolves each configured market to its provider', async () => {
      for (const code of ['uk', 'ie']) {
        const provider = await registry().forMarket(db(), await marketId(code));
        expect(provider?.code).toBe('fake');
      }
    });

    it('fails closed for a market with no configuration', async () => {
      await clearConfig('uk');
      expect(await registry().forMarket(db(), await marketId('uk'))).toBeNull();
      // And the other market is unaffected — resolution really is per market.
      expect((await registry().forMarket(db(), await marketId('ie')))?.code).toBe('fake');
    });

    it('fails closed for a provider this deployment cannot build', async () => {
      await setProvider('uk', 'someprovider');
      expect(await registry().forMarket(db(), await marketId('uk'))).toBeNull();
    });

    it('resolves a webhook provider from the environment, not the table', async () => {
      // The security property: clearing every market's configuration must not
      // change what the webhook route can resolve, or the route becomes a way
      // to enumerate configured markets.
      await clearConfig('uk');
      await clearConfig('ie');
      expect(registry().byCode('fake')?.code).toBe('fake');
      expect(registry().byCode('someprovider')).toBeNull();
    });
  });

  // ---- the payment paths ----------------------------------------------------

  describe('the payment paths use the market’s provider', () => {
    it('starts a payment for a configured market', async () => {
      const { client, order } = await orderIn('uk');
      expect((await pay(client, 'uk', order.id)).statusCode).toBe(201);
    });

    it('refuses to start one for a market with no provider', async () => {
      const { client, order } = await orderIn('uk');
      await clearConfig('uk');
      const response = await pay(client, 'uk', order.id);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    });

    it('refuses for a provider the deployment cannot build', async () => {
      const { client, order } = await orderIn('uk');
      await setProvider('uk', 'someprovider');
      const response = await pay(client, 'uk', order.id);
      expect(errorCode(response)).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    });

    it('answers identically whether the market has none or the deployment has none', async () => {
      // A customer must not be able to tell those apart: either answer would
      // say something about how this deployment is configured.
      const first = await orderIn('uk');
      await clearConfig('uk');
      const noMarketConfig = await pay(first.client, 'uk', first.order.id);

      const second = await orderIn('ie');
      await setProvider('ie', 'someprovider');
      const unbuildable = await pay(second.client, 'ie', second.order.id);

      expect(noMarketConfig.statusCode).toBe(unbuildable.statusCode);
      expect(noMarketConfig.json()).toMatchObject({
        error: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' },
      });
      expect(errorCode(unbuildable)).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    });

    it('one market losing its provider does not stop another paying', async () => {
      await clearConfig('uk');
      const { client, order } = await orderIn('ie');
      expect((await pay(client, 'ie', order.id)).statusCode).toBe(201);
    });

    it('reconciliation resolves the payment’s own market', async () => {
      const { client, order } = await orderIn('uk');
      const payment = (await pay(client, 'uk', order.id)).json<{ payment: { id: string } }>()
        .payment;
      const reference = (
        await h.sql.query<{ provider_reference: string }>(
          `SELECT provider_reference FROM payments WHERE id = $1`,
          [payment.id],
        )
      ).rows[0]!.provider_reference;

      await clearConfig('uk');
      // No provider for this market, so the check cannot be made and nothing
      // is written — not a refusal to act on an answer, an inability to ask.
      const blocked = await h.app.get(PaymentsReconcileService).reconcile(payment.id);
      expect(blocked).toEqual({ kind: 'provider_unavailable', detail: 'no_provider_configured' });

      await configurePaymentsForTesting(h.sql, ['uk']);
      h.app
        .get<ReadonlyMap<string, FakePaymentProvider>>(PAYMENT_PROVIDERS)
        .get('fake')!
        .complete(reference);
      const checked = await h.app.get(PaymentsReconcileService).reconcile(payment.id);
      expect(checked.kind).toBe('checked');
    });

    it('a refund resolves the market of the refund, not a deployment provider', async () => {
      const { rows } = await h.sql.query<{ id: string }>(
        `INSERT INTO refunds (order_id, market_id, provider, amount_minor, currency, reason,
                              idempotency_key)
         SELECT o.id, o.market_id, 'fake', 500, o.currency, 'unfulfillable', $2
           FROM orders o WHERE o.id = $1 RETURNING id`,
        [(await orderIn('uk')).order.id, `cfg-refund-${Date.now()}`],
      );
      await clearConfig('uk');
      // No provider for the market, so nothing is asked and the obligation
      // stays raised — still owed, by a provider we cannot currently reach.
      await h.app.get(RefundsService).send(rows[0]!.id);
      const after = await h.sql.query<{ status: string }>(
        `SELECT status FROM refunds WHERE id = $1`,
        [rows[0]!.id],
      );
      expect(after.rows[0]!.status).toBe('raised');
    });
  });

  // ---- webhooks: the P6-3 boundary is unchanged ------------------------------

  describe('webhook intake', () => {
    const deliver = (provider: string) => {
      const raw = Buffer.from(
        JSON.stringify({
          id: `cfg-evt-${Date.now()}-${keyCounter++}`,
          type: 'payment.succeeded',
          reference: 'no-such-reference',
          state: 'succeeded',
          amountMinor: 250,
          currency: 'GBP',
          occurredAt: new Date().toISOString(),
        }),
        'utf8',
      );
      return h.app.inject({
        method: 'POST',
        url: `/webhooks/payments/${provider}`,
        remoteAddress: ip,
        headers: {
          'content-type': 'application/json',
          [FAKE_SIGNATURE_HEADER]: signWebhook('integration-test-webhook-secret', raw),
        },
        payload: raw,
      });
    };

    it('still verifies with the resolved provider', async () => {
      expect((await deliver('fake')).statusCode).toBe(200);
    });

    it('answers the same whether any market is configured or not', async () => {
      const configured = await deliver('fake');
      await clearConfig('uk');
      await clearConfig('ie');
      const unconfigured = await deliver('fake');
      // Identical: the route reads the environment, never the table, so it
      // cannot be used to discover which markets are configured.
      expect(unconfigured.statusCode).toBe(configured.statusCode);
    });

    it('still refuses an unknown provider without saying which exist', async () => {
      const response = await deliver('someprovider');
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
      expect(response.body).not.toContain('fake');
    });
  });

  // ---- the admin surface ----------------------------------------------------

  describe('the admin surface (D17 = A)', () => {
    it('is closed to a staff role without config.manage', async () => {
      for (const client of [admin, finance]) {
        expect(errorCode(await client.get('/admin/markets/uk/payment-config'))).toBe('FORBIDDEN');
        expect(errorCode(await client.put('/admin/markets/uk/payment-config', CONFIGURE))).toBe(
          'FORBIDDEN',
        );
      }
    });

    it('shows a super_admin the configuration and what is available', async () => {
      const response = await superAdmin.get('/admin/markets/uk/payment-config');
      expect(response.statusCode).toBe(200);
      expect(response.json<{ config: unknown }>().config).toMatchObject({
        market: 'uk',
        providerCode: 'fake',
        configRef: 'test-fixture-fake',
        resolvable: true,
        availableProviders: ['fake'],
      });
    });

    it('says when a configured provider cannot be built here', async () => {
      await setProvider('uk', 'someprovider');
      const config = (await superAdmin.get('/admin/markets/uk/payment-config')).json<{
        config: { resolvable: boolean };
      }>().config;
      expect(config.resolvable).toBe(false);
    });

    it('requires fresh step-up MFA to write', async () => {
      const noMfa = await registeredClient(h.app, uniqueEmail('cfg-nomfa'));
      await grantRole(h.sql, noMfa.email, 'super_admin');
      const response = await noMfa.put('/admin/markets/uk/payment-config', CONFIGURE);
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('STEP_UP_REQUIRED');
    });

    it('does not require step-up merely to read', async () => {
      const noMfa = await registeredClient(h.app, uniqueEmail('cfg-read'));
      await grantRole(h.sql, noMfa.email, 'super_admin');
      expect((await noMfa.get('/admin/markets/uk/payment-config')).statusCode).toBe(200);
    });

    it('requires a reason', async () => {
      for (const body of [
        { providerCode: 'fake', configRef: 'r' },
        { ...CONFIGURE, reason: ' ' },
      ]) {
        expect((await superAdmin.put('/admin/markets/uk/payment-config', body)).statusCode).toBe(
          400,
        );
      }
    });

    it('refuses half a configuration with a domain error, not a 500', async () => {
      const response = await superAdmin.put('/admin/markets/uk/payment-config', {
        providerCode: 'fake',
        configRef: null,
        ...REASON,
      });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('PAYMENT_CONFIG_INCOMPLETE');
    });

    it('writes the configuration and audits who changed it', async () => {
      await clearConfig('uk');
      const response = await superAdmin.put('/admin/markets/uk/payment-config', CONFIGURE);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ config: { providerCode: string } }>().config.providerCode).toBe(
        'fake',
      );

      const audits = await h.sql.query<{
        actor_type: string;
        actor_user_id: string | null;
        reason: string;
        before: { providerCode: string | null };
        after: { providerCode: string | null };
      }>(
        `SELECT actor_type, actor_user_id, reason, before, after FROM audit_log
          WHERE action = 'market.payment_config.updated' ORDER BY occurred_at DESC LIMIT 1`,
      );
      expect(audits.rows[0]!.actor_type).toBe('user');
      expect(audits.rows[0]!.actor_user_id).not.toBeNull();
      expect(audits.rows[0]!.reason).toBe(REASON.reason);
      expect(audits.rows[0]!.before.providerCode).toBeNull();
      expect(audits.rows[0]!.after.providerCode).toBe('fake');
    });

    it('lets a market be taken out of service by clearing it', async () => {
      const response = await superAdmin.put('/admin/markets/uk/payment-config', {
        providerCode: null,
        configRef: null,
        ...REASON,
      });
      expect(response.statusCode).toBe(200);
      const { client, order } = await orderIn('uk');
      expect(errorCode(await pay(client, 'uk', order.id))).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    });

    it('is a 404 for a market that does not exist', async () => {
      expect((await superAdmin.get('/admin/markets/zz/payment-config')).statusCode).toBe(404);
    });
  });

  // ---- nothing leaks to a customer ------------------------------------------

  describe('no customer route exposes configuration', () => {
    it('keeps the reference out of every customer payment response', async () => {
      const { client, order } = await orderIn('uk');
      const created = await pay(client, 'uk', order.id);
      const payment = created.json<{ payment: { id: string } }>().payment;
      const status = await client.get(
        `/markets/uk/checkout/orders/${order.id}/payments/${payment.id}`,
      );
      for (const body of [created.body, status.body]) {
        expect(body).not.toContain('test-fixture-fake');
        expect(body).not.toContain('configRef');
        expect(body).not.toContain('config_ref');
      }
    });

    it('keeps it out of the market and order responses too', async () => {
      const { client, order } = await orderIn('uk');
      for (const url of ['/markets', '/markets/uk', `/markets/uk/checkout/orders/${order.id}`]) {
        const body = (await client.get(url)).body;
        expect(body).not.toContain('test-fixture-fake');
        expect(body).not.toContain('providerCode');
      }
    });
  });
});
