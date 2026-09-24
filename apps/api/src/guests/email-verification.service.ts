import { Inject, Injectable } from '@nestjs/common';
import { type Database, enqueueOutboxEvent, withTransaction } from '@hv/db';
import {
  SecretBox,
  VERIFICATION_CODES_PER_EMAIL_PER_HOUR,
  VERIFICATION_CODE_MAX_ATTEMPTS,
  VERIFICATION_CODE_TTL_MINUTES,
  VERIFICATION_EMAIL_TOPIC,
  generateVerificationCode,
  isWellFormedVerificationCode,
  normalizeEmail,
  normalizeVerificationCode,
  sealPayload,
  verificationHashesMatch,
  type VerificationEmailPayload,
} from '@hv/domain';
import type { VerificationCodeSentResponse } from '@hv/contracts';
import { RATE_LIMITS, RateLimiter } from '../auth/rate-limiter';
import { sha256 } from '../auth/tokens';
import { Errors } from '../common/errors';
import type { RequestMeta } from '../common/request-context';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { EmailVerificationRepository } from './email-verification.repository';
import { type GuestContext, GuestSessionsRepository } from './guest-sessions.repository';
import { GuestSessionsService } from './guest-sessions.service';

export interface CodeRequestResult {
  response: VerificationCodeSentResponse;
  /** Set when a guest session had to be created, so the caller can set the cookie. */
  issued?: { token: string; expiresAt: Date };
}

/**
 * Guest email verification (ADR-0020).
 *
 * A guest is emailed a six-digit code and types it back; the address then
 * becomes the key their ticket cap is counted against (ADR-0008).
 *
 * Six digits is only safe because guessing is bounded, so all three limits are
 * enforced here and in the database rather than trusted to the client: the
 * code expires, it is single-use, and attempts against it are counted under a
 * row lock. Sending is limited separately by the existing fail-closed Redis
 * limiter, per IP and per address — one address cannot be flooded, and one
 * caller cannot escape that by rotating addresses.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly verifications: EmailVerificationRepository,
    private readonly guestSessions: GuestSessionsRepository,
    private readonly guests: GuestSessionsService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * Issues a code and queues the email.
   *
   * The code, its hash and the outbox event are written in ONE transaction, so
   * an email is never queued for a code that was not stored, and a stored code
   * never goes unsent. The plaintext reaches the event sealed (ADR-0028) and is
   * never logged.
   *
   * The rate limits are consumed OUTSIDE that transaction, deliberately: Redis
   * is not transactional, and a rolled-back transaction must not appear to
   * give a refused caller their allowance back.
   */
  async requestCode(
    guest: GuestContext | null,
    rawEmail: string,
    meta: RequestMeta,
  ): Promise<CodeRequestResult> {
    const email = normalizeEmail(rawEmail);
    // Both limits are consumed before a code exists and before anything is
    // written, and both fail closed: a Redis outage refuses the request rather
    // than letting an unlimited number through.
    //
    // Per IP first, because it is the broader guard. The per-address limit
    // protects one inbox from being flooded; it does nothing about a caller
    // who rotates addresses, which is what would produce unbounded mail to
    // strangers and unbounded rows on tables hv_app cannot delete from.
    await this.rateLimiter.consume(RATE_LIMITS.verificationCodePerIp, meta.ip ?? 'unknown');
    await this.rateLimiter.consume(RATE_LIMITS.verificationCodePerEmail, email);

    const result = await withTransaction(this.db, async (trx) => {
      // A guest with no session yet gets one here: the session is what the
      // code is bound to, so there is nothing to verify without it.
      let guestSessionId = guest?.guestSessionId;
      let issued: CodeRequestResult['issued'];
      if (!guestSessionId) {
        const session = await this.guests.issue(trx, meta);
        guestSessionId = session.guestSessionId;
        issued = { token: session.token, expiresAt: session.expiresAt };
      }

      // A second limit in the database, because the Redis one is keyed on the
      // address alone and a caller rotating sessions would otherwise slip past
      // nothing — but a caller sharing an address with a real guest would.
      const recent = await this.verifications.countRecentSends(trx, email, 60);
      if (recent >= VERIFICATION_CODES_PER_EMAIL_PER_HOUR) throw Errors.rateLimited(3600);

      const code = generateVerificationCode();
      await this.verifications.insert(trx, {
        guestSessionId,
        email,
        codeHash: sha256(code),
        ttlMinutes: VERIFICATION_CODE_TTL_MINUTES,
      });

      const payload: VerificationEmailPayload = {
        to: email,
        code,
        expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES,
      };
      // Sealed before it reaches the outbox: an outbox payload is immutable and
      // undeletable, so a plaintext code there could never be redacted.
      await enqueueOutboxEvent(
        trx,
        VERIFICATION_EMAIL_TOPIC,
        sealPayload(this.secretBox(), VERIFICATION_EMAIL_TOPIC, payload),
      );
      return { issued };
    });

    return {
      response: { sent: true, expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES },
      ...(result.issued ? { issued: result.issued } : {}),
    };
  }

  /**
   * Checks a code and, if it is right, binds the address to the session.
   *
   * One transaction, with the verification row locked for the whole of it:
   * the attempt count is a security control, and two requests guessing at the
   * same moment must not both be allowed against the same count.
   *
   * Every failure returns the same error. A caller must not be able to tell a
   * wrong code from an expired one, a used one, or one that never existed —
   * that difference is exactly what makes guessing cheaper.
   */
  async verify(guest: GuestContext | null, rawEmail: string, rawCode: string): Promise<void> {
    if (!guest) throw Errors.badRequest('VERIFICATION_REQUIRED', 'Request a code first.');
    const email = normalizeEmail(rawEmail);
    const code = normalizeVerificationCode(rawCode);
    // Shape first, so a malformed code costs no database work and no attempt.
    if (!isWellFormedVerificationCode(code)) throw this.invalidCode();

    // The transaction RETURNS a verdict rather than throwing one. Throwing
    // inside it would roll back the attempt counter along with everything
    // else, and a guess that costs nothing is not a limit: the cap would
    // never engage however many times someone tried.
    const accepted = await withTransaction(this.db, async (trx) => {
      const verification = await this.verifications.findLiveForUpdate(
        trx,
        guest.guestSessionId,
        email,
      );
      if (!verification) return false;
      if (verification.attempts >= VERIFICATION_CODE_MAX_ATTEMPTS) return false;

      // Counted before the comparison, and committed whatever the verdict is.
      await this.verifications.countAttempt(trx, verification.id);
      if (!verificationHashesMatch(sha256(code), verification.codeHash)) return false;

      // Single use, and conditional: two correct guesses racing consume once.
      if (!(await this.verifications.consume(trx, verification.id))) return false;
      // Fails if the session lapsed, was revoked, or already carries an address.
      return this.guestSessions.bindVerifiedEmail(trx, guest.guestSessionId, email);
    });
    if (!accepted) throw this.invalidCode();
  }

  /** What a guest may know about their own verification state. */
  verificationState(guest: GuestContext | null, now = new Date()) {
    const verified = guest ? this.guests.hasFreshVerifiedEmail(guest, now) : false;
    return {
      email: verified ? guest!.verifiedEmail : null,
      verified,
      expiresAt:
        verified && guest?.verifiedEmailAt
          ? new Date(
              guest.verifiedEmailAt.getTime() + this.env.GUEST_VERIFIED_EMAIL_TTL_MINUTES * 60_000,
            ).toISOString()
          : null,
      serverTime: now.toISOString(),
    };
  }

  /**
   * One error for every failure. The message says what to do, not what went
   * wrong, because the difference is what a guesser wants to know.
   */
  private invalidCode() {
    return Errors.badRequest(
      'INVALID_VERIFICATION_CODE',
      'That code is not valid. Request a new one and try again.',
    );
  }

  private secretBox(): SecretBox {
    return new SecretBox(this.env.OUTBOX_ENCRYPTION_KEY, this.env.OUTBOX_ENCRYPTION_KEY_ID);
  }
}
