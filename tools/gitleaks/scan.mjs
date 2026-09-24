#!/usr/bin/env node
/**
 * Runs the same secret scan locally that CI runs, so a leak is caught before
 * a pull request rather than after it.
 *
 * CI downloads gitleaks and runs `gitleaks git --no-banner --redact .`. This
 * does the same, with the same pinned version and the same arguments, and
 * keeps the binary in a gitignored cache so only the first run pays for it.
 *
 * It fails closed. There is no flag, no environment variable and no fallback
 * that turns the scan off: if gitleaks cannot be fetched, verified or run,
 * that is a failure, because "the scan did not happen" and "the scan found
 * nothing" must never look alike.
 *
 * Usage: node tools/gitleaks/scan.mjs [extra gitleaks args]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from './extract.mjs';
import {
  GITLEAKS_VERSION,
  SCAN_ARGS,
  UnsupportedPlatformError,
  findChecksum,
  resolveArtifact,
} from './resolve.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Gitignored, and keyed by version and platform so caches never collide. */
const CACHE_ROOT = path.join(REPO_ROOT, '.cache', 'gitleaks');
const DOWNLOAD_TIMEOUT_MS = 120_000;

async function download(url, what) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (cause) {
    throw new Error(
      `could not download the gitleaks ${what} from ${url}: ${cause.message}. ` +
        `A network or proxy problem will stop the secret scan; it is not skipped.`,
    );
  }
  if (!response.ok) {
    throw new Error(`could not download the gitleaks ${what}: ${url} returned ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Returns a path to a verified gitleaks binary, fetching it if the cache has
 * none. The archive is checked against the official checksums file BEFORE it
 * is opened, so nothing unverified is ever extracted or executed.
 */
async function ensureBinary(artifact) {
  const slotDir = path.join(CACHE_ROOT, artifact.slot);
  const binaryPath = path.join(slotDir, artifact.binary);
  if (existsSync(binaryPath) && reportsExpectedVersion(binaryPath)) return binaryPath;

  const checksums = (await download(artifact.checksumsUrl, 'checksums')).toString('utf8');
  const expected = findChecksum(checksums, artifact.name);

  const archive = await download(artifact.url, `${artifact.name} archive`);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${artifact.name}: expected ${expected}, got ${actual}. ` +
        `The download was not extracted or run. Delete ${CACHE_ROOT} and retry; ` +
        `if it keeps happening, do not work around it — the artifact is not what it claims to be.`,
    );
  }

  const binary = extract(archive, artifact.archive, artifact.binary);
  mkdirSync(slotDir, { recursive: true });
  // Written under a temporary name and moved into place, so a cancelled run
  // cannot leave a half-written binary that a later run would trust.
  const pending = `${binaryPath}.${process.pid}.pending`;
  writeFileSync(pending, binary);
  chmodSync(pending, 0o755);
  renameSync(pending, binaryPath);

  if (!reportsExpectedVersion(binaryPath)) {
    throw new Error(`the downloaded binary does not report gitleaks ${GITLEAKS_VERSION}`);
  }
  return binaryPath;
}

/** A cached binary is only reused if it really is the pinned version. */
function reportsExpectedVersion(binaryPath) {
  const result = spawnSync(binaryPath, ['version'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().includes(GITLEAKS_VERSION);
}

async function main() {
  const artifact = resolveArtifact(process.platform, process.arch);
  const binaryPath = await ensureBinary(artifact);
  const args = [...SCAN_ARGS, ...process.argv.slice(2)];
  const result = spawnSync(binaryPath, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.error) throw new Error(`could not run gitleaks: ${result.error.message}`);
  // Gitleaks exits 1 when it finds something: that is a failed scan, not an
  // error here, and the exit code is passed straight through.
  process.exit(result.status ?? 1);
}

// Only scan when run as a command. Importing this module (the tests do) must
// not start a scan or exit the process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const hint =
      error instanceof UnsupportedPlatformError
        ? '\nInstall gitleaks manually and run it as CI does: gitleaks git --no-banner --redact .'
        : '';
    // process.stderr rather than console, as the migration CLI does.
    process.stderr.write(`\nSecret scan failed: ${error.message}${hint}\n\n`);
    process.exit(1);
  });
}

export { CACHE_ROOT, ensureBinary };
