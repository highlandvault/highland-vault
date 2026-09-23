/**
 * RBAC (deny by default), sensitive operations (permission + step-up MFA +
 * reason + audit in the same transaction) and market gate management, against
 * real PostgreSQL and Redis. The API is called directly: no UI is involved.
 */
import {
  AdminMarketListResponseSchema,
  AdminMarketResponseSchema,
  ErrorResponseSchema,
} from '@hv/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Client,
  type Harness,
  enrolMfa,
  grantRole,
  registeredClient,
  startHarness,
} from './support';

const errorCode = (response: { json: () => unknown }) =>
  ErrorResponseSchema.parse(response.json()).error.code;

const REASON = { reason: 'Integration test: gate change' };

interface AuditRow {
  actor_type: string;
  actor_user_id: string | null;
  entity_type: string;
  reason: string | null;
  request_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
}

interface AuditRow {
  actor_type: string;
  actor_user_id: string | null;
  entity_type: string;
  reason: string | null;
  request_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
}

describe('admin market gate management', () => {
  let h: Harness;
  let superAdmin: Client & { email: string };

  beforeAll(async () => {
    // DE is deliberately NOT in ENABLED_MARKETS here.
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie' });
    superAdmin = await registeredClient(h.app);
    await grantRole(h.sql, superAdmin.email, 'super_admin');
    await enrolMfa(superAdmin); // enrolment counts as a fresh step-up (valid 15 minutes)
  });

  afterAll(async () => {
    await h?.close();
  });

  const auditRows = async (action: string, marketCode: string) =>
    (
      await h.sql.query<AuditRow>(
        `SELECT a.* FROM audit_log a JOIN markets m ON m.id = a.market_id
          WHERE a.action = $1 AND m.code = $2 ORDER BY a.occurred_at`,
        [action, marketCode],
      )
    ).rows;

  describe('access control', () => {
    it('requires a session', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/admin/markets' });
      expect(response.statusCode).toBe(401);
    });

    it('denies customers (no admin permission)', async () => {
      const customer = await registeredClient(h.app);
      expect(errorCode(await customer.get('/admin/markets'))).toBe('FORBIDDEN');
      expect(errorCode(await customer.post('/admin/markets/uk/enable', REASON))).toBe('FORBIDDEN');
    });

    it('lets any staff role read gate state, but only markets.gate.manage change it', async () => {
      const support = await registeredClient(h.app);
      await grantRole(h.sql, support.email, 'support');
      const list = await support.get('/admin/markets');
      expect(list.statusCode).toBe(200);
      const markets = AdminMarketListResponseSchema.parse(list.json()).markets;
      expect(markets.map((m) => m.code)).toEqual(['de', 'ie', 'uk']);
      expect(markets.find((m) => m.code === 'de')).toMatchObject({
        isEnabled: false,
        environmentAllowed: false,
        available: false,
        requiresLegalApproval: true,
        legalApproval: null,
        missingSettings: ['min_age', 'self_exclusion_required'],
      });

      // Even with MFA, support lacks the permission.
      await enrolMfa(support);
      expect(errorCode(await support.post('/admin/markets/uk/enable', REASON))).toBe('FORBIDDEN');
    });

    it('requires step-up MFA for sensitive operations', async () => {
      // A super_admin without MFA has the permission but no second factor.
      const noMfa = await registeredClient(h.app);
      await grantRole(h.sql, noMfa.email, 'super_admin');
      const response = await noMfa.post('/admin/markets/uk/disable', REASON);
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('STEP_UP_REQUIRED');
    });

    it('expires step-up after 15 minutes and accepts a fresh one', async () => {
      const admin = await registeredClient(h.app);
      await grantRole(h.sql, admin.email, 'super_admin');
      const { authenticator } = await enrolMfa(admin);
      await h.sql.query(
        `UPDATE sessions SET mfa_verified_at = now() - interval '16 minutes'
          WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        [admin.email],
      );
      expect(errorCode(await admin.post('/admin/markets/uk/disable', REASON))).toBe(
        'STEP_UP_REQUIRED',
      );
      expect(
        (await admin.post('/auth/mfa/verify', { code: authenticator.next() })).statusCode,
      ).toBe(200);
      expect((await admin.post('/admin/markets/uk/disable', REASON)).statusCode).toBe(200);
    });

    it('requires a reason for every sensitive operation', async () => {
      for (const body of [{}, { reason: '' }, { reason: '  ' }]) {
        const response = await superAdmin.post('/admin/markets/uk/enable', body);
        expect(response.statusCode).toBe(400);
        expect(errorCode(response)).toBe('VALIDATION_FAILED');
      }
    });

    it('answers 404 for an unknown market', async () => {
      expect((await superAdmin.post('/admin/markets/xx/enable', REASON)).statusCode).toBe(404);
    });
  });

  describe('compliance-settings gate', () => {
    it('refuses to enable UK while settings are unset, and changes nothing', async () => {
      const response = await superAdmin.post('/admin/markets/uk/enable', REASON);
      expect(response.statusCode).toBe(409);
      const body = ErrorResponseSchema.parse(response.json());
      expect(body.error.code).toBe('COMPLIANCE_SETTINGS_MISSING');
      expect(body.error.details).toEqual({
        missingSettings: ['min_age', 'self_exclusion_required'],
      });
      expect(await auditRows('market.enabled', 'uk')).toHaveLength(0);
      expect((await h.app.inject({ method: 'GET', url: '/markets/uk' })).statusCode).toBe(404);
    });

    it('records settings entered by staff, audited with before/after, actor, reason and request id', async () => {
      const response = await superAdmin.put('/admin/markets/uk/settings', {
        minAge: 18,
        selfExclusionRequired: true,
        reason: 'Values supplied for the integration test',
      });
      expect(response.statusCode).toBe(200);
      const market = AdminMarketResponseSchema.parse(response.json()).market;
      expect(market.settings).toEqual({ minAge: 18, selfExclusionRequired: true });
      expect(market.missingSettings).toEqual([]);

      const row = (await auditRows('market.settings.updated', 'uk'))[0]!;
      expect(row).toMatchObject({
        actor_type: 'user',
        entity_type: 'market',
        reason: 'Values supplied for the integration test',
        request_id: response.headers['x-request-id'],
      });
      expect(row.before).toMatchObject({ minAge: null, selfExclusionRequired: null });
      expect(row.after).toMatchObject({ minAge: 18, selfExclusionRequired: true });
      expect(row.actor_user_id).toBeTruthy();
      expect(row.ip).toBe(superAdmin.ip);
    });

    it('enables UK once its settings exist; the public API then serves it', async () => {
      const response = await superAdmin.post('/admin/markets/uk/enable', REASON);
      expect(response.statusCode).toBe(200);
      expect(AdminMarketResponseSchema.parse(response.json()).market).toMatchObject({
        isEnabled: true,
        environmentAllowed: true,
        available: true,
      });
      expect(await auditRows('market.enabled', 'uk')).toHaveLength(1);
      expect((await h.app.inject({ method: 'GET', url: '/markets/uk' })).statusCode).toBe(200);
    });

    it('refuses to clear a required setting of an enabled market (database trigger → 409)', async () => {
      const response = await superAdmin.put('/admin/markets/uk/settings', {
        minAge: null,
        selfExclusionRequired: true,
        reason: 'Attempt to clear a required value',
      });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('COMPLIANCE_SETTINGS_MISSING');
      const { rows } = await h.sql.query<{ min_age: number | null }>(
        `SELECT s.min_age FROM market_settings s JOIN markets m ON m.id = s.market_id WHERE m.code = 'uk'`,
      );
      expect(rows[0]!.min_age).toBe(18);
    });

    it('disables UK again, audited, and the public API stops serving it', async () => {
      expect((await superAdmin.post('/admin/markets/uk/disable', REASON)).statusCode).toBe(200);
      expect((await h.app.inject({ method: 'GET', url: '/markets/uk' })).statusCode).toBe(404);
      expect((await auditRows('market.disabled', 'uk')).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Germany gate (sensitive operation)', () => {
    it('refuses legal approval for markets that do not need it', async () => {
      const response = await superAdmin.post('/admin/markets/ie/legal-approval', {
        reference: 'N/A',
        ...REASON,
      });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('LEGAL_APPROVAL_NOT_APPLICABLE');
    });

    it('refuses to enable DE without a recorded legal approval, even with complete settings', async () => {
      await superAdmin.put('/admin/markets/de/settings', {
        minAge: 18,
        selfExclusionRequired: true,
        reason: 'Test values for the Germany gate test',
      });
      const response = await superAdmin.post('/admin/markets/de/enable', REASON);
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('LEGAL_APPROVAL_REQUIRED');
      expect(await auditRows('market.enabled', 'de')).toHaveLength(0);
    });

    it('records a legal approval once, then enables DE — which the API still refuses while ENABLED_MARKETS excludes it', async () => {
      const approval = await superAdmin.post('/admin/markets/de/legal-approval', {
        reference: 'TEST-FIXTURE-NOT-A-REAL-APPROVAL',
        ...REASON,
      });
      expect(approval.statusCode).toBe(200);
      const approved = AdminMarketResponseSchema.parse(approval.json()).market;
      expect(approved.legalApproval).toMatchObject({
        reference: 'TEST-FIXTURE-NOT-A-REAL-APPROVAL',
      });

      const twice = await superAdmin.post('/admin/markets/de/legal-approval', {
        reference: 'SECOND',
        ...REASON,
      });
      expect(errorCode(twice)).toBe('LEGAL_APPROVAL_ALREADY_RECORDED');

      const enable = await superAdmin.post('/admin/markets/de/enable', REASON);
      expect(enable.statusCode).toBe(200);
      expect(AdminMarketResponseSchema.parse(enable.json()).market).toMatchObject({
        isEnabled: true,
        environmentAllowed: false,
        available: false,
      });
      // Layer 2 still holds: this API instance does not list DE.
      const publicDe = await h.app.inject({ method: 'GET', url: '/markets/de' });
      expect(publicDe.statusCode).toBe(404);
      expect(errorCode(publicDe)).toBe('MARKET_NOT_AVAILABLE');

      expect(await auditRows('market.legal_approval.recorded', 'de')).toHaveLength(1);
      expect(await auditRows('market.enabled', 'de')).toHaveLength(1);
    });
  });

  describe('market-scoped staff (isolation)', () => {
    it('lets a UK-scoped administrator manage UK but not IE or DE', async () => {
      const ukAdmin = await registeredClient(h.app);
      await grantRole(h.sql, ukAdmin.email, 'super_admin', 'uk');
      await enrolMfa(ukAdmin);

      expect((await ukAdmin.post('/admin/markets/uk/disable', REASON)).statusCode).toBe(200);
      for (const other of ['ie', 'de']) {
        const response = await ukAdmin.post(`/admin/markets/${other}/disable`, REASON);
        expect(response.statusCode).toBe(403);
        expect(errorCode(response)).toBe('FORBIDDEN');
      }
      const me = (await ukAdmin.get('/auth/me')).json<{
        permissions: { permission: string; market: string | null }[];
      }>();
      expect(me.permissions).toContainEqual({ permission: 'markets.gate.manage', market: 'uk' });
      // Every staff permission of this account is scoped to UK only.
      expect(me.permissions.every((p) => p.market === 'uk')).toBe(true);
    });
  });

  it('leaves an audit trail that cannot be rewritten', async () => {
    await expect(h.sql.query(`UPDATE audit_log SET reason = 'x'`)).rejects.toThrow(/append-only/);
  });
});
