import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ExecutableResolutionError,
  checkExecutablePath,
  resolveExecutable,
  safeSearchPathEntries,
} from '../../../src/process/binary-path.js';
import type { ExecutableFs } from '../../../src/process/binary-path.js';
import { hostPlatform } from '../../../src/process/cwd.js';
import type { FileIdentity, ProcessPlatform } from '../../../src/process/cwd.js';

function identity(file = true): FileIdentity {
  return {
    isFile: () => file,
    isDirectory: () => !file,
    dev: 1n,
    ino: 2n,
    size: 1234n,
    mtimeMs: 1700000000123n,
  };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fakeFs(
  realpaths: Readonly<Record<string, string | Error>>,
  stats: Readonly<Record<string, FileIdentity>>,
  executable = true,
): ExecutableFs & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    realpath: (value) => {
      calls.push(`realpath ${value}`);
      const target = realpaths[value] ?? errno('ENOENT');
      return target instanceof Error ? Promise.reject(target) : Promise.resolve(target);
    },
    stat: (value) => {
      calls.push(`stat ${value}`);
      const entry = stats[value];
      return entry === undefined ? Promise.reject(errno('ENOENT')) : Promise.resolve(entry);
    },
    canExecute: (value) => {
      calls.push(`access ${value}`);
      return executable ? Promise.resolve() : Promise.reject(errno('EACCES'));
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<ExecutableResolutionError> {
  const error: unknown = await promise.then(
    () => new Error('expected a rejection'),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ExecutableResolutionError);
  return error as ExecutableResolutionError;
}

describe('checkExecutablePath', () => {
  it.each<[string, ProcessPlatform, string | undefined]>([
    ['C:\\tools\\claude.exe', 'win32', undefined],
    ['C:\\tools\\CLAUDE.EXE', 'win32', undefined],
    ['\\\\server\\share\\claude.Exe', 'win32', undefined],
    ['C:\\tools\\claude.cmd', 'win32', 'batch-file'],
    ['C:\\tools\\claude.CMD', 'win32', 'batch-file'],
    ['C:\\tools\\claude.Bat', 'win32', 'batch-file'],
    ['C:\\tools\\claude.bAT', 'win32', 'batch-file'],
    ['C:\\tools\\CLAUDE~1.BAT', 'win32', 'batch-file'],
    ['C:\\evil.bat\\claude.exe', 'win32', 'batch-file'],
    ['C:/tools.cmd/claude.exe', 'win32', 'batch-file'],
    ['C:\\tools\\claude.com', 'win32', 'not-exe'],
    ['C:\\tools\\claude.COM', 'win32', 'not-exe'],
    ['C:\\tools\\claude.ps1', 'win32', 'not-exe'],
    ['C:\\tools\\claude.lnk', 'win32', 'not-exe'],
    ['C:\\tools\\claude.pif', 'win32', 'not-exe'],
    ['C:\\tools\\claude.scr', 'win32', 'not-exe'],
    ['C:\\tools\\claude.exe.js', 'win32', 'not-exe'],
    ['C:\\tools\\claude', 'win32', 'not-exe'],
    ['C:\\tools\\', 'win32', 'not-exe'],
    ['C:\\tools\\claude.bat.', 'win32', 'trailing-dot-or-space'],
    ['C:\\tools\\claude.bat ', 'win32', 'trailing-dot-or-space'],
    ['C:\\tools\\claude.exe.', 'win32', 'trailing-dot-or-space'],
    ['C:\\tools\\claude.bat::$DATA', 'win32', 'alternate-data-stream'],
    ['C:\\tools\\claude.exe:evil.bat', 'win32', 'alternate-data-stream'],
    ['C:\\tools\\nul.exe', 'win32', 'reserved-device-name'],
    ['claude.exe', 'win32', 'not-absolute'],
    ['.\\claude.exe', 'win32', 'not-absolute'],
    ['C:claude.exe', 'win32', 'not-absolute'],
    ['\\tools\\claude.exe', 'win32', 'not-absolute'],
    ['\\\\?\\C:\\tools\\claude.exe', 'win32', 'device-namespace'],
    ['\\\\.\\C:\\tools\\claude.exe', 'win32', 'device-namespace'],
    ['/usr/local/bin/claude', 'posix', undefined],
    ['/opt/claude.exe', 'posix', undefined],
    ['/opt/claude.CMD', 'posix', undefined],
    ['/opt/claude.cmd', 'posix', 'batch-file'],
    ['/opt/x.bat/claude', 'posix', 'batch-file'],
    ['claude', 'posix', 'not-absolute'],
    ['./claude', 'posix', 'not-absolute'],
    ['bin/claude', 'posix', 'not-absolute'],
    ['', 'posix', 'empty'],
    ['/opt/a\0b', 'posix', 'nul'],
  ])('%j on %s -> %s', (value, platform, expected) => {
    expect(checkExecutablePath(value, platform)).toBe(expected);
  });

  it('property: every case variant of .bat, .cmd and .com is refused on win32', () => {
    const variant = fc
      .tuple(
        fc.constantFrom('bat', 'cmd', 'com'),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
      )
      .map(([ext, upper]) =>
        Array.from(ext, (c, i) => (upper[i] === true ? c.toUpperCase() : c)).join(''),
      );
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9_-]{1,12}$/), variant, (stem, ext) => {
        expect(checkExecutablePath(`C:\\tools\\${stem}.${ext}`, 'win32')).toBeDefined();
        expect(checkExecutablePath(`C:\\${stem}.${ext}\\claude.exe`, 'win32')).toBe(
          ext.toLowerCase() === 'com' ? undefined : 'batch-file',
        );
      }),
    );
  });
});

describe('resolveExecutable with an injected filesystem', () => {
  it('refuses lexical problems without touching the filesystem', async () => {
    const fs = fakeFs({}, {});
    const error = await rejection(resolveExecutable('claude.exe', { platform: 'win32', fs }));
    expect(error.code).toBe('BINARY_REFUSED');
    expect(error.reason).toBe('not-absolute');
    expect(error.resolved).toBeUndefined();
    expect(error.message).toContain('not-absolute');
    const batch = await rejection(
      resolveExecutable('C:\\x\\claude.cmd', { platform: 'win32', fs }),
    );
    expect(batch.reason).toBe('batch-file');
    expect(fs.calls).toEqual([]);
  });

  it('returns the realpath, size and mtime of an executable file', async () => {
    const fs = fakeFs(
      { '/srv/user/.local/bin/claude': '/srv/user/.local/share/claude/versions/2.1.296' },
      { '/srv/user/.local/share/claude/versions/2.1.296': identity() },
    );
    await expect(
      resolveExecutable('/srv/user/.local/bin/claude', { platform: 'posix', fs }),
    ).resolves.toEqual({
      requested: '/srv/user/.local/bin/claude',
      path: '/srv/user/.local/share/claude/versions/2.1.296',
      size: 1234,
      mtimeMs: 1700000000123,
    });
    expect(fs.calls).toContain('access /srv/user/.local/share/claude/versions/2.1.296');
  });

  it('applies the access check on win32 too (existence there)', async () => {
    const fs = fakeFs(
      { 'C:\\t\\claude.exe': 'C:\\T\\claude.exe' },
      { 'C:\\T\\claude.exe': identity() },
      false,
    );
    const error = await rejection(
      resolveExecutable('C:\\t\\claude.exe', { platform: 'win32', fs }),
    );
    expect(error.reason).toBe('not-executable');
    expect(error.resolved).toBe('C:\\T\\claude.exe');
  });

  it.each([
    ['ENOENT', 'BINARY_NOT_FOUND', 'not-found'],
    ['ENOTDIR', 'BINARY_NOT_FOUND', 'not-found'],
    ['EACCES', 'BINARY_REFUSED', 'unresolvable'],
    ['ELOOP', 'BINARY_REFUSED', 'unresolvable'],
  ])('maps a realpath failure %s to %s/%s', async (code, errorCode, reason) => {
    const fs = fakeFs({ '/x/claude': errno(code) }, {});
    const error = await rejection(resolveExecutable('/x/claude', { platform: 'posix', fs }));
    expect(error.code).toBe(errorCode);
    expect(error.reason).toBe(reason);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('refuses a link whose target is a batch file or not an .exe (resolved path)', async () => {
    const fs = fakeFs(
      { 'C:\\t\\claude.exe': 'C:\\t\\launcher.cmd', 'C:\\t\\x.exe': 'C:\\t\\x.com' },
      { 'C:\\t\\launcher.cmd': identity(), 'C:\\t\\x.com': identity() },
    );
    const batch = await rejection(
      resolveExecutable('C:\\t\\claude.exe', { platform: 'win32', fs }),
    );
    expect(batch.reason).toBe('batch-file');
    expect(batch.resolved).toBe('C:\\t\\launcher.cmd');
    expect(batch.message).toContain('launcher.cmd');
    const com = await rejection(resolveExecutable('C:\\t\\x.exe', { platform: 'win32', fs }));
    expect(com.reason).toBe('not-exe');
    const posix = fakeFs({ '/bin/claude': '/opt/claude.bat' }, { '/opt/claude.bat': identity() });
    const error = await rejection(
      resolveExecutable('/bin/claude', { platform: 'posix', fs: posix }),
    );
    expect(error.reason).toBe('batch-file');
  });

  it('refuses a directory and a file without the executable bit', async () => {
    const dir = fakeFs({ '/x/claude': '/x/claude' }, { '/x/claude': identity(false) });
    expect(
      (await rejection(resolveExecutable('/x/claude', { platform: 'posix', fs: dir }))).reason,
    ).toBe('not-regular-file');
    const plain = fakeFs({ '/x/claude': '/x/claude' }, { '/x/claude': identity() }, false);
    const error = await rejection(resolveExecutable('/x/claude', { platform: 'posix', fs: plain }));
    expect(error.reason).toBe('not-executable');
    expect(error.code).toBe('BINARY_REFUSED');
  });
});

describe('resolveExecutable on the host filesystem', () => {
  let root = '';
  const exe = process.platform === 'win32' ? 'tool.exe' : 'tool';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'hudhud-bin-')));
    await writeFile(path.join(root, exe), 'binary');
    await chmod(path.join(root, exe), 0o755);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves an executable file with the host defaults', async () => {
    const resolved = await resolveExecutable(path.join(root, exe));
    expect(resolved.path).toBe(path.join(root, exe));
    expect(resolved.size).toBe(6);
    expect(resolved.mtimeMs).toBeGreaterThan(0);
  });

  it('resolves through a directory link', async () => {
    await symlink(root, path.join(root, '..', `${path.basename(root)}-link`), 'junction');
    try {
      const linked = path.join(`${root}-link`, exe);
      const resolved = await resolveExecutable(linked);
      expect(resolved.requested).toBe(linked);
      expect(resolved.path).toBe(path.join(root, exe));
    } finally {
      await rm(`${root}-link`, { force: true, recursive: false });
    }
  });

  it('reports a missing file and refuses a directory', async () => {
    const missing = await rejection(resolveExecutable(path.join(root, `missing-${exe}`)));
    expect(missing.code).toBe('BINARY_NOT_FOUND');
    const dir = path.join(root, `dir-${exe}`);
    await mkdir(dir);
    expect((await rejection(resolveExecutable(dir))).reason).toBe('not-regular-file');
  });

  it.runIf(process.platform !== 'win32')(
    'posix: refuses a file without the executable bit',
    async () => {
      const plain = path.join(root, 'plain');
      await writeFile(plain, 'x');
      await chmod(plain, 0o644);
      expect((await rejection(resolveExecutable(plain))).reason).toBe('not-executable');
    },
  );

  it.runIf(process.platform === 'win32')('win32: refuses a real .cmd file', async () => {
    const cmd = path.join(root, 'tool.cmd');
    await writeFile(cmd, '@echo off');
    expect((await rejection(resolveExecutable(cmd))).reason).toBe('batch-file');
    expect((await rejection(resolveExecutable(cmd.toUpperCase()))).reason).toBe('batch-file');
  });

  it('uses the host platform semantics', () => {
    expect(hostPlatform()).toBe(process.platform === 'win32' ? 'win32' : 'posix');
  });
});

describe('safeSearchPathEntries', () => {
  it('returns nothing for an unset PATH', () => {
    expect(safeSearchPathEntries(undefined, 'posix')).toEqual([]);
    expect(safeSearchPathEntries('', 'win32')).toEqual([]);
  });

  it('drops empty, relative, current-directory and duplicate entries on posix', () => {
    expect(
      safeSearchPathEntries('/usr/bin::.:bin:./node_modules/.bin:/usr/bin:/opt/x', 'posix'),
    ).toEqual(['/usr/bin', '/opt/x']);
  });

  it('drops unsafe entries on win32', () => {
    expect(
      safeSearchPathEntries(
        [
          'C:\\Windows\\System32',
          '',
          '.',
          'relative',
          '"C:\\Program Files\\x"',
          'C:\\a"b',
          '%SystemRoot%\\x',
          'C:x',
          '\\rooted',
          '\\\\?\\C:\\x',
          'C:\\Windows\\System32',
          '\\\\srv\\share\\bin',
          'C:/Tools',
        ].join(';'),
        'win32',
      ),
    ).toEqual(['C:\\Windows\\System32', '\\\\srv\\share\\bin', 'C:/Tools']);
  });

  it('property: every kept entry passes the lexical path rule', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 20 })),
        fc.constantFrom<ProcessPlatform>('posix', 'win32'),
        (parts, platform) => {
          const value = parts.join(platform === 'win32' ? ';' : ':');
          for (const entry of safeSearchPathEntries(value, platform)) {
            expect(entry.length).toBeGreaterThan(0);
            expect(
              platform === 'win32'
                ? /^([A-Za-z]:[\\/]|[\\/]{2})/.test(entry)
                : entry.startsWith('/'),
            ).toBe(true);
          }
        },
      ),
    );
  });
});
