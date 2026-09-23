import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';
import type { AuthContext, RequestMeta } from '../common/request-context';

export interface NewSession {
  tokenHash: Buffer;
  userId: string;
  mfaRequired: boolean;
  ttlHours: number;
  meta: RequestMeta;
}

@Injectable()
export class SessionsRepository {
  async insert(db: DbExecutor, session: NewSession): Promise<{ id: string; expiresAt: Date }> {
    const row = await db
      .insertInto('sessions')
      .values({
        token_hash: session.tokenHash,
        user_id: session.userId,
        mfa_required: session.mfaRequired,
        expires_at: sql<Date>`now() + make_interval(hours => ${session.ttlHours})`,
        ip: session.meta.ip,
        user_agent: session.meta.userAgent,
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();
    return { id: row.id, expiresAt: row.expires_at };
  }

  /** A live session: not revoked, not expired (database clock), and its user is active. */
  async findActiveByTokenHash(db: DbExecutor, tokenHash: Buffer): Promise<AuthContext | null> {
    const row = await db
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select([
        's.id',
        's.user_id',
        'u.email',
        's.mfa_required',
        's.mfa_verified_at',
        's.expires_at',
      ])
      .where('s.token_hash', '=', tokenHash)
      .where('s.revoked_at', 'is', null)
      .where('s.expires_at', '>', sql<Date>`now()`)
      .where('u.status', '=', 'active')
      .executeTakeFirst();
    if (!row) return null;
    return {
      sessionId: row.id,
      userId: row.user_id,
      email: row.email,
      mfaRequired: row.mfa_required,
      mfaVerifiedAt: row.mfa_verified_at,
      expiresAt: row.expires_at,
    };
  }

  async revoke(db: DbExecutor, sessionId: string): Promise<void> {
    await db
      .updateTable('sessions')
      .set({ revoked_at: sql<Date>`now()` })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async revokeOthers(db: DbExecutor, userId: string, keepSessionId: string): Promise<void> {
    await db
      .updateTable('sessions')
      .set({ revoked_at: sql<Date>`now()` })
      .where('user_id', '=', userId)
      .where('id', '<>', keepSessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Records a successful second-factor check (sign-in or step-up). */
  async markMfaVerified(db: DbExecutor, sessionId: string): Promise<Date> {
    const row = await db
      .updateTable('sessions')
      .set({ mfa_required: true, mfa_verified_at: sql<Date>`now()` })
      .where('id', '=', sessionId)
      .returning('mfa_verified_at')
      .executeTakeFirstOrThrow();
    return row.mfa_verified_at!;
  }
}
