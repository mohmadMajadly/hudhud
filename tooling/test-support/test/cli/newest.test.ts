import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchNewestCli, runPinSummary } from '../../src/cli/newest.js';
import type { FakeRegistry } from './fake-registry.js';
import { fakeRegistry, json, release, serve, versionDocument } from './fake-registry.js';

const HOST = process.platform;
const LATEST = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const NOW = new Date('2026-10-12T03:00:00.000Z');

let root = '';
let registry: FakeRegistry;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-newest-'));
  registry = fakeRegistry();
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

describe('fetchNewestCli', () => {
  it('records the registry integrity first and verifies the tarball against it', async () => {
    const r = release('linux-x64', '3.0.0');
    registry.routes.set(LATEST, json({ name: '@anthropic-ai/claude-code', version: '3.0.0' }));
    serve(registry, r);
    const { runPin, binary } = await newest('linux-x64');
    expect(registry.calls).toEqual([LATEST, r.documentUrl, r.tarballUrl]);
    expect(runPin).toEqual({
      package: r.pkg,
      version: '3.0.0',
      platform: 'linux-x64',
      file: 'claude',
      integrity: r.integrity,
      sha256: r.sha256,
      size: r.size,
      recordedAt: NOW.toISOString(),
    });
    expect(binary).toMatchObject({ version: '3.0.0', sha256: r.sha256, cache: 'fetched' });
    expect(new Uint8Array(await readFile(binary.binaryPath))).toEqual(r.binary);
  });

  it('always fetches, even when the version is cached', async () => {
    const r = release('win32-x64', '3.0.0');
    registry.routes.set(LATEST, json({ name: '@anthropic-ai/claude-code', version: '3.0.0' }));
    serve(registry, r);
    await newest('win32-x64');
    await newest('win32-x64');
    expect(registry.calls.filter((url) => url === r.tarballUrl)).toHaveLength(2);
  });

  it('fails closed when the tarball does not match the recorded integrity', async () => {
    const r = release('linux-x64', '3.0.0');
    const other = release('linux-x64', '3.0.0', 'swapped after the document was read');
    registry.routes.set(LATEST, json({ name: '@anthropic-ai/claude-code', version: '3.0.0' }));
    registry.routes.set(r.documentUrl, json(versionDocument(r)));
    serve(registry, { ...other, documentUrl: 'https://registry.npmjs.org/unused' });
    await expect(newest('linux-x64')).rejects.toMatchObject({ code: 'integrity-mismatch' });
  });

  it('refuses an unsupported platform without network access', async () => {
    await expect(newest('freebsd-x64')).rejects.toMatchObject({ code: 'platform-unavailable' });
    expect(registry.calls).toEqual([]);
  });
});

describe('runPinSummary', () => {
  it('renders the run-local pin for the job summary', () => {
    const summary = runPinSummary({
      package: '@anthropic-ai/claude-code-linux-x64',
      version: '3.0.0',
      platform: 'linux-x64',
      file: 'claude',
      integrity: 'sha512-x',
      sha256: 'ab',
      size: 5,
      recordedAt: NOW.toISOString(),
    });
    expect(summary).toContain('### Newest Claude Code CLI: 3.0.0 (linux-x64)');
    expect(summary).toContain(
      '| Registry integrity (recorded 2026-10-12T03:00:00.000Z) | `sha512-x` |',
    );
    expect(summary).toContain('| Binary size | 5 |');
  });
});
