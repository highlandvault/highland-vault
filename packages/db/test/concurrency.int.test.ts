/**
 * INFRASTRUCTURE VERIFICATION — real PostgreSQL concurrency (Phase 1, Part H2).
 *
 * Purpose: prove that the integration-test harness drives genuinely concurrent
 * transactions against the real PostgreSQL 18 container, so that later
 * critical-gate tests (tickets, caps, wallet, settlement) can be trusted.
 * No mocks, no SQLite, no fake connections: 10 separate pg.Client sockets,
 * each its own PostgreSQL backend process.
 *
 * What it proves:
 *  1. 10 simultaneous connections are 10 distinct backends (pg_backend_pid).
 *  2. FOR UPDATE SKIP LOCKED: 10 transactions holding locks AT THE SAME TIME
 *     each receive a disjoint set of rows (the pattern the ticket engine will use).
 *  3. The harness can detect a race: an unlocked read-modify-write loses updates
 *     (deterministically, via a barrier) — so a test CAN fail when locking is wrong.
 *  4. FOR UPDATE serialises the same read-modify-write: no lost updates.
 *
 * This is not the ticket-allocation gate test (Phase 4); it only uses scratch tables.
 */
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeConnections,
  createBarrier,
  createTestDatabase,
  openConnections,
  type TestDatabase,
} from '../src/testing';

const CONNECTIONS = 10;
const ROWS = 100;
const ROWS_PER_CONNECTION = ROWS / CONNECTIONS;

describe('real PostgreSQL concurrency (10 simultaneous connections)', () => {
  let database: TestDatabase;
  let clients: pg.Client[];
  let observer: pg.Client;

  beforeAll(async () => {
    database = await createTestDatabase();
    observer = (await openConnections(database.url, 1))[0]!;
    await observer.query(`
      CREATE TABLE scratch_slots (id integer PRIMARY KEY, taken_by integer);
      CREATE TABLE scratch_counter (id integer PRIMARY KEY, value integer NOT NULL);
    `);
  });

  afterAll(async () => {
    await observer?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await observer.query(`
      TRUNCATE scratch_slots, scratch_counter;
      INSERT INTO scratch_slots (id) SELECT generate_series(1, ${ROWS});
      INSERT INTO scratch_counter (id, value) VALUES (1, 0);
    `);
    clients = await openConnections(database.url, CONNECTIONS);
  });

  afterEach(async () => {
    await closeConnections(clients);
  });

  it('opens 10 distinct PostgreSQL backend connections simultaneously', async () => {
    const pids = await Promise.all(
      clients.map(async (client) => {
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return rows[0]!.pid;
      }),
    );
    expect(new Set(pids).size).toBe(CONNECTIONS);

    const { rows } = await observer.query<{ server_version_num: string }>(
      'SHOW server_version_num',
    );
    expect(Number(rows[0]!.server_version_num)).toBeGreaterThanOrEqual(180000);
  });

  it('FOR UPDATE SKIP LOCKED gives disjoint rows to 10 transactions holding locks at the same time', async () => {
    // 10 workers + 1 observer rendezvous twice: once when every worker holds its
    // locks, once more when the observer has finished inspecting.
    const allHoldLocks = createBarrier(CONNECTIONS + 1);
    const observed = createBarrier(CONNECTIONS + 1);

    const workers = clients.map(async (client, worker) => {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: number }>(
        `SELECT id FROM scratch_slots WHERE taken_by IS NULL
          ORDER BY id LIMIT ${ROWS_PER_CONNECTION} FOR UPDATE SKIP LOCKED`,
      );
      await allHoldLocks(); // keep the transaction open: locks are held concurrently
      await observed();
      await client.query('UPDATE scratch_slots SET taken_by = $1 WHERE id = ANY($2::int[])', [
        worker,
        rows.map((row) => row.id),
      ]);
      await client.query('COMMIT');
      return rows.map((row) => row.id);
    });

    // While all 10 transactions hold their locks, an 11th session finds no
    // lockable row (every row is locked by some worker) yet can still read all
    // rows without blocking (MVCC).
    const observerTask = (async () => {
      await allHoldLocks();
      const lockable = await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (SELECT id FROM scratch_slots FOR UPDATE SKIP LOCKED) s`,
      );
      const readable = await observer.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM scratch_slots',
      );
      await observed();
      return { lockable: lockable.rows[0]!.n, readable: readable.rows[0]!.n };
    })();

    const [taken, whileLocked] = await Promise.all([Promise.all(workers), observerTask]);

    expect(whileLocked).toEqual({ lockable: 0, readable: ROWS });
    for (const ids of taken) {
      expect(ids).toHaveLength(ROWS_PER_CONNECTION);
    }
    const all = taken.flat();
    expect(all).toHaveLength(ROWS);
    expect(new Set(all).size).toBe(ROWS); // no row handed to two transactions

    const { rows } = await observer.query<{ taken: number; owners: number }>(
      `SELECT count(*) FILTER (WHERE taken_by IS NOT NULL)::int AS taken,
              count(DISTINCT taken_by)::int AS owners FROM scratch_slots`,
    );
    expect(rows[0]).toEqual({ taken: ROWS, owners: CONNECTIONS });
  });

  it('detects a lost update when read-modify-write is NOT locked (proves the harness can catch races)', async () => {
    const everyoneHasRead = createBarrier(CONNECTIONS);

    await Promise.all(
      clients.map(async (client) => {
        await client.query('BEGIN');
        const { rows } = await client.query<{ value: number }>(
          'SELECT value FROM scratch_counter WHERE id = 1',
        );
        // All 10 transactions read value = 0 before anyone writes.
        await everyoneHasRead();
        await client.query('UPDATE scratch_counter SET value = $1 WHERE id = 1', [
          rows[0]!.value + 1,
        ]);
        await client.query('COMMIT');
      }),
    );

    const { rows } = await observer.query<{ value: number }>(
      'SELECT value FROM scratch_counter WHERE id = 1',
    );
    // 10 increments, but every writer computed 0 + 1: nine updates were lost.
    expect(rows[0]!.value).toBe(1);
  });

  it('FOR UPDATE serialises the same read-modify-write: no lost updates', async () => {
    const start = createBarrier(CONNECTIONS);

    await Promise.all(
      clients.map(async (client) => {
        await start(); // all 10 contend for the same row at once
        await client.query('BEGIN');
        const { rows } = await client.query<{ value: number }>(
          'SELECT value FROM scratch_counter WHERE id = 1 FOR UPDATE',
        );
        await client.query('SELECT pg_sleep(0.01)'); // widen the critical section
        await client.query('UPDATE scratch_counter SET value = $1 WHERE id = 1', [
          rows[0]!.value + 1,
        ]);
        await client.query('COMMIT');
      }),
    );

    const { rows } = await observer.query<{ value: number }>(
      'SELECT value FROM scratch_counter WHERE id = 1',
    );
    expect(rows[0]!.value).toBe(CONNECTIONS);
  });
});
