/**
 * Writing to the transactional outbox (migration 0011, ADR-0028).
 *
 * This lives in the database package rather than the worker because the
 * producer and the deliverer are different processes: the API writes events
 * inside its own business transactions, and the worker relays and delivers
 * them. Both need this one INSERT, and neither app can import from the other.
 */
import type { DbExecutor } from './client';
import { sql } from 'kysely';

/**
 * Adds an event to the outbox.
 *
 * Call it with the SAME executor as the business change, so the two commit or
 * roll back together — that is the entire point of the outbox, and the reason
 * this takes an executor rather than a database handle.
 */
export async function enqueueOutboxEvent(
  executor: DbExecutor,
  topic: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const { rows } = await sql<{
    id: string;
  }>`INSERT INTO outbox (topic, payload) VALUES (${topic}, ${JSON.stringify(payload)}::jsonb) RETURNING id`.execute(
    executor,
  );
  return rows[0]!.id;
}
