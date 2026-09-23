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
  EXPIRE_INTERVAL_MS,
  EXPIRE_JOB,
  EXPIRE_SCHEDULER_ID,
  type ExpiryResult,
  createReservationsQueue,
  createReservationsWorker,
} from './reservation-expiry';

/** Runs reservation expiry every 30 seconds. */
@Injectable()
export class ReservationExpiryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReservationExpiryService.name);
  private queue?: Queue;
  private worker?: Worker<unknown, ExpiryResult>;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = createReservationsQueue(this.redis);
    this.worker = createReservationsWorker({ connection: this.redis, db: this.db });
    this.worker.on('completed', (_job, result) => {
      if (result.expired > 0) this.logger.log(`reservations expired: ${result.expired}`);
    });
    this.worker.on('failed', (job, error) =>
      this.logger.error(`reservation expiry ${job?.id} failed: ${error.message}`),
    );
    this.worker.on('error', (error) => this.logger.error(`worker error: ${error.message}`));

    // Idempotent scheduler: restarts never create a second schedule.
    await this.queue.upsertJobScheduler(
      EXPIRE_SCHEDULER_ID,
      { every: EXPIRE_INTERVAL_MS },
      { name: EXPIRE_JOB },
    );
    this.logger.log(`reservation expiry every ${EXPIRE_INTERVAL_MS / 1000}s`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
