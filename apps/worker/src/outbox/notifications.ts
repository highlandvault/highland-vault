/**
 * The `notifications` queue and the relay that feeds it (ADR-0028,
 * specification Part B17).
 *
 * Division of labour:
 *   * the OUTBOX worker claims due rows and relays them here — it never sends
 *     and never marks a row published;
 *   * the NOTIFICATIONS worker sends the message and only then marks the row
 *     published, so `published_at` means the email was accepted by SMTP.
 *
 * PostgreSQL stays the source of truth. Nothing is read back from Redis, and
 * if Redis is emptied every unpublished row is relayed again once its claim
 * lease lapses.
 */
import { type Database, sql } from '@hv/db';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { MailPort } from '../mail/mail.port';
import { renderVerificationEmail, type VerificationEmailOpener } from '../mail/verification-email';
import {
  markOutboxFailed,
  markOutboxPublished,
  type OutboxEvent,
  type OutboxOutcome,
} from './outbox';

export const NOTIFICATIONS_QUEUE = 'notifications';
export const SEND_JOB = 'send';

/**
 * Job options that make the relay work (ADR-0028), not a tidiness preference.
 *
 * BullMQ ignores an add whose job id already exists — including ids belonging
 * to RETAINED completed or failed jobs. With retention, a failed email would
 * leave a retained failed job under the row's id, every later relay would be
 * silently dropped, and the event would never be delivered again: the retry
 * guarantee would be gone. Removing terminal jobs frees the id so PostgreSQL
 * can drive the retry.
 *
 * `attempts: 1` for the same reason — retry belongs to the outbox, and two
 * retry systems would make `attempts` and `last_error` meaningless.
 */
export const NOTIFICATION_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
} as const;

/** What travels through Redis. The payload stays SEALED: no plaintext in Redis. */
export interface NotificationJob {
  readonly outboxId: string;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

export function createNotificationsQueue(
  connection: ConnectionOptions,
  name = NOTIFICATIONS_QUEUE,
): Queue<NotificationJob> {
  return new Queue<NotificationJob>(name, {
    connection,
    defaultJobOptions: NOTIFICATION_JOB_OPTIONS,
  });
}

/**
 * The outbox-side handler: enqueue and step back.
 *
 * The job id is the outbox row id (B17), so a relay running again while a job
 * is still waiting or active does not create a second one. It returns
 * `deferred`, which is what keeps the row unpublished until the message is
 * really sent.
 *
 * There is deliberately no database write after the enqueue, so there is no
 * window in which Redis holds a job that PostgreSQL has already written off.
 */
export function createNotificationRelay(queue: Queue<NotificationJob>) {
  return async (event: OutboxEvent): Promise<OutboxOutcome> => {
    await queue.add(
      SEND_JOB,
      {
        outboxId: event.id,
        topic: event.topic,
        payload: event.payload,
        attempts: event.attempts,
      },
      { jobId: event.id },
    );
    return 'deferred';
  };
}

export interface NotificationsWorkerOptions {
  readonly connection: ConnectionOptions;
  readonly db: Database;
  readonly mailer: MailPort;
  readonly open: VerificationEmailOpener;
  readonly queueName?: string;
}

/**
 * Sends one notification and records the outcome on its outbox row.
 *
 * On failure the row is marked failed (so the backoff and `last_error` are the
 * outbox's, as they always were) and the error is rethrown, so the job is
 * marked failed and removed and its id becomes free for the next relay.
 */
export async function deliverNotification(
  options: Omit<NotificationsWorkerOptions, 'connection' | 'queueName'>,
  job: NotificationJob,
): Promise<void> {
  const { db, mailer, open } = options;
  try {
    const message = renderVerificationEmail(open(job.topic, job.payload));
    await mailer.send(message);
  } catch (error) {
    // The message is never included: it carries a one-time code (ADR-0028).
    await markOutboxFailed(db, job.outboxId, job.attempts, (error as Error).message);
    throw error;
  }
  await markOutboxPublished(db, job.outboxId);
}

export function createNotificationsWorker(
  options: NotificationsWorkerOptions,
): Worker<NotificationJob, void> {
  return new Worker<NotificationJob, void>(
    options.queueName ?? NOTIFICATIONS_QUEUE,
    async (job) => {
      if (job.name !== SEND_JOB) throw new Error(`Unknown notifications job: ${job.name}`);
      await deliverNotification(options, job.data);
    },
    { connection: options.connection, concurrency: 4 },
  );
}

/** Unpublished events whose topic routes to notifications, for operator checks. */
export async function countUndelivered(db: Database, topic: string): Promise<number> {
  const { rows } = await sql<{
    n: number;
  }>`SELECT count(*)::int AS n FROM outbox WHERE topic = ${topic} AND published_at IS NULL`.execute(
    db,
  );
  return rows[0]?.n ?? 0;
}
