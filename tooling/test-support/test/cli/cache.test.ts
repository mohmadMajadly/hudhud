import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cachePaths,
  createStaging,
  installBinary,
  removeStaging,
  verifyCachedBinary,
} from '../../src/cli/cache.js';
import type { CacheIdentity, CachePaths } from '../../src/cli/cache.js';
import { bytes, sha256 } from './tar-builder.js';

const HOST = process.platform;
const CONTENT = bytes('cached fake binary\n'.repeat(100));
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

async function install(content: Uint8Array = CONTENT): Promise<void> {
  const staging = await createStaging(root);
  const staged = path.join(staging, 'claude');
  await writeFile(staged, content, { mode: 0o755 });
  await installBinary(staged, paths, IDENTITY, HOST);
  await removeStaging(staging);
}

async function invalidReason(
  identity: CacheIdentity = IDENTITY,
  host: NodeJS.Platform = HOST,
): Promise<string> {
  try {
    await verifyCachedBinary(paths, identity, host);
  } catch (error) {
    expect(error).toMatchObject({ code: 'cache-invalid' });
    return (error as Error).message;
  }
  throw new Error('expected cache-invalid');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-cache-'));
  paths = cachePaths(path.join(root, 'cache'), '1.2.3', 'linux-x64', 'claude');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('cache layout and install', () => {
  it('keys the cache by version and platform under a resolved root', () => {
    expect(paths.binary).toBe(path.join(root, 'cache', '1.2.3', 'linux-x64', 'claude'));
    expect(paths.stamp).toBe(path.join(root, 'cache', '1.2.3', 'linux-x64', 'verified.json'));
    expect(cachePaths('rel', '1.0.0', 'win32-x64', 'claude.exe').root).toBe(path.resolve('rel'));
  });

  it('installs atomically with a stamp and verifies by re-hashing', async () => {
    await install();
    const stamp: unknown = JSON.parse(await readFile(paths.stamp, 'utf8'));
    expect(stamp).toEqual({ schema: 1, ...IDENTITY });
    expect(await verifyCachedBinary(paths, IDENTITY, HOST)).toEqual({
      binaryPath: paths.binary,
      sha256: IDENTITY.sha256,
      size: IDENTITY.size,
    });
    const rootEntries = await readdir(paths.root);
    expect(rootEntries).toEqual(['1.2.3']);
  });

  it('replaces an existing cached binary', async () => {
    await install(bytes('x'.repeat(CONTENT.byteLength)));
    await install();
    expect((await verifyCachedBinary(paths, IDENTITY, HOST)).sha256).toBe(IDENTITY.sha256);
  });

  it('fails closed when the binary cannot be replaced', async () => {
    await mkdir(path.join(paths.binary, 'occupied'), { recursive: true });
    await expect(install()).rejects.toMatchObject({ code: 'cache-invalid' });
  });
});

describe('verifyCachedBinary refuses', () => {
  it('a missing cache', async () => {
    expect(await invalidReason()).toContain('not cached');
  });

  it('altered content of the same size (re-hash on every use)', async () => {
    await install();
    const altered = new Uint8Array(CONTENT);
    altered[0] = (altered[0] ?? 0) ^ 1;
    await writeFile(paths.binary, altered);
    expect(await invalidReason()).toContain('sha256');
  });

  it('a different size', async () => {
    await install();
    await writeFile(paths.binary, CONTENT.subarray(1));
    expect(await invalidReason()).toContain('bytes, expected');
  });

  it('a stamp for another identity, a missing, malformed or oversized stamp', async () => {
    await install();
    for (const key of [
      'package',
      'version',
      'platform',
      'file',
      'integrity',
      'sha256',
      'size',
    ] as const) {
      const other = { ...IDENTITY, [key]: key === 'size' ? 1 : 'other' };
      expect(await invalidReason(other)).toContain(`expected ${key}`);
    }
    for (const text of ['null', '5', '{']) {
      await writeFile(paths.stamp, text);
      expect(await invalidReason()).toMatch(/stamp/);
    }
    await writeFile(paths.stamp, ' '.repeat(5000));
    expect(await invalidReason()).toContain('not a regular stamp file');
    await rm(paths.stamp);
    expect(await invalidReason()).toContain('not cached');
  });

  it('a directory in place of the binary or the stamp', async () => {
    await install();
    await rm(paths.binary);
    await mkdir(paths.binary);
    expect(await invalidReason()).toContain('not a regular file');
    await rm(paths.stamp);
    await mkdir(paths.stamp);
    expect(await invalidReason()).toContain('not a regular stamp file');
  });

  it('a link in place of the platform directory', async () => {
    await install();
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    await rm(paths.platformDir, { recursive: true });
    await symlink(elsewhere, paths.platformDir, 'junction');
    expect(await invalidReason()).toContain('not a directory');
  });

  it('a file in place of the version directory', async () => {
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.versionDir, 'x');
    expect(await invalidReason()).toContain('not a directory');
  });

  it('a symbolic link in place of the binary', async () => {
    await install();
    const target = path.join(root, 'target');
    await writeFile(target, CONTENT);
    await rm(paths.binary);
    try {
      await symlink(target, paths.binary, 'file');
    } catch (error) {
      // Unprivileged Windows cannot create file symlinks; the directory case
      // above covers the refusal there, and Linux CI runs this one.
      expect(HOST).toBe('win32');
      expect(error).toMatchObject({ code: 'EPERM' });
      return;
    }
    expect(await invalidReason()).toContain('not a regular file');
  });

  it('group- or world-writable directories and binaries under the POSIX policy', async () => {
    await install();
    if (HOST !== 'win32') {
      await chmod(paths.binary, 0o775);
      expect(await invalidReason(IDENTITY, 'linux')).toContain('writable');
      await chmod(paths.binary, 0o755);
      await chmod(paths.platformDir, 0o777);
      expect(await invalidReason(IDENTITY, 'linux')).toContain('writable');
      await chmod(paths.platformDir, 0o700);
      expect((await verifyCachedBinary(paths, IDENTITY, 'linux')).size).toBe(IDENTITY.size);
    } else {
      // Windows reports every file as 0o666, so the POSIX policy refuses it,
      // while the win32 policy relies on the owner-only profile directory.
      expect(await invalidReason(IDENTITY, 'linux')).toContain('writable');
      expect((await verifyCachedBinary(paths, IDENTITY, 'win32')).size).toBe(IDENTITY.size);
    }
  });
});
