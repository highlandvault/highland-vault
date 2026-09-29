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
import { WORKER_ENV, type WorkerEnv } from '../config/env';
import { DATABASE, REDIS } from '../tokens';
import {
  EXPIRE_ATTEMPTS_JOB,
  EXPIRE_ATTEMPTS_SCHEDULER_ID,
  EXPIRE_ORDERS_JOB,
  EXPIRE_ORDERS_SCHEDULER_ID,
  PAYMENTS_INTERVAL_MS,
  RECONCILE_JOB,
  RECONCILE_SCHEDULER_ID,
  RETRY_REFUNDS_JOB,
  RETRY_REFUNDS_SCHEDULER_ID,
  type PaymentsJobResult,
  createPaymentsQueue,
  createPaymentsWorker,
} from './payment-expiry';
import { reconcileOnce, retryRefundsOnce } from './reconciler';

/**
 * The `payments` queue (Phase 6, task P6-5).
 *
 * Three repeatable jobs, all every 60 seconds, all conditional-update-only and
 * safe to run concurrently or repeatedly — the same shape as the reservation
 * and draw sweepers beside them.
 *
 *   * `expire-orders`    — a lapsed payment deadline ends the order (D1).
 *   * `expire-attempts`  — a lapsed attempt stops holding the order's one live
 *                          slot (D3a). The order is not touched.
 *   * `reconcile`        — D12a's trusted status check, through the API.
 *
 * The reconciler is scheduled **only when the internal API is configured**. A
 * deployment without it gets the two sweeps and a line in the log saying why
 * the third is absent, rather than a job that fails every minute.
 */
@Injectable()
export class PaymentsJobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsJobsService.name);
  private queue: Queue | undefined;
  private worker: Worker<unknown, PaymentsJobResult> | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const reconciler = this.reconciler();
    this.queue = createPaymentsQueue(this.redis);
    this.worker = createPaymentsWorker({
      connection: this.redis,
      db: this.db,
      reconcile: reconciler,
      retryRefunds: this.refundRetry(),
    });

    this.worker.on('completed', (_job, result) => {
      if (result.job === 'retry-refunds') {
        if (result.attempted > 0) this.logger.log(`refunds retried: ${result.attempted}`);
        return;
      }
      if (result.job === 'reconcile') {
        if (result.checked + result.failed > 0) {
          this.logger.log(`payments reconciled: ${result.checked}, failed: ${result.failed}`);
        }
        return;
      }
      if (result.expired > 0) this.logger.log(`${result.job}: ${result.expired}`);
    });
    this.worker.on('failed', (job, error) =>
      this.logger.error(`payments job ${job?.name} ${job?.id} failed: ${error.message}`),
    );
    this.worker.on('error', (error) => this.logger.error(`worker error: ${error.message}`));

    // Idempotent schedulers: restarts never create a second schedule.
    await this.queue.upsertJobScheduler(
      EXPIRE_ORDERS_SCHEDULER_ID,
      { every: PAYMENTS_INTERVAL_MS },
      { name: EXPIRE_ORDERS_JOB },
    );
    await this.queue.upsertJobScheduler(
      EXPIRE_ATTEMPTS_SCHEDULER_ID,
      { every: PAYMENTS_INTERVAL_MS },
      { name: EXPIRE_ATTEMPTS_JOB },
    );
    if (reconciler) {
      await this.queue.upsertJobScheduler(
        RECONCILE_SCHEDULER_ID,
        { every: PAYMENTS_INTERVAL_MS },
        { name: RECONCILE_JOB },
      );
      await this.queue.upsertJobScheduler(
        RETRY_REFUNDS_SCHEDULER_ID,
        { every: PAYMENTS_INTERVAL_MS },
        { name: RETRY_REFUNDS_JOB },
      );
    }
    this.logger.log(
      `payments jobs every ${PAYMENTS_INTERVAL_MS / 1000}s` +
        (reconciler ? '' : ' (no reconciler: INTERNAL_API_URL is not configured)'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  /** The reconciler, or undefined when the internal API is not configured. */
  private reconciler(): (() => Promise<{ checked: number; failed: number }>) | undefined {
    const config = this.internal();
    if (!config) return undefined;
    return () => reconcileOnce(this.db, config, { warn: (message) => this.logger.warn(message) });
  }

  /** Retries refunds through the API, or undefined when it is not configured. */
  private refundRetry(): (() => Promise<{ attempted: number }>) | undefined {
    const config = this.internal();
    if (!config) return undefined;
    return () => retryRefundsOnce(config, { warn: (message) => this.logger.warn(message) });
  }

  /**
   * Where the API's internal listener is, or undefined.
   *
   * The token travels with the URL because neither is useful alone, and both
   * are the only payment-related configuration this process ever holds. No
   * provider credential reaches the worker (K-a).
   */
  private internal(): { baseUrl: string; token: string } | undefined {
    const baseUrl = this.env.INTERNAL_API_URL;
    const token = this.env.INTERNAL_API_TOKEN;
    if (!baseUrl || !token) return undefined;
    return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
  }
}
