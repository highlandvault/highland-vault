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
 * Phase 6 adds the B9 safety rule: a trusted provider status check before
 * expiring a reservation whose order has a pending payment.
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
