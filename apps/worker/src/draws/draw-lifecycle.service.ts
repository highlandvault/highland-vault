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
  SWEEP_INTERVAL_MS,
  SWEEP_JOB,
  SWEEP_SCHEDULER_ID,
  createDrawLifecycleQueue,
  createDrawLifecycleWorker,
  type SweepResult,
} from './draw-lifecycle';

/** Runs the draw lifecycle sweep every minute. */
@Injectable()
export class DrawLifecycleService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DrawLifecycleService.name);
  private queue?: Queue;
  private worker?: Worker<unknown, SweepResult>;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = createDrawLifecycleQueue(this.redis);
    this.worker = createDrawLifecycleWorker({ connection: this.redis, db: this.db });
    this.worker.on('completed', (_job, result) => {
      if (result.opened.length > 0 || result.closed.length > 0) {
        this.logger.log(`draws opened: ${result.opened.length}, closed: ${result.closed.length}`);
      }
    });
    this.worker.on('failed', (job, error) =>
      this.logger.error(`draw lifecycle sweep ${job?.id} failed: ${error.message}`),
    );
    this.worker.on('error', (error) => this.logger.error(`worker error: ${error.message}`));

    // Idempotent scheduler: restarts never create a second schedule.
    await this.queue.upsertJobScheduler(
      SWEEP_SCHEDULER_ID,
      { every: SWEEP_INTERVAL_MS },
      { name: SWEEP_JOB },
    );
    this.logger.log(`draw lifecycle sweep every ${SWEEP_INTERVAL_MS / 1000}s`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
