// Real-CLI runs are refused on a local macOS host (W3-Z ruling 10, research
// 09): GitHub-hosted runners only, unless the developer opts in. The
// launcher keys the refusal on what would run (default deny: only the
// stand-in CLI, a copy of the running Node.js binary, passes), and reads
// the host markers from the real process environment.

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SandboxRefusedError } from '../../src/launcher/errors.js';
import {
  assertRealCliHostAllowed,
  LOCAL_MACOS_OPT_IN,
  realCliHostRefusal,
} from '../../src/launcher/host-policy.js';
import { probePinnedCli, resolvePinnedCli } from '../../src/launcher/pinned-cli.js';
import { makeFakeCli } from './fake-cli.js';
import type { FakeCli } from './fake-cli.js';

const REPO = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const GITHUB_HOSTED = { CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };

/**
 * Runs `body` with `process.platform` reading `platform` (the real-platform
 * read of the policy), restored afterwards. Test-only seam.
 */
async function onRealPlatform(
  platform: NodeJS.Platform,
  body: () => void | Promise<void>,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    await body();
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original);
  }
}

describe('realCliHostRefusal', () => {
  it('allows every non-macOS host', async () => {
    await onRealPlatform('linux', () => {
      for (const platform of ['linux', 'win32', 'freebsd'] as const) {
        expect(realCliHostRefusal(platform, {})).toBeUndefined();
      }
      expect(() => {
        assertRealCliHostAllowed('linux', {});
      }).not.toThrow();
    });
  });

  it('never lets an injected platform claim non-macOS on a real Mac (seam only stricter)', async () => {
    await onRealPlatform('darwin', async () => {
      for (const platform of ['linux', 'win32'] as const) {
        expect(realCliHostRefusal(platform, {})).toMatch(/local macOS host/);
        expect(realCliHostRefusal(platform, GITHUB_HOSTED)).toBeUndefined();
        expect(realCliHostRefusal(platform, { [LOCAL_MACOS_OPT_IN]: '1' })).toBeUndefined();
      }
      vi.stubEnv('CI', '');
      vi.stubEnv('RUNNER_ENVIRONMENT', '');
      vi.stubEnv(LOCAL_MACOS_OPT_IN, '');
      try {
        await expect(
          resolvePinnedCli({
            repoRoot: REPO,
            env: {},
            hostPlatform: 'linux',
            platformKey: 'linux-x64',
            cacheRoot: path.join(REPO, 'no-such-cache'),
          }),
        ).rejects.toMatchObject({ code: 'host' });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('allows macOS on a GitHub-hosted runner only', () => {
    expect(realCliHostRefusal('darwin', GITHUB_HOSTED)).toBeUndefined();
    for (const env of [
      {},
      { CI: 'true' },
      { RUNNER_ENVIRONMENT: 'github-hosted' },
      { CI: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
      { CI: '1', RUNNER_ENVIRONMENT: 'github-hosted' },
    ]) {
      expect(realCliHostRefusal('darwin', env)).toMatch(/local macOS host.*security\(1\)/s);
    }
  });

  it('allows a local Mac only with the explicit opt-in', () => {
    expect(LOCAL_MACOS_OPT_IN).toBe('HUDHUD_ALLOW_LOCAL_MACOS_REAL_CLI');
    expect(realCliHostRefusal('darwin', { [LOCAL_MACOS_OPT_IN]: '1' })).toBeUndefined();
    for (const value of ['', '0', 'true', 'yes']) {
      expect(realCliHostRefusal('darwin', { [LOCAL_MACOS_OPT_IN]: value })).toBeDefined();
    }
  });

  it('names the opt-in in the refusal', () => {
    const error: unknown = (() => {
      try {
        assertRealCliHostAllowed('darwin', {});
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(SandboxRefusedError);
    expect((error as SandboxRefusedError).code).toBe('host');
    expect((error as SandboxRefusedError).message).toContain(`${LOCAL_MACOS_OPT_IN}=1`);
  });
});

describe('the launcher refuses the real pinned CLI on a local Mac (keyed on what runs)', () => {
  let fake: FakeCli;
  let dir = '';

  beforeAll(async () => {
    fake = await makeFakeCli();
    dir = await mkdtemp(path.join(tmpdir(), 'hudhud-pin-copy-'));
  }, 120_000);

  afterAll(async () => {
    await fake.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A local Mac: no host marker in the real process environment. */
  function localHost(): void {
    vi.stubEnv('CI', '');
    vi.stubEnv('RUNNER_ENVIRONMENT', '');
    vi.stubEnv(LOCAL_MACOS_OPT_IN, '');
  }

  const real = {
    repoRoot: REPO,
    env: {},
    hostPlatform: 'darwin' as const,
    platformKey: 'linux-x64',
    cacheRoot: path.join(REPO, 'no-such-cache'),
  };

  it('refuses the repository pin before the cache is read', async () => {
    localHost();
    await expect(resolvePinnedCli(real)).rejects.toMatchObject({ code: 'host' });
    await expect(probePinnedCli(real)).rejects.toMatchObject({ code: 'host' });
    // A pending entry (no digest yet) is presumed real as well.
    await expect(resolvePinnedCli({ ...real, platformKey: 'darwin-arm64' })).rejects.toMatchObject({
      code: 'host',
    });
    // So is a platform the pin does not list.
    await expect(resolvePinnedCli({ ...real, platformKey: 'linux-arm64' })).rejects.toMatchObject({
      code: 'host',
    });
    // The probe still reports a pending pin first.
    await expect(probePinnedCli({ ...real, platformKey: 'darwin-arm64' })).resolves.toEqual({
      available: false,
      reason: expect.stringContaining('pending the macOS gate') as unknown,
    });
  });

  it('refuses a copy of the real pin at another path (no path key to bypass)', async () => {
    localHost();
    const copy = path.join(dir, 'cli-pin.json');
    await copyFile(path.join(REPO, 'tooling', 'cli-pin.json'), copy);
    await expect(resolvePinnedCli({ ...real, repoRoot: dir, pinFile: copy })).rejects.toMatchObject(
      { code: 'host' },
    );
  });

  it('reads the host markers from the real environment, never from the caller env', async () => {
    localHost();
    await expect(
      resolvePinnedCli({ ...real, env: { ...GITHUB_HOSTED, [LOCAL_MACOS_OPT_IN]: '1' } }),
    ).rejects.toMatchObject({ code: 'host' });
  });

  it('lets a GitHub-hosted runner and the opt-in through to the cache check', async () => {
    for (const markers of [GITHUB_HOSTED, { [LOCAL_MACOS_OPT_IN]: '1' }]) {
      localHost();
      for (const [name, value] of Object.entries(markers)) vi.stubEnv(name, value);
      await expect(probePinnedCli(real)).resolves.toMatchObject({
        available: false,
        reason: expect.stringContaining('cli:fetch') as unknown,
      });
      vi.unstubAllEnvs();
    }
  });

  it('allows the stand-in CLI, a copy of the running Node.js binary', async () => {
    localHost();
    const error: unknown = await resolvePinnedCli({
      repoRoot: fake.root,
      env: {},
      cacheRoot: fake.cacheRoot,
      pinFile: fake.pinFile,
      platformKey: fake.platformKey,
      hostPlatform: 'darwin',
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // Whatever the darwin cache checks say on this host, it is not the host refusal.
    expect(error instanceof SandboxRefusedError && error.code === 'host').toBe(false);
  });
});
