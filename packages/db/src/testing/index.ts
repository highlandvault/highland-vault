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
    drop: () =>
      withAdminClient(async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }),
  };
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
