/**
 * Proves the scan can actually fail.
 *
 * A secret scan that always passes is indistinguishable from one that does
 * nothing, so this plants a fake credential and checks that the same binary,
 * with the same arguments, reports it and exits non-zero.
 *
 * The fixture is committed to a THROWAWAY repository in the system temp
 * directory, never to this one: the scan reads git history, so a secret
 * committed here — even if reverted immediately — would be a permanent finding
 * for every future run. The temporary repository is removed afterwards.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCAN_ARGS, resolveArtifact } from './resolve.mjs';
import { ensureBinary } from './scan.mjs';

/**
 * Generated at run time, never written down here.
 *
 * The rule that catches this kind of value keys on entropy, so the fixture has
 * to be genuinely random — and a genuinely random 64-hex string committed to
 * THIS file would itself be flagged for ever after, which is the trap this
 * test exists to prove we can detect. Generating it per run keeps the
 * repository clean and still exercises the rule: it is random data, never a
 * credential for anything.
 */
const FAKE_SECRET = randomBytes(32).toString('hex');

describe('gitleaks detects a planted secret', () => {
  let binaryPath;
  let repo;

  beforeAll(async () => {
    // The same acquisition path `pnpm secrets:scan` uses: same pinned version,
    // same verified binary, same cache.
    binaryPath = await ensureBinary(resolveArtifact(process.platform, process.arch));
    repo = mkdtempSync(path.join(tmpdir(), 'hv-gitleaks-control-'));
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    };
    git('init', '--quiet');
    git('config', 'user.email', 'control@example.invalid');
    git('config', 'user.name', 'negative control');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, '.env.example'), `API_KEY=${FAKE_SECRET}\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', 'plant a fake credential');
  }, 180_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const scan = (extraArgs = []) =>
    spawnSync(binaryPath, [...SCAN_ARGS, ...extraArgs], { cwd: repo, encoding: 'utf8' });

  it('exits non-zero when a secret is committed', () => {
    const result = scan();
    expect(result.status).not.toBe(0);
  });

  it('reports the finding, and redacts the secret out of its own output', () => {
    const result = scan();
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/leaks found/i);
    // --redact is why a leak never reaches a terminal or a CI log in clear.
    expect(output).not.toContain(FAKE_SECRET);
  });

  it('exits zero once the secret is not in the history', () => {
    // Same binary, same arguments, on a repository without the fixture: the
    // failure above is the secret, not the setup.
    const clean = mkdtempSync(path.join(tmpdir(), 'hv-gitleaks-clean-'));
    try {
      const git = (...args) => spawnSync('git', args, { cwd: clean, encoding: 'utf8' });
      git('init', '--quiet');
      git('config', 'user.email', 'control@example.invalid');
      git('config', 'user.name', 'negative control');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(path.join(clean, 'README.md'), 'nothing secret here\n');
      git('add', '-A');
      git('commit', '--quiet', '-m', 'no secrets');

      const result = spawnSync(binaryPath, SCAN_ARGS, { cwd: clean, encoding: 'utf8' });
      expect(result.status).toBe(0);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});
