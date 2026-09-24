import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Database } from '@hv/db';
import { SecretBox } from '@hv/domain';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { WORKER_ENV, type WorkerEnv } from '../config/env';
import { UnconfiguredMailer, type MailPort } from '../mail/mail.port';
import { SmtpMailer } from '../mail/smtp-mailer';
import {
  VERIFICATION_EMAIL_TOPIC,
  createVerificationEmailOpener,
} from '../mail/verification-email';
import { DATABASE, REDIS } from '../tokens';
import {
  createNotificationRelay,
  createNotificationsQueue,
  createNotificationsWorker,
  type NotificationJob,
} from './notifications';
import {
  PUBLISH_INTERVAL_MS,
  PUBLISH_JOB,
  PUBLISH_SCHEDULER_ID,
  type OutboxHandler,
  type PublishResult,
  createOutboxQueue,
  createOutboxWorker,
  createTopicDispatcher,
} from './outbox';

/**
 * Runs both halves of outbox delivery (ADR-0028):
 *
 *   * the outbox worker claims due rows every few seconds and RELAYS them to
 *     the notifications queue, keyed by the row id;
 *   * the notifications worker sends the message and marks the row published.
 *
 * Mail configuration is optional outside production so development and the
 * existing tests run without SMTP; a worker without it refuses to send rather
 * than appearing to work, and production refuses to start at all (config).
 */
@Injectable()
export class OutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private outboxQueue?: Queue;
  private outboxWorker?: Worker<unknown, PublishResult>;
  private notificationsQueue?: Queue<NotificationJob>;
  private notificationsWorker?: Worker<NotificationJob, void>;
  private mailer?: MailPort;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.notificationsQueue = createNotificationsQueue(this.redis);
    this.mailer = this.createMailer();

    this.outboxQueue = createOutboxQueue(this.redis);
    const relay = createNotificationRelay(this.notificationsQueue);
    const handlers: Record<string, OutboxHandler> = { [VERIFICATION_EMAIL_TOPIC]: relay };
    this.outboxWorker = createOutboxWorker({
      connection: this.redis,
      db: this.db,
      handle: createTopicDispatcher(handlers),
    });
    this.outboxWorker.on('completed', (_job, result) => {
      if (result.published + result.deferred + result.failed > 0) {
        this.logger.log(
          `outbox relayed: ${result.deferred}, published: ${result.published}, failed: ${result.failed}`,
        );
      }
    });
    this.outboxWorker.on('failed', (job, error) =>
      this.logger.error(`outbox run ${job?.id} failed: ${error.message}`),
    );
    this.outboxWorker.on('error', (error) => this.logger.error(`worker error: ${error.message}`));

    this.notificationsWorker = createNotificationsWorker({
      connection: this.redis,
      db: this.db,
      mailer: this.mailer,
      open: createVerificationEmailOpener(this.secretBox()),
    });
    // Only the outbox id is logged: never the address, never the code.
    this.notificationsWorker.on('failed', (job, error) =>
      this.logger.error(`notification ${job?.data.outboxId} failed: ${error.message}`),
    );
    this.notificationsWorker.on('error', (error) =>
      this.logger.error(`notifications worker error: ${error.message}`),
    );

    await this.outboxQueue.upsertJobScheduler(
      PUBLISH_SCHEDULER_ID,
      { every: PUBLISH_INTERVAL_MS },
      { name: PUBLISH_JOB },
    );
    this.logger.log(`outbox relay every ${PUBLISH_INTERVAL_MS / 1000}s`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.outboxWorker?.close();
    await this.notificationsWorker?.close();
    await this.outboxQueue?.close();
    await this.notificationsQueue?.close();
    if (this.mailer instanceof SmtpMailer) this.mailer.close();
  }

  private createMailer(): MailPort {
    const { SMTP_URL, MAIL_FROM } = this.env;
    if (!SMTP_URL || !MAIL_FROM) {
      this.logger.warn('SMTP_URL/MAIL_FROM are unset: notification events will be recorded failed');
      return new UnconfiguredMailer('SMTP_URL and MAIL_FROM are unset');
    }
    return new SmtpMailer({ url: SMTP_URL, from: MAIL_FROM });
  }

  private secretBox(): SecretBox {
    const key = this.env.OUTBOX_ENCRYPTION_KEY;
    if (!key) {
      // Outside production this is a development worker with no mail
      // configured; the mailer already refuses, and an unopenable payload is
      // recorded as failed rather than silently dropped.
      this.logger.warn('OUTBOX_ENCRYPTION_KEY is unset: sealed payloads cannot be opened');
      return new SecretBox('0'.repeat(64), this.env.OUTBOX_ENCRYPTION_KEY_ID);
    }
    return new SecretBox(key, this.env.OUTBOX_ENCRYPTION_KEY_ID);
  }
}
