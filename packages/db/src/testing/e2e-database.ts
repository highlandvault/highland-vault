/**
 * Prepares the throwaway database used by the Playwright smoke tests:
 * recreate `hv_e2e`, apply the real migrations, then enable UK and IE with the
 * TEST FIXTURE compliance values (see fixtures.ts — not compliance decisions),
 * and seed test draws. Germany stays exactly as the migrations leave it:
 * disabled, no approval — although a published DE draw exists, to prove it
 * stays hidden. Ireland has no draws, for the empty state.
 *
 *   pnpm --filter @hv/db e2e:prepare
 *
 * Also empties the e2e Redis logical database (REDIS_URL, never DB 0), so
 * rate-limit counters from earlier runs cannot make a new run fail.
 *
 * Refuses to run against anything but local servers.
 */
import { Redis } from 'ioredis';
import pg from 'pg';
import { migrateUp } from '../migrate/runner';
import { enableMarketsForTesting, insertFixtureDraw } from './fixtures';
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
    const day = 24 * 60 * 60 * 1000;
    await insertFixtureDraw(client, {
      market: 'uk',
      slug: 'highland-lodge-escape',
      title: 'Highland lodge escape',
      state: 'live',
      ticketPriceMinor: 299,
      totalTickets: 4000,
      maxPerPerson: 50,
      prizes: ['A week in a Highland lodge', 'Weekend spa break'],
    });
    await insertFixtureDraw(client, {
      market: 'uk',
      slug: 'vintage-whisky-collection',
      title: 'Vintage whisky collection',
      state: 'scheduled',
      opensAt: new Date(Date.now() + 2 * day),
      closesAt: new Date(Date.now() + 9 * day),
      prizes: ['Twelve-bottle collection'],
    });
    await insertFixtureDraw(client, {
      market: 'uk',
      slug: 'secret-draft',
      title: 'Secret draft',
      state: 'draft',
    });
    await insertFixtureDraw(client, {
      market: 'uk',
      slug: 'withdrawn-draw',
      title: 'Withdrawn draw',
      state: 'cancelled',
    });
    await insertFixtureDraw(client, {
      market: 'de',
      slug: 'de-draw',
      title: 'German draw',
      state: 'live',
    });
  } finally {
    await client.end();
  }
  await resetE2eRedis();
  process.stdout.write(
    `e2e database ${E2E_DB} ready (uk, ie enabled with test fixture values; test draws seeded)\n`,
  );
}

async function resetE2eRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL (the e2e Redis database) is not set');
  const parsed = new URL(url);
  const dbIndex = Number(parsed.pathname.slice(1) || '0');
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) || !(dbIndex > 0)) {
    throw new Error('refusing to flush Redis: e2e needs a local, non-zero logical database');
  }
  const redis = new Redis(url, { maxRetriesPerRequest: 1 });
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `e2e:prepare failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
