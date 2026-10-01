/**
 * Pulls one named file out of a gitleaks release archive.
 *
 * Node has no tar or zip reader, and shelling out to `tar`, `unzip` or
 * `Expand-Archive` would mean three different code paths and three different
 * sets of assumptions about what a developer's machine happens to have. Both
 * formats are simple enough to read directly, and `zlib` covers the
 * compression, so this stays one implementation everywhere.
 */
import { gunzipSync, inflateRawSync } from 'node:zlib';

const TAR_BLOCK = 512;

/**
 * Reads a gzipped tar and returns the contents of `wanted`.
 *
 * POSIX tar is a sequence of 512-byte headers, each followed by its file
 * rounded up to the next block. Only the name and the size are needed here.
 */
export function extractFromTarGz(archive, wanted) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + TAR_BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    // Two zero blocks mark the end of the archive.
    if (header.every((byte) => byte === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeField, 8);
    if (!Number.isFinite(size)) throw new Error(`tar entry "${name}" has an unreadable size`);

    const body = offset + TAR_BLOCK;
    if (name === wanted) return Buffer.from(tar.subarray(body, body + size));
    // Entries are padded to a whole number of blocks.
    offset = body + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  throw new Error(`"${wanted}" is not in the archive`);
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/**
 * Reads a zip and returns the contents of `wanted`.
 *
 * Entries are found through the central directory at the end of the file
 * rather than by scanning forwards, which is what the format is designed for.
 * Only "stored" and "deflate" appear in these releases.
 */
export function extractFromZip(archive, wanted) {
  const eocd = findEndOfCentralDirectory(archive);
  let entry = archive.readUInt32LE(eocd + 16);
  const count = archive.readUInt16LE(eocd + 10);

  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(entry) !== CENTRAL_SIGNATURE) {
      throw new Error('zip central directory is malformed');
    }
    const method = archive.readUInt16LE(entry + 10);
    const compressedSize = archive.readUInt32LE(entry + 20);
    const nameLength = archive.readUInt16LE(entry + 28);
    const extraLength = archive.readUInt16LE(entry + 30);
    const commentLength = archive.readUInt16LE(entry + 32);
    const localHeader = archive.readUInt32LE(entry + 42);
    const name = archive.subarray(entry + 46, entry + 46 + nameLength).toString('utf8');

    if (name === wanted) {
      // The local header repeats the name and extra fields, with its own lengths.
      const localNameLength = archive.readUInt16LE(localHeader + 26);
      const localExtraLength = archive.readUInt16LE(localHeader + 28);
      const start = localHeader + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(compressed);
      if (method === 8) return inflateRawSync(compressed);
      throw new Error(`zip entry "${name}" uses unsupported compression method ${method}`);
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`"${wanted}" is not in the archive`);
}

/** The end-of-central-directory record is last, after a variable-length comment. */
function findEndOfCentralDirectory(archive) {
  for (let i = archive.length - 22; i >= 0; i--) {
    if (archive.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('not a zip archive: no end-of-central-directory record');
}

/** Picks the reader for an archive kind. */
export function extract(archive, kind, wanted) {
  if (kind === 'zip') return extractFromZip(archive, wanted);
  if (kind === 'tar.gz') return extractFromTarGz(archive, wanted);
  throw new Error(`unsupported archive kind "${kind}"`);
}
