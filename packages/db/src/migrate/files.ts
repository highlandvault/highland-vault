import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** `NNNN_snake_case_name.sql`, e.g. `0001_foundation.sql`. */
export const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** First line directive for statements PostgreSQL refuses to run in a transaction. */
export const NO_TRANSACTION_DIRECTIVE = '-- migrate:no-transaction';

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export class MigrationStateError extends Error {
  override readonly name = 'MigrationStateError';
  constructor(readonly problems: string[]) {
    super(`Migration state is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Line endings are normalised so a Windows checkout produces the same checksum as CI. */
export function normaliseSql(raw: string): string {
  return raw.replace(/\r\n/g, '\n');
}

export function checksumSql(sql: string): string {
  return createHash('sha256').update(normaliseSql(sql), 'utf8').digest('hex');
}

export function isTransactional(sql: string): boolean {
  const firstLine = normaliseSql(sql).split('\n', 1)[0]?.trim();
  return firstLine !== NO_TRANSACTION_DIRECTIVE;
}

/**
 * Reads and validates the migration directory. Refuses anything unexpected:
 * unknown files, duplicate versions, or gaps in the 0001..N sequence.
 */
export function loadMigrationFiles(directory: string): MigrationFile[] {
  const problems: string[] = [];
  const files: MigrationFile[] = [];

  for (const filename of readdirSync(directory).sort()) {
    const fullPath = path.join(directory, filename);
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match || !statSync(fullPath).isFile()) {
      problems.push(`unexpected entry in migrations directory: ${filename}`);
      continue;
    }
    const sql = normaliseSql(readFileSync(fullPath, 'utf8'));
    files.push({
      version: match[1]!,
      name: match[2]!,
      filename,
      sql,
      checksum: checksumSql(sql),
      transactional: isTransactional(sql),
    });
  }

  files.forEach((file, index) => {
    const expected = String(index + 1).padStart(4, '0');
    if (file.version !== expected) {
      problems.push(
        `migration sequence must be contiguous from 0001: expected ${expected}, found ${file.filename}`,
      );
    }
  });

  if (problems.length > 0) {
    throw new MigrationStateError(problems);
  }
  return files;
}
