import { Inject, Injectable } from '@nestjs/common';
import type { Database, DbExecutor } from '@hv/db';
import type { FastifyRequest } from 'fastify';
import type { AuthContext, RequestMeta } from '../common/request-context';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { SESSION_COOKIE, readCookie } from './cookies';
import { SessionsRepository } from './sessions.repository';
import { generateSessionToken, isWellFormedSessionToken, sha256 } from './tokens';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/** Server-side sessions in PostgreSQL (Revision 2 B6). */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly repository: SessionsRepository,
  ) {}

  /** Creates a session inside the caller's transaction. The plain token leaves only in the cookie. */
  async issue(
    trx: DbExecutor,
    userId: string,
    mfaRequired: boolean,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const token = generateSessionToken();
    const { expiresAt } = await this.repository.insert(trx, {
      tokenHash: sha256(token),
      userId,
      mfaRequired,
      ttlHours: this.env.SESSION_TTL_HOURS,
      meta,
    });
    return { token, expiresAt };
  }

  /** Resolves the session cookie of a request, or null when absent, malformed, expired or revoked. */
  async authenticate(request: FastifyRequest): Promise<AuthContext | null> {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token || !isWellFormedSessionToken(token)) return null;
    return this.repository.findActiveByTokenHash(this.db, sha256(token));
  }

  revoke(sessionId: string): Promise<void> {
    return this.repository.revoke(this.db, sessionId);
  }

  get cookieOptions() {
    return { secure: this.env.SESSION_COOKIE_SECURE };
  }
}
