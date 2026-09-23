/**
 * Time-based draw lifecycle (Revision 2 B14, B17 `draw-lifecycle` queue):
 * scheduled → live at opens_at, live → closed at closes_at. Settlement after
 * close is Phase 9 and is not triggered here.
 *
 * Safe to run concurrently and repeatedly: each change is a conditional UPDATE
 * (`WHERE status = <expected>`), so a second sweeper finds nothing left to do,
 * and every applied change writes its audit row in the same statement.
 */
import { type Database, sql, withTransaction } from '@hv/db';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

export const DRAW_LIFECYCLE_QUEUE = 'draw-lifecycle';
export const SWEEP_JOB = 'sweep';
export const SWEEP_SCHEDULER_ID = 'draw-lifecycle-sweep';
export const SWEEP_INTERVAL_MS = 60_000;

export interface SweepResult {
  opened: string[];
  closed: string[];
}

export async function sweepDrawLifecycle(db: Database): Promise<SweepResult> {
  return withTransaction(db, async (trx) => {
    const opened = await sql<{ id: string }>`
      WITH changed AS (
        UPDATE draws SET status = 'live'
         WHERE status = 'scheduled' AND opens_at <= now()
        RETURNING id, market_id
      ), audited AS (
        INSERT INTO audit_log (actor_type, action, entity_type, entity_id, market_id, before, after)
        SELECT 'system', 'draw.opened', 'draw', id::text, market_id,
               '{"status":"scheduled"}'::jsonb, '{"status":"live"}'::jsonb
          FROM changed
      )
      SELECT id FROM changed`.execute(trx);

    // Runs after the opening step, so a draw whose whole window has passed
    // (for example while the worker was down) still goes scheduled → live → closed.
    const closed = await sql<{ id: string }>`
      WITH changed AS (
        UPDATE draws SET status = 'closed', closed_at = now()
         WHERE status = 'live' AND closes_at <= now()
        RETURNING id, market_id
      ), audited AS (
        INSERT INTO audit_log (actor_type, action, entity_type, entity_id, market_id, before, after)
        SELECT 'system', 'draw.closed', 'draw', id::text, market_id,
               '{"status":"live"}'::jsonb, '{"status":"closed"}'::jsonb
          FROM changed
      )
      SELECT id FROM changed`.execute(trx);

    return { opened: opened.rows.map((r) => r.id), closed: closed.rows.map((r) => r.id) };
  });
}

export function createDrawLifecycleQueue(
  connection: ConnectionOptions,
  name = DRAW_LIFECYCLE_QUEUE,
): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 },
  });
}

export function createDrawLifecycleWorker(options: {
  connection: ConnectionOptions;
  db: Database;
  queueName?: string;
}): Worker<unknown, SweepResult> {
  return new Worker<unknown, SweepResult>(
    options.queueName ?? DRAW_LIFECYCLE_QUEUE,
    async (job) => {
      if (job.name !== SWEEP_JOB) throw new Error(`Unknown draw-lifecycle job: ${job.name}`);
      return sweepDrawLifecycle(options.db);
    },
    { connection: options.connection, concurrency: 1 },
  );
}
