/**
 * Market terms against real PostgreSQL (migration 0015, task P5-6).
 *
 * Terms are versioned per market, and an order will be placed under the
 * version the customer agreed to. Most of this file is about the two things
 * that makes necessary: that a published version cannot change underneath an
 * acceptance, and that one market's terms can never be read or accepted as
 * another's.
 *
 * There is no legal wording anywhere here. Version labels are test fixtures.
 */
import {
  AdminTermsListResponseSchema,
  AdminTermsVersionResponseSchema,
  ErrorResponseSchema,
  MarketTermsResponseSchema,
  TermsAcceptanceResponseSchema,
} from '@hv/contracts';
import {
  SecretBox,
  VERIFICATION_EMAIL_TOPIC,
  openPayload,
  type VerificationEmailPayload,
} from '@hv/domain';
import {
  enableGermanyForTesting,
  enableMarketsForTesting,
  insertFixtureUser,
} from '@hv/db/testing';
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

/** Test fixture labels. Not legal wording, and not a wording convention. */
const label = (n: number) => `test-fixture-v${n}`;

const termsOf = (response: { json: () => unknown }) =>
  MarketTermsResponseSchema.parse(response.json());
const versionOf = (response: { json: () => unknown }) =>
  AdminTermsVersionResponseSchema.parse(response.json()).version;
const acceptanceOf = (response: { json: () => unknown }) =>
  TermsAcceptanceResponseSchema.parse(response.json()).acceptance;
const errorCode = (response: { json: () => unknown }) =>
  ErrorResponseSchema.parse(response.json()).error.code;

describe('market terms', () => {
  let h: Harness;
  let admin: Client & { email: string };
  let counter = 0;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie,de', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk', 'ie']);
    admin = await registeredClient(h.app, uniqueEmail('terms-admin'));
    await grantRole(h.sql, admin.email, 'super_admin');
    // Enrolment counts as a fresh step-up; every terms mutation is sensitive.
    await enrolMfa(admin);
  });

  afterAll(async () => {
    await h?.close();
  });

  let ip: string;
  beforeEach(() => {
    ip = randomIp();
  });

  const inject = (method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      remoteAddress: ip,
      headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  /** Creates, publishes and activates a version, returning it. */
  const activeVersionIn = async (market: string) => {
    const version = label(++counter);
    const created = versionOf(
      await admin.post(`/admin/markets/${market}/terms`, {
        version,
        publish: true,
        reason: 'Integration test fixture.',
      }),
    );
    const activated = await admin.post(`/admin/markets/${market}/terms/${created.id}/activate`, {
      reason: 'Integration test fixture.',
    });
    expect(activated.statusCode).toBe(200);
    return versionOf(activated);
  };

  const guestCookieFrom = (response: { headers: Record<string, unknown> }) => {
    const raw = response.headers['set-cookie'] as string | string[] | undefined;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = value ? new RegExp(`${GUEST_SESSION_COOKIE}=([^;]*)`).exec(value) : null;
    return match ? `${GUEST_SESSION_COOKIE}=${match[1]}` : null;
  };

  const verifiedGuest = async (market = 'uk') => {
    const email = uniqueEmail('terms-guest');
    const requested = await inject('POST', `/markets/${market}/checkout/email/code`, undefined, {
      email,
    });
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
    const verified = await inject('POST', `/markets/${market}/checkout/email/verify`, cookie, {
      email,
      code,
    });
    expect(verified.statusCode).toBe(200);
    return cookie;
  };

  // ---- publishing ----------------------------------------------------------

  describe('publishing a version', () => {
    it('creates a draft, publishes it, then makes it active', async () => {
      const version = label(++counter);
      const created = versionOf(
        await admin.post('/admin/markets/uk/terms', { version, reason: 'Staged for review.' }),
      );
      expect(created).toMatchObject({ version, publishedAt: null, active: false });

      const published = versionOf(
        await admin.post(`/admin/markets/uk/terms/${created.id}/publish`, { reason: 'Approved.' }),
      );
      expect(published.publishedAt).not.toBeNull();

      const activated = versionOf(
        await admin.post(`/admin/markets/uk/terms/${created.id}/activate`, { reason: 'Live.' }),
      );
      expect(activated.active).toBe(true);
    });

    it('refuses to activate a version that was never published', async () => {
      const draft = versionOf(
        await admin.post('/admin/markets/uk/terms', {
          version: label(++counter),
          reason: 'Draft only.',
        }),
      );
      const response = await admin.post(`/admin/markets/uk/terms/${draft.id}/activate`, {
        reason: 'Too soon.',
      });
      expect(response.statusCode).toBe(409);
    });

    it('refuses a duplicate label within a market', async () => {
      const version = label(++counter);
      await admin.post('/admin/markets/uk/terms', { version, reason: 'First.' });
      const again = await admin.post('/admin/markets/uk/terms', { version, reason: 'Again.' });
      expect(again.statusCode).toBe(409);
    });

    it('allows the same label in a different market', async () => {
      const version = label(++counter);
      expect(
        (await admin.post('/admin/markets/uk/terms', { version, reason: 'UK.' })).statusCode,
      ).toBe(201);
      expect(
        (await admin.post('/admin/markets/ie/terms', { version, reason: 'IE.' })).statusCode,
      ).toBe(201);
    });

    it('records every change in the audit log', async () => {
      const created = versionOf(
        await admin.post('/admin/markets/uk/terms', {
          version: label(++counter),
          publish: true,
          reason: 'Audited.',
        }),
      );
      await admin.post(`/admin/markets/uk/terms/${created.id}/activate`, { reason: 'Audited.' });
      const { rows } = await h.sql.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at`,
        [created.id],
      );
      expect(rows.map((r) => r.action)).toEqual(['market.terms.created', 'market.terms.activated']);
    });

    it('requires a reason', async () => {
      const response = await admin.post('/admin/markets/uk/terms', { version: label(++counter) });
      expect(response.statusCode).toBe(400);
    });

    it('is refused without the permission', async () => {
      const nobody = await registeredClient(h.app);
      const response = await nobody.post('/admin/markets/uk/terms', {
        version: label(++counter),
        reason: 'Not allowed.',
      });
      expect(response.statusCode).toBe(403);
    });

    it('is refused to a guest cookie', async () => {
      const cookie = await verifiedGuest();
      const response = await inject('POST', '/admin/markets/uk/terms', cookie, {
        version: label(++counter),
        reason: 'Not allowed.',
      });
      expect([401, 403]).toContain(response.statusCode);
    });
  });

  // ---- immutability --------------------------------------------------------

  describe('a published version is settled', () => {
    it('cannot be renamed or unpublished, even in SQL', async () => {
      const active = await activeVersionIn('uk');
      await expect(
        h.sql.query(`UPDATE terms_versions SET version = 'rewritten' WHERE id = $1`, [active.id]),
      ).rejects.toThrow(/immutable/);
      await expect(
        h.sql.query(`UPDATE terms_versions SET published_at = NULL WHERE id = $1`, [active.id]),
      ).rejects.toThrow(/published once/);
    });

    it('cannot be published twice', async () => {
      const created = versionOf(
        await admin.post('/admin/markets/uk/terms', {
          version: label(++counter),
          publish: true,
          reason: 'Already live.',
        }),
      );
      const again = await admin.post(`/admin/markets/uk/terms/${created.id}/publish`, {
        reason: 'Again.',
      });
      expect(again.statusCode).toBe(409);
    });
  });

  // ---- the customer read path ---------------------------------------------

  describe('what a customer sees', () => {
    it('reports no terms, and no checkout, before one is activated', async () => {
      // A market with nothing activated yet: IE is untouched until its own tests.
      const fresh = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
      try {
        await enableMarketsForTesting(fresh.sql, ['uk']);
        const response = await fresh.app.inject({ method: 'GET', url: '/markets/uk/terms' });
        const terms = MarketTermsResponseSchema.parse(response.json());
        expect(terms.active).toBeNull();
        // This is the flag P5-7's gate turns on. The market is still browsable.
        expect(terms.checkoutAllowed).toBe(false);
        expect(terms.accepted).toBeNull();
      } finally {
        await fresh.close();
      }
    });

    it('is readable with no identity at all', async () => {
      const active = await activeVersionIn('uk');
      const terms = termsOf(await inject('GET', '/markets/uk/terms'));
      expect(terms.active?.version).toBe(active.version);
      expect(terms.checkoutAllowed).toBe(true);
      expect(terms.accepted).toBeNull();
    });

    it('carries no wording, because the content is legal’s', async () => {
      await activeVersionIn('uk');
      const body: Record<string, unknown> = (await inject('GET', '/markets/uk/terms')).json();
      const active = (body.active ?? {}) as Record<string, unknown>;
      expect(Object.keys(active).sort()).toEqual(
        ['createdAt', 'id', 'market', 'publishedAt', 'version'].sort(),
      );
    });
  });

  // ---- acceptance ----------------------------------------------------------

  describe('accepting', () => {
    it('records a signed-in customer’s acceptance', async () => {
      const active = await activeVersionIn('uk');
      const client = await registeredClient(h.app);
      const response = await client.post('/markets/uk/terms/acceptance', {
        version: active.version,
      });
      expect(response.statusCode).toBe(201);
      expect(acceptanceOf(response)).toMatchObject({
        acceptedBy: 'user',
        termsVersion: { version: active.version },
      });
      expect(termsOf(await client.get('/markets/uk/terms')).accepted).toBe(true);
    });

    it('records a verified guest’s acceptance without creating an account', async () => {
      const active = await activeVersionIn('uk');
      const before = await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
      const cookie = await verifiedGuest();

      const response = await inject('POST', '/markets/uk/terms/acceptance', cookie, {
        version: active.version,
      });
      expect(response.statusCode).toBe(201);
      expect(acceptanceOf(response).acceptedBy).toBe('guest');

      const { rows } = await h.sql.query<{ user_id: string | null; guest_session_id: string }>(
        `SELECT user_id, guest_session_id FROM terms_acceptances
          WHERE terms_version_id = $1 AND guest_session_id IS NOT NULL`,
        [active.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.user_id).toBeNull();
      // Verifying an email creates no user, and neither does accepting terms.
      const after = await h.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it('is idempotent: accepting twice is one acceptance', async () => {
      const active = await activeVersionIn('uk');
      const client = await registeredClient(h.app);
      await client.post('/markets/uk/terms/acceptance', { version: active.version });
      const second = await client.post('/markets/uk/terms/acceptance', {
        version: active.version,
      });
      expect(second.statusCode).toBe(201);

      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM terms_acceptances ta
           JOIN users u ON u.id = ta.user_id
          WHERE ta.terms_version_id = $1 AND u.email = $2`,
        [active.id, client.email],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('refuses a version that is no longer the active one', async () => {
      const first = await activeVersionIn('uk');
      await activeVersionIn('uk');
      const client = await registeredClient(h.app);
      const response = await client.post('/markets/uk/terms/acceptance', {
        version: first.version,
      });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('TERMS_VERSION_STALE');
    });

    it('refuses when the market has no active terms', async () => {
      const fresh = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
      try {
        await enableMarketsForTesting(fresh.sql, ['uk']);
        const client = await registeredClient(fresh.app);
        const response = await client.post('/markets/uk/terms/acceptance', { version: 'anything' });
        expect(response.statusCode).toBe(409);
        expect(errorCode(response)).toBe('TERMS_UNAVAILABLE');
      } finally {
        await fresh.close();
      }
    });

    it('refuses a caller with no identity', async () => {
      const active = await activeVersionIn('uk');
      const response = await inject('POST', '/markets/uk/terms/acceptance', undefined, {
        version: active.version,
      });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('CHECKOUT_IDENTITY_REQUIRED');
    });

    it('refuses unknown fields', async () => {
      const active = await activeVersionIn('uk');
      const client = await registeredClient(h.app);
      const response = await client.post('/markets/uk/terms/acceptance', {
        version: active.version,
        acceptedBy: 'someone-else',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ---- market isolation ----------------------------------------------------

  describe('terms belong to one market', () => {
    it('never returns UK terms as IE terms', async () => {
      const uk = await activeVersionIn('uk');
      const ie = await activeVersionIn('ie');
      expect(uk.version).not.toBe(ie.version);
      expect(termsOf(await inject('GET', '/markets/uk/terms')).active?.id).toBe(uk.id);
      expect(termsOf(await inject('GET', '/markets/ie/terms')).active?.id).toBe(ie.id);
    });

    it('does not count a UK acceptance as an IE one', async () => {
      const uk = await activeVersionIn('uk');
      await activeVersionIn('ie');
      const client = await registeredClient(h.app);
      await client.post('/markets/uk/terms/acceptance', { version: uk.version });

      expect(termsOf(await client.get('/markets/uk/terms')).accepted).toBe(true);
      expect(termsOf(await client.get('/markets/ie/terms')).accepted).toBe(false);
    });

    it('will not let a market point at another market’s version, even in SQL', async () => {
      const ie = await activeVersionIn('ie');
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'uk'`,
      );
      await expect(
        h.sql.query(
          `UPDATE market_settings SET active_terms_version_id = $1 WHERE market_id = $2`,
          [ie.id, rows[0]!.id],
        ),
      ).rejects.toThrow();
    });

    it('refuses a version id from another market through the admin route', async () => {
      const ie = await activeVersionIn('ie');
      const response = await admin.post(`/admin/markets/uk/terms/${ie.id}/activate`, {
        reason: 'Wrong market.',
      });
      expect(response.statusCode).toBe(404);
    });

    it('lists only its own market’s versions', async () => {
      await activeVersionIn('uk');
      await activeVersionIn('ie');
      const uk = AdminTermsListResponseSchema.parse(
        (await admin.get('/admin/markets/uk/terms')).json(),
      ).versions;
      expect(uk.every((v) => v.market === 'uk')).toBe(true);
      expect(uk.filter((v) => v.active)).toHaveLength(1);
    });

    it('refuses a market that is not available', async () => {
      expect((await inject('GET', '/markets/de/terms')).statusCode).toBe(404);
    });
  });

  // ---- the schema holds the line ------------------------------------------

  describe('the schema, not just the API', () => {
    it('refuses an acceptance owned by both a user and a guest session', async () => {
      const active = await activeVersionIn('uk');
      const { rows: markets } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'uk'`,
      );
      const { rows: users } = await h.sql.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
      const { rows: guests } = await h.sql.query<{ id: string }>(
        `SELECT id FROM guest_sessions LIMIT 1`,
      );
      await expect(
        h.sql.query(
          `INSERT INTO terms_acceptances (market_id, terms_version_id, user_id, guest_session_id)
           VALUES ($1, $2, $3, $4)`,
          [markets[0]!.id, active.id, users[0]!.id, guests[0]!.id],
        ),
      ).rejects.toThrow(/terms_acceptances_one_identity/);
    });

    it('refuses an acceptance owned by nobody', async () => {
      const active = await activeVersionIn('uk');
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'uk'`,
      );
      await expect(
        h.sql.query(`INSERT INTO terms_acceptances (market_id, terms_version_id) VALUES ($1, $2)`, [
          rows[0]!.id,
          active.id,
        ]),
      ).rejects.toThrow(/terms_acceptances_one_identity/);
    });

    it('refuses an acceptance filed under the wrong market', async () => {
      const uk = await activeVersionIn('uk');
      const { rows } = await h.sql.query<{ id: string }>(
        `SELECT id FROM markets WHERE code = 'ie'`,
      );
      const { rows: users } = await h.sql.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
      await expect(
        h.sql.query(
          `INSERT INTO terms_acceptances (market_id, terms_version_id, user_id)
           VALUES ($1, $2, $3)`,
          [rows[0]!.id, uk.id, users[0]!.id],
        ),
      ).rejects.toThrow();
    });

    it('never lets an acceptance be rewritten', async () => {
      const active = await activeVersionIn('uk');
      const client = await registeredClient(h.app);
      await client.post('/markets/uk/terms/acceptance', { version: active.version });
      await expect(
        h.sql.query(
          `UPDATE terms_acceptances SET accepted_at = now() WHERE terms_version_id = $1`,
          [active.id],
        ),
      ).rejects.toThrow(/cannot be changed/);
    });

    it('gives hv_app no way to erase terms or acceptances', async () => {
      const { rows } = await h.sql.query<{ relname: string; del: boolean; upd: boolean }>(
        `SELECT c.relname,
                has_table_privilege('hv_app', c.oid, 'DELETE') AS del,
                has_table_privilege('hv_app', c.oid, 'UPDATE') AS upd
           FROM pg_class c WHERE c.relname IN ('terms_versions', 'terms_acceptances')
          ORDER BY c.relname`,
      );
      const acceptances = rows.find((r) => r.relname === 'terms_acceptances')!;
      const versions = rows.find((r) => r.relname === 'terms_versions')!;
      expect(acceptances.del).toBe(false);
      expect(acceptances.upd).toBe(false);
      // Versions are still updatable, because publishing is an update.
      expect(versions.del).toBe(false);
      expect(versions.upd).toBe(true);
    });

    it('leaves the market-enablement gate alone', async () => {
      // ADR-0031: terms gate checkout, not enablement. A market with no active
      // terms is still enabled and still browsable.
      const { rows } = await h.sql.query<{ missing: string[] }>(
        `SELECT hv_market_missing_settings(id) AS missing FROM markets WHERE code = 'ie'`,
      );
      expect(rows[0]!.missing ?? []).not.toContain('active_terms_version_id');
    });
  });
});

/** Germany stays refused whatever terms exist. */
describe('the German gate is unaffected by terms', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
    await enableMarketsForTesting(h.sql, ['uk']);
    await enableGermanyForTesting(
      h.sql,
      await insertFixtureUser(h.sql, 'de-approver-terms@example.com'),
    );
  });

  afterAll(async () => {
    await h?.close();
  });

  it('refuses German terms even when the market row is enabled', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/markets/de/terms' });
    expect(response.statusCode).toBe(404);
  });
});
