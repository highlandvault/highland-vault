/**
 * Phase 2 identity, RBAC and audit invariants enforced by PostgreSQL
 * (migrations 0003, 0005, 0006, 0007).
 */
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_PASSWORD_HASH,
  createTestDatabase,
  insertFixtureUser,
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

const tokenHash = () => createHash('sha256').update(randomBytes(32)).digest();

describe('identity, RBAC and audit (database layer)', () => {
  let database: TestDatabase;
  let client: pg.Client;

  beforeAll(async () => {
    database = await createTestDatabase();
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await database?.drop();
  });

  const insertUser = (email: string, hash = FIXTURE_PASSWORD_HASH) =>
    client.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`, [
      email,
      hash,
    ]);

  describe('users', () => {
    it('has no market column: accounts are market-independent (ADR-0003)', async () => {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
      );
      expect(rows.map((r) => r.column_name)).not.toContain('market_id');
    });

    it('makes email globally unique, case-insensitively', async () => {
      await insertUser('unique@example.com');
      const error = await pgError(insertUser('unique@example.com'));
      expect(error.constraint).toBe('users_email_key');
      // citext equality: a lookup in any case finds the one row.
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE email = 'UNIQUE@Example.com'`,
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('only stores the normalized form of an email', async () => {
      expect((await pgError(insertUser('Upper@example.com'))).constraint).toBe(
        'users_email_normalized',
      );
      // Surrounding whitespace also breaks the shape check; either constraint refuses it.
      for (const email of [' padded@example.com', 'tail@example.com ']) {
        expect(['users_email_normalized', 'users_email_format']).toContain(
          (await pgError(insertUser(email))).constraint,
        );
      }
    });

    it('rejects strings that are not email-shaped', async () => {
      for (const email of ['no-at-sign', 'two@@example.com', 'sp ace@example.com', '@x']) {
        expect((await pgError(insertUser(email))).code).toBe('23514');
      }
    });

    it('accepts only Argon2id password hashes (never plaintext)', async () => {
      const error = await pgError(insertUser('plain@example.com', 'hunter2hunter2'));
      expect(error.constraint).toBe('users_password_hash_argon2id');
    });

    it('restricts status to known values and defaults to active', async () => {
      const { rows } = await client.query<{ status: string }>(
        `INSERT INTO users (email, password_hash) VALUES ('status@example.com', $1) RETURNING status, created_at, updated_at`,
        [FIXTURE_PASSWORD_HASH],
      );
      expect(rows[0]!.status).toBe('active');
      const error = await pgError(
        client.query(`UPDATE users SET status = 'banned' WHERE email = 'status@example.com'`),
      );
      expect(error.constraint).toBe('users_status_valid');
    });

    it('stamps updated_at on every update (hv_set_updated_at)', async () => {
      const id = await insertFixtureUser(client, 'stamp@example.com');
      await client.query(`BEGIN`);
      await client.query(`SELECT pg_sleep(0.01)`);
      const { rows } = await client.query<{ created_at: Date; updated_at: Date; tx_now: Date }>(
        `UPDATE users SET status = 'disabled' WHERE id = $1 RETURNING created_at, updated_at, now() AS tx_now`,
        [id],
      );
      await client.query(`COMMIT`);
      const row = rows[0]!;
      expect(row.updated_at.getTime()).toBe(row.tx_now.getTime());
      expect(row.updated_at.getTime()).toBeGreaterThan(row.created_at.getTime());
    });
  });

  describe('sessions', () => {
    it('stores only a 32-byte token hash, unique across sessions', async () => {
      const userId = await insertFixtureUser(client, 'session@example.com');
      const hash = tokenHash();
      const insert = (h: Buffer) =>
        client.query(
          `INSERT INTO sessions (token_hash, user_id, mfa_required, expires_at)
           VALUES ($1, $2, false, now() + interval '1 hour')`,
          [h, userId],
        );
      await insert(hash);
      expect((await pgError(insert(hash))).constraint).toBe('sessions_token_hash_key');
      expect((await pgError(insert(Buffer.from('short')))).constraint).toBe(
        'sessions_token_hash_sha256',
      );
    });

    it('requires an existing user and an expiry after creation', async () => {
      const orphan = await pgError(
        client.query(
          `INSERT INTO sessions (token_hash, user_id, mfa_required, expires_at)
           VALUES ($1, gen_random_uuid(), false, now() + interval '1 hour')`,
          [tokenHash()],
        ),
      );
      expect(orphan.code).toBe('23503');
      const userId = await insertFixtureUser(client, 'expiry@example.com');
      const expired = await pgError(
        client.query(
          `INSERT INTO sessions (token_hash, user_id, mfa_required, expires_at) VALUES ($1, $2, false, now())`,
          [tokenHash(), userId],
        ),
      );
      expect(expired.constraint).toBe('sessions_expires_after_created');
    });
  });

  describe('MFA storage', () => {
    it('keeps recovery codes unique per user and hash-sized', async () => {
      const userId = await insertFixtureUser(client, 'recovery@example.com');
      const hash = tokenHash();
      const insert = (h: Buffer) =>
        client.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
          userId,
          h,
        ]);
      await insert(hash);
      expect((await pgError(insert(hash))).constraint).toBe('mfa_recovery_codes_user_code_key');
      expect((await pgError(insert(Buffer.alloc(16)))).constraint).toBe(
        'mfa_recovery_codes_code_hash_sha256',
      );
    });
  });

  describe('RBAC', () => {
    it('seeds the six approved roles (ADR-0010)', async () => {
      const { rows } = await client.query<{ code: string }>(`SELECT code FROM roles ORDER BY code`);
      expect(rows.map((r) => r.code)).toEqual([
        'admin',
        'customer',
        'finance',
        'fulfilment',
        'super_admin',
        'support',
      ]);
    });

    it('seeds the Revision 2 B7 starting matrix', async () => {
      const { rows } = await client.query<{ role_code: string; permissions: string[] }>(
        `SELECT r.code AS role_code, COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code)
                  FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_code = r.code
          GROUP BY r.code`,
      );
      const matrix = Object.fromEntries(rows.map((r) => [r.role_code, r.permissions]));
      expect(matrix.customer).toEqual([]);
      // Only super_admin controls roles, market gates and major configuration.
      for (const permission of ['roles.manage', 'markets.gate.manage', 'config.manage']) {
        const holders = rows
          .filter((r) => r.permissions.includes(permission))
          .map((r) => r.role_code);
        expect(holders).toEqual(['super_admin']);
      }
      // Refunds and wallet adjustments: finance and super_admin only.
      for (const permission of ['refunds.create', 'wallet.adjust']) {
        const holders = rows
          .filter((r) => r.permissions.includes(permission))
          .map((r) => r.role_code)
          .sort();
        expect(holders).toEqual(['finance', 'super_admin']);
      }
      // Every staff role opens the admin shell; customers do not.
      const shell = rows
        .filter((r) => r.permissions.includes('admin.access'))
        .map((r) => r.role_code);
      expect(shell.sort()).toEqual(['admin', 'finance', 'fulfilment', 'super_admin', 'support']);
      // Fulfilment staff never see full PII.
      expect(matrix.fulfilment).not.toContain('customers.pii.read');
    });

    it('allows one grant per user, role and market scope (NULL = all markets counts once)', async () => {
      const userId = await insertFixtureUser(client, 'grants@example.com');
      const grant = (role: string, market: string | null) =>
        client.query(
          `INSERT INTO user_roles (user_id, role_code, market_id)
           VALUES ($1, $2, (SELECT id FROM markets WHERE code = $3))`,
          [userId, role, market],
        );
      await grant('support', null);
      expect((await pgError(grant('support', null))).constraint).toBe(
        'user_roles_user_role_market_key',
      );
      // A market-scoped grant of the same role is a different scope.
      await grant('support', 'uk');
      expect((await pgError(grant('support', 'uk'))).constraint).toBe(
        'user_roles_user_role_market_key',
      );
      // The customer role is never market-scoped.
      expect((await pgError(grant('customer', 'uk'))).constraint).toBe(
        'user_roles_customer_not_market_scoped',
      );
      // Unknown roles are rejected by the foreign key.
      expect((await pgError(grant('root', null))).code).toBe('23503');
    });
  });

  describe('audit log', () => {
    it('is append-only, for every role including the owner', async () => {
      await client.query(
        `INSERT INTO audit_log (actor_type, action, entity_type, reason) VALUES ('system', 'test.appended', 'test', 'integration test')`,
      );
      for (const statement of [
        `UPDATE audit_log SET reason = 'rewritten'`,
        `DELETE FROM audit_log`,
        `TRUNCATE audit_log`,
      ]) {
        const error = await pgError(client.query(statement));
        expect(error.code).toBe('23001');
        expect(error.message).toMatch(/append-only/);
      }
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log`,
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('requires a consistent actor, a dotted action and a non-blank reason', async () => {
      const insert = (
        actorType: string,
        actorId: string | null,
        action: string,
        reason: string | null,
      ) =>
        client.query(
          `INSERT INTO audit_log (actor_type, actor_user_id, action, entity_type, reason) VALUES ($1, $2, $3, 'test', $4)`,
          [actorType, actorId, action, reason],
        );
      const userId = await insertFixtureUser(client, 'auditor@example.com');
      expect((await pgError(insert('user', null, 'a.b', null))).constraint).toBe(
        'audit_log_actor_consistent',
      );
      expect((await pgError(insert('system', userId, 'a.b', null))).constraint).toBe(
        'audit_log_actor_consistent',
      );
      expect((await pgError(insert('system', null, 'NotDotted', null))).constraint).toBe(
        'audit_log_action_format',
      );
      expect((await pgError(insert('system', null, 'a.b', '   '))).constraint).toBe(
        'audit_log_reason_not_blank',
      );
      await insert('user', userId, 'market.enabled', 'valid reason');
    });
  });
});
