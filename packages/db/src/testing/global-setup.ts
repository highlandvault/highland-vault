/**
 * Vitest global setup for the `integration` project: recreates the migrated
 * template database from packages/db/migrations using the real migration tool.
 */
import pg from 'pg';
import { migrateUp } from '../migrate/runner';
import {
  MIGRATIONS_DIR,
  TEST_DB_PREFIX,
  TEST_TEMPLATE_DB,
  databaseUrl,
  testAdminUrl,
  withAdminClient,
} from './index';

const { Client } = pg;

/** A connection to the template database itself, rather than to `postgres`. */
async function withTemplateClient(fn: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new Client({
    connectionString: databaseUrl(testAdminUrl(), TEST_TEMPLATE_DB),
    application_name: 'hv-test-template',
  });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

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

  // Reproduce the privilege model the production bootstrap sets up
  // (infra/docker/postgres/init/01-roles-and-database.sh).
  //
  // Without this, hv_app has NO privileges at all in a test database, because
  // ALTER DEFAULT PRIVILEGES is per database and the template is cloned from
  // template1. Every "hv_app cannot DELETE this" assertion would then pass for
  // the wrong reason — there is no grant to revoke — and a migration that
  // forgot its REVOKE would look correct. Migrations run as hv_owner here, so
  // the defaults below apply to the tables they create.
  await withTemplateClient(async (client) => {
    await client.query(`
      GRANT USAGE ON SCHEMA public TO hv_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE hv_owner IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hv_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE hv_owner IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO hv_app;
    `);
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
