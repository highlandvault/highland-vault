import { describe, expect, it } from 'vitest';
import { analyse } from './runner';
import { MIGRATION_FILENAME, checksumSql, isTransactional, type MigrationFile } from './files';

const fileOf = (version: string, name: string, sql = 'SELECT 1;'): MigrationFile => ({
  version,
  name,
  filename: `${version}_${name}.sql`,
  sql,
  checksum: checksumSql(sql),
  transactional: true,
});

describe('migration files', () => {
  it('accepts only NNNN_snake_case.sql names', () => {
    expect(MIGRATION_FILENAME.test('0001_foundation.sql')).toBe(true);
    expect(MIGRATION_FILENAME.test('0012_add_ticket_pool.sql')).toBe(true);
    expect(MIGRATION_FILENAME.test('1_foundation.sql')).toBe(false);
    expect(MIGRATION_FILENAME.test('0001-foundation.sql')).toBe(false);
    expect(MIGRATION_FILENAME.test('0001_Foundation.sql')).toBe(false);
    expect(MIGRATION_FILENAME.test('0001_foundation.SQL')).toBe(false);
  });

  it('computes line-ending-independent SHA-256 checksums', () => {
    expect(checksumSql('SELECT 1;\nSELECT 2;\n')).toBe(checksumSql('SELECT 1;\r\nSELECT 2;\r\n'));
    expect(checksumSql('SELECT 1;')).not.toBe(checksumSql('SELECT 2;'));
    expect(checksumSql('')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects the no-transaction directive only on the first line', () => {
    expect(isTransactional('CREATE TABLE t ();')).toBe(true);
    expect(
      isTransactional('-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (x);'),
    ).toBe(false);
    expect(isTransactional('SELECT 1;\n-- migrate:no-transaction')).toBe(true);
  });
});

describe('analyse (files vs history)', () => {
  const applied = (file: MigrationFile) => ({
    version: file.version,
    name: file.name,
    checksum: file.checksum,
    transactional: true,
    appliedAt: new Date(0),
    executionMs: 1,
  });

  it('reports pending files for an empty history', () => {
    const report = analyse([fileOf('0001', 'a'), fileOf('0002', 'b')], []);
    expect(report.problems).toEqual([]);
    expect(report.pending.map((f) => f.version)).toEqual(['0001', '0002']);
  });

  it('flags changed, missing and out-of-order entries', () => {
    const a = fileOf('0001', 'a');
    const b = fileOf('0002', 'b');
    const c = fileOf('0003', 'c');
    const report = analyse(
      [a, { ...b, checksum: checksumSql('changed') }],
      [applied(b), applied(c)],
    );
    expect(report.entries.map((e) => [e.version, e.state])).toEqual([
      ['0001', 'pending'],
      ['0002', 'changed'],
      ['0003', 'missing_file'],
    ]);
    expect(report.problems).toHaveLength(3);
  });
});
