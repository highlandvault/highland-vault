import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql, type Database } from '@hv/db';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { DATABASE, REDIS } from '../tokens';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_JOB,
  HEARTBEAT_SCHEDULER_ID,
  createSystemQueue,
  createSystemWorker,
} from './system-queue';

@Injectable()
export class SystemService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SystemService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Startup verification: refuse to run without PostgreSQL and Redis.
    await sql`SELECT 1`.execute(this.db);
    await this.redis.ping();
    this.logger.log('startup check passed: PostgreSQL and Redis reachable');

    this.queue = createSystemQueue(this.redis);
    this.worker = createSystemWorker({ connection: this.redis, redis: this.redis });
    this.worker.on('completed', (job) => this.logger.log(`processed ${job.name} (job ${job.id})`));
    this.worker.on('failed', (job, error) =>
      this.logger.error(`job ${job?.name} (job ${job?.id}) failed: ${error.message}`),
    );
    this.worker.on('error', (error) => this.logger.error(`worker error: ${error.message}`));

    // Idempotent: re-upserting the same scheduler id never creates a duplicate schedule.
    await this.queue.upsertJobScheduler(
      HEARTBEAT_SCHEDULER_ID,
      { every: HEARTBEAT_INTERVAL_MS },
      { name: HEARTBEAT_JOB },
    );
    this.logger.log(
      `worker ready: queue "system", heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s`,
    );
  }

  /** Runs before connections are closed (onModuleDestroy precedes onApplicationShutdown). */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('shutting down: waiting for active jobs to finish');
    await this.worker?.close();
    await this.queue?.close();
  }
}
