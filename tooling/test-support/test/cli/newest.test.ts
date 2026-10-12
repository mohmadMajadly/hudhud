import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { manifestEntry } from '../../src/cli/crosscheck.js';
import { CliFetchError } from '../../src/cli/errors.js';
import { fetchNewestCli, runPinSummary } from '../../src/cli/newest.js';
import type { FakeRegistry, Release } from './fake-registry.js';
import {
  SDK_LATEST,
  fakeRegistry,
  json,
  manifestFor,
  release,
  serve,
  serveSdk,
  versionDocument,
} from './fake-registry.js';

const HOST = process.platform;
const LATEST = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const SDK_DOC = 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.9.0';
const NOW = new Date('2026-10-12T03:00:00.000Z');

let root = '';
let registry: FakeRegistry;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-newest-'));
  registry = fakeRegistry();
  registry.routes.set(LATEST, json({ name: '@anthropic-ai/claude-code', version: '3.0.0' }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function newest(platform: string): ReturnType<typeof fetchNewestCli> {
  return fetchNewestCli({
    platform,
    cacheRoot: path.join(root, 'cache'),
    hostPlatform: HOST,
    registry: registry.options,
    now: () => NOW,
  });
}

async function expectNothingInstalled(): Promise<void> {
  const cache = path.join(root, 'cache');
  expect(await readdir(cache)).toEqual([]);
}

describe('fetchNewestCli', () => {
  it('records the integrity, cross-checks against the SDK manifest, verifies', async () => {
    const r = release('linux-x64', '3.0.0');
    serve(registry, r);
    const sdkTarball = serveSdk(registry, '0.9.0', '3.0.0', manifestFor('3.0.0', r));
    const { runPin, binary } = await newest('linux-x64');
    expect(registry.calls).toEqual([
      LATEST,
      r.documentUrl,
      SDK_LATEST,
      SDK_DOC,
      sdkTarball,
      r.tarballUrl,
    ]);
    expect(runPin).toEqual({
      package: r.pkg,
      version: '3.0.0',
      platform: 'linux-x64',
      file: 'claude',
      integrity: r.integrity,
      sha256: r.sha256,
      size: r.size,
      recordedAt: NOW.toISOString(),
      crossCheck: 'verified',
      crossCheckDetail: expect.stringContaining(
        '@anthropic-ai/claude-agent-sdk@0.9.0 manifest.json (SDK integrity sha512-',
      ) as string,
    });
    expect(binary).toMatchObject({ version: '3.0.0', sha256: r.sha256, cache: 'fetched' });
    expect(new Uint8Array(await readFile(binary.binaryPath))).toEqual(r.binary);
    // The SDK staging directory is gone; only the CLI cache remains.
    expect(await readdir(path.join(root, 'cache'))).toEqual(['3.0.0']);
  });

  it.each([
    ['another CLI version', '2.9.9', 'bundles CLI 2.9.9, not 3.0.0'],
    ['no claudeCodeVersion', undefined, 'bundles CLI unknown'],
    ['an invalid claudeCodeVersion', '../3.0.0', 'bundles CLI unknown'],
  ])(
    'records the cross-check as unavailable when the SDK latest has %s',
    async (_n, cc, detail) => {
      const r = release('win32-x64', '3.0.0');
      serve(registry, r);
      serveSdk(registry, '0.9.0', cc, manifestFor('3.0.0', r));
      const { runPin } = await newest('win32-x64');
      expect(runPin.crossCheck).toBe('unavailable');
      expect(runPin.crossCheckDetail).toContain(detail);
      expect(registry.calls).not.toContain(SDK_DOC);
    },
  );

  it('always fetches, even when the version is cached', async () => {
    const r = release('win32-x64', '3.0.0');
    serve(registry, r);
    serveSdk(registry, '0.9.0', '3.0.0', manifestFor('3.0.0', r));
    await newest('win32-x64');
    await newest('win32-x64');
    expect(registry.calls.filter((url) => url === r.tarballUrl)).toHaveLength(2);
  });

  it('fails closed when the binary differs from the SDK manifest', async () => {
    const r = release('linux-x64', '3.0.0');
    const other: Release = release('linux-x64', '3.0.0', 'what the SDK says');
    serve(registry, r);
    serveSdk(registry, '0.9.0', '3.0.0', manifestFor('3.0.0', { ...other, size: r.size }));
    await expect(newest('linux-x64')).rejects.toMatchObject({ code: 'binary-mismatch' });
    await expectNothingInstalled();
    serveSdk(registry, '0.9.0', '3.0.0', manifestFor('3.0.0', other));
    await expect(newest('linux-x64')).rejects.toMatchObject({ code: 'archive-refused' });
    await expectNothingInstalled();
  });

  it.each([
    ['manifest for another CLI version', manifestFor('3.0.1'), 'cross-check-failed'],
    ['manifest without the platform', manifestFor('3.0.0'), 'cross-check-failed'],
    ['manifest that is not JSON', '{', 'cross-check-failed'],
    ['no manifest at all', undefined, 'archive-refused'],
  ])('fails closed on an SDK %s', async (_n, manifest, code) => {
    const r = release('linux-x64', '3.0.0');
    serve(registry, r);
    serveSdk(registry, '0.9.0', '3.0.0', manifest);
    await expect(newest('linux-x64')).rejects.toMatchObject({ code });
    expect(registry.calls).not.toContain(r.tarballUrl);
    await expectNothingInstalled();
  });

  it('fails closed when the SDK tarball does not match its registry integrity', async () => {
    const r = release('linux-x64', '3.0.0');
    serve(registry, r);
    serveSdk(registry, '0.9.0', '3.0.0', manifestFor('3.0.0', r), (tgz) => tgz.subarray(1));
    await expect(newest('linux-x64')).rejects.toMatchObject({ code: 'integrity-mismatch' });
    await expectNothingInstalled();
  });

  it('fails closed when the SDK registry is unreachable', async () => {
    serve(registry, release('linux-x64', '3.0.0'));
    await expect(newest('linux-x64')).rejects.toMatchObject({ code: 'registry' });
  });

  it('fails closed when the tarball does not match the recorded integrity', async () => {
    const r = release('linux-x64', '3.0.0');
    const other = release('linux-x64', '3.0.0', 'swapped after the document was read');
    registry.routes.set(r.documentUrl, json(versionDocument(r)));
    serve(registry, { ...other, documentUrl: 'https://registry.npmjs.org/unused' });
    serveSdk(registry, '0.9.0', '2.0.0');
    await expect(newest('linux-x64')).rejects.toMatchObject({ code: 'integrity-mismatch' });
  });

  it('refuses an unsupported platform without network access', async () => {
    await expect(newest('freebsd-x64')).rejects.toMatchObject({ code: 'platform-unavailable' });
    expect(registry.calls).toEqual([]);
  });
});

describe('manifestEntry', () => {
  const good = { binary: 'claude', checksum: 'a'.repeat(64), size: 10 };

  it('returns the platform entry', () => {
    expect(
      manifestEntry(
        { version: '1.0.0', platforms: { 'linux-x64': good } },
        '1.0.0',
        'linux-x64',
        'claude',
        's',
      ),
    ).toEqual({ sha256: 'a'.repeat(64), size: 10 });
  });

  it.each([
    [null],
    [[]],
    [{ version: '1.0.0' }],
    [{ version: '1.0.0', platforms: [] }],
    [{ version: '1.0.0', platforms: { 'linux-x64': 'x' } }],
    [{ version: '1.0.0', platforms: { 'linux-x64': { ...good, binary: 'claude.exe' } } }],
    [{ version: '1.0.0', platforms: { 'linux-x64': { ...good, checksum: 5 } } }],
    [{ version: '1.0.0', platforms: { 'linux-x64': { ...good, checksum: 'XYZ' } } }],
    [{ version: '1.0.0', platforms: { 'linux-x64': { ...good, size: -1 } } }],
  ])('refuses %j', (manifest) => {
    expect(() => manifestEntry(manifest, '1.0.0', 'linux-x64', 'claude', 's')).toThrow(
      CliFetchError,
    );
  });
});

describe('runPinSummary', () => {
  it('renders the run-local pin and the cross-check for the job summary', () => {
    const summary = runPinSummary({
      package: '@anthropic-ai/claude-code-linux-x64',
      version: '3.0.0',
      platform: 'linux-x64',
      file: 'claude',
      integrity: 'sha512-x',
      sha256: 'ab',
      size: 5,
      recordedAt: NOW.toISOString(),
      crossCheck: 'unavailable',
      crossCheckDetail: 'no SDK yet',
    });
    expect(summary).toContain('### Newest Claude Code CLI: 3.0.0 (linux-x64)');
    expect(summary).toContain(
      '| Registry integrity (recorded 2026-10-12T03:00:00.000Z) | `sha512-x` |',
    );
    expect(summary).toContain('| Binary size | 5 |');
    expect(summary).toContain('| Cross-check | **unavailable**: no SDK yet |');
  });
});
