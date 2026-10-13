// Real-CLI runs are refused on a local macOS host (W3-Z ruling 10, research
// 09): GitHub-hosted runners only, unless the developer opts in.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SandboxRefusedError } from '../../src/launcher/errors.js';
import {
  assertRealCliHostAllowed,
  LOCAL_MACOS_OPT_IN,
  realCliHostRefusal,
} from '../../src/launcher/host-policy.js';
import { probePinnedCli, resolvePinnedCli } from '../../src/launcher/pinned-cli.js';

const REPO = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const GITHUB_HOSTED = { CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };

describe('realCliHostRefusal', () => {
  it('allows every non-macOS host', () => {
    for (const platform of ['linux', 'win32', 'freebsd'] as const) {
      expect(realCliHostRefusal(platform, {})).toBeUndefined();
    }
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
    expect(() => {
      assertRealCliHostAllowed('linux', {});
    }).not.toThrow();
  });
});

describe('the launcher refuses the real pinned CLI on a local Mac', () => {
  it('before reading the pin or the cache', async () => {
    const options = {
      repoRoot: REPO,
      env: {},
      hostPlatform: 'darwin' as const,
      cacheRoot: path.join(REPO, 'no-such-cache'),
    };
    await expect(resolvePinnedCli(options)).rejects.toMatchObject({ code: 'host' });
    // The probe reports a pending darwin pin first (no digests yet); once a
    // platform has digests, the probe refuses like resolvePinnedCli.
    await expect(probePinnedCli({ ...options, platformKey: 'linux-x64' })).rejects.toMatchObject({
      code: 'host',
    });
    await expect(probePinnedCli({ ...options, platformKey: 'darwin-arm64' })).resolves.toEqual({
      available: false,
      reason: expect.stringContaining('pending the macOS gate') as unknown,
    });
  });

  it('lets a GitHub-hosted runner and the opt-in through to the cache check', async () => {
    for (const env of [GITHUB_HOSTED, { [LOCAL_MACOS_OPT_IN]: '1' }]) {
      const probe = await probePinnedCli({
        repoRoot: REPO,
        env,
        hostPlatform: 'darwin',
        platformKey: 'linux-x64',
        cacheRoot: path.join(REPO, 'no-such-cache'),
      });
      expect(probe).toMatchObject({
        available: false,
        reason: expect.stringContaining('cli:fetch') as unknown,
      });
    }
  });
});
