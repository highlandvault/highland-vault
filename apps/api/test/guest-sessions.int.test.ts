/**
 * Guest sessions against real PostgreSQL (migration 0012, task P5-3).
 *
 * The properties that matter are the boundaries: a guest is an identity for a
 * checkout and nothing else. It creates no account, it expires, its verified
 * address is normalized the way an account's is so the ticket cap sees one
 * person, and — most importantly — it can never stand in for being signed in.
 */
import { createDb, withTransaction, type Database } from '@hv/db';
import { createTestDatabase, insertFixtureUser, type TestDatabase } from '@hv/db/testing';
import { normalizeEmail } from '@hv/domain';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUEST_SESSION_COOKIE, guestSessionCookie, readCookie } from '../src/auth/cookies';
import { generateSessionToken, sha256 } from '../src/auth/tokens';
import { GuestSessionsRepository } from '../src/guests/guest-sessions.repository';

const META = { ip: '203.0.113.9', requestId: 'req-1', userAgent: 'vitest' };

describe('guest sessions (database layer)', () => {
  let database: TestDatabase;
  let db: Database;
  let sql: pg.Pool;
  const repository = new GuestSessionsRepository();

  beforeEach(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.url, applicationName: 'hv-test-guests', max: 3 });
    sql = new pg.Pool({ connectionString: database.url, max: 2 });
  });

  afterEach(async () => {
    await db?.destroy();
    await sql?.end();
    await database?.drop();
  });

  /** A session that is already past its expiry: expires_at is immutable, so it is inserted lapsed. */
  const issueLapsed = async () => {
    const token = generateSessionToken();
    const { rows } = await sql.query<{ id: string }>(
      `INSERT INTO guest_sessions (token_hash, created_at, expires_at)
       VALUES ($1, now() - interval '2 days', now() - interval '1 day') RETURNING id`,
      [sha256(token)],
    );
    return { token, id: rows[0]!.id };
  };

  const issue = async (ttlHours = 24) => {
    const token = generateSessionToken();
    const created = await withTransaction(db, (trx) =>
      repository.insert(trx, { tokenHash: sha256(token), ttlHours, meta: META }),
    );
    return { token, ...created };
  };

  describe('identity', () => {
    it('stores only the hash of the token, never the token itself', async () => {
      const { token, id } = await issue();
      const { rows } = await sql.query<{ token_hash: Buffer; raw: string }>(
        `SELECT token_hash, guest_sessions::text AS raw FROM guest_sessions WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.token_hash.equals(sha256(token))).toBe(true);
      expect(rows[0]!.raw).not.toContain(token);
    });

    it('creates no user row for a guest', async () => {
      await issue();
      const { rows } = await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
      expect(rows[0]!.n).toBe(0);
    });

    it('resolves a live session from its token hash', async () => {
      const { token, id } = await issue();
      const guest = await repository.findLiveByTokenHash(db, sha256(token));
      expect(guest).toMatchObject({ guestSessionId: id, verifiedEmail: null });
    });

    it('does not resolve an unknown token', async () => {
      await issue();
      expect(await repository.findLiveByTokenHash(db, sha256(generateSessionToken()))).toBeNull();
    });

    it('refuses two sessions with the same token hash', async () => {
      const token = generateSessionToken();
      const insert = () =>
        withTransaction(db, (trx) =>
          repository.insert(trx, { tokenHash: sha256(token), ttlHours: 24, meta: META }),
        );
      await insert();
      await expect(insert()).rejects.toThrow();
    });

    it('refuses a hash that is not a SHA-256', async () => {
      await expect(
        sql.query(
          `INSERT INTO guest_sessions (token_hash, expires_at) VALUES ($1, now() + interval '1 day')`,
          [Buffer.alloc(16)],
        ),
      ).rejects.toThrow(/token_hash_sha256/);
    });
  });

  describe('lifetime', () => {
    it('does not resolve a session past its expiry', async () => {
      const { token } = await issueLapsed();
      expect(await repository.findLiveByTokenHash(db, sha256(token))).toBeNull();
    });

    it('does not resolve a revoked session', async () => {
      const { token, id } = await issue();
      await repository.revoke(db, id);
      expect(await repository.findLiveByTokenHash(db, sha256(token))).toBeNull();
    });

    it('revokes once, and a second revoke changes nothing', async () => {
      const { id } = await issue();
      await repository.revoke(db, id);
      const first = await sql.query<{ revoked_at: Date }>(
        `SELECT revoked_at FROM guest_sessions WHERE id = $1`,
        [id],
      );
      await repository.revoke(db, id);
      const second = await sql.query<{ revoked_at: Date }>(
        `SELECT revoked_at FROM guest_sessions WHERE id = $1`,
        [id],
      );
      expect(second.rows[0]!.revoked_at).toEqual(first.rows[0]!.revoked_at);
    });

    it('refuses a session that expires before it was created', async () => {
      await expect(
        sql.query(
          `INSERT INTO guest_sessions (token_hash, expires_at) VALUES ($1, now() - interval '1 hour')`,
          [sha256(generateSessionToken())],
        ),
      ).rejects.toThrow(/expires_after_created/);
    });

    it('refuses a session created already revoked', async () => {
      await expect(
        sql.query(
          `INSERT INTO guest_sessions (token_hash, expires_at, revoked_at)
           VALUES ($1, now() + interval '1 day', now())`,
          [sha256(generateSessionToken())],
        ),
      ).rejects.toThrow(/created live/);
    });
  });

  describe('verified email is the cap identity', () => {
    it('binds a normalized address', async () => {
      const { token, id } = await issue();
      expect(
        await repository.bindVerifiedEmail(db, id, normalizeEmail('  Guest@Example.COM ')),
      ).toBe(true);
      const guest = await repository.findLiveByTokenHash(db, sha256(token));
      expect(guest!.verifiedEmail).toBe('guest@example.com');
      expect(guest!.verifiedEmailAt).toBeInstanceOf(Date);
    });

    it('matches an account holder who typed the address differently', async () => {
      // ADR-0008: the cap key is the normalized verified email, so a guest and
      // an account with the same address are one person to the cap.
      const userId = await insertFixtureUser(sql, 'person@example.com');
      const { id } = await issue();
      await repository.bindVerifiedEmail(db, id, normalizeEmail('Person@Example.com'));
      const { rows } = await sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users u
          JOIN guest_sessions g ON g.verified_email = u.email
         WHERE u.id = $1`,
        [userId],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('refuses an address the database does not consider normalized', async () => {
      const { id } = await issue();
      await expect(
        sql.query(
          `UPDATE guest_sessions SET verified_email = 'Mixed@Case.com', verified_email_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/verified_email_normalized/);
    });

    it('refuses an address without the moment it was verified', async () => {
      const { id } = await issue();
      await expect(
        sql.query(`UPDATE guest_sessions SET verified_email = 'a@b.com' WHERE id = $1`, [id]),
      ).rejects.toThrow(/verified_consistent/);
    });

    it('will not bind a second address over the first', async () => {
      const { id } = await issue();
      expect(await repository.bindVerifiedEmail(db, id, 'first@example.com')).toBe(true);
      // The conditional update declines…
      expect(await repository.bindVerifiedEmail(db, id, 'second@example.com')).toBe(false);
      // …and the database refuses it outright, so a race cannot do it either.
      await expect(
        sql.query(
          `UPDATE guest_sessions SET verified_email = 'second@example.com', verified_email_at = now() WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/verified email cannot be changed/);
    });

    it('will not bind to an expired or revoked session', async () => {
      const expired = await issueLapsed();
      expect(await repository.bindVerifiedEmail(db, expired.id, 'a@example.com')).toBe(false);

      const revoked = await issue();
      await repository.revoke(db, revoked.id);
      expect(await repository.bindVerifiedEmail(db, revoked.id, 'b@example.com')).toBe(false);
    });
  });

  describe('the database protects the record', () => {
    it('refuses to change what a session is', async () => {
      const { id } = await issue();
      await expect(
        sql.query(
          `UPDATE guest_sessions SET expires_at = now() + interval '9 days' WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        sql.query(`UPDATE guest_sessions SET token_hash = $2 WHERE id = $1`, [
          id,
          sha256(generateSessionToken()),
        ]),
      ).rejects.toThrow(/immutable/);
    });

    it('will not let the application delete a session', async () => {
      const { rows } = await sql.query<{ delete: boolean; truncate: boolean }>(
        `SELECT has_table_privilege('hv_app', 'guest_sessions', 'DELETE') AS delete,
                has_table_privilege('hv_app', 'guest_sessions', 'TRUNCATE') AS truncate`,
      );
      expect(rows[0]).toEqual({ delete: false, truncate: false });
    });
  });

  describe('the cookie that carries it', () => {
    it('is its own name, never the authenticated one', () => {
      expect(GUEST_SESSION_COOKIE).toBe('hv_guest');
      const header = guestSessionCookie('tok', new Date(Date.now() + 3_600_000), { secure: true });
      expect(readCookie(header.split(';')[0], GUEST_SESSION_COOKIE)).toBe('tok');
      expect(readCookie(header.split(';')[0], 'hv_session')).toBeNull();
    });

    it('is HttpOnly and SameSite=Lax, and Secure when configured', () => {
      const expires = new Date(Date.now() + 3_600_000);
      const secure = guestSessionCookie('tok', expires, { secure: true });
      expect(secure).toMatch(
        /^hv_guest=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Expires=/,
      );
      expect(secure).toMatch(/; Secure$/);
      expect(guestSessionCookie('tok', expires, { secure: false })).not.toMatch(/Secure/);
    });
  });
});
