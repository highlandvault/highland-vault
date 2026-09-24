/**
 * The decisions the gitleaks runner makes before it touches the network or the
 * disk: which release artifact this machine needs, where it belongs in the
 * cache, and which checksum it must match.
 *
 * Kept separate from the side effects so it can be unit-tested for every
 * platform, including the ones this repository is not developed on.
 */

/** Pinned to the version CI uses. Changing it here alone would break parity. */
export const GITLEAKS_VERSION = '8.30.1';

/**
 * The scan CI runs, split into arguments.
 *
 * `git` scans every commit, not just the working tree, which is the whole
 * point: a secret removed in a later commit is still a leak. `--redact` keeps
 * the finding out of the output, so a leak is never printed to a terminal or a
 * CI log. There is no `--config`, so gitleaks uses its default rules and picks
 * up `.gitleaksignore` from the repository root by itself.
 */
export const SCAN_ARGS = ['git', '--no-banner', '--redact', '.'];

/** `process.arch` values that map to a published artifact, per platform. */
const ARCHITECTURES = {
  win32: { x64: 'x64', arm64: 'arm64', ia32: 'x32' },
  darwin: { x64: 'x64', arm64: 'arm64' },
  linux: { x64: 'x64', arm64: 'arm64', ia32: 'x32', arm: 'armv7' },
};

const PLATFORMS = {
  win32: { release: 'windows', archive: 'zip', binary: 'gitleaks.exe' },
  darwin: { release: 'darwin', archive: 'tar.gz', binary: 'gitleaks' },
  linux: { release: 'linux', archive: 'tar.gz', binary: 'gitleaks' },
};

export class UnsupportedPlatformError extends Error {}

/**
 * Describes the artifact for a platform and architecture.
 *
 * Throws rather than guessing: running the wrong binary, or silently skipping
 * the scan on a machine nobody anticipated, are both worse than stopping.
 */
export function resolveArtifact(platform, arch, version = GITLEAKS_VERSION) {
  const target = PLATFORMS[platform];
  if (!target) {
    throw new UnsupportedPlatformError(
      `gitleaks ${version} is not published for platform "${platform}". ` +
        `Supported: ${Object.keys(PLATFORMS).join(', ')}.`,
    );
  }
  const releaseArch = ARCHITECTURES[platform][arch];
  if (!releaseArch) {
    throw new UnsupportedPlatformError(
      `gitleaks ${version} is not published for ${platform}/${arch}. ` +
        `Supported on ${platform}: ${Object.keys(ARCHITECTURES[platform]).join(', ')}.`,
    );
  }
  const name = `gitleaks_${version}_${target.release}_${releaseArch}.${target.archive}`;
  return {
    name,
    archive: target.archive,
    binary: target.binary,
    /** Cache key: version, platform and architecture, so none can be confused. */
    slot: `${version}/${target.release}-${releaseArch}`,
    url: `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${name}`,
    checksumsUrl: `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_checksums.txt`,
  };
}

/**
 * Finds an artifact's SHA-256 in the official checksums file.
 *
 * Matching the exact file name matters: the file lists every platform, and
 * taking the wrong line would verify the wrong artifact perfectly happily.
 */
export function findChecksum(checksumsText, artifactName) {
  for (const line of checksumsText.split('\n')) {
    const [digest, name] = line.trim().split(/\s+/);
    if (name === artifactName) {
      if (!/^[0-9a-f]{64}$/.test(digest ?? '')) {
        throw new Error(`checksum for ${artifactName} is not a SHA-256 digest`);
      }
      return digest;
    }
  }
  throw new Error(`no checksum published for ${artifactName}`);
}
