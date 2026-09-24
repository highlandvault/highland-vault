import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Database } from '@hv/db';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { DATABASE, REDIS } from '../tokens';
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
 * Delivers outbox events every few seconds.
 *
 * No handlers are registered yet, so nothing is delivered and nothing is
 * produced: P5-1 builds the mechanism, and P5-2 registers the first handler
 * (the guest verification email) once the mail port exists. Until then an
 * event with an unknown topic would be recorded as failed rather than lost,
 * which is the behaviour we want if a producer ever lands first.
 */
@Injectable()
export class OutboxService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private queue?: Queue;
  private worker?: Worker<unknown, PublishResult>;
  private readonly handlers: Record<string, OutboxHandler> = {};

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = createOutboxQueue(this.redis);
    this.worker = createOutboxWorker({
      connection: this.redis,
      db: this.db,
      handle: createTopicDispatcher(this.handlers),
    });
    this.worker.on('completed', (_job, result) => {
      if (result.published > 0 || result.failed > 0) {
        this.logger.log(`outbox published: ${result.published}, failed: ${result.failed}`);
      }
    });
    this.worker.on('failed', (job, error) =>
      this.logger.error(`outbox run ${job?.id} failed: ${error.message}`),
    );
    this.worker.on('error', (error) => this.logger.error(`worker error: ${error.message}`));

    // Idempotent scheduler: restarts never create a second schedule.
    await this.queue.upsertJobScheduler(
      PUBLISH_SCHEDULER_ID,
      { every: PUBLISH_INTERVAL_MS },
      { name: PUBLISH_JOB },
    );
    this.logger.log(`outbox delivery every ${PUBLISH_INTERVAL_MS / 1000}s`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
