import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';
import type { RequestMeta } from '../common/request-context';

/**
 * A live guest session, as a request sees it.
 *
 * Note what is absent: no user id, no permissions, no MFA state. A guest
 * session cannot answer an authorization question, only "which checkout is
 * this" and "which address has been verified" (ADR-0029).
 */
export interface GuestContext {
  readonly guestSessionId: string;
  readonly verifiedEmail: string | null;
  readonly verifiedEmailAt: Date | null;
  readonly expiresAt: Date;
}

@Injectable()
export class GuestSessionsRepository {
  async insert(
    db: DbExecutor,
    session: { tokenHash: Buffer; ttlHours: number; meta: RequestMeta },
  ): Promise<{ id: string; expiresAt: Date }> {
    const row = await db
      .insertInto('guest_sessions')
      .values({
        token_hash: session.tokenHash,
        expires_at: sql<Date>`now() + make_interval(hours => ${session.ttlHours})`,
        ip: session.meta.ip,
        user_agent: session.meta.userAgent,
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();
    return { id: row.id, expiresAt: row.expires_at };
  }

  /** A live session: not revoked and not expired, by the database clock. */
  async findLiveByTokenHash(db: DbExecutor, tokenHash: Buffer): Promise<GuestContext | null> {
    const row = await db
      .selectFrom('guest_sessions')
      .select(['id', 'verified_email', 'verified_email_at', 'expires_at'])
      .where('token_hash', '=', tokenHash)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) return null;
    return {
      guestSessionId: row.id,
      verifiedEmail: row.verified_email,
      verifiedEmailAt: row.verified_email_at,
      expiresAt: row.expires_at,
    };
  }

  /** The same live-session read, by id, for re-reading after a write. */
  async findLiveById(db: DbExecutor, id: string): Promise<GuestContext | null> {
    const row = await db
      .selectFrom('guest_sessions')
      .select(['id', 'verified_email', 'verified_email_at', 'expires_at'])
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) return null;
    return {
      guestSessionId: row.id,
      verifiedEmail: row.verified_email,
      verifiedEmailAt: row.verified_email_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Records a verified address, once.
   *
   * Conditional on the session still being live and not already carrying one,
   * so a race cannot overwrite the address a basket was built against; the
   * guard trigger refuses it as well. Returns false when nothing was written.
   */
  async bindVerifiedEmail(
    db: DbExecutor,
    guestSessionId: string,
    normalizedEmail: string,
  ): Promise<boolean> {
    const result = await db
      .updateTable('guest_sessions')
      .set({ verified_email: normalizedEmail, verified_email_at: sql<Date>`now()` })
      .where('id', '=', guestSessionId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .where('verified_email', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async revoke(db: DbExecutor, guestSessionId: string): Promise<void> {
    await db
      .updateTable('guest_sessions')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', guestSessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}
