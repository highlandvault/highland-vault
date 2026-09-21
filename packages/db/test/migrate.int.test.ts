/**
 * Migration tool against a real, empty PostgreSQL database per test.
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationStateError } from '../src/migrate/files';
import { migrateUp, migrationStatus, migrationVerify } from '../src/migrate/runner';
import { MIGRATIONS_DIR, createTestDatabase, type TestDatabase } from '../src/testing';

describe('migration tool', () => {
  let database: TestDatabase;
  let dir: string;
  const options = () => ({ connectionString: database.url, migrationsDir: dir });
  const file = (name: string, sql: string) => writeFileSync(path.join(dir, name), sql);

  async function query<T extends pg.QueryResultRow>(text: string): Promise<T[]> {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      return (await client.query<T>(text)).rows;
    } finally {
      await client.end();
    }
  }

  beforeEach(async () => {
    database = await createTestDatabase({ migrated: false });
    dir = mkdtempSync(path.join(tmpdir(), 'hv-migrations-'));
  });

  afterEach(async () => {
    await database.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies migrations in version order and records history with checksums', async () => {
    file('0002_second.sql', 'INSERT INTO t (id) VALUES (2);');
    file('0001_first.sql', 'CREATE TABLE t (id int PRIMARY KEY);');

    const applied = await migrateUp(options());

    expect(applied.map((m) => m.filename)).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(await query('SELECT id FROM t')).toEqual([{ id: 2 }]);
    const history = await query<{ version: string; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    expect(history.map((h) => [h.version, h.name])).toEqual([
      ['0001', 'first'],
      ['0002', 'second'],
    ]);
    expect(history.every((h) => /^[0-9a-f]{64}$/.test(h.checksum))).toBe(true);
  });

  it('is a no-op when re-run (repeatable without corrupting state)', async () => {
    file('0001_first.sql', 'CREATE TABLE t (id int PRIMARY KEY);');
    await migrateUp(options());

    expect(await migrateUp(options())).toEqual([]);
    expect(await migrateUp(options())).toEqual([]);
    expect(await query('SELECT count(*)::int AS n FROM schema_migrations')).toEqual([{ n: 1 }]);
  });

  it('status and verify report pending, then applied', async () => {
    file('0001_first.sql', 'CREATE TABLE t (id int);');

    const before = await migrationStatus(options());
    expect(before.entries).toEqual([{ version: '0001', name: 'first', state: 'pending' }]);
    expect(await migrationVerify(options())).toMatchObject({
      ok: false,
      problems: ['0001_first.sql is pending (not applied)'],
    });

    await migrateUp(options());

    const after = await migrationStatus(options());
    expect(after.entries[0]).toMatchObject({ version: '0001', state: 'applied' });
    expect(after.problems).toEqual([]);
    expect(await migrationVerify(options())).toEqual({ ok: true, problems: [], appliedCount: 1 });
  });

  it('refuses to run when an applied migration was modified', async () => {
    file('0001_first.sql', 'CREATE TABLE t (id int);');
    await migrateUp(options());
    file('0001_first.sql', 'CREATE TABLE t (id bigint);');
    file('0002_second.sql', 'CREATE TABLE u (id int);');

    await expect(migrateUp(options())).rejects.toThrow(/modified after being applied/);
    expect(await query("SELECT to_regclass('u') IS NULL AS absent")).toEqual([{ absent: true }]);
    const verify = await migrationVerify(options());
    expect(verify.ok).toBe(false);
    expect(verify.problems.join('\n')).toMatch(/0001_first\.sql was modified/);
  });

  it('treats CRLF and LF versions of a file as identical (Windows checkouts)', async () => {
    file('0001_first.sql', 'CREATE TABLE t (id int);\nCREATE TABLE u (id int);\n');
    await migrateUp(options());
    file('0001_first.sql', 'CREATE TABLE t (id int);\r\nCREATE TABLE u (id int);\r\n');

    expect(await migrationVerify(options())).toMatchObject({ ok: true });
  });

  it('refuses to run when an applied migration file is missing or renamed', async () => {
    file('0001_first.sql', 'CREATE TABLE t (id int);');
    await migrateUp(options());

    unlinkSync(path.join(dir, '0001_first.sql'));
    await expect(migrateUp(options())).rejects.toThrow(/file is missing/);

    file('0001_renamed.sql', 'CREATE TABLE t (id int);');
    await expect(migrateUp(options())).rejects.toThrow(/file renamed after being applied/);
  });

  it('refuses out-of-order migrations (an older version appearing after a newer one was applied)', async () => {
    file('0001_first.sql', 'SELECT 1;');
    file('0002_second.sql', 'SELECT 2;');
    await migrateUp(options());
    // Simulate history where 0001 was never applied but 0002 was.
    await query("DELETE FROM schema_migrations WHERE version = '0001'");

    await expect(migrateUp(options())).rejects.toThrow(/out-of-order migration/);
  });

  it('refuses unexpected files and gaps in the sequence', async () => {
    file('0001_first.sql', 'SELECT 1;');
    file('notes.txt', 'not a migration');
    await expect(migrateUp(options())).rejects.toThrow(MigrationStateError);
    await expect(migrateUp(options())).rejects.toThrow(/unexpected entry.*notes\.txt/);

    unlinkSync(path.join(dir, 'notes.txt'));
    file('0003_third.sql', 'SELECT 3;');
    await expect(migrateUp(options())).rejects.toThrow(/expected 0002, found 0003_third\.sql/);
    expect(await query("SELECT to_regclass('schema_migrations') IS NULL AS absent")).toEqual([
      { absent: true },
    ]);
  });

  it('rolls back a failing migration completely and keeps earlier ones', async () => {
    file('0001_first.sql', 'CREATE TABLE t (id int);');
    file('0002_broken.sql', 'CREATE TABLE u (id int);\nSELECT * FROM does_not_exist;');

    await expect(migrateUp(options())).rejects.toThrow(
      /0002_broken\.sql failed and was rolled back/,
    );

    expect(await query("SELECT to_regclass('t') IS NOT NULL AS present")).toEqual([
      { present: true },
    ]);
    expect(await query("SELECT to_regclass('u') IS NULL AS absent")).toEqual([{ absent: true }]);
    expect(await query('SELECT version FROM schema_migrations')).toEqual([{ version: '0001' }]);
  });

  it('runs a `-- migrate:no-transaction` migration outside a transaction', async () => {
    file('0001_table.sql', 'CREATE TABLE t (id int);');
    // CREATE INDEX CONCURRENTLY is rejected by PostgreSQL inside a transaction block.
    file(
      '0002_index.sql',
      '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_idx ON t (id);',
    );

    await migrateUp(options());

    expect(await query("SELECT to_regclass('t_id_idx') IS NOT NULL AS present")).toEqual([
      { present: true },
    ]);
    expect(
      await query("SELECT transactional FROM schema_migrations WHERE version = '0002'"),
    ).toEqual([{ transactional: false }]);
  });

  it('serialises concurrent runners with an advisory lock: each migration applied exactly once', async () => {
    file('0001_first.sql', 'CREATE TABLE t (id int);');
    file('0002_slow.sql', 'SELECT pg_sleep(0.2); INSERT INTO t VALUES (1);');

    const results = await Promise.all(Array.from({ length: 5 }, () => migrateUp(options())));

    expect(
      results
        .flat()
        .map((m) => m.filename)
        .sort(),
    ).toEqual(['0001_first.sql', '0002_slow.sql']);
    expect(await query('SELECT count(*)::int AS n FROM t')).toEqual([{ n: 1 }]);
    expect(await query('SELECT count(*)::int AS n FROM schema_migrations')).toEqual([{ n: 2 }]);
  });

  it('applies the real repository migrations to a clean database', async () => {
    const real = { connectionString: database.url, migrationsDir: MIGRATIONS_DIR };
    const applied = await migrateUp(real);
    expect(applied.length).toBeGreaterThan(0);
    expect(await migrationVerify(real)).toMatchObject({ ok: true });
  });
});
