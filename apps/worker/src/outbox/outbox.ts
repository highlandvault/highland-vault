/**
 * Transactional outbox delivery (Phase 5, task P5-1; migration 0011).
 *
 * Producers write an outbox row inside their own business transaction, so the
 * event exists exactly when the business change does. This module is the other
 * half: it claims due events and hands them to a consumer.
 *
 * Delivery is AT LEAST ONCE. A worker can deliver an event and then die before
 * recording the success, and the event is delivered again once its lease
 * lapses. Every handler must therefore be idempotent. The alternative —
 * recording success first — would lose events instead of repeating them, which
 * is the worse failure for an email or a provider call.
 *
 * Claiming is a lease, not a hand-off (see hv_claim_outbox). Nothing here
 * decides when to stop retrying: attempts and the last error are recorded so a
 * stuck event stays visible, and the give-up policy is left to the owner.
 */
import { type Database, type DbExecutor, sql } from '@hv/db';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

export const OUTBOX_QUEUE = 'outbox';
export const PUBLISH_JOB = 'publish';
export const PUBLISH_SCHEDULER_ID = 'outbox-publish';
/** How often a run is scheduled. Delivery latency is at most this plus the run. */
export const PUBLISH_INTERVAL_MS = 5_000;
/** Events claimed per transaction; a run repeats batches while it keeps filling them. */
export const PUBLISH_BATCH = 100;
/** Batches per run, so one run cannot occupy the worker indefinitely. */
const MAX_BATCHES = 20;
/**
 * How long a claimed event stays invisible to other workers. Long enough for a
 * delivery to finish, short enough that a crashed worker's events come back
 * quickly. An event still in flight when this lapses may be delivered twice.
 */
export const CLAIM_LEASE_SECONDS = 60;
/** Retry backoff: attempts are spaced out, and the spacing stops growing here. */
const RETRY_BASE_SECONDS = 10;
const RETRY_MAX_SECONDS = 3600;

export interface OutboxEvent {
  readonly id: string;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

/** Delivers one event. Must be idempotent: the same event can arrive twice. */
export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export interface PublishResult {
  published: number;
  failed: number;
}

interface ClaimedRow {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Spaces out retries, then stops growing so a stuck event keeps being retried. */
export function retryDelaySeconds(attempts: number): number {
  const delay = RETRY_BASE_SECONDS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, RETRY_MAX_SECONDS);
}

/**
 * Adds an event to the outbox. Call it with the SAME executor as the business
 * change, so the two commit or roll back together — that is the entire point
 * of the outbox and the reason this takes an executor rather than a database.
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

async function claim(db: DbExecutor, limit: number): Promise<ClaimedRow[]> {
  const { rows } = await sql<ClaimedRow>`
    SELECT id, topic, payload, attempts FROM hv_claim_outbox(${limit}, ${CLAIM_LEASE_SECONDS})
  `.execute(db);
  return rows;
}

async function markPublished(db: DbExecutor, id: string): Promise<void> {
  await sql`UPDATE outbox SET published_at = now(), last_error = NULL WHERE id = ${id} AND published_at IS NULL`.execute(
    db,
  );
}

async function markFailed(
  db: DbExecutor,
  id: string,
  attempts: number,
  message: string,
): Promise<void> {
  // Bring the next attempt forward from the lease to the backoff, and record why.
  await sql`
    UPDATE outbox
       SET available_at = now() + make_interval(secs => ${retryDelaySeconds(attempts)}),
           last_error = ${message.slice(0, 1000)}
     WHERE id = ${id} AND published_at IS NULL
  `.execute(db);
}

/**
 * Claims and delivers due events until nothing is due or the run is full.
 *
 * Each event is delivered on its own: one failing handler neither stops the
 * run nor rolls back the events already published beside it.
 */
export async function publishOutbox(
  db: Database,
  handle: OutboxHandler,
  batch = PUBLISH_BATCH,
): Promise<PublishResult> {
  const result: PublishResult = { published: 0, failed: 0 };
  for (let i = 0; i < MAX_BATCHES; i++) {
    const claimed = await claim(db, batch);
    for (const event of claimed) {
      try {
        await handle(event);
        await markPublished(db, event.id);
        result.published += 1;
      } catch (error) {
        await markFailed(db, event.id, event.attempts, (error as Error).message);
        result.failed += 1;
      }
    }
    if (claimed.length < batch) break;
  }
  return result;
}

/**
 * Routes an event to the handler registered for its topic. An unknown topic
 * fails the event rather than dropping it: it stays in the outbox, visible,
 * with the reason recorded. P5-2 registers the first real handler.
 */
export function createTopicDispatcher(handlers: Readonly<Record<string, OutboxHandler>>) {
  return async (event: OutboxEvent): Promise<void> => {
    const handler = handlers[event.topic];
    if (!handler) throw new Error(`no handler registered for outbox topic "${event.topic}"`);
    await handler(event);
  };
}

export function createOutboxQueue(connection: ConnectionOptions, name = OUTBOX_QUEUE): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 },
  });
}

export function createOutboxWorker(options: {
  connection: ConnectionOptions;
  db: Database;
  handle: OutboxHandler;
  queueName?: string;
}): Worker<unknown, PublishResult> {
  return new Worker<unknown, PublishResult>(
    options.queueName ?? OUTBOX_QUEUE,
    async (job) => {
      if (job.name !== PUBLISH_JOB) throw new Error(`Unknown outbox job: ${job.name}`);
      return publishOutbox(options.db, options.handle);
    },
    // One run at a time in this process. Several worker processes are still
    // safe: claiming skips rows another worker holds.
    { connection: options.connection, concurrency: 1 },
  );
}
