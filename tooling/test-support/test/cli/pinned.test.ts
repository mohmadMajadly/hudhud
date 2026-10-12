import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePin } from '../../src/cli/pin.js';
import type { CliPin } from '../../src/cli/pin.js';
import { ensurePinnedCli, verifyPinnedCli } from '../../src/cli/pinned.js';
import type { FakeRegistry, Release } from './fake-registry.js';
import {
  fakeRegistry,
  json,
  pinDocument,
  release,
  serve,
  versionDocument,
} from './fake-registry.js';
import { archive, bytes, entry, gzip, sri } from './tar-builder.js';

const HOST = process.platform;
const SRC = path.resolve(import.meta.dirname, '../../src/cli');

let root = '';
let cacheRoot = '';
let registry: FakeRegistry;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-pinned-'));
  cacheRoot = path.join(root, 'cache');
  registry = fakeRegistry();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function pinFor(r: Release, overrides: Record<string, unknown> = {}): CliPin {
  const doc = pinDocument(r) as {
    version: string;
    platforms: Record<string, Record<string, unknown>>;
  };
  const entryDoc = doc.platforms[r.platform] ?? {};
  return parsePin(
    { ...doc, platforms: { [r.platform]: { ...entryDoc, ...overrides } } },
    'test pin',
  );
}

function ensure(pin: CliPin, platform: string): ReturnType<typeof ensurePinnedCli> {
  return ensurePinnedCli({
    pin,
    platform,
    cacheRoot,
    hostPlatform: HOST,
    registry: registry.options,
  });
}

async function expectNothingInstalled(r: Release): Promise<void> {
  // No staging directory survives and no binary is left in the cache.
  expect(await readdir(cacheRoot)).toEqual(
    expect.not.arrayContaining([expect.stringMatching(/^\.staging-/)]),
  );
  await expect(
    verifyPinnedCli({ pin: pinFor(r), platform: r.platform, cacheRoot, hostPlatform: HOST }),
  ).rejects.toMatchObject({
    code: 'cache-invalid',
  });
}

describe('ensurePinnedCli', () => {
  it.each(['linux-x64', 'win32-x64'])('fetches, verifies and caches %s', async (platform) => {
    const r = release(platform, '9.9.9');
    serve(registry, r);
    const pin = pinFor(r);
    const fetched = await ensure(pin, platform);
    expect(fetched).toEqual({
      binaryPath: path.join(cacheRoot, '9.9.9', platform, r.file),
      version: '9.9.9',
      platform,
      integrity: r.integrity,
      sha256: r.sha256,
      size: r.size,
      cache: 'fetched',
    });
    expect(registry.calls).toEqual([r.documentUrl, r.tarballUrl]);
    expect(new Uint8Array(await readFile(fetched.binaryPath))).toEqual(r.binary);
    expect(await readdir(cacheRoot)).toEqual(['9.9.9']);
    expect((await readdir(path.join(cacheRoot, '9.9.9', platform))).sort()).toEqual(
      [r.file, 'verified.json'].sort(),
    );

    // Second use: re-verified from the cache, no network.
    const again = await ensure(pin, platform);
    expect(again.cache).toBe('hit');
    expect(registry.calls).toHaveLength(2);
    expect(await verifyPinnedCli({ pin, platform, cacheRoot, hostPlatform: HOST })).toEqual(again);
  });

  it('refetches a tampered cached binary', async () => {
    const r = release('linux-x64', '9.9.9');
    serve(registry, r);
    const pin = pinFor(r);
    const first = await ensure(pin, 'linux-x64');
    await writeFile(first.binaryPath, new Uint8Array(r.size));
    const second = await ensure(pin, 'linux-x64');
    expect(second.cache).toBe('fetched');
    expect(new Uint8Array(await readFile(second.binaryPath))).toEqual(r.binary);
  });

  it('refuses when the registry states another integrity than the pin, before downloading', async () => {
    const r = release('linux-x64', '9.9.9');
    const other = release('linux-x64', '9.9.9', 'republished');
    registry.routes.set(r.documentUrl, json(versionDocument(other)));
    await expect(ensure(pinFor(r), 'linux-x64')).rejects.toMatchObject({
      code: 'integrity-mismatch',
    });
    expect(registry.calls).toEqual([r.documentUrl]);
  });

  it('fails closed on a corrupted download', async () => {
    const r = release('linux-x64', '9.9.9');
    const corrupted = r.tgz.slice();
    corrupted[corrupted.length - 10] = (corrupted[corrupted.length - 10] ?? 0) ^ 0xff;
    serve(registry, r, corrupted);
    await expect(ensure(pinFor(r), 'linux-x64')).rejects.toMatchObject({
      code: 'integrity-mismatch',
    });
    await expectNothingInstalled(r);
  });

  it('fails closed on a truncated download', async () => {
    const r = release('linux-x64', '9.9.9');
    serve(registry, r, r.tgz.subarray(0, r.tgz.byteLength - 100));
    await expect(ensure(pinFor(r), 'linux-x64')).rejects.toMatchObject({
      code: 'integrity-mismatch',
    });
    await expectNothingInstalled(r);
  });

  it('refuses a binary whose sha256 differs from the pin', async () => {
    const r = release('linux-x64', '9.9.9');
    serve(registry, r);
    const pin = pinFor(r, { sha256: 'b'.repeat(64) });
    await expect(ensure(pin, 'linux-x64')).rejects.toMatchObject({ code: 'binary-mismatch' });
    await expectNothingInstalled(r);
  });

  it('refuses a binary whose size differs from the pin', async () => {
    const r = release('linux-x64', '9.9.9');
    serve(registry, r);
    await expect(ensure(pinFor(r, { size: r.size + 1 }), 'linux-x64')).rejects.toMatchObject({
      code: 'archive-refused',
    });
  });

  it('refuses a pinned tarball that is not gzip or holds a refused entry', async () => {
    // A pin (and registry) whose integrity matches a hostile tarball: the
    // archive checks still stop it.
    const r = release('linux-x64', '9.9.9');
    const hostile = (tgz: Uint8Array): Release => ({ ...r, tgz, integrity: sri(tgz) });
    const notGzip = bytes('this is not a gzip stream');
    serve(registry, hostile(notGzip));
    await expect(ensure(pinFor(r, { integrity: sri(notGzip) }), 'linux-x64')).rejects.toMatchObject(
      { code: 'archive-refused' },
    );

    const evil = gzip(
      archive(
        entry({ name: '../../escape', body: bytes('x') }),
        entry({ name: 'package/claude', body: r.binary }),
      ),
    );
    serve(registry, hostile(evil));
    await expect(ensure(pinFor(r, { integrity: sri(evil) }), 'linux-x64')).rejects.toThrow(
      /traversal/,
    );
    await expectNothingInstalled(r);
  });

  it('refuses pending and unknown platforms without network access', async () => {
    const pin = parsePin(
      {
        version: '9.9.9',
        platforms: {
          'darwin-arm64': {
            package: '@anthropic-ai/claude-code-darwin-arm64',
            file: 'claude',
            pendingGate: true,
          },
        },
      },
      'pin',
    );
    await expect(ensure(pin, 'darwin-arm64')).rejects.toMatchObject({
      code: 'platform-unavailable',
    });
    await expect(ensure(pin, 'linux-x64')).rejects.toMatchObject({ code: 'platform-unavailable' });
    expect(registry.calls).toEqual([]);
  });
});

describe('verifyPinnedCli', () => {
  it('refuses a missing cache without network access', async () => {
    const r = release('linux-x64', '9.9.9');
    await expect(
      verifyPinnedCli({ pin: pinFor(r), platform: 'linux-x64', cacheRoot, hostPlatform: HOST }),
    ).rejects.toMatchObject({ code: 'cache-invalid' });
  });
});

describe('never executes the binary', () => {
  it('src/cli imports no process, worker or VM APIs', async () => {
    const files = (await readdir(SRC)).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = await readFile(path.join(SRC, file), 'utf8');
      expect(text, file).not.toMatch(
        /child_process|worker_threads|node:vm|node:cluster|process\.dlopen|\bexecFile\b|\bspawn\(/,
      );
    }
  });
});
