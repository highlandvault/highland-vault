/**
 * Phase 1 database foundation against real PostgreSQL: Kysely client, int8
 * safety, transaction retry policy, and the append-only trigger function.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client';
import { withTransaction } from '../src/transaction';
import { createTestDatabase, type TestDatabase } from '../src/testing';

describe('database foundation', () => {
  let database: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.url, applicationName: 'hv-test', max: 4 });
  });

  afterAll(async () => {
    await db?.destroy();
    await database?.drop();
  });

  it('connects through Kysely to PostgreSQL 18', async () => {
    const { rows } = await sql<{
      version: string;
    }>`SELECT current_setting('server_version') AS version`.execute(db);
    expect(rows[0]!.version).toMatch(/^18\./);
  });

  describe('int8 parsing', () => {
    it('returns bigint values within the safe range as numbers', async () => {
      const { rows } = await sql<{
        max: number;
        min: number;
        arr: number[];
      }>`SELECT 9007199254740991::int8 AS max, (-9007199254740991)::int8 AS min, ARRAY[1, 2]::int8[] AS arr`.execute(
        db,
      );
      expect(rows[0]).toEqual({ max: 9007199254740991, min: -9007199254740991, arr: [1, 2] });
    });

    it('throws instead of silently losing precision', async () => {
      await expect(sql`SELECT 9007199254740992::int8 AS v`.execute(db)).rejects.toThrow(RangeError);
      await expect(sql`SELECT ARRAY[9007199254740993]::int8[] AS v`.execute(db)).rejects.toThrow(
        RangeError,
      );
    });
  });

  describe('withTransaction', () => {
    const forceSqlState = (code: string) =>
      sql`DO $$ BEGIN RAISE EXCEPTION 'forced' USING ERRCODE = ${sql.raw(`'${code}'`)}; END $$`;

    it('retries a real serialization failure (40001) and then succeeds', async () => {
      let attempts = 0;
      const result = await withTransaction(db, async (trx) => {
        attempts += 1;
        if (attempts === 1) await forceSqlState('40001').execute(trx);
        return 'committed';
      });
      expect(result).toBe('committed');
      expect(attempts).toBe(2);
    });

    it('retries a deadlock (40P01) and gives up after maxAttempts', async () => {
      let attempts = 0;
      await expect(
        withTransaction(
          db,
          async (trx) => {
            attempts += 1;
            await forceSqlState('40P01').execute(trx);
          },
          { maxAttempts: 3 },
        ),
      ).rejects.toMatchObject({ code: '40P01' });
      expect(attempts).toBe(3);
    });

    it('does not retry other errors, and rolls back', async () => {
      await sql`CREATE TABLE tx_probe (id int PRIMARY KEY)`.execute(db);
      let attempts = 0;
      await expect(
        withTransaction(db, async (trx) => {
          attempts += 1;
          await sql`INSERT INTO tx_probe VALUES (1)`.execute(trx);
          await sql`INSERT INTO tx_probe VALUES (1)`.execute(trx); // unique_violation 23505
        }),
      ).rejects.toMatchObject({ code: '23505' });
      expect(attempts).toBe(1);
      const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM tx_probe`.execute(
        db,
      );
      expect(rows[0]!.n).toBe(0);
    });

    it('applies the requested isolation level', async () => {
      const level = await withTransaction(
        db,
        async (trx) =>
          (
            await sql<{
              level: string;
            }>`SELECT current_setting('transaction_isolation') AS level`.execute(trx)
          ).rows[0]!.level,
        { isolationLevel: 'serializable' },
      );
      expect(level).toBe('serializable');
    });
  });

  describe('hv_forbid_update_delete (append-only guard from 0001_foundation)', () => {
    beforeAll(async () => {
      await sql`
        CREATE TABLE append_only_probe (id int PRIMARY KEY, note text);
        CREATE TRIGGER append_only_probe_no_update_delete
          BEFORE UPDATE OR DELETE ON append_only_probe
          FOR EACH ROW EXECUTE FUNCTION hv_forbid_update_delete();
        CREATE TRIGGER append_only_probe_no_truncate
          BEFORE TRUNCATE ON append_only_probe
          FOR EACH STATEMENT EXECUTE FUNCTION hv_forbid_update_delete();
        INSERT INTO append_only_probe VALUES (1, 'original');
      `.execute(db);
    });

    it('allows INSERT', async () => {
      await sql`INSERT INTO append_only_probe VALUES (2, 'appended')`.execute(db);
    });

    it.each([
      ['UPDATE', sql`UPDATE append_only_probe SET note = 'changed' WHERE id = 1`],
      ['DELETE', sql`DELETE FROM append_only_probe WHERE id = 1`],
      ['TRUNCATE', sql`TRUNCATE append_only_probe`],
    ])('rejects %s', async (operation, statement) => {
      await expect(statement.execute(db)).rejects.toMatchObject({
        code: '23001',
        message: expect.stringContaining(`${operation} is not allowed`) as unknown,
      });
      const { rows } = await sql<{
        note: string;
      }>`SELECT note FROM append_only_probe WHERE id = 1`.execute(db);
      expect(rows[0]!.note).toBe('original');
    });
  });
});
