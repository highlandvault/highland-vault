/**
 * Prepares the throwaway database used by the Playwright smoke tests:
 * recreate `hv_e2e`, apply the real migrations, then enable UK and IE with the
 * TEST FIXTURE compliance values (see fixtures.ts — not compliance decisions).
 * Germany stays exactly as the migrations leave it: disabled, no approval.
 *
 *   pnpm --filter @hv/db e2e:prepare
 *
 * Refuses to run against anything but a local database server.
 */
import pg from 'pg';
import { migrateUp } from '../migrate/runner';
import { enableMarketsForTesting } from './fixtures';
import { MIGRATIONS_DIR, databaseUrl, testAdminUrl, withAdminClient } from './index';

export const E2E_DB = 'hv_e2e';

async function main(): Promise<void> {
  const adminUrl = testAdminUrl();
  const host = new URL(adminUrl).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`refusing to prepare an e2e database on non-local host ${host}`);
  }
  await withAdminClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${E2E_DB}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${E2E_DB}" TEMPLATE template1`);
  });
  const url = databaseUrl(adminUrl, E2E_DB);
  await migrateUp({ connectionString: url, migrationsDir: MIGRATIONS_DIR });
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await enableMarketsForTesting(client, ['uk', 'ie']);
  } finally {
    await client.end();
  }
  process.stdout.write(`e2e database ${E2E_DB} ready (uk, ie enabled with test fixture values)\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `e2e:prepare failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
