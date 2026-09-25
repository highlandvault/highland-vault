/**
 * Serialising a verified email against its account (ADR-0021).
 *
 * Guest allocation asks "does an account exist for this address?" and
 * registration answers it by creating one. Both then write cap counters keyed
 * on what they found. Row locks cannot serialise that, because the losing race
 * is a row that does not exist yet: the guest resolves "no account", the
 * registration commits and merges, and the guest then inserts a fresh
 * email-keyed counter behind it. Split counters, cap bypassed.
 *
 * A transaction-scoped advisory lock on the address closes it. Whoever takes
 * it second sees the other's committed state and resolves correctly.
 *
 * This is the ticket engine's only advisory lock, and it is deliberately not a
 * lock on tickets or reservations: it orders two identity decisions, nothing
 * else, and it is released when the transaction ends however it ends.
 */
import { sql } from 'kysely';
import type { DbExecutor } from './client';

/**
 * Takes the lock for a normalized email. Must be called INSIDE the transaction
 * that is about to resolve or create the identity, before anything is read.
 */
export async function lockEntrantEmail(db: DbExecutor, normalizedEmail: string): Promise<void> {
  // hashtext gives a stable 32-bit key; the namespace keeps it clear of any
  // other advisory lock this project might take later.
  await sql`SELECT pg_advisory_xact_lock(hashtext(${'hv:entrant:' + normalizedEmail}))`.execute(db);
}
