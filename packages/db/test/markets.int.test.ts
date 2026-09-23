/**
 * Phase 2 market invariants, enforced by PostgreSQL itself (migration 0004).
 * Every assertion runs against a real database cloned from the migrated template.
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateUp } from '../src/migrate/runner';
import {
  MIGRATIONS_DIR,
  closeConnections,
  createBarrier,
  createTestDatabase,
  enableMarketsForTesting,
  insertFixtureUser,
  openConnections,
  type TestDatabase,
} from '../src/testing';

async function pgError(promise: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error('expected the statement to fail');
}

describe('markets (database layer)', () => {
  let database: TestDatabase;
  let client: pg.Client;

  beforeEach(async () => {
    database = await createTestDatabase();
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
  });

  afterEach(async () => {
    await client?.end();
    await database?.drop();
  });

  const setSettings = (code: string, minAge: number | null, selfExclusion: boolean | null) =>
    client.query(
      `UPDATE market_settings SET min_age = $2, self_exclusion_required = $3
        WHERE market_id = (SELECT id FROM markets WHERE code = $1)`,
      [code, minAge, selfExclusion],
    );
  const setEnabled = (code: string, enabled: boolean) =>
    client.query(`UPDATE markets SET is_enabled = $2 WHERE code = $1`, [code, enabled]);

  describe('seed', () => {
    it('creates UK, IE and DE with their fixed currency and locale, all disabled', async () => {
      const { rows } = await client.query(
        `SELECT code, name, currency, locale, is_enabled, requires_legal_approval,
                legal_approved_at, hv_market_missing_settings(id) AS missing
           FROM markets ORDER BY code`,
      );
      expect(rows).toEqual([
        {
          code: 'de',
          name: 'Germany',
          currency: 'EUR',
          locale: 'de-DE',
          is_enabled: false,
          requires_legal_approval: true,
          legal_approved_at: null,
          missing: ['min_age', 'self_exclusion_required'],
        },
        {
          code: 'ie',
          name: 'Ireland',
          currency: 'EUR',
          locale: 'en-IE',
          is_enabled: false,
          requires_legal_approval: false,
          legal_approved_at: null,
          missing: ['min_age', 'self_exclusion_required'],
        },
        {
          code: 'uk',
          name: 'United Kingdom',
          currency: 'GBP',
          locale: 'en-GB',
          is_enabled: false,
          requires_legal_approval: false,
          legal_approved_at: null,
          missing: ['min_age', 'self_exclusion_required'],
        },
      ]);
    });

    it('creates exactly one settings row per market, with every compliance value unset (OPEN O12)', async () => {
      const { rows } = await client.query(
        `SELECT m.code, s.min_age, s.self_exclusion_required
           FROM markets m JOIN market_settings s ON s.market_id = m.id ORDER BY m.code`,
      );
      expect(rows).toEqual([
        { code: 'de', min_age: null, self_exclusion_required: null },
        { code: 'ie', min_age: null, self_exclusion_required: null },
        { code: 'uk', min_age: null, self_exclusion_required: null },
      ]);
    });
  });

  describe('market definition', () => {
    it('rejects an invalid currency/market combination', async () => {
      await client.query(
        `DELETE FROM market_settings WHERE market_id = (SELECT id FROM markets WHERE code = 'ie')`,
      );
      await client.query(`DELETE FROM markets WHERE code = 'ie'`);
      for (const [code, currency, locale] of [
        ['ie', 'GBP', 'en-IE'], // wrong currency for Ireland
        ['ie', 'EUR', 'en-GB'], // wrong locale
        ['fr', 'EUR', 'fr-FR'], // not a defined market
      ]) {
        const error = await pgError(
          client.query(
            `INSERT INTO markets (code, name, currency, locale, requires_legal_approval)
             VALUES ($1, 'X', $2, $3, false)`,
            [code, currency, locale],
          ),
        );
        expect(error.constraint).toBe('markets_known_definition');
      }
      const unsupported = await pgError(
        client.query(
          `INSERT INTO markets (code, name, currency, locale, requires_legal_approval)
           VALUES ('ie', 'X', 'USD', 'en-IE', false)`,
        ),
      );
      expect(unsupported.code).toBe('23514');
    });

    it('enforces market uniqueness', async () => {
      const error = await pgError(
        client.query(
          `INSERT INTO markets (code, name, currency, locale, requires_legal_approval)
           VALUES ('uk', 'Duplicate', 'GBP', 'en-GB', false)`,
        ),
      );
      expect(error.code).toBe('23505');
      expect(error.constraint).toBe('markets_code_key');
    });

    it('makes code, currency, locale and the legal-approval requirement immutable', async () => {
      for (const assignment of [
        `currency = 'EUR'`,
        `code = 'ie'`,
        `locale = 'en-IE'`,
        `requires_legal_approval = true`,
      ]) {
        const error = await pgError(
          client.query(`UPDATE markets SET ${assignment} WHERE code = 'uk'`),
        );
        expect(error.constraint).toBe('markets_identity_immutable');
      }
      // Germany cannot be relieved of its legal gate.
      const de = await pgError(
        client.query(`UPDATE markets SET requires_legal_approval = false WHERE code = 'de'`),
      );
      expect(de.constraint).toBe('markets_identity_immutable');
    });
  });

  describe('market isolation key', () => {
    it('lets a composite foreign key on (id, currency) reject a currency that does not match the market', async () => {
      // A stand-in for draws/orders (Phases 3 and 5), which will reference markets the same way.
      await client.query(`
        CREATE TABLE scratch_orders (
          id serial PRIMARY KEY,
          market_id uuid NOT NULL,
          currency text NOT NULL,
          FOREIGN KEY (market_id, currency) REFERENCES markets (id, currency)
        )`);
      await client.query(
        `INSERT INTO scratch_orders (market_id, currency) SELECT id, 'GBP' FROM markets WHERE code = 'uk'`,
      );
      await client.query(
        `INSERT INTO scratch_orders (market_id, currency) SELECT id, 'EUR' FROM markets WHERE code = 'ie'`,
      );
      const error = await pgError(
        client.query(
          `INSERT INTO scratch_orders (market_id, currency) SELECT id, 'EUR' FROM markets WHERE code = 'uk'`,
        ),
      );
      expect(error.code).toBe('23503'); // foreign_key_violation
    });
  });

  describe('Germany legal-approval gate (layer 1)', () => {
    it('refuses to enable DE without a recorded approval, even with complete settings', async () => {
      await setSettings('de', 18, true);
      const error = await pgError(setEnabled('de', true));
      expect(error.constraint).toBe('markets_legal_approval_required');
    });

    it('requires all approval fields together', async () => {
      const userId = await insertFixtureUser(client, 'legal@example.com');
      const partial = await pgError(
        client.query(`UPDATE markets SET legal_approved_at = now() WHERE code = 'de'`),
      );
      expect(partial.constraint).toBe('markets_legal_approval_complete');
      const blankRef = await pgError(
        client.query(
          `UPDATE markets SET legal_approved_at = now(), legal_approved_by = $1, legal_approval_ref = '  ' WHERE code = 'de'`,
          [userId],
        ),
      );
      expect(blankRef.constraint).toBe('markets_legal_approval_complete');
    });

    it('allows DE only once approval AND compliance settings exist', async () => {
      const userId = await insertFixtureUser(client, 'legal@example.com');
      await client.query(
        `UPDATE markets SET legal_approved_at = now(), legal_approved_by = $1, legal_approval_ref = 'REF-1' WHERE code = 'de'`,
        [userId],
      );
      // Approved but settings unset: the compliance gate still refuses.
      expect((await pgError(setEnabled('de', true))).constraint).toBe(
        'markets_compliance_settings_required',
      );
      await setSettings('de', 18, true);
      await setEnabled('de', true);
      const { rows } = await client.query<{ is_enabled: boolean }>(
        `SELECT is_enabled FROM markets WHERE code = 'de'`,
      );
      expect(rows[0]!.is_enabled).toBe(true);
    });

    it('cannot clear the approval of an enabled legally-gated market', async () => {
      const userId = await insertFixtureUser(client, 'legal@example.com');
      await setSettings('de', 18, true);
      await client.query(
        `UPDATE markets SET legal_approved_at = now(), legal_approved_by = $1, legal_approval_ref = 'REF-1', is_enabled = true WHERE code = 'de'`,
        [userId],
      );
      const error = await pgError(
        client.query(
          `UPDATE markets SET legal_approved_at = NULL, legal_approved_by = NULL, legal_approval_ref = NULL WHERE code = 'de'`,
        ),
      );
      expect(error.constraint).toBe('markets_legal_approval_required');
    });
  });

  describe('compliance-settings gate (ADR-0016)', () => {
    it('refuses to enable a market while any required setting is unset, naming them', async () => {
      const error = await pgError(setEnabled('uk', true));
      expect(error.code).toBe('23514');
      expect(error.constraint).toBe('markets_compliance_settings_required');
      expect(error.detail).toBe('min_age,self_exclusion_required');

      await setSettings('uk', 18, null);
      expect((await pgError(setEnabled('uk', true))).detail).toBe('self_exclusion_required');
    });

    it('enables a market once every required setting is set (UK and IE need no legal approval)', async () => {
      await setSettings('uk', 18, true);
      await setSettings('ie', 18, false);
      await setEnabled('uk', true);
      await setEnabled('ie', true);
      const { rows } = await client.query<{ code: string }>(
        `SELECT code FROM markets WHERE is_enabled ORDER BY code`,
      );
      expect(rows.map((r) => r.code)).toEqual(['ie', 'uk']);
    });

    it('refuses to clear a required setting, or delete the settings, while the market is enabled', async () => {
      await enableMarketsForTesting(client, ['uk']);
      expect((await pgError(setSettings('uk', null, true))).constraint).toBe(
        'markets_compliance_settings_required',
      );
      const deletion = await pgError(
        client.query(
          `DELETE FROM market_settings WHERE market_id = (SELECT id FROM markets WHERE code = 'uk')`,
        ),
      );
      expect(deletion.constraint).toBe('markets_compliance_settings_required');
      // Once disabled, the setting may be cleared again.
      await setEnabled('uk', false);
      await setSettings('uk', null, true);
    });

    it('validates the setting values themselves', async () => {
      expect((await pgError(setSettings('uk', 0, true))).constraint).toBe(
        'market_settings_min_age_range',
      );
      expect((await pgError(setSettings('uk', 150, true))).constraint).toBe(
        'market_settings_min_age_range',
      );
    });

    it('never lets a concurrent "enable" and "clear setting" both commit (no write skew)', async () => {
      // Each round races the two transactions from separate connections.
      // Whatever the interleaving, an enabled market must end with complete settings.
      const [a, b] = await openConnections(database.url, 2);
      try {
        for (let round = 0; round < 25; round++) {
          await setEnabled('uk', false);
          await setSettings('uk', 18, true);
          const barrier = createBarrier(2);
          const race = async (conn: pg.Client, statement: string) => {
            await conn.query('BEGIN');
            await barrier();
            try {
              await conn.query(statement);
              await conn.query('COMMIT');
              return 'committed';
            } catch {
              await conn.query('ROLLBACK');
              return 'rejected';
            }
          };
          const results = await Promise.all([
            race(a!, `UPDATE markets SET is_enabled = true WHERE code = 'uk'`),
            race(
              b!,
              `UPDATE market_settings SET min_age = NULL
                WHERE market_id = (SELECT id FROM markets WHERE code = 'uk')`,
            ),
          ]);
          const { rows } = await client.query<{ is_enabled: boolean; missing: number }>(
            `SELECT m.is_enabled, cardinality(hv_market_missing_settings(m.id)) AS missing
               FROM markets m WHERE code = 'uk'`,
          );
          expect(
            rows[0]!.is_enabled && rows[0]!.missing > 0,
            `round ${round}: ${results.join('/')}`,
          ).toBe(false);
          // Exactly one of the two can win.
          expect(results.filter((r) => r === 'committed')).toHaveLength(1);
        }
      } finally {
        await closeConnections([a!, b!]);
      }
    });
  });
});

describe('runtime role privileges (production-style provisioning)', () => {
  // Reproduces how environments provision hv_app: default privileges for tables
  // created by hv_owner, then the real migrations. Proves the REVOKEs in the
  // migrations take effect on top of those defaults.
  let database: TestDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    database = await createTestDatabase({ migrated: false });
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hv_app`,
    );
    await migrateUp({ connectionString: database.url, migrationsDir: MIGRATIONS_DIR });
  });

  afterAll(async () => {
    await client?.end();
    await database?.drop();
  });

  const privileges = async (table: string) => {
    const { rows } = await client.query<Record<string, boolean>>(
      `SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
        .map((p) => `has_table_privilege('hv_app', $1, '${p}') AS "${p}"`)
        .join(', ')}`,
      [table],
    );
    return rows[0];
  };

  it('can read and change the market gate, but never create or delete markets', async () => {
    for (const table of ['markets', 'market_settings']) {
      expect(await privileges(table)).toEqual({
        SELECT: true,
        INSERT: false,
        UPDATE: true,
        DELETE: false,
        TRUNCATE: false,
      });
    }
  });

  it('can only read roles, permissions and the role matrix', async () => {
    for (const table of ['roles', 'permissions', 'role_permissions']) {
      expect(await privileges(table)).toEqual({
        SELECT: true,
        INSERT: false,
        UPDATE: false,
        DELETE: false,
        TRUNCATE: false,
      });
    }
  });

  it('can only append to the audit log', async () => {
    expect(await privileges('audit_log')).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    });
  });

  it('can create and change draws, but never delete them (they are cancelled instead)', async () => {
    expect(await privileges('draws')).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: true,
      DELETE: false,
      TRUNCATE: false,
    });
    for (const table of ['draw_prizes', 'skill_questions', 'skill_question_options']) {
      expect(await privileges(table)).toMatchObject({
        SELECT: true,
        INSERT: true,
        UPDATE: true,
        DELETE: true,
      });
    }
  });

  it('can hold and free tickets, but never delete tickets, reservations or entry counts', async () => {
    for (const table of ['tickets', 'reservations', 'draw_entrant_counts']) {
      expect(await privileges(table)).toEqual({
        SELECT: true,
        INSERT: true,
        UPDATE: true,
        DELETE: false,
        TRUNCATE: false,
      });
    }
  });

  it('has ordinary DML on identity tables', async () => {
    for (const table of ['users', 'sessions', 'user_mfa', 'mfa_recovery_codes', 'user_roles']) {
      expect(await privileges(table)).toMatchObject({ SELECT: true, INSERT: true, UPDATE: true });
    }
  });
});
