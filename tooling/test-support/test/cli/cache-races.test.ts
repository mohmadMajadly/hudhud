// TOCTOU checks of the cache: a binary swapped or modified around and during
// verification is refused. `open` is wrapped so a test can act at the exact
// moment between the checks; everything else is the real file system.

import type * as FsPromises from 'node:fs/promises';
import type { StatOptions } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cachePaths,
  createStaging,
  installBinary,
  verifyCachedBinary,
} from '../../src/cli/cache.js';
import type { CacheIdentity, CachePaths } from '../../src/cli/cache.js';
import { parsePin } from '../../src/cli/pin.js';
import { ensurePinnedCli } from '../../src/cli/pinned.js';
import { fakeRegistry } from './fake-registry.js';
import { bytes, sha256 } from './tar-builder.js';

const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((file: string) => Promise<void>) | undefined,
  afterOpen: undefined as ((file: string, handle: FileHandle) => Promise<void>) | undefined,
  /** Answers `lstat(file)` with the stats of another path. */
  lstatAs: undefined as ((file: string) => string | undefined) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
      const file = String(args[0]);
      await hooks.beforeOpen?.(file);
      const handle = await actual.open(...args);
      await hooks.afterOpen?.(file, handle);
      return handle;
    },
    lstat: (file: string, options?: StatOptions) =>
      actual.lstat(hooks.lstatAs?.(file) ?? file, options),
  };
});

const HOST = process.platform;
const CONTENT = bytes('race fake binary\n'.repeat(100));
const IDENTITY: CacheIdentity = {
  package: '@anthropic-ai/claude-code-linux-x64',
  version: '1.2.3',
  platform: 'linux-x64',
  file: 'claude',
  integrity: `sha512-${'A'.repeat(86)}==`,
  sha256: sha256(CONTENT),
  size: CONTENT.byteLength,
};

let root = '';
let paths: CachePaths;
let impostor = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-race-'));
  paths = cachePaths(path.join(root, 'cache'), '1.2.3', 'linux-x64', 'claude');
  const staging = await createStaging(paths.root);
  const staged = path.join(staging, 'claude');
  await writeFile(staged, CONTENT, { mode: 0o755 });
  await installBinary(staged, paths, IDENTITY, HOST);
  // Same size, same content: only the file identity differs.
  impostor = path.join(root, 'impostor');
  await writeFile(impostor, CONTENT, { mode: 0o755 });
});

afterEach(async () => {
  hooks.beforeOpen = undefined;
  hooks.afterOpen = undefined;
  hooks.lstatAs = undefined;
  await rm(root, { recursive: true, force: true });
});

async function reason(): Promise<string> {
  try {
    await verifyCachedBinary(paths, IDENTITY, HOST);
  } catch (error) {
    expect(error).toMatchObject({ code: 'cache-invalid' });
    return (error as Error).message;
  }
  throw new Error('expected cache-invalid');
}

describe('verifyCachedBinary under races', () => {
  it('verifies when nothing interferes', async () => {
    expect((await verifyCachedBinary(paths, IDENTITY, HOST)).sha256).toBe(IDENTITY.sha256);
  });

  it('refuses a binary swapped between the check and the open', async () => {
    hooks.beforeOpen = async (file) => {
      if (file === paths.binary) await rename(impostor, paths.binary);
    };
    expect(await reason()).toContain('replaced while opening');
  });

  it('refuses a binary swapped while it is hashed', async () => {
    // The path resolves to another file once the descriptor is open.
    hooks.afterOpen = (file) => {
      if (file === paths.binary) hooks.lstatAs = (f) => (f === paths.binary ? impostor : undefined);
      return Promise.resolve();
    };
    expect(await reason()).toContain('replaced while hashing');
  });

  it('refuses a real swap during hashing (POSIX); Windows refuses the swap itself', async () => {
    let swap: unknown;
    hooks.afterOpen = async (file) => {
      if (file !== paths.binary) return;
      try {
        await rename(impostor, paths.binary);
      } catch (error) {
        swap = error;
      }
    };
    const outcome = await reason().catch((error: unknown) => error);
    if (swap === undefined) {
      expect(outcome).toContain('replaced while hashing');
    } else {
      // An open file cannot be replaced on Windows; verification then passes on the original.
      expect(HOST).toBe('win32');
      expect(swap).toMatchObject({ code: 'EPERM' });
    }
  });

  it('refuses a binary modified while it is hashed', async () => {
    hooks.afterOpen = (file, handle) => {
      if (file !== paths.binary) return Promise.resolve();
      const read = handle.read.bind(handle);
      let appended = false;
      Object.defineProperty(handle, 'read', {
        value: async (...args: Parameters<FileHandle['read']>) => {
          if (!appended) {
            appended = true;
            await appendFile(paths.binary, 'x');
          }
          return read(...args);
        },
      });
      return Promise.resolve();
    };
    expect(await reason()).toContain('modified while hashing');
  });

  it('ensurePinnedCli propagates unexpected I/O errors instead of refetching', async () => {
    hooks.beforeOpen = (file) =>
      file === paths.binary ? Promise.reject(new Error('simulated EIO')) : Promise.resolve();
    const registry = fakeRegistry();
    const pin = parsePin(
      {
        version: IDENTITY.version,
        platforms: {
          'linux-x64': {
            package: IDENTITY.package,
            file: IDENTITY.file,
            integrity: IDENTITY.integrity,
            sha256: IDENTITY.sha256,
            size: IDENTITY.size,
          },
        },
      },
      'pin',
    );
    await expect(
      ensurePinnedCli({
        pin,
        platform: 'linux-x64',
        cacheRoot: paths.root,
        hostPlatform: HOST,
        registry: registry.options,
      }),
    ).rejects.toThrow('simulated EIO');
    expect(registry.calls).toEqual([]);
  });
});
