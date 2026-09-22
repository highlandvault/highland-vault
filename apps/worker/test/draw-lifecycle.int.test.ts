/**
 * Draw lifecycle sweeper against real PostgreSQL (and real Redis for the queue).
 */
import { randomUUID } from 'node:crypto';
import { createDb, type Database } from '@hv/db';
import { createTestDatabase, insertFixtureDraw, type TestDatabase } from '@hv/db/testing';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SWEEP_JOB,
  createDrawLifecycleQueue,
  createDrawLifecycleWorker,
  sweepDrawLifecycle,
} from '../src/draws/draw-lifecycle';

const HOUR = 60 * 60 * 1000;

function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('TEST_REDIS_URL is not set');
  return url;
}

describe('draw lifecycle sweeper', () => {
  let database: TestDatabase;
  let db: Database;
  let sqlClient: pg.Pool;

  beforeEach(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.url, applicationName: 'hv-test-worker', max: 6 });
    sqlClient = new pg.Pool({ connectionString: database.url, max: 2 });
  });

  afterEach(async () => {
    await db?.destroy();
    await sqlClient?.end();
    await database?.drop();
  });

  const row = async (id: string) =>
    (
      await sqlClient.query<{ status: string; closed_at: Date | null }>(
        `SELECT status, closed_at FROM draws WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  const audits = async (id: string) =>
    (
      await sqlClient.query<{ action: string; actor_type: string }>(
        `SELECT action, actor_type FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at, action DESC`,
        [id],
      )
    ).rows;

  it('opens scheduled draws whose opening time has come, and audits it as a system action', async () => {
    const due = await insertFixtureDraw(sqlClient, {
      market: 'uk',
      slug: 'due',
      state: 'scheduled',
    });
    const future = await insertFixtureDraw(sqlClient, {
      market: 'uk',
      slug: 'future',
      state: 'scheduled',
      opensAt: new Date(Date.now() + HOUR),
      closesAt: new Date(Date.now() + 2 * HOUR),
    });

    const result = await sweepDrawLifecycle(db);

    expect(result.opened).toEqual([due]);
    expect((await row(due)).status).toBe('live');
    expect((await row(future)).status).toBe('scheduled');
    expect(await audits(due)).toEqual([{ action: 'draw.opened', actor_type: 'system' }]);
  });

  it('closes live draws at their closing time — even ones whose whole window passed unseen', async () => {
    const closesSoon = new Date(Date.now() + 1500);
    const live = await insertFixtureDraw(sqlClient, {
      market: 'uk',
      slug: 'closing',
      state: 'live',
      closesAt: closesSoon,
    });
    const neverOpened = await insertFixtureDraw(sqlClient, {
      market: 'ie',
      slug: 'missed',
      state: 'scheduled',
      closesAt: closesSoon,
    });
    const stillOpen = await insertFixtureDraw(sqlClient, {
      market: 'uk',
      slug: 'open',
      state: 'live',
    });
    await new Promise((resolve) => setTimeout(resolve, 1700));

    const result = await sweepDrawLifecycle(db);

    expect(result.closed.sort()).toEqual([live, neverOpened].sort());
    const closedRow = await row(live);
    expect(closedRow.status).toBe('closed');
    expect(closedRow.closed_at).toBeInstanceOf(Date);
    expect((await row(neverOpened)).status).toBe('closed');
    expect((await row(stillOpen)).status).toBe('live');
    // The missed draw still went through every state, each audited.
    expect((await audits(neverOpened)).map((a) => a.action)).toEqual([
      'draw.opened',
      'draw.closed',
    ]);
  });

  it('applies each transition exactly once when sweeps run concurrently', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        insertFixtureDraw(sqlClient, { market: 'uk', slug: `concurrent-${i}`, state: 'scheduled' }),
      ),
    );
    const results = await Promise.all(Array.from({ length: 6 }, () => sweepDrawLifecycle(db)));

    expect(results.flatMap((r) => r.opened).sort()).toEqual([...ids].sort());
    const { rows } = await sqlClient.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'draw.opened'`,
    );
    expect(rows[0]!.n).toBe(5);
  });

  it('leaves drafts and cancelled draws alone', async () => {
    const draft = await insertFixtureDraw(sqlClient, {
      market: 'uk',
      slug: 'draft',
      state: 'draft',
    });
    const cancelled = await insertFixtureDraw(sqlClient, {
      market: 'uk',
      slug: 'gone',
      state: 'cancelled',
    });
    await sweepDrawLifecycle(db);
    expect((await row(draft)).status).toBe('draft');
    expect((await row(cancelled)).status).toBe('cancelled');
  });

  it('runs as a BullMQ job on the draw-lifecycle queue', async () => {
    const redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
    const queueName = `test-draw-lifecycle-${randomUUID()}`;
    const queue = createDrawLifecycleQueue(redis, queueName);
    const worker = createDrawLifecycleWorker({ connection: redis, db, queueName });
    try {
      const id = await insertFixtureDraw(sqlClient, {
        market: 'uk',
        slug: 'queued',
        state: 'scheduled',
      });
      const done = new Promise<{ opened: string[] }>((resolve, reject) => {
        worker.on('completed', (_job, result) => resolve(result));
        worker.on('failed', (_job, error) => reject(error));
      });
      await queue.add(SWEEP_JOB, {});
      expect((await done).opened).toEqual([id]);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await redis.quit();
    }
  });
});
