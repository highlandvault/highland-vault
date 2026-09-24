/**
 * Transactional outbox against real PostgreSQL (migration 0011, task P5-1).
 *
 * The properties under test are the ones the mechanism exists for: an event
 * lives and dies with the transaction that produced it, two workers never
 * deliver the same claim at the same moment, and a failure is retried rather
 * than lost. No business producer exists yet — P5-2 registers the first
 * handler — so the events here are deliberately synthetic.
 */
import { randomUUID } from 'node:crypto';
import { createDb, withTransaction, type Database } from '@hv/db';
import {
  closeConnections,
  createBarrier,
  createTestDatabase,
  openConnections,
} from '@hv/db/testing';
import type { TestDatabase } from '@hv/db/testing';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAIM_LEASE_SECONDS,
  PUBLISH_JOB,
  createOutboxQueue,
  createOutboxWorker,
  createTopicDispatcher,
  enqueueOutboxEvent,
  publishOutbox,
  retryDelaySeconds,
  type OutboxEvent,
} from '../src/outbox/outbox';

function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('TEST_REDIS_URL is not set');
  return url;
}

const TOPIC = 'test.event';

describe('transactional outbox', () => {
  let database: TestDatabase;
  let db: Database;
  let sql: pg.Pool;

  beforeEach(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.url, applicationName: 'hv-test-outbox', max: 8 });
    sql = new pg.Pool({ connectionString: database.url, max: 4 });
  });

  afterEach(async () => {
    await db?.destroy();
    await sql?.end();
    await database?.drop();
  });

  const rows = async () =>
    (
      await sql.query<{
        id: string;
        topic: string;
        attempts: number;
        published_at: Date | null;
        last_error: string | null;
        available_at: Date;
      }>(
        `SELECT id, topic, attempts, published_at, last_error, available_at FROM outbox ORDER BY created_at`,
      )
    ).rows;

  /** Collects what a handler was given, so delivery can be asserted on. */
  const collector = () => {
    const seen: OutboxEvent[] = [];
    const handle = (event: OutboxEvent): Promise<void> => {
      seen.push(event);
      return Promise.resolve();
    };
    return { seen, handle };
  };

  describe('the event lives and dies with its transaction', () => {
    it('keeps the event when the business transaction commits', async () => {
      const id = await withTransaction(db, async (trx) => {
        // Stands in for a business change committing alongside its side effect.
        await trx.selectFrom('markets').select('id').limit(1).execute();
        return enqueueOutboxEvent(trx, TOPIC, { order: 'abc' });
      });

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id, topic: TOPIC, attempts: 0, published_at: null });
    });

    it('leaves no event when the business transaction rolls back', async () => {
      await expect(
        withTransaction(db, async (trx) => {
          await enqueueOutboxEvent(trx, TOPIC, { order: 'abc' });
          throw new Error('business rule refused the change');
        }),
      ).rejects.toThrow('business rule refused the change');

      expect(await rows()).toEqual([]);
    });
  });

  describe('claiming', () => {
    it('does not claim an event whose time has not come', async () => {
      await sql.query(
        `INSERT INTO outbox (topic, payload, available_at) VALUES ($1, '{}'::jsonb, now() + interval '1 hour')`,
        [TOPIC],
      );
      const { seen, handle } = collector();

      expect(await publishOutbox(db, handle)).toEqual({ published: 0, deferred: 0, failed: 0 });
      expect(seen).toEqual([]);
      expect((await rows())[0]).toMatchObject({ attempts: 0, published_at: null });
    });

    it('does not claim an event that is already published', async () => {
      await enqueueOutboxEvent(db, TOPIC, {});
      const first = collector();
      expect(await publishOutbox(db, first.handle)).toEqual({
        published: 1,
        deferred: 0,
        failed: 0,
      });

      const second = collector();
      expect(await publishOutbox(db, second.handle)).toEqual({
        published: 0,
        deferred: 0,
        failed: 0,
      });
      expect(second.seen).toEqual([]);
      expect((await rows())[0]!.published_at).not.toBeNull();
    });

    it('gives the same event to only one of two workers claiming at once', async () => {
      await enqueueOutboxEvent(db, TOPIC, { only: 'once' });
      // Two real connections claiming through the same barrier, so the claims
      // overlap rather than merely follow each other.
      const connections = await openConnections(database.url, 2);
      try {
        const barrier = createBarrier(connections.length);
        const claims = await Promise.all(
          connections.map(async (conn) => {
            await barrier();
            const { rows: claimed } = await conn.query<{ id: string }>(
              `SELECT id FROM hv_claim_outbox(10, $1)`,
              [CLAIM_LEASE_SECONDS],
            );
            return claimed.map((r) => r.id);
          }),
        );
        expect(claims.flat()).toHaveLength(1);
      } finally {
        await closeConnections(connections);
      }
      // Claimed once, so counted once.
      expect((await rows())[0]!.attempts).toBe(1);
    });

    it('does not deadlock when many workers claim a shared backlog at once', async () => {
      for (let i = 0; i < 40; i++) await enqueueOutboxEvent(db, TOPIC, { i });
      const connections = await openConnections(database.url, 6);
      try {
        const barrier = createBarrier(connections.length);
        const claims = await Promise.all(
          connections.map(async (conn) => {
            await barrier();
            const { rows: claimed } = await conn.query<{ id: string }>(
              `SELECT id FROM hv_claim_outbox(8, $1)`,
              [CLAIM_LEASE_SECONDS],
            );
            return claimed.map((r) => r.id);
          }),
        );
        const ids = claims.flat();
        // SKIP LOCKED means workers step past each other instead of waiting:
        // no deadlock, and no event handed to two of them.
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBeLessThanOrEqual(40);
      } finally {
        await closeConnections(connections);
      }
    });

    it('steps past rows another worker holds instead of waiting for them', async () => {
      for (let i = 0; i < 4; i++) await enqueueOutboxEvent(db, TOPIC, { i });
      const [holder] = await openConnections(database.url, 1);
      try {
        // Claim two rows and KEEP the transaction open, so their locks are held.
        await holder!.query('BEGIN');
        const { rows: held } = await holder!.query<{ id: string }>(
          `SELECT id FROM hv_claim_outbox(2, $1)`,
          [CLAIM_LEASE_SECONDS],
        );
        expect(held).toHaveLength(2);

        // A short timeout turns "waits for the lock" into a visible failure
        // rather than a hang: without SKIP LOCKED this statement would block.
        const other = await openConnections(database.url, 1);
        try {
          await other[0]!.query(`SET statement_timeout = '3s'`);
          const { rows: claimed } = await other[0]!.query<{ id: string }>(
            `SELECT id FROM hv_claim_outbox(2, $1)`,
            [CLAIM_LEASE_SECONDS],
          );
          expect(claimed).toHaveLength(2);
          // The other two rows, not the locked ones.
          expect(claimed.map((r) => r.id).some((id) => held.some((h) => h.id === id))).toBe(false);
        } finally {
          await closeConnections(other);
        }
        await holder!.query('ROLLBACK');
      } finally {
        await closeConnections([holder!]);
      }
    });

    it('leases a claimed event so a second run steps over it', async () => {
      await enqueueOutboxEvent(db, TOPIC, {});
      const { rows: claimed } = await sql.query<{ id: string }>(
        `SELECT id FROM hv_claim_outbox(10, $1)`,
        [CLAIM_LEASE_SECONDS],
      );
      expect(claimed).toHaveLength(1);

      const { seen, handle } = collector();
      expect(await publishOutbox(db, handle)).toEqual({ published: 0, deferred: 0, failed: 0 });
      expect(seen).toEqual([]);
      const [row] = await rows();
      expect(row!.attempts).toBe(1);
      expect(row!.available_at.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('delivery, failure and retry', () => {
    it('works through a backlog larger than one batch', async () => {
      for (let i = 0; i < 25; i++) await enqueueOutboxEvent(db, TOPIC, { i });
      const { seen, handle } = collector();

      expect(await publishOutbox(db, handle, 10)).toEqual({
        published: 25,
        deferred: 0,
        failed: 0,
      });
      expect(seen).toHaveLength(25);
      expect((await rows()).every((r) => r.published_at !== null)).toBe(true);
    });

    it('records a failure, keeps the event, and retries it once it is due again', async () => {
      await enqueueOutboxEvent(db, TOPIC, { will: 'fail once' });
      let calls = 0;
      const flaky = (): Promise<void> => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('consumer unavailable')) : Promise.resolve();
      };

      expect(await publishOutbox(db, flaky)).toEqual({ published: 0, deferred: 0, failed: 1 });
      const afterFailure = (await rows())[0]!;
      expect(afterFailure).toMatchObject({ attempts: 1, published_at: null });
      expect(afterFailure.last_error).toBe('consumer unavailable');
      // Backed off rather than retried immediately.
      expect(afterFailure.available_at.getTime()).toBeGreaterThan(Date.now());

      // Make it due, the way the backoff eventually would.
      await sql.query(`UPDATE outbox SET available_at = now()`);
      expect(await publishOutbox(db, flaky)).toEqual({ published: 1, deferred: 0, failed: 0 });
      const afterRetry = (await rows())[0]!;
      expect(afterRetry.attempts).toBe(2);
      expect(afterRetry.published_at).not.toBeNull();
      // A published row reads as clean.
      expect(afterRetry.last_error).toBeNull();
    });

    it('keeps one failing event from holding up the rest of the run', async () => {
      const poison = await enqueueOutboxEvent(db, TOPIC, { poison: true });
      for (let i = 0; i < 4; i++) await enqueueOutboxEvent(db, TOPIC, { i });

      const result = await publishOutbox(db, (event) =>
        event.id === poison ? Promise.reject(new Error('nope')) : Promise.resolve(),
      );
      expect(result).toEqual({ published: 4, deferred: 0, failed: 1 });
      const byId = new Map((await rows()).map((r) => [r.id, r]));
      expect(byId.get(poison)!.published_at).toBeNull();
      expect([...byId.values()].filter((r) => r.published_at !== null)).toHaveLength(4);
    });

    it('fails an event with no handler instead of dropping it', async () => {
      await enqueueOutboxEvent(db, 'unhandled.topic', {});
      const dispatch = createTopicDispatcher({ [TOPIC]: () => Promise.resolve() });

      expect(await publishOutbox(db, dispatch)).toEqual({ published: 0, deferred: 0, failed: 1 });
      const [row] = await rows();
      expect(row!.published_at).toBeNull();
      expect(row!.last_error).toContain('no handler registered');
    });

    it('spaces retries out and stops the spacing growing', () => {
      expect(retryDelaySeconds(1)).toBe(10);
      expect(retryDelaySeconds(2)).toBe(20);
      expect(retryDelaySeconds(3)).toBe(40);
      expect(retryDelaySeconds(50)).toBe(3600);
    });
  });

  describe('the database protects the record', () => {
    it('refuses to publish an event twice', async () => {
      await enqueueOutboxEvent(db, TOPIC, {});
      await sql.query(`UPDATE outbox SET published_at = now()`);
      await expect(sql.query(`UPDATE outbox SET published_at = now()`)).rejects.toThrow(
        /already published/,
      );
    });

    it('refuses to change what an event is', async () => {
      await enqueueOutboxEvent(db, TOPIC, { a: 1 });
      await expect(sql.query(`UPDATE outbox SET payload = '{"a":2}'::jsonb`)).rejects.toThrow(
        /immutable/,
      );
    });

    it('will not let the application delete an event', async () => {
      const { rows: privileges } = await sql.query<{ delete: boolean; truncate: boolean }>(
        `SELECT has_table_privilege('hv_app', 'outbox', 'DELETE') AS delete,
                has_table_privilege('hv_app', 'outbox', 'TRUNCATE') AS truncate`,
      );
      expect(privileges[0]).toEqual({ delete: false, truncate: false });
    });
  });

  it('runs as a BullMQ job on the outbox queue', async () => {
    const redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
    const queueName = `test-outbox-${randomUUID()}`;
    const queue = createOutboxQueue(redis, queueName);
    const { seen, handle } = collector();
    const worker = createOutboxWorker({ connection: redis, db, handle, queueName });
    try {
      await enqueueOutboxEvent(db, TOPIC, { via: 'queue' });
      const done = new Promise<{ published: number; failed: number }>((resolve, reject) => {
        worker.on('completed', (_job, result) => resolve(result));
        worker.on('failed', (_job, error) => reject(error));
      });
      await queue.add(PUBLISH_JOB, {});
      expect(await done).toEqual({ published: 1, deferred: 0, failed: 0 });
      expect(seen).toHaveLength(1);
    } finally {
      await worker.close();
      await queue.close();
      redis.disconnect();
    }
  });
});
