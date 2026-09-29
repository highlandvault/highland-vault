import { Injectable } from '@nestjs/common';
import { type DbExecutor, sql } from '@hv/db';

export interface LiveVerification {
  readonly id: string;
  readonly codeHash: Buffer;
  readonly attempts: number;
}

@Injectable()
export class EmailVerificationRepository {
  async insert(
    db: DbExecutor,
    verification: {
      guestSessionId: string;
      email: string;
      codeHash: Buffer;
      ttlMinutes: number;
    },
  ): Promise<string> {
    const row = await db
      .insertInto('guest_email_verifications')
      .values({
        guest_session_id: verification.guestSessionId,
        email: verification.email,
        code_hash: verification.codeHash,
        expires_at: sql<Date>`now() + make_interval(mins => ${verification.ttlMinutes})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /**
   * The newest unused, unexpired code for this session and address, locked.
   *
   * Locked because the attempt count is a security control: two requests
   * guessing at once must not each see the same count and both be allowed.
   * Everything after this in the transaction relies on holding it.
   */
  async findLiveForUpdate(
    trx: DbExecutor,
    guestSessionId: string,
    email: string,
  ): Promise<LiveVerification | null> {
    const row = await trx
      .selectFrom('guest_email_verifications')
      .select(['id', 'code_hash', 'attempts'])
      .where('guest_session_id', '=', guestSessionId)
      .where('email', '=', email)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .orderBy('created_at', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return null;
    return { id: row.id, codeHash: row.code_hash, attempts: row.attempts };
  }

  /** Counts the attempt, whether or not the code was right. */
  async countAttempt(trx: DbExecutor, id: string): Promise<void> {
    await trx
      .updateTable('guest_email_verifications')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('id', '=', id)
      .execute();
  }

  /**
   * Spends the code. Conditional on it still being unused, so two correct
   * guesses racing can only consume it once; the guard refuses a second.
   */
  async consume(trx: DbExecutor, id: string): Promise<boolean> {
    const result = await trx
      .updateTable('guest_email_verifications')
      .set({ consumed_at: sql<Date>`now()` })
      .where('id', '=', id)
      .where('consumed_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  /**
   * Codes issued for an address in the window, for the send limit — used or
   * not, expired or not: what is being limited is how often an inbox can be
   * mailed, not how many codes are still usable.
   */
  async countRecentSends(db: DbExecutor, email: string, withinMinutes: number): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM guest_email_verifications
       WHERE email = ${email}
         AND created_at > now() - make_interval(mins => ${withinMinutes})
    `.execute(db);
    return rows[0]?.n ?? 0;
  }
}
