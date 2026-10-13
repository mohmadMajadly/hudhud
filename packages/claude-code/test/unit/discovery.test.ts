// Binary discovery (K7, ADR-0011 §5, plan §1.8): option, native installer
// launcher (01 §4.1), sanitized PATH; no node_modules probing.

import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { BinaryNotFoundError, BinaryRefusedError } from '@hudhud/core';
import {
  ExecutableResolutionError,
  hostPlatform,
  type ProcessPlatform,
  type ResolvedExecutable,
} from '@hudhud/core/process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  discoverBinary,
  nodeDiscoveryDeps,
  type DiscoveryDeps,
  type DiscoveryFs,
} from '../../src/discovery.js';

type Resolution = string | ExecutableResolutionError | Error;

function executable(requested: string, real = requested): ResolvedExecutable {
  return { requested, path: real, size: 1, mtimeMs: 1 };
}

const notFound = (value: string): ExecutableResolutionError =>
  new ExecutableResolutionError('not-found', value);

interface FakeWorld {
  /** requested path -> realpath, or the error resolveExecutable throws. */
  readonly resolve?: Readonly<Record<string, Resolution>>;
  readonly links?: readonly string[];
  /** Plain realpaths for the layout check. */
  readonly realpaths?: Readonly<Record<string, string>>;
  readonly modes?: Readonly<Record<string, number>>;
}

function deps(
  platform: ProcessPlatform,
  world: FakeWorld,
  overrides: Partial<DiscoveryDeps> = {},
): DiscoveryDeps & { readonly resolved: string[] } {
  const resolved: string[] = [];
  const fs: DiscoveryFs = {
    lstat: (value) =>
      Object.hasOwn(world.realpaths ?? {}, value) || Object.hasOwn(world.resolve ?? {}, value)
        ? Promise.resolve({ isSymbolicLink: () => (world.links ?? []).includes(value) })
        : Promise.reject(new Error('ENOENT')),
    realpath: (value) => {
      const direct = world.realpaths?.[value];
      if (direct !== undefined) return Promise.resolve(direct);
      const target = world.resolve?.[value];
      return typeof target === 'string'
        ? Promise.resolve(target)
        : Promise.reject(new Error('ENOENT'));
    },
    stat: (value) => {
      const mode = world.modes?.[value];
      return mode === undefined
        ? Promise.resolve({ mode: 0o40755 })
        : mode < 0
          ? Promise.reject(new Error('EACCES'))
          : Promise.resolve({ mode });
    },
  };
  return {
    platform,
    env: {},
    home: platform === 'win32' ? 'C:\\Users\\user' : '/home/user',
    cwd: platform === 'win32' ? 'C:\\work' : '/work',
    fs,
    resolved,
    resolve: (value) => {
      resolved.push(value);
      const target = world.resolve?.[value] ?? notFound(value);
      return typeof target === 'string'
        ? Promise.resolve(executable(value, target))
        : Promise.reject(target);
    },
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error('expected a rejection'),
    (error: unknown) => error,
  );
}

const POSIX_LAUNCHER = '/home/user/.local/bin/claude';
const POSIX_VERSIONS = '/home/user/.local/share/claude/versions';
const WIN_LAUNCHER = 'C:\\Users\\user\\.local\\bin\\claude.exe';

describe('the binaryPath option', () => {
  it('is used alone when given', async () => {
    const d = deps('posix', {
      resolve: { '/opt/claude': '/opt/real/claude', [POSIX_LAUNCHER]: '/x' },
    });
    await expect(discoverBinary('/opt/claude', d)).resolves.toEqual({
      source: 'option',
      requestedPath: '/opt/claude',
      executable: executable('/opt/claude', '/opt/real/claude'),
      candidates: [{ source: 'option', path: '/opt/claude', outcome: 'selected' }],
    });
    expect(d.resolved).toEqual(['/opt/claude']);
  });

  it('missing is BinaryNotFoundError, without a fallback', async () => {
    const d = deps('posix', { resolve: { [POSIX_LAUNCHER]: '/x' } });
    const error = await caught(discoverBinary('/opt/claude', d));
    expect(error).toBeInstanceOf(BinaryNotFoundError);
    expect((error as BinaryNotFoundError).details).toEqual({
      path: '/opt/claude',
      candidates: [{ source: 'option', path: '/opt/claude', outcome: 'not-found' }],
    });
    expect(d.resolved).toEqual(['/opt/claude']);
  });

  it('refused is BinaryRefusedError with the reason', async () => {
    const d = deps('win32', {
      resolve: {
        'C:\\x\\claude.cmd': new ExecutableResolutionError('batch-file', 'C:\\x\\claude.cmd'),
      },
    });
    const error = await caught(discoverBinary('C:\\x\\claude.cmd', d));
    expect(error).toBeInstanceOf(BinaryRefusedError);
    expect((error as BinaryRefusedError).details).toEqual({
      source: 'option',
      path: 'C:\\x\\claude.cmd',
      reason: 'batch-file',
      candidates: [
        { source: 'option', path: 'C:\\x\\claude.cmd', outcome: 'refused', reason: 'batch-file' },
      ],
    });
  });

  it('reports the resolved path of a refusal', async () => {
    const d = deps('posix', {
      resolve: {
        '/opt/claude': new ExecutableResolutionError('not-executable', '/opt/claude', '/opt/real'),
      },
    });
    const error = await caught(discoverBinary('/opt/claude', d));
    expect((error as BinaryRefusedError).details).toMatchObject({ resolved: '/opt/real' });
  });

  it('lets unexpected errors through', async () => {
    const boom = new Error('boom');
    const d = deps('posix', { resolve: { '/opt/claude': boom } });
    await expect(discoverBinary('/opt/claude', d)).rejects.toBe(boom);
  });
});

describe('the native installer launcher (01 §4.1)', () => {
  it('resolves the POSIX symbolic link into versions/<version>', async () => {
    const d = deps('posix', {
      resolve: { [POSIX_LAUNCHER]: `${POSIX_VERSIONS}/2.1.296` },
      links: [POSIX_LAUNCHER],
      realpaths: { [POSIX_VERSIONS]: POSIX_VERSIONS },
    });
    await expect(discoverBinary(null, d)).resolves.toEqual({
      source: 'native-install',
      requestedPath: POSIX_LAUNCHER,
      executable: executable(POSIX_LAUNCHER, `${POSIX_VERSIONS}/2.1.296`),
      launcher: { kind: 'versions-link', version: '2.1.296' },
      candidates: [{ source: 'native-install', path: POSIX_LAUNCHER, outcome: 'selected' }],
    });
  });

  it('compares the versions directory by realpath (a linked home)', async () => {
    const d = deps('posix', {
      resolve: { [POSIX_LAUNCHER]: '/data/a/.local/share/claude/versions/2.1.296' },
      links: [POSIX_LAUNCHER],
      realpaths: { [POSIX_VERSIONS]: '/data/a/.local/share/claude/versions' },
    });
    await expect(discoverBinary(null, d)).resolves.toMatchObject({
      launcher: { kind: 'versions-link', version: '2.1.296' },
    });
  });

  it.each<[string, FakeWorld]>([
    [
      'a link outside the versions directory',
      {
        resolve: { [POSIX_LAUNCHER]: '/opt/claude' },
        links: [POSIX_LAUNCHER],
        realpaths: { [POSIX_VERSIONS]: POSIX_VERSIONS },
      },
    ],
    [
      'a file that is not named by a version',
      {
        resolve: { [POSIX_LAUNCHER]: `${POSIX_VERSIONS}/latest` },
        links: [POSIX_LAUNCHER],
        realpaths: { [POSIX_VERSIONS]: POSIX_VERSIONS },
      },
    ],
    [
      'no versions directory',
      { resolve: { [POSIX_LAUNCHER]: `${POSIX_VERSIONS}/2.1.296` }, links: [POSIX_LAUNCHER] },
    ],
  ])('reports %s as layout other', async (_name, world) => {
    await expect(discoverBinary(null, deps('posix', world))).resolves.toMatchObject({
      source: 'native-install',
      launcher: { kind: 'other' },
    });
  });

  it('takes the Windows copy itself (the installer copies, it does not link)', async () => {
    const d = deps('win32', { resolve: { [WIN_LAUNCHER]: WIN_LAUNCHER } });
    await expect(discoverBinary(null, d)).resolves.toMatchObject({
      source: 'native-install',
      requestedPath: WIN_LAUNCHER,
      launcher: { kind: 'copy' },
    });
  });

  it('compares Windows paths ignoring case', async () => {
    const d = deps('win32', {
      resolve: { [WIN_LAUNCHER]: WIN_LAUNCHER },
      realpaths: { [WIN_LAUNCHER]: WIN_LAUNCHER.toUpperCase() },
    });
    await expect(discoverBinary(null, d)).resolves.toMatchObject({ launcher: { kind: 'copy' } });
  });

  it('refuses a launcher that resolves elsewhere on a second look (race)', async () => {
    const d = deps('posix', {
      resolve: { [POSIX_LAUNCHER]: `${POSIX_VERSIONS}/2.1.296` },
      links: [POSIX_LAUNCHER],
      realpaths: { [POSIX_LAUNCHER]: '/tmp/evil' },
    });
    const error = await caught(discoverBinary(null, d));
    expect(error).toBeInstanceOf(BinaryRefusedError);
    expect((error as BinaryRefusedError).details).toMatchObject({ reason: 'launcher-changed' });
  });

  it('refuses a launcher that vanished on a second look', async () => {
    const d = deps('posix', { resolve: { [POSIX_LAUNCHER]: `${POSIX_VERSIONS}/2.1.296` } });
    const fs: DiscoveryFs = { ...d.fs, lstat: () => Promise.reject(new Error('ENOENT')) };
    await expect(discoverBinary(null, { ...d, fs })).rejects.toBeInstanceOf(BinaryRefusedError);
  });

  it('stops with BinaryRefusedError when the launcher exists but is refused', async () => {
    const d = deps('posix', {
      resolve: {
        [POSIX_LAUNCHER]: new ExecutableResolutionError('not-executable', POSIX_LAUNCHER),
        '/usr/bin/claude': '/usr/bin/claude',
      },
    });
    const error = await caught(discoverBinary(null, { ...d, env: { PATH: '/usr/bin' } }));
    expect(error).toBeInstanceOf(BinaryRefusedError);
    expect((error as BinaryRefusedError).details).toMatchObject({
      source: 'native-install',
      reason: 'not-executable',
      candidates: [
        {
          source: 'native-install',
          path: POSIX_LAUNCHER,
          outcome: 'refused',
          reason: 'not-executable',
        },
      ],
    });
    expect(d.resolved).toEqual([POSIX_LAUNCHER]);
  });

  it.each<[string | undefined]>([[undefined], [''], ['relative/home']])(
    'is skipped without a usable home (%j)',
    async (home) => {
      const d = deps(
        'posix',
        { resolve: { '/usr/bin/claude': '/usr/bin/claude' } },
        { home, env: { PATH: '/usr/bin' } },
      );
      await expect(discoverBinary(null, d)).resolves.toMatchObject({
        source: 'path',
        candidates: [
          { source: 'native-install', path: '', outcome: 'skipped', reason: 'no-home' },
          { source: 'path', path: '/usr/bin/claude', outcome: 'selected' },
        ],
      });
    },
  );
});

describe('the PATH lookup', () => {
  it('searches only absolute entries, skips the current directory and records each candidate', async () => {
    const d = deps(
      'posix',
      {
        resolve: {
          '/opt/bad/claude': new ExecutableResolutionError('not-regular-file', '/opt/bad/claude'),
          '/work/claude': '/work/claude',
          '/usr/local/bin/claude': '/usr/local/lib/claude',
        },
      },
      { env: { PATH: ':.:bin:/opt/none:/work:/opt/bad:/usr/local/bin:/usr/bin' } },
    );
    await expect(discoverBinary(null, d)).resolves.toEqual({
      source: 'path',
      requestedPath: '/usr/local/bin/claude',
      executable: executable('/usr/local/bin/claude', '/usr/local/lib/claude'),
      candidates: [
        { source: 'native-install', path: POSIX_LAUNCHER, outcome: 'not-found' },
        { source: 'path', path: '/opt/none/claude', outcome: 'not-found' },
        { source: 'path', path: '/work/claude', outcome: 'skipped', reason: 'current-directory' },
        { source: 'path', path: '/opt/bad/claude', outcome: 'refused', reason: 'not-regular-file' },
        { source: 'path', path: '/usr/local/bin/claude', outcome: 'selected' },
      ],
    });
    expect(d.resolved).toEqual([
      POSIX_LAUNCHER,
      '/opt/none/claude',
      '/opt/bad/claude',
      '/usr/local/bin/claude',
    ]);
    // node_modules is never probed.
    expect(d.resolved.some((value) => value.includes('node_modules'))).toBe(false);
  });

  it.each<[string, Readonly<Record<string, number>>]>([
    ['a world-writable PATH entry', { '/tmp/bin': 0o41777 }],
    ['a world-writable directory of the resolved file', { '/tmp/real': 0o40777 }],
    ['an unreadable directory', { '/tmp/bin': -1 }],
  ])('skips %s on POSIX', async (_name, modes) => {
    const d = deps(
      'posix',
      {
        resolve: { '/tmp/bin/claude': '/tmp/real/claude', '/usr/bin/claude': '/usr/bin/claude' },
        modes,
      },
      { env: { PATH: '/tmp/bin:/usr/bin' } },
    );
    await expect(discoverBinary(null, d)).resolves.toMatchObject({
      requestedPath: '/usr/bin/claude',
      candidates: [
        { source: 'native-install', outcome: 'not-found' },
        {
          source: 'path',
          path: '/tmp/bin/claude',
          outcome: 'refused',
          reason: 'world-writable-directory',
        },
        { source: 'path', path: '/usr/bin/claude', outcome: 'selected' },
      ],
    });
  });

  it('looks only for claude.exe on Windows, with PATH named in any case', async () => {
    const d = deps(
      'win32',
      {
        resolve: { 'C:\\tools\\claude.exe': 'C:\\tools\\claude.exe' },
        modes: { 'C:\\tools': 0o40777 },
      },
      { env: { Path: 'C:\\npm;.;C:\\WORK\\;C:\\tools' } },
    );
    await expect(discoverBinary(null, d)).resolves.toMatchObject({
      source: 'path',
      requestedPath: 'C:\\tools\\claude.exe',
      candidates: [
        { source: 'native-install', path: WIN_LAUNCHER, outcome: 'not-found' },
        { source: 'path', path: 'C:\\npm\\claude.exe', outcome: 'not-found' },
        {
          source: 'path',
          path: 'C:\\WORK\\claude.exe',
          outcome: 'skipped',
          reason: 'current-directory',
        },
        { source: 'path', path: 'C:\\tools\\claude.exe', outcome: 'selected' },
      ],
    });
    expect(d.resolved.every((value) => value.endsWith('claude.exe'))).toBe(true);
  });

  it('skips a Windows PATH whose spellings disagree', async () => {
    const d = deps('win32', {}, { env: { Path: 'C:\\a', PATH: 'C:\\b', path: undefined } });
    const error = await caught(discoverBinary(null, d));
    expect(error).toBeInstanceOf(BinaryNotFoundError);
    expect((error as BinaryNotFoundError).details).toEqual({
      candidates: [
        { source: 'native-install', path: WIN_LAUNCHER, outcome: 'not-found' },
        { source: 'path', path: '', outcome: 'skipped', reason: 'path-ambiguous' },
      ],
    });
  });

  it('accepts one PATH spelled twice with the same value on Windows', async () => {
    const d = deps(
      'win32',
      { resolve: { 'C:\\a\\claude.exe': 'C:\\a\\claude.exe' } },
      { env: { Path: 'C:\\a', PATH: 'C:\\a' } },
    );
    await expect(discoverBinary(null, d)).resolves.toMatchObject({ source: 'path' });
  });

  it('is BinaryNotFoundError with every candidate when nothing is found', async () => {
    const d = deps('posix', {}, { env: { PATH: '/usr/bin' } });
    const error = await caught(discoverBinary(null, d));
    expect(error).toBeInstanceOf(BinaryNotFoundError);
    expect((error as BinaryNotFoundError).details).toEqual({
      candidates: [
        { source: 'native-install', path: POSIX_LAUNCHER, outcome: 'not-found' },
        { source: 'path', path: '/usr/bin/claude', outcome: 'not-found' },
      ],
    });
  });

  it('copes with no PATH at all', async () => {
    await expect(discoverBinary(null, deps('posix', {}))).rejects.toBeInstanceOf(
      BinaryNotFoundError,
    );
  });
});

describe('the host defaults', () => {
  it('use the host platform, environment, home and filesystem', () => {
    const d = nodeDiscoveryDeps();
    expect(d.platform).toBe(hostPlatform());
    expect(d.env).toBe(process.env);
    expect(d.cwd).toBe(process.cwd());
    expect(typeof d.home).toBe('string');
  });

  describe('against a real temporary home', () => {
    let root = '';

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(tmpdir(), 'hudhud-discovery-')));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    });

    it.runIf(process.platform !== 'win32')('resolves the launcher link layout', async () => {
      const home = path.join(root, 'home-link');
      const versions = path.join(home, '.local', 'share', 'claude', 'versions');
      await mkdir(versions, { recursive: true });
      await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
      const target = path.join(versions, '2.1.296');
      await writeFile(target, '#!/bin/sh\n');
      await chmod(target, 0o755);
      await symlink(target, path.join(home, '.local', 'bin', 'claude'));
      const found = await discoverBinary(null, { ...nodeDiscoveryDeps(), home, env: {} });
      expect(found).toMatchObject({
        source: 'native-install',
        executable: { path: target },
        launcher: { kind: 'versions-link', version: '2.1.296' },
      });
    });

    it.runIf(process.platform === 'win32')('takes the launcher copy', async () => {
      const home = path.join(root, 'home-copy');
      await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
      const launcher = path.join(home, '.local', 'bin', 'claude.exe');
      await writeFile(launcher, 'MZ');
      const found = await discoverBinary(null, { ...nodeDiscoveryDeps(), home, env: {} });
      expect(found).toMatchObject({
        source: 'native-install',
        executable: { path: launcher },
        launcher: { kind: 'copy' },
      });
    });
  });
});
