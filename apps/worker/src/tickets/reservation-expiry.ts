/**
 * Reservation expiry (ADR-0011, Revision 2 B9 and B17 `reservations` queue):
 * every 30 s, reservations past their expiry end as "expired" and their
 * tickets become available again.
 *
 * All the work is hv_expire_reservations() (migration 0009), which the API also
 * uses for its per-draw sweep: due reservations are taken with SKIP LOCKED and
 * each one ends at most once, so concurrent or repeated runs cannot double-free
 * a ticket or double-decrement a cap counter. Sold tickets are never touched.
 *
 * **No provider is consulted before a reservation expires, and that is a
 * decision rather than an omission (D11a = B).**
 *
 * B9's safety rule would have had this check with the provider before expiring
 * a hold whose order has a payment in flight. Phase 6 does not, because under
 * **D1 = B** the check could never fire: an order's payment deadline is
 * `min(created_at + 600s, earliest reservation expiry − 90s)`, so the deadline
 * always passes at least 90 seconds BEFORE the hold does. By the time a
 * reservation is due here, its order was already unpayable a sweep or three
 * ago, and there is nothing in flight to protect.
 *
 * A second, independent guard stands behind that arithmetic: **D10 = B** made
 * `hv_tickets_guard` refuse `reserved → sold` unless the reservation is
 * `active` with `expires_at > now()` (migration 0022). So even if this sweep
 * did race a confirmation, the database would refuse the sale on its own.
 *
 * **Re-evaluate this if the D1 margin changes.** The safety rule becomes
 * reachable the moment an order's deadline can outlive its hold —
 * `PAYMENT_MARGIN_SECONDS` reaching zero, or the deadline being derived from
 * anything other than the earliest reservation expiry. The guard would still
 * refuse the sale, but the customer would be paying for tickets already back
 * in the pool, which is the case D11 existed to avoid.
 */
import { type Database, sql } from '@hv/db';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

export const RESERVATIONS_QUEUE = 'reservations';
export const EXPIRE_JOB = 'expire';
export const EXPIRE_SCHEDULER_ID = 'reservations-expire';
export const EXPIRE_INTERVAL_MS = 30_000;
/** Reservations per transaction; a run repeats batches up to MAX_BATCHES. */
export const EXPIRE_BATCH = 500;
const MAX_BATCHES = 20;

export interface ExpiryResult {
  expired: number;
}

export async function expireReservations(
  db: Database,
  batch = EXPIRE_BATCH,
): Promise<ExpiryResult> {
  let expired = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    // One statement = one transaction: a batch commits or rolls back as a whole.
    const { rows } = await sql<{
      n: number;
    }>`SELECT hv_expire_reservations(NULL, ${batch}) AS n`.execute(db);
    const n = rows[0]?.n ?? 0;
    expired += n;
    if (n < batch) break;
  }
  return { expired };
}

export function createReservationsQueue(
  connection: ConnectionOptions,
  name = RESERVATIONS_QUEUE,
): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 },
  });
}

export function createReservationsWorker(options: {
  connection: ConnectionOptions;
  db: Database;
  queueName?: string;
}): Worker<unknown, ExpiryResult> {
  return new Worker<unknown, ExpiryResult>(
    options.queueName ?? RESERVATIONS_QUEUE,
    async (job) => {
      if (job.name !== EXPIRE_JOB) throw new Error(`Unknown reservations job: ${job.name}`);
      return expireReservations(options.db);
    },
    { connection: options.connection, concurrency: 1 },
  );
}
