import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CwdValidationError,
  WIN32_CWD_MAX_LENGTH,
  checkCwdPath,
  errnoCode,
  hostPlatform,
  pathProblem,
  validateCwd,
} from '../../../src/process/cwd.js';
import type { CwdFs, FileIdentity, ProcessPlatform } from '../../../src/process/cwd.js';

function identity(over: Partial<{ dir: boolean; dev: bigint; ino: bigint }> = {}): FileIdentity {
  const dir = over.dir ?? true;
  return {
    isFile: () => !dir,
    isDirectory: () => dir,
    dev: over.dev ?? 7n,
    ino: over.ino ?? 42n,
    size: 0n,
    mtimeMs: 0n,
  };
}

function errno(code: unknown): Error {
  return Object.assign(new Error(String(code)), { code });
}

/** A fake filesystem: realpath map plus stat map; missing entries are ENOENT. */
function fakeFs(
  realpaths: Readonly<Record<string, string>>,
  stats: Readonly<Record<string, FileIdentity | Error>>,
): CwdFs & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    realpath: (value) => {
      calls.push(`realpath ${value}`);
      const target = realpaths[value];
      return target === undefined ? Promise.reject(errno('ENOENT')) : Promise.resolve(target);
    },
    stat: (value) => {
      calls.push(`stat ${value}`);
      const entry = stats[value] ?? errno('ENOENT');
      return entry instanceof Error ? Promise.reject(entry) : Promise.resolve(entry);
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<CwdValidationError> {
  const error: unknown = await promise.then(
    () => new Error('expected a rejection'),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CwdValidationError);
  return error as CwdValidationError;
}

/** A drive-absolute win32 path of exactly `length` UTF-16 code units. */
function win32PathOfLength(length: number): string {
  const segments: string[] = [];
  let remaining = length - 3;
  while (remaining > 0) {
    const size = Math.min(remaining, 100);
    segments.push('a'.repeat(size));
    remaining -= size + 1;
  }
  const value = `C:\\${segments.join('\\')}`;
  return value.length === length ? value : `${value}a`.slice(0, length);
}

describe('hostPlatform', () => {
  it('maps win32 to win32 and every other platform to posix', () => {
    expect(hostPlatform('win32')).toBe('win32');
    expect(hostPlatform('linux')).toBe('posix');
    expect(hostPlatform('darwin')).toBe('posix');
    expect(hostPlatform()).toBe(process.platform === 'win32' ? 'win32' : 'posix');
  });
});

describe('pathProblem', () => {
  it.each<[string, ProcessPlatform, string | undefined]>([
    ['', 'posix', 'empty'],
    ['', 'win32', 'empty'],
    ['/a\0b', 'posix', 'nul'],
    ['C:\\a\0b', 'win32', 'nul'],
    ['/a\uD800', 'posix', 'ill-formed'],
    ['/abs/dir', 'posix', undefined],
    ['/', 'posix', undefined],
    ['rel/dir', 'posix', 'not-absolute'],
    ['./x', 'posix', 'not-absolute'],
    ['C:\\x', 'posix', 'not-absolute'],
    ['C:\\', 'win32', undefined],
    ['C:\\work\\proj', 'win32', undefined],
    ['c:/work/proj', 'win32', undefined],
    ['C:\\work\\.\\..\\proj', 'win32', undefined],
    ['\\\\server\\share\\proj', 'win32', undefined],
    ['//server/share', 'win32', undefined],
    ['\\\\server', 'win32', 'not-absolute'],
    ['C:proj', 'win32', 'not-absolute'],
    ['\\proj', 'win32', 'not-absolute'],
    ['/proj', 'win32', 'not-absolute'],
    ['proj', 'win32', 'not-absolute'],
    ['\\\\?\\C:\\proj', 'win32', 'device-namespace'],
    ['\\\\.\\C:\\proj', 'win32', 'device-namespace'],
    ['//?/C:/proj', 'win32', 'device-namespace'],
    ['\\\\?\\UNC\\server\\share', 'win32', 'device-namespace'],
    ['\\??\\C:\\proj', 'win32', 'device-namespace'],
    ['C:\\proj\\file:stream', 'win32', 'alternate-data-stream'],
    ['C:\\proj::$DATA', 'win32', 'alternate-data-stream'],
    ['C:\\proj.', 'win32', 'trailing-dot-or-space'],
    ['C:\\proj \\x', 'win32', 'trailing-dot-or-space'],
    ['C:\\proj...', 'win32', 'trailing-dot-or-space'],
    ['C:\\con', 'win32', 'reserved-device-name'],
    ['C:\\x\\NUL.txt', 'win32', 'reserved-device-name'],
    ['C:\\x\\com1', 'win32', 'reserved-device-name'],
    ['C:\\x\\LPT9.log', 'win32', 'reserved-device-name'],
    ['C:\\x\\COM¹', 'win32', 'reserved-device-name'],
    ['C:\\x\\CONOUT$', 'win32', 'reserved-device-name'],
    ['C:\\x\\console', 'win32', undefined],
    ['C:\\x\\com10', 'win32', undefined],
  ])('%j on %s -> %s', (value, platform, expected) => {
    expect(pathProblem(value, platform)).toBe(expected);
  });
});

describe('checkCwdPath', () => {
  it('builds paths of exact lengths for the boundary tests', () => {
    for (const length of [3, 4, 100, 258, 259, 400]) {
      expect(win32PathOfLength(length)).toHaveLength(length);
    }
  });

  it('applies the win32 258/259 boundary in UTF-16 code units', () => {
    expect(WIN32_CWD_MAX_LENGTH).toBe(258);
    expect(checkCwdPath(win32PathOfLength(258), 'win32')).toBeUndefined();
    expect(checkCwdPath(win32PathOfLength(259), 'win32')).toBe('too-long');
    // One astral character is two code units.
    const astral = `${win32PathOfLength(256)}𝒜`;
    expect(astral).toHaveLength(258);
    expect(checkCwdPath(astral, 'win32')).toBeUndefined();
    expect(checkCwdPath(`${astral}b`, 'win32')).toBe('too-long');
  });

  it('has no length limit on posix', () => {
    expect(checkCwdPath(`/${'a'.repeat(1000)}`, 'posix')).toBeUndefined();
  });

  it('reports lexical problems before the length', () => {
    expect(checkCwdPath(`\\\\?\\${win32PathOfLength(300)}`, 'win32')).toBe('device-namespace');
  });

  it('property: a win32 path is too long exactly from 259 code units', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 2000 }), (length) => {
        const verdict = checkCwdPath(win32PathOfLength(length), 'win32');
        expect(verdict).toBe(length >= 259 ? 'too-long' : undefined);
      }),
      { numRuns: 500 },
    );
  });
});

describe('CwdValidationError', () => {
  it('maps reasons to codes and names the workarounds for too-long', () => {
    const tooLong = new CwdValidationError('too-long', 'C:\\x');
    expect(tooLong.code).toBe('CWD_TOO_LONG');
    expect(tooLong.name).toBe('CwdValidationError');
    expect(tooLong.message).toContain('subst');
    expect(tooLong.message).toContain('junction');
    expect(tooLong.message).toContain('\\\\?\\');
    expect(tooLong.resolved).toBeUndefined();
    expect(new CwdValidationError('not-found', '/x').message).toContain('does not exist');
    expect(new CwdValidationError('nul', '/x').code).toBe('CWD_INVALID');
  });
});

describe('errnoCode', () => {
  it('reads a string code and ignores everything else', () => {
    expect(errnoCode(errno('EACCES'))).toBe('EACCES');
    expect(errnoCode(errno(13))).toBeUndefined();
    expect(errnoCode(new Error('x'))).toBeUndefined();
    expect(errnoCode('ENOENT')).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
  });
});

describe('validateCwd with an injected filesystem', () => {
  it('refuses lexical problems without touching the filesystem', async () => {
    const fs = fakeFs({}, {});
    for (const [value, platform, reason] of [
      ['rel', 'posix', 'not-absolute'],
      ['\\\\?\\C:\\x', 'win32', 'device-namespace'],
      ['C:\\x:ads', 'win32', 'alternate-data-stream'],
      ['C:\\x.', 'win32', 'trailing-dot-or-space'],
    ] as const) {
      const error = await rejection(validateCwd(value, platform, fs));
      expect(error.reason).toBe(reason);
      expect(error.code).toBe('CWD_INVALID');
      expect(error.path).toBe(value);
    }
    expect(fs.calls).toEqual([]);
  });

  it('returns the realpath of a directory', async () => {
    const fs = fakeFs({ '/tmp/x': '/private/tmp/x' }, { '/private/tmp/x': identity() });
    await expect(validateCwd('/tmp/x', 'posix', fs)).resolves.toBe('/private/tmp/x');
    const win = fakeFs({ 'c:/proj': 'C:\\Proj' }, { 'C:\\Proj': identity() });
    await expect(validateCwd('c:/proj', 'win32', win)).resolves.toBe('C:\\Proj');
  });

  it.each([
    ['ENOENT', 'not-found'],
    ['ENOTDIR', 'not-found'],
    ['EACCES', 'unresolvable'],
    ['ELOOP', 'unresolvable'],
    [undefined, 'unresolvable'],
  ])('maps a realpath failure %s to %s', async (code, reason) => {
    const fs: CwdFs = {
      realpath: () => Promise.reject(code === undefined ? new Error('boom') : errno(code)),
      stat: () => Promise.resolve(identity()),
    };
    const error = await rejection(validateCwd('/x', 'posix', fs));
    expect(error.reason).toBe(reason);
    expect(error.cause).toBeDefined();
  });

  it('maps a stat failure and refuses a non-directory', async () => {
    const statFails = fakeFs({ '/x': '/x' }, { '/x': errno('EPERM') });
    expect((await rejection(validateCwd('/x', 'posix', statFails))).reason).toBe('unresolvable');
    const file = fakeFs({ '/x': '/real' }, { '/real': identity({ dir: false }) });
    const error = await rejection(validateCwd('/x', 'posix', file));
    expect(error.reason).toBe('not-directory');
    expect(error.resolved).toBe('/real');
  });

  it('refuses a realpath that comes back in the device namespace', async () => {
    const fs = fakeFs({ 'C:\\x': '\\\\?\\Volume{0}\\x' }, { '\\\\?\\Volume{0}\\x': identity() });
    const error = await rejection(validateCwd('C:\\x', 'win32', fs));
    expect(error.reason).toBe('device-namespace');
    expect(error.resolved).toBe('\\\\?\\Volume{0}\\x');
  });

  const long = win32PathOfLength(300);

  it('throws CWD_TOO_LONG for a long win32 path with no shorter alias', async () => {
    const fs = fakeFs({ [long]: long }, { [long]: identity() });
    const error = await rejection(validateCwd(long, 'win32', fs));
    expect(error.code).toBe('CWD_TOO_LONG');
    expect(error.reason).toBe('too-long');
    expect(error.resolved).toBe(long);
  });

  it('keeps a short alias (subst drive, junction) of a too-long directory', async () => {
    const fs = fakeFs({ 'S:/proj/': long }, { [long]: identity(), 'S:\\proj': identity() });
    await expect(validateCwd('S:/proj/', 'win32', fs)).resolves.toBe('S:\\proj');
  });

  it.each([
    ['another directory', identity({ ino: 43n })],
    ['another volume', identity({ dev: 8n })],
    ['a file', identity({ dir: false })],
    ['a stat failure', errno('EACCES')],
  ])('refuses an alias that resolves to %s', async (_label, aliasStat) => {
    const fs = fakeFs({ 'S:\\proj': long }, { [long]: identity(), 'S:\\proj': aliasStat });
    expect((await rejection(validateCwd('S:\\proj', 'win32', fs))).code).toBe('CWD_TOO_LONG');
  });

  it('refuses an alias when the file id is unknown (0)', async () => {
    const fs = fakeFs(
      { 'S:\\proj': long },
      { [long]: identity({ ino: 0n }), 'S:\\proj': identity({ ino: 0n }) },
    );
    expect((await rejection(validateCwd('S:\\proj', 'win32', fs))).code).toBe('CWD_TOO_LONG');
  });
});

describe('validateCwd on the host filesystem', () => {
  let root = '';
  const platform = hostPlatform();

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'hudhud-cwd-')));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the canonical path of an existing directory', async () => {
    await expect(validateCwd(root, platform)).resolves.toBe(root);
  });

  it('refuses a missing path and a file', async () => {
    expect((await rejection(validateCwd(path.join(root, 'missing'), platform))).reason).toBe(
      'not-found',
    );
    const file = path.join(root, 'file.txt');
    await writeFile(file, 'x');
    expect((await rejection(validateCwd(file, platform))).reason).toBe('not-directory');
  });

  it('resolves a directory link to its target', async () => {
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    await mkdir(target);
    // A junction needs no privilege on Windows; `type` is ignored on POSIX.
    await symlink(target, link, 'junction');
    await expect(validateCwd(link, platform)).resolves.toBe(target);
  });

  it.runIf(process.platform === 'win32')(
    'win32: refuses a real directory of 259+ units and accepts a short junction to it',
    async () => {
      let deep = root;
      while (deep.length < 300) deep = path.join(deep, 'd'.repeat(40));
      await mkdir(deep, { recursive: true });
      const error = await rejection(validateCwd(deep, 'win32'));
      expect(error.code).toBe('CWD_TOO_LONG');
      const alias = path.join(root, 'short');
      await symlink(deep, alias, 'junction');
      await expect(validateCwd(alias, 'win32')).resolves.toBe(alias);
    },
  );
});
