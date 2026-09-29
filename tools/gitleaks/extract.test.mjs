/**
 * The archive readers, against archives built here rather than downloaded, so
 * both formats are covered on every platform — a Windows machine never sees a
 * release tarball, and a Linux one never sees the zip.
 */
import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extract, extractFromTarGz, extractFromZip } from './extract.mjs';

/** A POSIX tar entry: a 512-byte header, then the body padded to 512 bytes. */
function tarEntry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('000644 \0', 100, 'utf8');
  header.write(`${body.length.toString(8).padStart(11, '0')} `, 124, 'utf8');
  header.write('        ', 148, 'utf8'); // checksum field, blank while summing
  header.write('0', 156, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

function buildTarGz(entries) {
  return gzipSync(Buffer.concat([...entries.map(([n, b]) => tarEntry(n, b)), Buffer.alloc(1024)]));
}

/** A minimal zip with one deflated entry, enough to exercise the reader. */
function buildZip(name, body) {
  const nameBuf = Buffer.from(name, 'utf8');
  const compressed = deflateRawSync(body);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localRecord = Buffer.concat([local, nameBuf, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const centralRecord = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);

  return Buffer.concat([localRecord, centralRecord, eocd]);
}

const BINARY = Buffer.from('#!/gitleaks\u0000binary-ish contents');

describe('tar.gz (macOS and Linux releases)', () => {
  it('returns the named entry', () => {
    const archive = buildTarGz([
      ['README.md', Buffer.from('not the binary')],
      ['gitleaks', BINARY],
    ]);
    expect(extractFromTarGz(archive, 'gitleaks').equals(BINARY)).toBe(true);
  });

  it('does not confuse a similarly named entry', () => {
    const archive = buildTarGz([
      ['gitleaks.txt', Buffer.from('decoy')],
      ['gitleaks', BINARY],
    ]);
    expect(extractFromTarGz(archive, 'gitleaks').equals(BINARY)).toBe(true);
  });

  it('fails when the entry is absent rather than returning something else', () => {
    const archive = buildTarGz([['LICENSE', Buffer.from('text')]]);
    expect(() => extractFromTarGz(archive, 'gitleaks')).toThrow(/is not in the archive/);
  });
});

describe('zip (Windows releases)', () => {
  it('returns the named entry, inflated', () => {
    expect(extractFromZip(buildZip('gitleaks.exe', BINARY), 'gitleaks.exe').equals(BINARY)).toBe(
      true,
    );
  });

  it('fails when the entry is absent', () => {
    expect(() => extractFromZip(buildZip('other.exe', BINARY), 'gitleaks.exe')).toThrow(
      /is not in the archive/,
    );
  });

  it('rejects something that is not a zip', () => {
    expect(() => extractFromZip(Buffer.alloc(64), 'gitleaks.exe')).toThrow(/not a zip archive/);
  });
});

describe('dispatch by archive kind', () => {
  it('reads each kind with the right reader', () => {
    expect(extract(buildTarGz([['gitleaks', BINARY]]), 'tar.gz', 'gitleaks').equals(BINARY)).toBe(
      true,
    );
    expect(extract(buildZip('gitleaks.exe', BINARY), 'zip', 'gitleaks.exe').equals(BINARY)).toBe(
      true,
    );
  });

  it('refuses an unknown kind', () => {
    expect(() => extract(Buffer.alloc(0), 'rar', 'gitleaks')).toThrow(/unsupported archive kind/);
  });
});
