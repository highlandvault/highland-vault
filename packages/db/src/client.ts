import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './generated/db';
import { pgTypes } from './int8';

export interface DbOptions {
  connectionString: string;
  /** Visible in pg_stat_activity, e.g. "hv-api". */
  applicationName: string;
  /** Pool size (default 10). */
  max?: number;
}

export function createPool(options: DbOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    // Session time zone is UTC, so timestamps are always reasoned about in UTC.
    options: '-c TimeZone=UTC',
    types: pgTypes,
  });
}

export type Database = Kysely<DB>;

/** The pool or an open transaction: repositories accept either. */
export type DbExecutor = Kysely<DB>;

/** Application database handle. Destroy it on shutdown (`await db.destroy()`). */
export function createDb(options: DbOptions): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: createPool(options) }),
  });
}
