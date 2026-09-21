import pg from 'pg';
import { MigrationStateError, loadMigrationFiles, type MigrationFile } from './files';

/**
 * Minimal forward-only plain-SQL migration tool (ADR-0002).
 *
 *  - Files `NNNN_name.sql` are applied in version order, each in its own transaction
 *    (unless the first line is `-- migrate:no-transaction`).
 *  - History lives in `public.schema_migrations` with a SHA-256 checksum per file.
 *  - Any drift (edited, deleted, renamed or out-of-order file) makes `up` refuse to run.
 *  - A PostgreSQL advisory lock serialises concurrent runners.
 */

export const HISTORY_TABLE = 'schema_migrations';

/** Arbitrary constant identifying the migration lock ("HVMIGR" in hex-ish digits). */
const ADVISORY_LOCK_KEY = 4_856_774_971;

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  transactional: boolean;
  appliedAt: Date;
  executionMs: number;
}

export type MigrationEntryState = 'applied' | 'pending' | 'changed' | 'missing_file';

export interface MigrationEntry {
  version: string;
  name: string;
  state: MigrationEntryState;
  appliedAt?: Date;
}

export interface MigrationReport {
  entries: MigrationEntry[];
  /** Drift that makes the database state inconsistent with the files. */
  problems: string[];
  pending: MigrationFile[];
}

export interface MigrateOptions {
  connectionString: string;
  migrationsDir: string;
}

async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'hv-migrate' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function historyTableExists(client: pg.Client): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${HISTORY_TABLE}`],
  );
  return result.rows[0]?.exists ?? false;
}

async function ensureHistoryTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.${HISTORY_TABLE} (
      version       text        PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
      name          text        NOT NULL,
      checksum      text        NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      transactional boolean     NOT NULL,
      applied_at    timestamptz NOT NULL DEFAULT now(),
      execution_ms  integer     NOT NULL CHECK (execution_ms >= 0)
    )`);
  // The runtime role may read the history (e.g. for diagnostics) but never change it.
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hv_app') THEN
        REVOKE ALL ON public.${HISTORY_TABLE} FROM hv_app;
        GRANT SELECT ON public.${HISTORY_TABLE} TO hv_app;
      END IF;
    END $$`);
}

async function readApplied(client: pg.Client): Promise<AppliedMigration[]> {
  if (!(await historyTableExists(client))) {
    return [];
  }
  const result = await client.query<{
    version: string;
    name: string;
    checksum: string;
    transactional: boolean;
    applied_at: Date;
    execution_ms: number;
  }>(
    `SELECT version, name, checksum, transactional, applied_at, execution_ms
       FROM public.${HISTORY_TABLE} ORDER BY version`,
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    transactional: row.transactional,
    appliedAt: row.applied_at,
    executionMs: row.execution_ms,
  }));
}

/** Pure comparison of files on disk against the recorded history. */
export function analyse(files: MigrationFile[], applied: AppliedMigration[]): MigrationReport {
  const problems: string[] = [];
  const entries: MigrationEntry[] = [];
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const filesByVersion = new Map(files.map((file) => [file.version, file]));
  const highestApplied = applied.reduce((max, row) => (row.version > max ? row.version : max), '');
  const pending: MigrationFile[] = [];

  for (const file of files) {
    const row = appliedByVersion.get(file.version);
    if (!row) {
      entries.push({ version: file.version, name: file.name, state: 'pending' });
      pending.push(file);
      if (file.version < highestApplied) {
        problems.push(
          `${file.filename} is not applied but a later migration (${highestApplied}) is: out-of-order migration`,
        );
      }
      continue;
    }
    if (row.name !== file.name || row.checksum !== file.checksum) {
      entries.push({
        version: file.version,
        name: file.name,
        state: 'changed',
        appliedAt: row.appliedAt,
      });
      problems.push(
        row.name !== file.name
          ? `${file.filename} was applied as "${row.version}_${row.name}.sql": file renamed after being applied`
          : `${file.filename} was modified after being applied (checksum ${row.checksum.slice(0, 12)}… != ${file.checksum.slice(0, 12)}…)`,
      );
      continue;
    }
    entries.push({
      version: file.version,
      name: file.name,
      state: 'applied',
      appliedAt: row.appliedAt,
    });
  }

  for (const row of applied) {
    if (!filesByVersion.has(row.version)) {
      entries.push({
        version: row.version,
        name: row.name,
        state: 'missing_file',
        appliedAt: row.appliedAt,
      });
      problems.push(
        `${row.version}_${row.name}.sql is recorded as applied but the file is missing`,
      );
    }
  }

  entries.sort((a, b) => a.version.localeCompare(b.version));
  return { entries, problems, pending };
}

export async function migrationStatus(options: MigrateOptions): Promise<MigrationReport> {
  const files = loadMigrationFiles(options.migrationsDir);
  const applied = await withClient(options.connectionString, readApplied);
  return analyse(files, applied);
}

/** Applies all pending migrations. Refuses to run if the recorded state has drifted. */
export async function migrateUp(options: MigrateOptions): Promise<MigrationFile[]> {
  const files = loadMigrationFiles(options.migrationsDir);

  return withClient(options.connectionString, async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await ensureHistoryTable(client);
      // Read history only after taking the lock, so a concurrent runner's work is visible.
      const report = analyse(files, await readApplied(client));
      if (report.problems.length > 0) {
        throw new MigrationStateError(report.problems);
      }
      for (const file of report.pending) {
        await applyOne(client, file);
      }
      return report.pending;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  });
}

async function applyOne(client: pg.Client, file: MigrationFile): Promise<void> {
  const started = performance.now();
  const record = async () => {
    await client.query(
      `INSERT INTO public.${HISTORY_TABLE} (version, name, checksum, transactional, execution_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        file.version,
        file.name,
        file.checksum,
        file.transactional,
        Math.round(performance.now() - started),
      ],
    );
  };

  if (!file.transactional) {
    // Must be a single statement (e.g. CREATE INDEX CONCURRENTLY); should be idempotent
    // (IF NOT EXISTS) because a crash between execution and recording leaves it unrecorded.
    try {
      await client.query(file.sql);
    } catch (error) {
      throw new Error(`Migration ${file.filename} failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    await record();
    return;
  }

  await client.query('BEGIN');
  try {
    await client.query(file.sql);
    await record();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(
      `Migration ${file.filename} failed and was rolled back: ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  appliedCount: number;
}

/** The database must match the migration files exactly: no drift and nothing pending. */
export async function migrationVerify(options: MigrateOptions): Promise<VerifyResult> {
  const report = await migrationStatus(options);
  const problems = [
    ...report.problems,
    ...report.pending
      .filter((file) => !report.problems.some((p) => p.startsWith(file.filename)))
      .map((file) => `${file.filename} is pending (not applied)`),
  ];
  return {
    ok: problems.length === 0,
    problems,
    appliedCount: report.entries.filter((entry) => entry.state === 'applied').length,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
