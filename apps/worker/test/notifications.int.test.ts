/**
 * Outbox → notifications relay and mail delivery, against real PostgreSQL,
 * real Redis and real SMTP (Mailpit). ADR-0028.
 *
 * The properties under test are the ones the relay exists for: `published_at`
 * means the message was accepted by SMTP and never "queued in Redis", the
 * plaintext one-time code is nowhere in PostgreSQL, and a failed send leaves
 * an event that can actually be delivered later — which is exactly what
 * retained BullMQ jobs would have quietly prevented.
 */
import { randomUUID } from 'node:crypto';
import { createDb, type Database } from '@hv/db';
import { createTestDatabase, type TestDatabase } from '@hv/db/testing';
import { SecretBox, sealPayload } from '@hv/domain';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MailMessage, MailPort } from '../src/mail/mail.port';
import { UnconfiguredMailer } from '../src/mail/mail.port';
import {
  VERIFICATION_EMAIL_TOPIC,
  createVerificationEmailOpener,
} from '../src/mail/verification-email';
import {
  NOTIFICATION_JOB_OPTIONS,
  SEND_JOB,
  createNotificationRelay,
  createNotificationsQueue,
  createNotificationsWorker,
  countUndelivered,
  deliverNotification,
  type NotificationJob,
} from '../src/outbox/notifications';
import {
  createTopicDispatcher,
  enqueueOutboxEvent,
  publishOutbox,
  type OutboxHandler,
} from '../src/outbox/outbox';

function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('TEST_REDIS_URL is not set');
  return url;
}

const KEY = '4f8b2c19a07d3e56b1c48a29f70d6e35c92a1b84de07f63a5c18e40b9d2f7a61';
const box = new SecretBox(KEY, 'k1');
const open = createVerificationEmailOpener(box);

/** Records what was sent, and can be told to fail. */
class RecordingMailer implements MailPort {
  readonly sent: MailMessage[] = [];
  failures = 0;

  send(message: MailMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('smtp refused the message'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}

describe('outbox → notifications relay', () => {
  let database: TestDatabase;
  let db: Database;
  let sql: pg.Pool;
  let redis: Redis;
  let queueName: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.url, applicationName: 'hv-test-notify', max: 8 });
    sql = new pg.Pool({ connectionString: database.url, max: 4 });
    redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
    queueName = `test-notifications-${randomUUID()}`;
  });

  afterEach(async () => {
    await db?.destroy();
    await sql?.end();
    redis?.disconnect();
    await database?.drop();
  });

  const CODE = '204815';
  const TO = 'guest@example.com';

  /** A sealed verification event, the way P5-4's producer will write one. */
  const sealedEvent = (to = TO, code = CODE) =>
    enqueueOutboxEvent(
      db,
      VERIFICATION_EMAIL_TOPIC,
      sealPayload(box, VERIFICATION_EMAIL_TOPIC, { to, code, expiresInMinutes: 10 }),
    );

  const row = async (id: string) =>
    (
      await sql.query<{
        attempts: number;
        published_at: Date | null;
        last_error: string | null;
        payload: unknown;
      }>(`SELECT attempts, published_at, last_error, payload FROM outbox WHERE id = $1`, [id])
    ).rows[0]!;

  const relayOnce = async (queue: ReturnType<typeof createNotificationsQueue>) => {
    const handlers: Record<string, OutboxHandler> = {
      [VERIFICATION_EMAIL_TOPIC]: createNotificationRelay(queue),
    };
    return publishOutbox(db, createTopicDispatcher(handlers));
  };

  describe('the plaintext code never reaches PostgreSQL or Redis', () => {
    it('stores only a sealed envelope, with no trace of the code or the address', async () => {
      const id = await sealedEvent();

      // Straight from the column, not through any helper that might decrypt.
      const { rows } = await sql.query<{ payload: Record<string, unknown>; raw: string }>(
        `SELECT payload, payload::text AS raw FROM outbox WHERE id = $1`,
        [id],
      );
      const stored = rows[0]!;
      expect(stored.raw).not.toContain(CODE);
      expect(stored.raw).not.toContain(TO);
      expect(Object.keys(stored.payload).sort()).toEqual(['kid', 'sealed', 'v']);

      // And nothing anywhere else in the table either.
      const { rows: scan } = await sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`,
        [CODE],
      );
      expect(scan[0]!.n).toBe(0);
    });

    it('keeps the payload sealed as it travels through Redis', async () => {
      const id = await sealedEvent();
      const queue = createNotificationsQueue(redis, queueName);
      try {
        await relayOnce(queue);
        const job = await queue.getJob(id);
        expect(JSON.stringify(job!.data)).not.toContain(CODE);
        expect(JSON.stringify(job!.data)).not.toContain(TO);
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it('opens the sealed payload back to the original code', () => {
      const payload = sealPayload(box, VERIFICATION_EMAIL_TOPIC, {
        to: TO,
        code: CODE,
        expiresInMinutes: 10,
      });
      expect(open(VERIFICATION_EMAIL_TOPIC, payload)).toEqual({
        to: TO,
        code: CODE,
        expiresInMinutes: 10,
      });
    });
  });

  describe('published_at means delivered, never queued', () => {
    it('leaves the row unpublished once the relay has enqueued it', async () => {
      const id = await sealedEvent();
      const queue = createNotificationsQueue(redis, queueName);
      try {
        expect(await relayOnce(queue)).toEqual({ published: 0, deferred: 1, failed: 0 });
        const after = await row(id);
        expect(after.published_at).toBeNull();
        expect(after.attempts).toBe(1);
        expect(await queue.getJob(id)).toBeTruthy();
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it('marks the row published only after SMTP accepts the message', async () => {
      const id = await sealedEvent();
      const mailer = new RecordingMailer();
      const job: NotificationJob = {
        outboxId: id,
        topic: VERIFICATION_EMAIL_TOPIC,
        payload: (await row(id)).payload as Record<string, unknown>,
        attempts: 1,
      };

      await deliverNotification({ db, mailer, open }, job);

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe(TO);
      expect(mailer.sent[0]!.text).toContain(CODE);
      const after = await row(id);
      expect(after.published_at).not.toBeNull();
      expect(after.last_error).toBeNull();
    });

    it('does not publish the row when SMTP fails, and records why', async () => {
      const id = await sealedEvent();
      const mailer = new RecordingMailer();
      mailer.failures = 1;
      const job: NotificationJob = {
        outboxId: id,
        topic: VERIFICATION_EMAIL_TOPIC,
        payload: (await row(id)).payload as Record<string, unknown>,
        attempts: 1,
      };

      await expect(deliverNotification({ db, mailer, open }, job)).rejects.toThrow('smtp refused');

      const after = await row(id);
      expect(after.published_at).toBeNull();
      expect(after.last_error).toBe('smtp refused the message');
      expect(mailer.sent).toEqual([]);
    });

    it('records a failure, and never the code, when mail is unconfigured', async () => {
      const id = await sealedEvent();
      const job: NotificationJob = {
        outboxId: id,
        topic: VERIFICATION_EMAIL_TOPIC,
        payload: (await row(id)).payload as Record<string, unknown>,
        attempts: 1,
      };

      await expect(
        deliverNotification({ db, mailer: new UnconfiguredMailer('no SMTP_URL'), open }, job),
      ).rejects.toThrow('mail is not configured');
      const after = await row(id);
      expect(after.published_at).toBeNull();
      expect(after.last_error).not.toContain(CODE);
      expect(after.last_error).not.toContain(TO);
    });
  });

  describe('BullMQ lifecycle the relay depends on', () => {
    it('deduplicates a waiting job so one row is never sent twice at once', async () => {
      const id = await sealedEvent();
      const queue = createNotificationsQueue(redis, queueName);
      try {
        await relayOnce(queue);
        // The lease normally prevents this; force a second relay of the same row.
        await sql.query(`UPDATE outbox SET available_at = now() WHERE id = $1`, [id]);
        await relayOnce(queue);

        const counts = await queue.getJobCounts('wait', 'active', 'delayed');
        expect((counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0)).toBe(1);
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it('removes terminal jobs so the same outbox id can be relayed again', async () => {
      const id = await sealedEvent();
      const mailer = new RecordingMailer();
      mailer.failures = 1;
      const queue = createNotificationsQueue(redis, queueName);
      const worker = createNotificationsWorker({
        connection: redis,
        db,
        mailer,
        open,
        queueName,
      });
      try {
        // First delivery fails; the job must NOT linger under this id.
        await relayOnce(queue);
        await new Promise<void>((resolve) => worker.once('failed', () => resolve()));
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await queue.getJob(id)).toBeUndefined();
        expect((await row(id)).published_at).toBeNull();

        // The outbox drives the retry: relay again, and it is accepted.
        await sql.query(`UPDATE outbox SET available_at = now() WHERE id = $1`, [id]);
        await relayOnce(queue);
        await new Promise<void>((resolve) => worker.once('completed', () => resolve()));
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(mailer.sent).toHaveLength(1);
        expect((await row(id)).published_at).not.toBeNull();
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it('keeps retry in PostgreSQL by giving jobs a single attempt', () => {
      expect(NOTIFICATION_JOB_OPTIONS).toEqual({
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });
    });

    it('refuses an unknown job name on the notifications queue', async () => {
      const queue = createNotificationsQueue(redis, queueName);
      const worker = createNotificationsWorker({
        connection: redis,
        db,
        mailer: new RecordingMailer(),
        open,
        queueName,
      });
      try {
        const failed = new Promise<Error>((resolve) =>
          worker.once('failed', (_j, e) => resolve(e)),
        );
        await queue.add('not-a-send', {} as NotificationJob);
        expect((await failed).message).toContain('Unknown notifications job');
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });
  });

  describe('redelivery is safe', () => {
    it('sends again but publishes once when an event is delivered twice', async () => {
      const id = await sealedEvent();
      const mailer = new RecordingMailer();
      const job: NotificationJob = {
        outboxId: id,
        topic: VERIFICATION_EMAIL_TOPIC,
        payload: (await row(id)).payload as Record<string, unknown>,
        attempts: 1,
      };

      await deliverNotification({ db, mailer, open }, job);
      const firstPublishedAt = (await row(id)).published_at;

      // At-least-once (ADR-0028): a duplicate email is an accepted outcome.
      await deliverNotification({ db, mailer, open }, job);

      expect(mailer.sent).toHaveLength(2);
      // …but the record of the first success is untouched.
      expect((await row(id)).published_at).toEqual(firstPublishedAt);
    });
  });

  describe('end to end through the queue', () => {
    it('relays, sends and publishes a real event', async () => {
      const id = await sealedEvent();
      const mailer = new RecordingMailer();
      const queue = createNotificationsQueue(redis, queueName);
      const worker = createNotificationsWorker({
        connection: redis,
        db,
        mailer,
        open,
        queueName,
      });
      try {
        const done = new Promise<void>((resolve) => worker.once('completed', () => resolve()));
        expect(await relayOnce(queue)).toEqual({ published: 0, deferred: 1, failed: 0 });
        await done;
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(mailer.sent).toHaveLength(1);
        expect(mailer.sent[0]!.text).toContain(CODE);
        expect((await row(id)).published_at).not.toBeNull();
        expect(await queue.getJob(id)).toBeUndefined();
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    it('fails an event sealed for a different topic instead of sending it', async () => {
      const id = await enqueueOutboxEvent(
        db,
        VERIFICATION_EMAIL_TOPIC,
        sealPayload(box, 'email.something_else', {
          to: TO,
          code: CODE,
          expiresInMinutes: 10,
        }),
      );
      const mailer = new RecordingMailer();
      const job: NotificationJob = {
        outboxId: id,
        topic: VERIFICATION_EMAIL_TOPIC,
        payload: (await row(id)).payload as Record<string, unknown>,
        attempts: 1,
      };

      await expect(deliverNotification({ db, mailer, open }, job)).rejects.toThrow();
      expect(mailer.sent).toEqual([]);
      expect((await row(id)).published_at).toBeNull();
    });
  });

  it('exposes how many verification events are still undelivered', async () => {
    await sealedEvent();
    await sealedEvent('second@example.com');
    expect(await countUndelivered(db, VERIFICATION_EMAIL_TOPIC)).toBe(2);
  });

  it('names the send job consistently', () => {
    expect(SEND_JOB).toBe('send');
  });
});
