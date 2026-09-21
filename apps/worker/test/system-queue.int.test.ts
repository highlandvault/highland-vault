/**
 * BullMQ pipeline against the real Redis container (logical DB from TEST_REDIS_URL).
 * Each test uses its own queue name so a running dev worker cannot interfere.
 */
import { randomUUID } from 'node:crypto';
import type { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HEARTBEAT_JOB,
  createSystemQueue,
  createSystemWorker,
  type HeartbeatResult,
} from '../src/system/system-queue';

function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('TEST_REDIS_URL is not set');
  return url;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('system queue (BullMQ + real Redis)', () => {
  let redis: Redis;
  let queue: Queue;
  let worker: Worker<unknown, HeartbeatResult> | undefined;
  let queueName: string;
  let heartbeatKey: string;

  beforeEach(() => {
    redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
    queueName = `test-system-${randomUUID()}`;
    heartbeatKey = `test:heartbeat:${queueName}`;
    queue = createSystemQueue(redis, queueName);
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.del(heartbeatKey);
    await redis.quit();
  });

  it('processes a heartbeat job and records the heartbeat in Redis', async () => {
    worker = createSystemWorker({ connection: redis, redis, queueName, heartbeatKey });
    const completed: string[] = [];
    worker.on('completed', (job) => completed.push(job.id ?? ''));

    await queue.add(HEARTBEAT_JOB, {});
    await waitFor(() => completed.length === 1);

    const stored = JSON.parse((await redis.get(heartbeatKey)) ?? '{}') as { processedAt?: string };
    expect(stored.processedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('enqueuing the same job id twice processes it exactly once (job-id idempotency pattern)', async () => {
    const first = await queue.add(HEARTBEAT_JOB, {}, { jobId: 'fixed-id' });
    const second = await queue.add(HEARTBEAT_JOB, {}, { jobId: 'fixed-id' });
    expect(second.id).toBe(first.id);

    worker = createSystemWorker({ connection: redis, redis, queueName, heartbeatKey });
    let processed = 0;
    worker.on('completed', () => {
      processed += 1;
    });

    await waitFor(() => processed >= 1);
    // A third add after completion is still deduplicated while the completed job is retained.
    await queue.add(HEARTBEAT_JOB, {}, { jobId: 'fixed-id' });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(processed).toBe(1);
    expect(await queue.getJobCounts('completed', 'waiting', 'active')).toMatchObject({
      completed: 1,
      waiting: 0,
      active: 0,
    });
  });

  it('fails unknown job names instead of silently ignoring them', async () => {
    worker = createSystemWorker({ connection: redis, redis, queueName, heartbeatKey });
    const failures: string[] = [];
    worker.on('failed', (_job, error) => failures.push(error.message));

    await queue.add('not-a-real-job', {});
    await waitFor(() => failures.length === 1);
    expect(failures[0]).toMatch(/Unknown system job: not-a-real-job/);
  });
});
