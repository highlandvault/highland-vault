/**
 * The integration harness's own database lifecycle.
 *
 * A test database is dropped with WITH (FORCE), which terminates whatever is
 * still connected. `pool.end()` resolves once its clients have been asked to
 * close, not once their backends are gone, so dropping immediately after
 * tearing a pool down used to terminate connections that were still finishing
 * and surface `57P01: terminating connection due to administrator command` as
 * an unhandled error — every test passing, the run still failing.
 */
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client';
import {
  connectionsClosed,
  countBackends,
  createTestDatabase,
  type TestDatabase,
} from '../src/testing';

describe('test database lifecycle', () => {
  let database: TestDatabase;
  let db: Database | undefined;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
    await database?.drop();
  });

  /** Fills the pool and leaves every connection genuinely used. */
  const loadPool = async (size: number) => {
    db = createDb({
      connectionString: database.url,
      applicationName: 'hv-test-lifecycle',
      max: size,
    });
    await Promise.all(
      Array.from({ length: size * 3 }, () => sql`SELECT pg_sleep(0.02)`.execute(db!)),
    );
  };

  it('a destroyed pool can still have live backends, which is the hazard', async () => {
    await loadPool(20);
    expect(await countBackends(database.name)).toBeGreaterThan(0);

    await db!.destroy();
    db = undefined;

    // Not asserted as "> 0": the point is that destroy() gives no guarantee
    // either way. What must hold is that waiting afterwards reaches zero.
    expect(await connectionsClosed(database.name)).toBe(true);
    expect(await countBackends(database.name)).toBe(0);
  });

  it('waits for a busy pool to close before reporting it closed', async () => {
    // Deliberately not the 60 of the ticket-engine gate pool: the suite already
    // peaks around 80 of PostgreSQL’s 100 connections, and a second 60-slot
    // pool running beside it would add avoidable pressure. The assertion does
    // not depend on the size — what matters is that the wait reaches zero.
    await loadPool(25);
    await db!.destroy();
    db = undefined;

    expect(await connectionsClosed(database.name)).toBe(true);
    expect(await countBackends(database.name)).toBe(0);
  });

  it('drops a database that a heavily used pool has just been torn down from', async () => {
    await loadPool(25);
    await db!.destroy();
    db = undefined;

    // The teardown order a test file uses. Before the fix this is where
    // WITH (FORCE) could terminate a connection that was still closing.
    await database.drop();
    expect(await countBackends(database.name)).toBe(0);

    // Dropped for real, so afterEach has nothing left to do.
    database = await createTestDatabase();
  });

  it('reports open connections as not closed while one is held', async () => {
    const holder = createDb({
      connectionString: database.url,
      applicationName: 'hv-test-holder',
      max: 1,
    });
    try {
      await sql`SELECT 1`.execute(holder);
      expect(await countBackends(database.name)).toBeGreaterThan(0);
    } finally {
      await holder.destroy();
    }
    expect(await connectionsClosed(database.name)).toBe(true);
  });
});
