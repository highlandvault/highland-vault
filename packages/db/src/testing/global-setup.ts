/**
 * Vitest global setup for the `integration` project: recreates the migrated
 * template database from packages/db/migrations using the real migration tool.
 */
import { migrateUp } from '../migrate/runner';
import {
  MIGRATIONS_DIR,
  TEST_DB_PREFIX,
  TEST_TEMPLATE_DB,
  databaseUrl,
  testAdminUrl,
  withAdminClient,
} from './index';

export default async function setup(): Promise<() => Promise<void>> {
  await withAdminClient(async (client) => {
    // Remove leftovers from interrupted runs. Assumes one integration run at a time per database server.
    const stale = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${TEST_DB_PREFIX}%`],
    );
    for (const { datname } of stale.rows) {
      await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
    await client.query(`CREATE DATABASE "${TEST_TEMPLATE_DB}" TEMPLATE template1`);
  });

  await migrateUp({
    connectionString: databaseUrl(testAdminUrl(), TEST_TEMPLATE_DB),
    migrationsDir: MIGRATIONS_DIR,
  });

  return async () => {
    await withAdminClient(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${TEST_TEMPLATE_DB}" WITH (FORCE)`);
    });
  };
}
