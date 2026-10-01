/**
 * The runner's platform and integrity decisions, for every platform the
 * project supports — including the ones this machine is not. Actually running
 * gitleaks on macOS or Linux is not possible here, so the artifact names, the
 * cache layout and the checksum selection are pinned by test instead.
 */
import { describe, expect, it } from 'vitest';
import {
  GITLEAKS_VERSION,
  SCAN_ARGS,
  UnsupportedPlatformError,
  findChecksum,
  resolveArtifact,
} from './resolve.mjs';

describe('gitleaks version and scan parity with CI', () => {
  it('is pinned to the version CI downloads', () => {
    expect(GITLEAKS_VERSION).toBe('8.30.1');
  });

  it('runs exactly the scan CI runs', () => {
    // CI: gitleaks git --no-banner --redact .
    expect(SCAN_ARGS).toEqual(['git', '--no-banner', '--redact', '.']);
  });

  it('scans history rather than only the working tree', () => {
    // A secret removed in a later commit is still in the repository.
    expect(SCAN_ARGS[0]).toBe('git');
  });

  it('passes no --config, so the repository .gitleaksignore is used as CI uses it', () => {
    expect(SCAN_ARGS).not.toContain('--config');
  });
});

describe('release artifact for each supported platform', () => {
  const cases = [
    [
      'win32',
      'x64',
      'gitleaks_8.30.1_windows_x64.zip',
      'zip',
      'gitleaks.exe',
      '8.30.1/windows-x64',
    ],
    [
      'win32',
      'arm64',
      'gitleaks_8.30.1_windows_arm64.zip',
      'zip',
      'gitleaks.exe',
      '8.30.1/windows-arm64',
    ],
    [
      'win32',
      'ia32',
      'gitleaks_8.30.1_windows_x32.zip',
      'zip',
      'gitleaks.exe',
      '8.30.1/windows-x32',
    ],
    [
      'darwin',
      'arm64',
      'gitleaks_8.30.1_darwin_arm64.tar.gz',
      'tar.gz',
      'gitleaks',
      '8.30.1/darwin-arm64',
    ],
    [
      'darwin',
      'x64',
      'gitleaks_8.30.1_darwin_x64.tar.gz',
      'tar.gz',
      'gitleaks',
      '8.30.1/darwin-x64',
    ],
    ['linux', 'x64', 'gitleaks_8.30.1_linux_x64.tar.gz', 'tar.gz', 'gitleaks', '8.30.1/linux-x64'],
    [
      'linux',
      'arm64',
      'gitleaks_8.30.1_linux_arm64.tar.gz',
      'tar.gz',
      'gitleaks',
      '8.30.1/linux-arm64',
    ],
    [
      'linux',
      'arm',
      'gitleaks_8.30.1_linux_armv7.tar.gz',
      'tar.gz',
      'gitleaks',
      '8.30.1/linux-armv7',
    ],
  ];

  it.each(cases)('%s/%s resolves to %s', (platform, arch, name, archive, binary, slot) => {
    const artifact = resolveArtifact(platform, arch);
    expect(artifact.name).toBe(name);
    expect(artifact.archive).toBe(archive);
    expect(artifact.binary).toBe(binary);
    // The cache is keyed by version, platform and architecture together.
    expect(artifact.slot).toBe(slot);
    expect(artifact.url).toBe(
      `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/${name}`,
    );
    expect(artifact.checksumsUrl).toContain('gitleaks_8.30.1_checksums.txt');
  });

  it('gives every platform a distinct cache slot', () => {
    const slots = cases.map(([platform, arch]) => resolveArtifact(platform, arch).slot);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('refuses an unsupported platform rather than skipping the scan', () => {
    expect(() => resolveArtifact('aix', 'x64')).toThrow(UnsupportedPlatformError);
    expect(() => resolveArtifact('aix', 'x64')).toThrow(/not published for platform "aix"/);
  });

  it('refuses an unsupported architecture, and says what is supported', () => {
    expect(() => resolveArtifact('darwin', 'ia32')).toThrow(UnsupportedPlatformError);
    expect(() => resolveArtifact('darwin', 'ia32')).toThrow(/darwin\/ia32/);
    expect(() => resolveArtifact('darwin', 'ia32')).toThrow(/x64, arm64/);
  });
});

describe('checksum selection', () => {
  // The shape of the official gitleaks_8.30.1_checksums.txt.
  const CHECKSUMS = [
    'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5  gitleaks_8.30.1_darwin_arm64.tar.gz',
    '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  gitleaks_8.30.1_linux_x64.tar.gz',
    'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e  gitleaks_8.30.1_windows_x64.zip',
  ].join('\n');

  it('takes the line for the exact artifact, not merely a matching platform', () => {
    expect(findChecksum(CHECKSUMS, 'gitleaks_8.30.1_windows_x64.zip')).toBe(
      'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e',
    );
    expect(findChecksum(CHECKSUMS, 'gitleaks_8.30.1_linux_x64.tar.gz')).toBe(
      '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    );
  });

  it('fails when the artifact has no published checksum', () => {
    expect(() => findChecksum(CHECKSUMS, 'gitleaks_8.30.1_linux_armv6.tar.gz')).toThrow(
      /no checksum published/,
    );
  });

  it('fails on a digest that is not a SHA-256', () => {
    expect(() =>
      findChecksum(
        'deadbeef  gitleaks_8.30.1_linux_x64.tar.gz',
        'gitleaks_8.30.1_linux_x64.tar.gz',
      ),
    ).toThrow(/not a SHA-256/);
  });

  it('tolerates blank lines and trailing whitespace', () => {
    expect(findChecksum(`\n${CHECKSUMS}\n\n`, 'gitleaks_8.30.1_linux_x64.tar.gz')).toBe(
      '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    );
  });
});
