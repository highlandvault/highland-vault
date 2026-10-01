import { Inject, Injectable } from '@nestjs/common';
import type { Database, DbExecutor } from '@hv/db';
import { normalizeEmail } from '@hv/domain';
import type { FastifyRequest } from 'fastify';
import { GUEST_SESSION_COOKIE, readCookie } from '../auth/cookies';
import { generateSessionToken, isWellFormedSessionToken, sha256 } from '../auth/tokens';
import type { RequestMeta } from '../common/request-context';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { type GuestContext, GuestSessionsRepository } from './guest-sessions.repository';

export interface IssuedGuestSession {
  token: string;
  expiresAt: Date;
  guestSessionId: string;
}

/**
 * Server-side guest sessions (ADR-0029), built from the same primitives as
 * authenticated ones: the same 256-bit opaque token, the same SHA-256 at rest,
 * the same rejection of a malformed token before any lookup.
 *
 * What it deliberately does not do is authenticate. It resolves to a
 * GuestContext, which has no user and no permissions, and the guard attaches
 * it only on public routes.
 */
@Injectable()
export class GuestSessionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly repository: GuestSessionsRepository,
  ) {}

  /** Creates a guest session. The plain token leaves only in the cookie. */
  async issue(trx: DbExecutor, meta: RequestMeta): Promise<IssuedGuestSession> {
    const token = generateSessionToken();
    const { id, expiresAt } = await this.repository.insert(trx, {
      tokenHash: sha256(token),
      ttlHours: this.env.GUEST_SESSION_TTL_HOURS,
      meta,
    });
    return { token, expiresAt, guestSessionId: id };
  }

  /** The guest behind a request, or null when absent, malformed, expired or revoked. */
  async resolve(request: FastifyRequest): Promise<GuestContext | null> {
    const token = readCookie(request.headers.cookie, GUEST_SESSION_COOKIE);
    // Shape is checked before the database is touched, so a junk cookie costs
    // a regular expression rather than a query.
    if (!token || !isWellFormedSessionToken(token)) return null;
    return this.repository.findLiveByTokenHash(this.db, sha256(token));
  }

  /**
   * Binds a verified address to the session, normalized exactly as
   * `users.email` is, so a guest and an account holder who type the same
   * address differently are still one person to the ticket cap (ADR-0008).
   */
  bindVerifiedEmail(trx: DbExecutor, guestSessionId: string, email: string): Promise<boolean> {
    return this.repository.bindVerifiedEmail(trx, guestSessionId, normalizeEmail(email));
  }

  /** Re-reads a session, so a response can reflect what was just written to it. */
  reload(guestSessionId: string): Promise<GuestContext | null> {
    return this.repository.findLiveById(this.db, guestSessionId);
  }

  revoke(guestSessionId: string): Promise<void> {
    return this.repository.revoke(this.db, guestSessionId);
  }

  /**
   * Whether a verified address may still be used.
   *
   * Verification is only good for a short window (ADR-0020), and the window is
   * evaluated here on every use rather than cached, so a binding cannot go
   * stale in someone's session and still be accepted at checkout.
   */
  hasFreshVerifiedEmail(guest: GuestContext, now = new Date()): boolean {
    if (!guest.verifiedEmail || !guest.verifiedEmailAt) return false;
    const age = now.getTime() - guest.verifiedEmailAt.getTime();
    return age >= 0 && age < this.env.GUEST_VERIFIED_EMAIL_TTL_MINUTES * 60_000;
  }

  get cookieOptions() {
    return { secure: this.env.SESSION_COOKIE_SECURE };
  }
}
