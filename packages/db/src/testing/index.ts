/**
 * Real-PostgreSQL integration test harness (ADR-0001: no mocked databases).
 *
 * The global setup migrates a template database once per run; every test file
 * then clones it (`CREATE DATABASE … TEMPLATE`), which takes milliseconds and
 * gives each file full isolation.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { pgTypes } from '../int8';

export const TEST_TEMPLATE_DB = 'hv_test_template';
export const TEST_DB_PREFIX = 'hv_test_';
export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export function testAdminUrl(): string {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_ADMIN_URL is not set. Copy .env.example to .env and run `pnpm infra:up`.',
    );
  }
  return url;
}

export function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: testAdminUrl(),
    application_name: 'hv-test-admin',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/**
 * Creates a throwaway database. `migrated: true` (default) clones the migrated
 * template; `migrated: false` gives an empty database (for migration-tool tests).
 */
export async function createTestDatabase(
  options: { migrated?: boolean } = {},
): Promise<TestDatabase> {
  const name = `${TEST_DB_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const template = options.migrated === false ? 'template1' : TEST_TEMPLATE_DB;
  await withAdminClient((client) =>
    client.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`),
  );
  return {
    name,
    url: databaseUrl(testAdminUrl(), name),
    drop: () => dropDatabase(name),
  };
}

/**
 * How long to let a test's connections finish closing before dropping its
 * database. Generously above what closing actually takes (milliseconds), so
 * reaching it means something is really still connected rather than slow.
 */
const CONNECTIONS_CLOSED_TIMEOUT_MS = 10_000;

/**
 * Waits until nothing is connected to `name` any more.
 *
 * `pool.end()` resolves once its clients have been ASKED to close, not once
 * their backends are gone: after destroying a 60-connection pool, PostgreSQL
 * still reported several live backends, which disappeared a few hundred
 * milliseconds later. Dropping in that window makes WITH (FORCE) terminate a
 * connection that is still finishing, and the driver surfaces that as
 * `57P01: terminating connection due to administrator command` — an unhandled
 * error that fails the run even though every test passed.
 *
 * So this waits on the server's own view of the database rather than on a
 * duration: it returns the moment the count reaches zero, whatever the machine
 * is doing. If the deadline passes, something is genuinely still holding a
 * connection and the drop goes ahead as before — WITH (FORCE) stays the safety
 * net it always was, it just no longer has anything to terminate.
 */
async function waitForConnectionsToClose(client: pg.Client, name: string): Promise<boolean> {
  const deadline = Date.now() + CONNECTIONS_CLOSED_TIMEOUT_MS;
  for (;;) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    if (rows[0]!.n === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * DROP … WITH (FORCE) cannot terminate an autovacuum worker (it runs as the
 * bootstrap superuser, and the test role may not signal it), so a drop that
 * races autovacuum fails with 42501. The worker finishes quickly: retry.
 */
async function dropDatabase(name: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await withAdminClient(async (client) => {
        await waitForConnectionsToClose(client, name);
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      });
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== '42501' || attempt >= 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Waits until nothing is connected to `name`, for a test that needs to assert
 * on that directly. Ordinary teardown gets this from `drop()`.
 */
export async function connectionsClosed(name: string): Promise<boolean> {
  return withAdminClient((client) => waitForConnectionsToClose(client, name));
}

/** Backends currently connected to `name`, excluding the caller. */
export async function countBackends(name: string): Promise<number> {
  return withAdminClient(async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    return rows[0]!.n;
  });
}

/** Opens `count` independent physical connections (not a pool) and checks they are distinct backends. */
export async function openConnections(url: string, count: number): Promise<pg.Client[]> {
  const clients = Array.from(
    { length: count },
    (_, i) =>
      new pg.Client({
        connectionString: url,
        application_name: `hv-test-conn-${i}`,
        types: pgTypes,
      }),
  );
  await Promise.all(clients.map((client) => client.connect()));
  return clients;
}

export async function closeConnections(clients: pg.Client[]): Promise<void> {
  await Promise.all(clients.map((client) => client.end()));
}

/**
 * Rendezvous point for `parties` concurrent tasks: each `await barrier()` resolves
 * only once all parties have arrived. Rejects after `timeoutMs` so a broken
 * test fails instead of hanging.
 */
export function createBarrier(parties: number, timeoutMs = 10_000): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  let fail!: (error: Error) => void;
  const allArrived = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const timer = setTimeout(
    () => fail(new Error(`barrier timed out: ${arrived}/${parties} arrived`)),
    timeoutMs,
  );
  return () => {
    arrived += 1;
    if (arrived === parties) {
      clearTimeout(timer);
      release();
    }
    return allArrived;
  };
}

export {
  FIXTURE_PASSWORD_HASH,
  TEST_FIXTURE_COMPLIANCE,
  enableGermanyForTesting,
  enableMarketsForTesting,
  insertFixtureDraw,
  insertFixtureUser,
  type FixtureDrawOptions,
} from './fixtures';
