/**
 * Authentication foundation against real PostgreSQL and Redis: registration,
 * sign-in, sessions, CSRF origin check, rate limits and TOTP MFA. Only the
 * behaviour that is implemented is tested; email verification and password
 * reset are not part of this phase.
 */
import { ErrorResponseSchema, LoginResponseSchema, MeResponseSchema } from '@hv/contracts';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hotp, totpStep } from '../src/auth/totp';
import {
  Client,
  type Harness,
  PASSWORD,
  enrolMfa,
  registeredClient,
  startHarness,
  uniqueEmail,
} from './support';

function errorCode(response: { json: () => unknown }) {
  return ErrorResponseSchema.parse(response.json()).error.code;
}

describe('authentication', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('registration', () => {
    it('creates a market-independent customer account and signs it in', async () => {
      const client = new Client(h.app);
      const email = uniqueEmail('Register');
      const response = await client.post('/auth/register', {
        email: `  ${email.toUpperCase()} `,
        password: PASSWORD,
      });
      expect(response.statusCode).toBe(201);
      expect(LoginResponseSchema.parse(response.json())).toEqual({ status: 'authenticated' });

      const setCookie = String(response.headers['set-cookie']);
      expect(setCookie).toMatch(/^hv_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax/);

      const me = MeResponseSchema.parse((await client.get('/auth/me')).json());
      expect(me.user.email).toBe(email.toLowerCase()); // stored normalized
      expect(me.user.emailVerified).toBe(false);
      expect(me.user.mfaEnabled).toBe(false);
      expect(me.roles).toEqual([{ role: 'customer', market: null }]);
      expect(me.permissions).toEqual([]);
    });

    it('stores an Argon2id hash and only the SHA-256 of the session token', async () => {
      const client = await registeredClient(h.app);
      const { rows } = await h.sql.query<{ password_hash: string; token_hash: Buffer }>(
        `SELECT u.password_hash, s.token_hash FROM users u JOIN sessions s ON s.user_id = u.id WHERE u.email = $1`,
        [client.email],
      );
      expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
      expect(rows[0]!.password_hash).not.toContain(PASSWORD);
      expect(rows[0]!.token_hash.equals(createHash('sha256').update(client.cookie!).digest())).toBe(
        true,
      );
    });

    it('refuses a second account for the same email in any letter case', async () => {
      const first = await registeredClient(h.app);
      const response = await new Client(h.app).post('/auth/register', {
        email: first.email.toUpperCase(),
        password: PASSWORD,
      });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('EMAIL_TAKEN');
    });

    it('allows exactly one of many concurrent registrations of the same email', async () => {
      const email = uniqueEmail('race');
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          new Client(h.app).post('/auth/register', { email, password: PASSWORD }),
        ),
      );
      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(7);
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE email = $1`,
        [email],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('validates input and reports every field problem', async () => {
      const response = await new Client(h.app).post('/auth/register', {
        email: 'not-an-email',
        password: 'short',
      });
      expect(response.statusCode).toBe(400);
      const body = ErrorResponseSchema.parse(response.json());
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details).toMatchObject({ issues: [{ path: 'password' }] });

      const badEmail = await new Client(h.app).post('/auth/register', {
        email: 'not-an-email',
        password: PASSWORD,
      });
      expect(errorCode(badEmail)).toBe('VALIDATION_FAILED');

      const extra = await new Client(h.app).post('/auth/register', {
        email: uniqueEmail('extra'),
        password: PASSWORD,
        role: 'super_admin',
      });
      expect(extra.statusCode).toBe(400); // unknown fields are rejected, never ignored
    });

    it('rejects a malformed JSON body with the uniform error shape', async () => {
      const response = await new Client(h.app).request('POST', '/auth/register', '{"email":', {
        'content-type': 'application/json',
      });
      expect(response.statusCode).toBe(400);
      expect(ErrorResponseSchema.parse(response.json()).requestId).toBeTruthy();
    });
  });

  describe('sign-in and sessions', () => {
    it('signs in with the right password and out again', async () => {
      const account = await registeredClient(h.app);
      const client = new Client(h.app);
      const login = await client.post('/auth/login', {
        email: account.email.toUpperCase(),
        password: PASSWORD,
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toEqual({ status: 'authenticated' });
      expect((await client.get('/auth/me')).statusCode).toBe(200);

      const token = client.cookie;
      const logout = await client.post('/auth/logout');
      expect(logout.statusCode).toBe(204);
      expect(String(logout.headers['set-cookie'])).toMatch(/^hv_session=; .*Max-Age=0/);
      // The server-side session is revoked: replaying the old cookie fails.
      client.cookie = token;
      expect(errorCode(await client.get('/auth/me'))).toBe('UNAUTHENTICATED');
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const account = await registeredClient(h.app);
      const wrong = await new Client(h.app).post('/auth/login', {
        email: account.email,
        password: 'wrong password!!',
      });
      const unknown = await new Client(h.app).post('/auth/login', {
        email: uniqueEmail('nobody'),
        password: PASSWORD,
      });
      for (const response of [wrong, unknown]) {
        expect(response.statusCode).toBe(401);
        expect(errorCode(response)).toBe('INVALID_CREDENTIALS');
      }
    });

    it('refuses disabled accounts and ends their existing sessions', async () => {
      const account = await registeredClient(h.app);
      await h.sql.query(`UPDATE users SET status = 'disabled' WHERE email = $1`, [account.email]);
      expect(errorCode(await account.get('/auth/me'))).toBe('UNAUTHENTICATED');
      const login = await new Client(h.app).post('/auth/login', {
        email: account.email,
        password: PASSWORD,
      });
      expect(login.statusCode).toBe(403);
      expect(errorCode(login)).toBe('ACCOUNT_DISABLED');
    });

    it('rejects expired, forged and malformed session cookies', async () => {
      const account = await registeredClient(h.app);
      await h.sql.query(
        `UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
          WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
        [account.email],
      );
      expect(errorCode(await account.get('/auth/me'))).toBe('UNAUTHENTICATED');
      for (const cookie of ['x'.repeat(43), 'not-a-token', '']) {
        account.cookie = cookie;
        expect((await account.get('/auth/me')).statusCode).toBe(401);
      }
    });

    it('requires a session for /auth/me', async () => {
      const response = await new Client(h.app).get('/auth/me');
      expect(response.statusCode).toBe(401);
      expect(errorCode(response)).toBe('UNAUTHENTICATED');
    });
  });

  describe('CSRF origin check', () => {
    it('refuses state-changing requests without an allowed Origin', async () => {
      for (const origin of ['https://evil.example', 'null', '']) {
        const response = await new Client(h.app).post(
          '/auth/login',
          { email: uniqueEmail('csrf'), password: PASSWORD },
          { origin },
        );
        expect(response.statusCode).toBe(403);
        expect(errorCode(response)).toBe('ORIGIN_NOT_ALLOWED');
      }
    });

    it('does not apply to safe methods', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('rate limiting', () => {
    it('limits sign-in attempts per email (10 per 15 minutes), then answers 429', async () => {
      const account = await registeredClient(h.app);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        // A fresh client (and IP) each time: the per-email limit applies regardless.
        const response = await new Client(h.app).post('/auth/login', {
          email: account.email,
          password: 'wrong password!!',
        });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
      const limited = await new Client(h.app).post('/auth/login', {
        email: account.email,
        password: PASSWORD,
      });
      expect(limited.statusCode).toBe(429);
      expect(errorCode(limited)).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('TOTP MFA', () => {
    it('enrols: setup → confirm with a code → recovery codes; audited', async () => {
      const client = await registeredClient(h.app);
      const { recoveryCodes } = await enrolMfa(client);
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);

      const me = MeResponseSchema.parse((await client.get('/auth/me')).json());
      expect(me.user.mfaEnabled).toBe(true);
      expect(me.session.mfaVerifiedAt).not.toBeNull();

      const { rows } = await h.sql.query<{
        id: string;
        encryption_key_id: string;
        confirmed_at: Date | null;
        codes: number;
        audits: number;
      }>(
        `SELECT u.id, m.totp_secret_encrypted, m.encryption_key_id, m.confirmed_at,
                (SELECT count(*)::int FROM mfa_recovery_codes r WHERE r.user_id = u.id) AS codes,
                (SELECT count(*)::int FROM audit_log a WHERE a.entity_id = u.id::text AND a.action = 'auth.mfa.enrolled') AS audits
           FROM users u JOIN user_mfa m ON m.user_id = u.id WHERE u.email = $1`,
        [client.email],
      );
      expect(rows[0]).toMatchObject({ encryption_key_id: 'k1', codes: 10, audits: 1 });
      expect(rows[0]!.confirmed_at).toBeInstanceOf(Date);
      // Recovery codes are stored hashed only.
      const stored = await h.sql.query<{ code_hash: Buffer }>(
        `SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1`,
        [rows[0]!.id],
      );
      expect(stored.rows.some((r) => r.code_hash.toString().includes(recoveryCodes[0]!))).toBe(
        false,
      );
    });

    it('refuses a wrong confirmation code and a second enrolment', async () => {
      const client = await registeredClient(h.app);
      await client.post('/auth/mfa/totp/setup');
      const wrong = await client.post('/auth/mfa/totp/confirm', { code: '000000' });
      expect(errorCode(wrong)).toBe('INVALID_MFA_CODE');
      await enrolMfa(client).catch(() => undefined);
      const again = await client.post('/auth/mfa/totp/setup');
      expect(again.statusCode).toBe(409);
      expect(errorCode(again)).toBe('MFA_ALREADY_ENABLED');
    });

    it('signs out other sessions when MFA is enabled', async () => {
      const client = await registeredClient(h.app);
      const other = new Client(h.app);
      await other.post('/auth/login', { email: client.email, password: PASSWORD });
      expect((await other.get('/auth/me')).statusCode).toBe(200);
      await enrolMfa(client);
      expect((await other.get('/auth/me')).statusCode).toBe(401);
      expect((await client.get('/auth/me')).statusCode).toBe(200);
    });

    it('makes sign-in two-step once enrolled', async () => {
      const account = await registeredClient(h.app);
      const { authenticator } = await enrolMfa(account);

      const client = new Client(h.app);
      const login = await client.post('/auth/login', { email: account.email, password: PASSWORD });
      expect(login.json()).toEqual({ status: 'mfa_required' });

      // A half-authenticated session can do nothing but verify or sign out.
      const blocked = await client.get('/auth/me');
      expect(blocked.statusCode).toBe(401);
      expect(errorCode(blocked)).toBe('MFA_REQUIRED');

      const wrong = await client.post('/auth/mfa/verify', { code: '123456' });
      expect(errorCode(wrong)).toBe('INVALID_MFA_CODE');

      const verify = await client.post('/auth/mfa/verify', { code: authenticator.next() });
      expect(verify.statusCode).toBe(200);
      expect((await client.get('/auth/me')).statusCode).toBe(200);
    });

    it('accepts each TOTP code once, even under concurrent replay', async () => {
      const account = await registeredClient(h.app);
      const { authenticator } = await enrolMfa(account);
      const code = authenticator.next();
      // 4 parallel attempts: enrolment used 1 of the 5 attempts the rate limit allows.
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => account.post('/auth/mfa/verify', { code })),
      );
      expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.statusCode === 401)).toHaveLength(3);
    });

    it('rejects a code from before the last accepted one', async () => {
      const account = await registeredClient(h.app);
      const { authenticator } = await enrolMfa(account);
      const secret = authenticator.secret;
      // Enrolment used the current step; the previous step is inside the drift window but older.
      const older = hotp(secret, totpStep(Date.now()) - 1);
      expect(errorCode(await account.post('/auth/mfa/verify', { code: older }))).toBe(
        'INVALID_MFA_CODE',
      );
    });

    it('accepts each recovery code once, in any case or grouping, and audits its use', async () => {
      const account = await registeredClient(h.app);
      const { recoveryCodes } = await enrolMfa(account);
      const code = recoveryCodes[0]!;
      const typed = code.toLowerCase().replace(/-/g, '');
      expect((await account.post('/auth/mfa/verify', { recoveryCode: typed })).statusCode).toBe(
        200,
      );
      expect(errorCode(await account.post('/auth/mfa/verify', { recoveryCode: code }))).toBe(
        'INVALID_MFA_CODE',
      );
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log a JOIN users u ON a.entity_id = u.id::text
          WHERE u.email = $1 AND a.action = 'auth.mfa.recovery_code_used'`,
        [account.email],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('answers MFA_NOT_ENROLLED for accounts without MFA', async () => {
      const account = await registeredClient(h.app);
      const response = await account.post('/auth/mfa/verify', { code: '123456' });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('MFA_NOT_ENROLLED');
    });

    it('limits MFA attempts per account (5 per 15 minutes)', async () => {
      const account = await registeredClient(h.app);
      await enrolMfa(account);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await account.post('/auth/mfa/verify', { code: '000000' })).statusCode);
      }
      // Enrolment's confirm counted as one attempt.
      expect(statuses.slice(0, 4).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(4).every((s) => s === 429)).toBe(true);
    });
  });
});
