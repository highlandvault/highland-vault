/**
 * The `system` queue exists only to prove the BullMQ pipeline end to end
 * (Phase 1). It carries no business work.
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

export const SYSTEM_QUEUE = 'system';
export const HEARTBEAT_JOB = 'heartbeat';
export const HEARTBEAT_SCHEDULER_ID = 'system-heartbeat';
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_KEY = 'hv:worker:last-heartbeat';

export interface HeartbeatResult {
  processedAt: string;
}

/** Records the time of the latest processed heartbeat so operators can see the worker is alive. */
export async function processHeartbeat(
  redis: Redis,
  job: Job,
  key = HEARTBEAT_KEY,
): Promise<HeartbeatResult> {
  const processedAt = new Date().toISOString();
  await redis.set(key, JSON.stringify({ processedAt, jobId: job.id }), 'EX', 5 * 60);
  return { processedAt };
}

export function createSystemQueue(connection: ConnectionOptions, name = SYSTEM_QUEUE): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 },
  });
}

export function createSystemWorker(options: {
  connection: ConnectionOptions;
  redis: Redis;
  queueName?: string;
  heartbeatKey?: string;
}): Worker<unknown, HeartbeatResult> {
  return new Worker<unknown, HeartbeatResult>(
    options.queueName ?? SYSTEM_QUEUE,
    async (job) => {
      if (job.name !== HEARTBEAT_JOB) {
        throw new Error(`Unknown system job: ${job.name}`);
      }
      return processHeartbeat(options.redis, job, options.heartbeatKey);
    },
    { connection: options.connection, concurrency: 1 },
  );
}
