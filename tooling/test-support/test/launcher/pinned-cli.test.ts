import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CliFetchError } from '../../src/cli/errors.js';
import { SandboxRefusedError } from '../../src/launcher/errors.js';
import {
  defaultCacheRoot,
  HOST_FACTS,
  hostPlatformKey,
  isInside,
  probePinnedCli,
  recheckPinnedCli,
} from '../../src/launcher/pinned-cli.js';
import { FAKE_VERSION, makeFakeCli } from './fake-cli.js';
import type { FakeCli } from './fake-cli.js';

let fake: FakeCli;

beforeAll(async () => {
  fake = await makeFakeCli();
}, 120_000);

afterAll(async () => {
  await fake.dispose();
});

describe('locations', () => {
  it('defaults the cache root like pnpm cli:fetch', () => {
    const repo = path.resolve('/repo');
    expect(defaultCacheRoot(repo, {})).toBe(path.join(repo, '.cache', 'claude-cli'));
    expect(defaultCacheRoot(repo, { HUDHUD_CLI_CACHE: '' })).toBe(
      path.join(repo, '.cache', 'claude-cli'),
    );
    expect(defaultCacheRoot(repo, { HUDHUD_CLI_CACHE: 'c' })).toBe(path.join(repo, 'c'));
  });

  it('computes the host platform key', () => {
    const linux = {
      platform: 'linux' as const,
      arch: 'x64',
      report: () => ({ header: { glibcVersionRuntime: '2.36' } }),
    };
    expect(hostPlatformKey({}, linux)).toBe('linux-x64');
    expect(hostPlatformKey({}, { ...linux, report: () => ({ header: {} }) })).toBe(
      'linux-x64-musl',
    );
    expect(hostPlatformKey({ HUDHUD_CLI_LIBC: 'musl' }, linux)).toBe('linux-x64-musl');
    expect(hostPlatformKey({ HUDHUD_CLI_LIBC: 'glibc' }, { ...linux, report: () => ({}) })).toBe(
      'linux-x64',
    );
    expect(hostPlatformKey({}, { platform: 'win32', arch: 'x64', report: () => ({}) })).toBe(
      'win32-x64',
    );
    expect(hostPlatformKey({})).toMatch(/^(?:win32|linux|darwin)-/);
    expect(typeof HOST_FACTS.report()).toBe('object');
  });

  it('decides containment', () => {
    const root = path.resolve('/c');
    expect(isInside(root, path.join(root, 'a'))).toBe(true);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, path.resolve('/d'))).toBe(false);
    expect(isInside(root, path.resolve('/c/../c2/x'))).toBe(false);
  });
});

describe('resolvePinnedCli', () => {
  it('verifies the cached pinned binary and records its file identity', () => {
    expect(fake.cli.binaryPath.startsWith(fake.cacheRoot)).toBe(true);
    expect(fake.cli.cache).toBe('hit');
    expect(fake.cli.identity.size).toBe(BigInt(fake.cli.size));
    expect(() => {
      recheckPinnedCli(fake.cli);
    }).not.toThrow();
  });

  it('reads tooling/cli-pin.json and the default cache root of a repository', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'hudhud-repo-'));
    try {
      await mkdir(path.join(repo, 'tooling'));
      const { readFile } = await import('node:fs/promises');
      await writeFile(path.join(repo, 'tooling', 'cli-pin.json'), await readFile(fake.pinFile));
      const probe = await probePinnedCli({
        repoRoot: repo,
        env: {},
        hostPlatform: process.platform,
      });
      expect(probe).toEqual({
        available: false,
        reason: expect.stringMatching(/pnpm cli:fetch/) as unknown,
      });
      const viaEnv = await probePinnedCli({
        repoRoot: repo,
        env: { HUDHUD_CLI_CACHE: fake.cacheRoot },
        platformKey: fake.platformKey,
      });
      expect(viaEnv.available).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it('reports a platform pending the macOS gate as unavailable, naming the gate', async () => {
    const pinFile = path.join(fake.root, 'pending-pin.json');
    await writeFile(
      pinFile,
      JSON.stringify({
        version: FAKE_VERSION,
        platforms: {
          'darwin-arm64': {
            package: '@anthropic-ai/claude-code-darwin-arm64',
            file: 'claude',
            pendingGate: true,
          },
        },
      }),
    );
    await expect(
      probePinnedCli({ repoRoot: fake.root, env: {}, pinFile, platformKey: 'darwin-arm64' }),
    ).resolves.toEqual({
      available: false,
      reason: expect.stringMatching(/darwin-arm64 is pending the macOS gate \(ADR-0014/) as unknown,
    });
  });

  it('rethrows failures other than a missing cache', async () => {
    await expect(
      probePinnedCli({
        repoRoot: fake.root,
        env: {},
        pinFile: path.join(fake.root, 'missing.json'),
      }),
    ).rejects.toThrow(/ENOENT|no such file/);
    await writeFile(path.join(fake.root, 'bad-pin.json'), '{}');
    await expect(
      probePinnedCli({
        repoRoot: fake.root,
        env: {},
        pinFile: path.join(fake.root, 'bad-pin.json'),
      }),
    ).rejects.toBeInstanceOf(CliFetchError);
    // A valid pin without an entry for the platform is not a cache problem either.
    await expect(
      probePinnedCli({ repoRoot: fake.root, env: {}, pinFile: fake.pinFile, platformKey: 'aix' }),
    ).rejects.toMatchObject({ code: 'platform-unavailable' });
  });
});

describe('recheckPinnedCli', () => {
  it('refuses a binary outside its cache root', () => {
    expect(() => {
      recheckPinnedCli({ ...fake.cli, cacheRoot: path.join(fake.root, 'other') });
    }).toThrow(SandboxRefusedError);
  });

  it('refuses a binary that is gone', () => {
    expect(() => {
      recheckPinnedCli({ ...fake.cli, binaryPath: path.join(fake.cacheRoot, 'gone', 'claude') });
    }).toThrow(/gone since verification/);
  });

  it('refuses a binary whose identity changed', async () => {
    expect(() => {
      recheckPinnedCli({ ...fake.cli, identity: { ...fake.cli.identity, size: 1n } });
    }).toThrow(/changed since verification/);
    expect(() => {
      recheckPinnedCli({
        ...fake.cli,
        identity: { ...fake.cli.identity, dev: fake.cli.identity.dev + 1n },
      });
    }).toThrow(/changed/);
    expect(() => {
      recheckPinnedCli({
        ...fake.cli,
        identity: { ...fake.cli.identity, ino: fake.cli.identity.ino + 1n },
      });
    }).toThrow(/changed/);
    const dir = path.dirname(fake.cli.binaryPath);
    expect(() => {
      recheckPinnedCli({ ...fake.cli, binaryPath: dir });
    }).toThrow(/changed/);
    const later = new Date(Date.now() + 60_000);
    await utimes(fake.cli.binaryPath, later, later);
    expect(() => {
      recheckPinnedCli(fake.cli);
    }).toThrow(/changed/);
  });
});
