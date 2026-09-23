/**
 * Reservation expiry worker against real PostgreSQL and Redis.
 */
import { randomUUID } from 'node:crypto';
import { createDb, type Database } from '@hv/db';
import {
  createTestDatabase,
  enableMarketsForTesting,
  insertFixtureDraw,
  insertFixtureUser,
  type TestDatabase,
} from '@hv/db/testing';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXPIRE_JOB,
  createReservationsQueue,
  createReservationsWorker,
  expireReservations,
} from '../src/tickets/reservation-expiry';

function testRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('TEST_REDIS_URL is not set');
  return url;
}

describe('reservation expiry worker', () => {
  let database: TestDatabase;
  let db: Database;
  let sql: pg.Pool;
  let drawId: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.url, applicationName: 'hv-test-expiry', max: 6 });
    sql = new pg.Pool({ connectionString: database.url, max: 3 });
    await enableMarketsForTesting(sql, ['uk']);
    drawId = await insertFixtureDraw(sql, {
      market: 'uk',
      slug: 'expiry',
      state: 'live',
      totalTickets: 100,
      maxPerPerson: 10,
    });
  });

  afterEach(async () => {
    await db?.destroy();
    await sql?.end();
    await database?.drop();
  });

  /** A held reservation of `n` tickets lasting `seconds`, set up the way the allocation leaves it. */
  async function held(email: string, numbers: number[], seconds: number) {
    const userId = await insertFixtureUser(sql, email);
    const { rows } = await sql.query<{ id: string }>(
      `INSERT INTO reservations (draw_id, market_id, currency, entrant_type, entrant_ref, user_id,
                                 quantity, unit_price_minor, total_minor, expires_at)
       SELECT d.id, d.market_id, d.currency, 'user', $2::text, $5::uuid, $3::int, d.ticket_price_minor,
              d.ticket_price_minor * $3::int, now() + make_interval(secs => $4)
         FROM draws d WHERE d.id = $1
       RETURNING id`,
      [drawId, userId, numbers.length, seconds, userId],
    );
    const id = rows[0]!.id;
    await sql.query(
      `UPDATE tickets SET status = 'reserved', reservation_id = $1 WHERE draw_id = $2 AND ticket_number = ANY($3::int[])`,
      [id, drawId, numbers],
    );
    await sql.query(
      `INSERT INTO draw_entrant_counts (draw_id, entrant_type, entrant_ref, count) VALUES ($1, 'user', $2, $3)`,
      [drawId, userId, numbers.length],
    );
    return id;
  }

  const state = async () => {
    const tickets = await sql.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM tickets WHERE draw_id = $1 GROUP BY status`,
      [drawId],
    );
    const counts = await sql.query<{ total: number }>(
      `SELECT COALESCE(sum(count), 0)::int AS total FROM draw_entrant_counts WHERE draw_id = $1`,
      [drawId],
    );
    return {
      tickets: Object.fromEntries(tickets.rows.map((r) => [r.status, r.n])),
      held: counts.rows[0]!.total,
    };
  };

  it('expires only past-due reservations, returning their tickets and cap allowance', async () => {
    await held('a@example.com', [1, 2, 3], 1);
    await held('b@example.com', [4, 5], 600);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(await expireReservations(db)).toEqual({ expired: 1 });
    expect(await state()).toEqual({ tickets: { available: 98, reserved: 2 }, held: 2 });
    // Idempotent: nothing left to do.
    expect(await expireReservations(db)).toEqual({ expired: 0 });
  });

  it('works through more due reservations than one batch', async () => {
    for (let i = 0; i < 12; i++) await held(`batch-${i}@example.com`, [i * 2 + 1, i * 2 + 2], 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await expireReservations(db, 5)).toEqual({ expired: 12 });
    expect(await state()).toEqual({ tickets: { available: 100 }, held: 0 });
  });

  it('is safe when several workers run at once (duplicate scheduler runs)', async () => {
    for (let i = 0; i < 15; i++)
      await held(`dup-${i}@example.com`, [i * 3 + 1, i * 3 + 2, i * 3 + 3], 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const results = await Promise.all(Array.from({ length: 5 }, () => expireReservations(db, 4)));
    expect(results.reduce((sum, r) => sum + r.expired, 0)).toBe(15);
    expect(await state()).toEqual({ tickets: { available: 100 }, held: 0 });
  });

  it('runs as a BullMQ job on the reservations queue', async () => {
    const redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
    const queueName = `test-reservations-${randomUUID()}`;
    const queue = createReservationsQueue(redis, queueName);
    const worker = createReservationsWorker({ connection: redis, db, queueName });
    try {
      await held('queued@example.com', [10], 1);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const done = new Promise<{ expired: number }>((resolve, reject) => {
        worker.on('completed', (_job, result) => resolve(result));
        worker.on('failed', (_job, error) => reject(error));
      });
      await queue.add(EXPIRE_JOB, {});
      expect(await done).toEqual({ expired: 1 });
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await redis.quit();
    }
  });
});
