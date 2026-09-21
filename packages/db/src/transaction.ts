import type { IsolationLevel, Kysely, Transaction } from 'kysely';
import { setTimeout as sleep } from 'node:timers/promises';

/** serialization_failure, deadlock_detected — safe to retry the whole transaction. */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

export function isRetryableTransactionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_SQLSTATES.has(error.code)
  );
}

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
}

/**
 * Runs `fn` in one database transaction. On serialization failure or deadlock
 * the whole transaction is retried, so `fn` must not have side effects outside
 * the database (no emails, no provider calls — use the outbox for those).
 * Any other error is rethrown immediately after rollback.
 */
export async function withTransaction<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const builder = options.isolationLevel
        ? db.transaction().setIsolationLevel(options.isolationLevel)
        : db.transaction();
      return await builder.execute(fn);
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(10 * 2 ** (attempt - 1) + Math.floor(Math.random() * 10));
    }
  }
}
