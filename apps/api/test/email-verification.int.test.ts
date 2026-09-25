/**
 * Guest email verification end to end (migration 0013, task P5-4).
 *
 * The whole vertical slice against real PostgreSQL and Redis: request a code,
 * find it sealed in the outbox, type it back, and end up with an address bound
 * to the guest session as the ticket-cap key.
 *
 * Six digits is only safe because guessing is bounded, so most of this file is
 * about the bounds: expiry, single use, the attempt cap, and the fact that no
 * failure tells a caller which of those stopped them.
 */
import {
  SecretBox,
  VERIFICATION_CODE_MAX_ATTEMPTS,
  VERIFICATION_EMAIL_TOPIC,
  openPayload,
  type VerificationEmailPayload,
} from '@hv/domain';
import { enableMarketsForTesting } from '@hv/db/testing';
import { ErrorResponseSchema } from '@hv/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GUEST_SESSION_COOKIE } from '../src/auth/cookies';
import { RATE_LIMITS } from '../src/auth/rate-limiter';
import { sha256 } from '../src/auth/tokens';
import { WEB_ORIGIN, type Harness, randomIp, startHarness } from './support';

const KEY = 'a1'.repeat(16) + 'b2'.repeat(16);
const box = new SecretBox(KEY, 'k1');

describe('guest email verification', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ ENABLED_MARKETS: 'uk,ie', OUTBOX_ENCRYPTION_KEY: KEY });
    await enableMarketsForTesting(h.sql, ['uk']);
  });

  afterAll(async () => {
    await h?.close();
  });

  /**
   * A fresh client address per test.
   *
   * Sending is limited per IP as well as per address, and the counters live in
   * a Redis database shared with every other test and every previous run. A
   * fixed address would make each test spend the next one's allowance — the
   * same reason `support.ts` gives every Client a `randomIp()`.
   */
  let ip: string;

  beforeEach(async () => {
    // A clean slate per test: the send limit counts rows, and Redis counters
    // are keyed on the address and the IP.
    ip = randomIp();
    await h.sql.query(`TRUNCATE guest_email_verifications, outbox`);
    await h.sql.query(`UPDATE guest_sessions SET revoked_at = now() WHERE revoked_at IS NULL`);
  });

  let unique = 0;
  const freshEmail = () => `guest-${Date.now()}-${unique++}@example.com`;

  // `from` defaults to this test's address; default parameters are evaluated
  // per call, so it picks up whatever beforeEach assigned.
  const post = (url: string, payload: unknown, cookie?: string, from = ip) =>
    h.app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      remoteAddress: from,
      headers: { origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
    });

  const guestCookieFrom = (response: { headers: Record<string, unknown> }) => {
    const raw = response.headers['set-cookie'] as string | string[] | undefined;
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = value ? new RegExp(`${GUEST_SESSION_COOKIE}=([^;]*)`).exec(value) : null;
    return match ? `${GUEST_SESSION_COOKIE}=${match[1]}` : null;
  };

  /** Everything a code request writes, so a refusal can be shown to write none of it. */
  const rowCounts = async () => {
    const { rows } = await h.sql.query<{ verifications: number; events: number; sessions: number }>(
      `SELECT (SELECT count(*) FROM guest_email_verifications)::int AS verifications,
              (SELECT count(*) FROM outbox)::int                   AS events,
              (SELECT count(*) FROM guest_sessions)::int           AS sessions`,
    );
    return rows[0]!;
  };

  /** The code as the worker would read it: out of the outbox, unsealed. */
  const codeFromOutbox = async (): Promise<string> => {
    const { rows } = await h.sql.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM outbox ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]!.topic).toBe(VERIFICATION_EMAIL_TOPIC);
    const opened = openPayload<VerificationEmailPayload>(
      box,
      VERIFICATION_EMAIL_TOPIC,
      rows[0]!.payload,
    );
    return opened.code;
  };

  /** Requests a code and returns the guest cookie and the code itself. */
  const requestCode = async (email: string, cookie?: string) => {
    const response = await post('/markets/uk/checkout/email/code', { email }, cookie);
    expect(response.statusCode).toBe(202);
    return {
      cookie: guestCookieFrom(response) ?? cookie!,
      code: await codeFromOutbox(),
    };
  };

  describe('the happy path', () => {
    it('issues a guest session, queues a sealed email, and verifies the address', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email);
      expect(cookie).toContain(GUEST_SESSION_COOKIE);
      expect(code).toMatch(/^\d{6}$/);

      const verified = await post('/markets/uk/checkout/email/verify', { email, code }, cookie);
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({
        verification: { email, verified: true },
      });

      // The address is now on the session, which is what the cap keys on.
      const { rows } = await h.sql.query<{ verified_email: string }>(
        `SELECT verified_email FROM guest_sessions WHERE verified_email IS NOT NULL`,
      );
      expect(rows.map((r) => r.verified_email)).toContain(email);
    });

    it('normalizes the address, so the cap sees one person', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email.toUpperCase());
      await post('/markets/uk/checkout/email/verify', { email: email.toUpperCase(), code }, cookie);
      const { rows } = await h.sql.query<{ verified_email: string }>(
        `SELECT verified_email FROM guest_sessions WHERE verified_email IS NOT NULL`,
      );
      expect(rows.map((r) => r.verified_email)).toContain(email.toLowerCase());
    });

    it('accepts a code typed with a space or a dash', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email);
      const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
      const response = await post(
        '/markets/uk/checkout/email/verify',
        { email, code: spaced },
        cookie,
      );
      expect(response.statusCode).toBe(200);
    });

    it('reuses an existing guest session instead of issuing another', async () => {
      const email = freshEmail();
      const first = await requestCode(email);
      const second = await post('/markets/uk/checkout/email/code', { email }, first.cookie);
      expect(second.statusCode).toBe(202);
      // No new cookie: the caller already had a session.
      expect(guestCookieFrom(second)).toBeNull();
    });

    it('reports verification state, and lets it lapse', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email);
      await post('/markets/uk/checkout/email/verify', { email, code }, cookie);

      const state = await h.app.inject({
        method: 'GET',
        url: '/markets/uk/checkout/email/verification',
        headers: { cookie },
      });
      expect(state.json()).toMatchObject({ verification: { verified: true, email } });

      // Past the 30-minute binding window (ADR-0020).
      await h.sql.query(
        `UPDATE guest_sessions SET verified_email_at = now() - interval '31 minutes'
          WHERE verified_email IS NOT NULL`,
      );
      const lapsed = await h.app.inject({
        method: 'GET',
        url: '/markets/uk/checkout/email/verification',
        headers: { cookie },
      });
      expect(lapsed.json()).toMatchObject({ verification: { verified: false, email: null } });
    });
  });

  describe('the code is never readable where it should not be', () => {
    it('is absent from the response that issues it', async () => {
      const email = freshEmail();
      const response = await post('/markets/uk/checkout/email/code', { email });
      const code = await codeFromOutbox();
      expect(response.body).not.toContain(code);
      expect(response.json()).toEqual({ sent: true, expiresInMinutes: 10 });
    });

    it('is stored only as a hash, never in clear', async () => {
      const email = freshEmail();
      const { code } = await requestCode(email);
      const { rows } = await h.sql.query<{ code_hash: Buffer; raw: string }>(
        `SELECT code_hash, guest_email_verifications::text AS raw FROM guest_email_verifications`,
      );
      expect(rows[0]!.code_hash.equals(sha256(code))).toBe(true);
      expect(rows[0]!.raw).not.toContain(code);
    });

    it('is sealed in the outbox, not written in clear', async () => {
      const email = freshEmail();
      const { code } = await requestCode(email);
      const { rows } = await h.sql.query<{ raw: string }>(
        `SELECT payload::text AS raw FROM outbox`,
      );
      expect(rows[0]!.raw).not.toContain(code);
      expect(rows[0]!.raw).not.toContain(email);
    });
  });

  describe('guessing is bounded', () => {
    it('refuses a wrong code', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email);
      const wrong = code === '000000' ? '111111' : '000000';
      const response = await post(
        '/markets/uk/checkout/email/verify',
        { email, code: wrong },
        cookie,
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_VERIFICATION_CODE' },
      });
    });

    it('stops accepting guesses after the attempt cap, even a correct one', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < VERIFICATION_CODE_MAX_ATTEMPTS; i++) {
        const response = await post(
          '/markets/uk/checkout/email/verify',
          { email, code: wrong },
          cookie,
        );
        expect(response.statusCode).toBe(400);
      }
      // The right code now too: the row is spent.
      const correct = await post('/markets/uk/checkout/email/verify', { email, code }, cookie);
      expect(correct.statusCode).toBe(400);

      const { rows } = await h.sql.query<{ attempts: number; consumed_at: Date | null }>(
        `SELECT attempts, consumed_at FROM guest_email_verifications`,
      );
      // Exactly the cap: the limit check runs before the count, so a refused
      // guess does not push it higher.
      expect(rows[0]!.attempts).toBe(5);
      expect(rows[0]!.consumed_at).toBeNull();
    });

    it('counts a wrong guess even though it tells the caller nothing', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email);
      await post(
        '/markets/uk/checkout/email/verify',
        { email, code: code === '000000' ? '111111' : '000000' },
        cookie,
      );
      const { rows } = await h.sql.query<{ attempts: number }>(
        `SELECT attempts FROM guest_email_verifications`,
      );
      expect(rows[0]!.attempts).toBe(1);
    });

    it('refuses a code that has already been used', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email);
      expect(
        (await post('/markets/uk/checkout/email/verify', { email, code }, cookie)).statusCode,
      ).toBe(200);
      // Replayed: single use (ADR-0020).
      const replay = await post('/markets/uk/checkout/email/verify', { email, code }, cookie);
      expect(replay.statusCode).toBe(400);
    });

    it('refuses an expired code', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email);
      // expires_at is immutable by trigger, so a lapsed code is INSERTed as
      // one rather than aged in place.
      const { rows } = await h.sql.query<{ guest_session_id: string; code_hash: Buffer }>(
        `SELECT guest_session_id, code_hash FROM guest_email_verifications`,
      );
      await h.sql.query(`TRUNCATE guest_email_verifications`);
      await h.sql.query(
        `INSERT INTO guest_email_verifications (guest_session_id, email, code_hash, created_at, expires_at)
         VALUES ($1, $2, $3, now() - interval '20 minutes', now() - interval '10 minutes')`,
        [rows[0]!.guest_session_id, email, rows[0]!.code_hash],
      );

      const response = await post('/markets/uk/checkout/email/verify', { email, code }, cookie);
      expect(response.statusCode).toBe(400);
    });

    it('gives the same answer for every kind of failure', async () => {
      const email = freshEmail();
      const { cookie, code } = await requestCode(email);

      const failures = [
        // Wrong code.
        await post(
          '/markets/uk/checkout/email/verify',
          { email, code: code === '000000' ? '111111' : '000000' },
          cookie,
        ),
        // An address that never had a code on this session.
        await post('/markets/uk/checkout/email/verify', { email: freshEmail(), code }, cookie),
        // A malformed code.
        await post('/markets/uk/checkout/email/verify', { email, code: 'abcdef' }, cookie),
      ].map((response) => ErrorResponseSchema.parse(response.json()).error);

      expect(new Set(failures.map((e) => e.code))).toEqual(new Set(['INVALID_VERIFICATION_CODE']));
      // Messages identical too: nothing distinguishes the reasons.
      expect(new Set(failures.map((e) => e.message)).size).toBe(1);
    });
  });

  describe('a code belongs to one guest session', () => {
    it('will not let another session use it', async () => {
      const email = freshEmail();
      const { code } = await requestCode(email);
      // A second guest, with its own session.
      const other = await requestCode(freshEmail());

      const response = await post(
        '/markets/uk/checkout/email/verify',
        { email, code },
        other.cookie,
      );
      expect(response.statusCode).toBe(400);
    });

    it('refuses verification with no guest session at all', async () => {
      const response = await post('/markets/uk/checkout/email/verify', {
        email: freshEmail(),
        code: '123456',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VERIFICATION_REQUIRED' } });
    });
  });

  describe('sending is limited', () => {
    it('refuses more than the hourly allowance for one address', async () => {
      const email = freshEmail();
      let cookie: string | undefined;
      for (let i = 0; i < 3; i++) {
        const response = await post('/markets/uk/checkout/email/code', { email }, cookie);
        expect(response.statusCode).toBe(202);
        cookie = guestCookieFrom(response) ?? cookie;
      }
      const fourth = await post('/markets/uk/checkout/email/code', { email }, cookie);
      expect(fourth.statusCode).toBe(429);
      expect(fourth.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    });

    /**
     * The per-address limit bounds one inbox. It does nothing about a caller
     * who rotates addresses, which is the case that produces unlimited mail to
     * strangers and unlimited rows on tables hv_app cannot delete from — so
     * sending is limited per IP as well.
     */
    describe('per IP, so rotating the address does not buy more', () => {
      const send = (from?: string) =>
        post('/markets/uk/checkout/email/code', { email: freshEmail() }, undefined, from);

      it('allows the whole allowance from one address', async () => {
        for (let i = 0; i < RATE_LIMITS.verificationCodePerIp.limit; i++) {
          expect((await send()).statusCode).toBe(202);
        }
      });

      it('refuses the request after it, although every address is new', async () => {
        for (let i = 0; i < RATE_LIMITS.verificationCodePerIp.limit; i++) {
          expect((await send()).statusCode).toBe(202);
        }
        const over = await send();
        expect(over.statusCode).toBe(429);
        expect(over.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      });

      it('writes nothing for a refused request', async () => {
        for (let i = 0; i < RATE_LIMITS.verificationCodePerIp.limit; i++) await send();
        const before = await rowCounts();
        expect((await send()).statusCode).toBe(429);
        // The limiter runs before the transaction, so a refusal costs no
        // verification row, no outbox event and no guest session.
        expect(await rowCounts()).toEqual(before);
      });

      it('does not leak the address or the session in the refusal', async () => {
        const email = freshEmail();
        for (let i = 0; i < RATE_LIMITS.verificationCodePerIp.limit; i++) await send();
        const over = await post('/markets/uk/checkout/email/code', { email });
        expect(over.statusCode).toBe(429);
        expect(over.body).not.toContain(email);
        // Nothing says which limit was hit, or anything about the address.
        expect(over.json()).toMatchObject({
          error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
        });
        expect(guestCookieFrom(over)).toBeNull();
      });

      it('gives a different address its own allowance', async () => {
        const other = randomIp();
        for (let i = 0; i < RATE_LIMITS.verificationCodePerIp.limit; i++) await send();
        expect((await send()).statusCode).toBe(429);
        // A separate bucket, not a shared one.
        expect((await send(other)).statusCode).toBe(202);
      });

      it('still refuses a single address after three, well inside the IP allowance', async () => {
        // Proves the two limits are both live: three sends is nowhere near 20.
        const email = freshEmail();
        for (let i = 0; i < 3; i++) {
          expect((await post('/markets/uk/checkout/email/code', { email })).statusCode).toBe(202);
        }
        expect((await post('/markets/uk/checkout/email/code', { email })).statusCode).toBe(429);
        // And the IP itself is not exhausted: another address still works.
        expect((await send()).statusCode).toBe(202);
      });
    });

    it('refuses rather than sends when Redis is unreachable', async () => {
      // Fail closed (B19): without the limiter there is no brute-force or
      // flooding protection, so the request is refused, not waved through.
      const offline = await startHarness({
        ENABLED_MARKETS: 'uk,ie',
        OUTBOX_ENCRYPTION_KEY: KEY,
        // A port nothing listens on, so every limiter call fails. The same
        // address the readiness test uses for an unreachable Redis.
        REDIS_URL: 'redis://127.0.0.1:1/0',
      });
      try {
        await enableMarketsForTesting(offline.sql, ['uk']);
        const response = await offline.app.inject({
          method: 'POST',
          url: '/markets/uk/checkout/email/code',
          payload: { email: freshEmail() },
          remoteAddress: randomIp(),
          headers: { origin: WEB_ORIGIN },
        });
        expect(response.statusCode).toBe(503);
        const { rows } = await offline.sql.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM guest_email_verifications`,
        );
        expect(rows[0]!.n).toBe(0);
      } finally {
        await offline.close();
      }
    });
  });

  describe('market scoping', () => {
    it('is refused in a market that is not available', async () => {
      const response = await post('/markets/de/checkout/email/code', { email: freshEmail() });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('input validation', () => {
    it('refuses a malformed address before anything else happens', async () => {
      const response = await post('/markets/uk/checkout/email/code', { email: 'not-an-address' });
      expect(response.statusCode).toBe(400);
      const { rows } = await h.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guest_email_verifications`,
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('refuses unknown fields', async () => {
      const response = await post('/markets/uk/checkout/email/code', {
        email: freshEmail(),
        admin: true,
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
