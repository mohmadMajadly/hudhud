import process from 'node:process';

import { describe, expect, it } from 'vitest';

import {
  createTaskkillCalls,
  DEFAULT_TASKKILL_TIMEOUT_MS,
  nodeTaskkillDeps,
  resolveTaskkillPath,
  systemRootFrom,
  taskkillArgv,
  TaskkillUnavailableError,
  WIN32_DEFAULT_SYSTEM_ROOT,
  type TaskkillDeps,
  type TaskkillExecError,
  type TaskkillExecOptions,
  type TaskkillFs,
} from '../../src/process/taskkill.js';

const EXE = 'C:\\Windows\\System32\\taskkill.exe';

function fakeFs(overrides: Partial<TaskkillFs> = {}): TaskkillFs & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    realpath: (path) => {
      seen.push(`realpath:${path}`);
      return Promise.resolve(path);
    },
    lstat: (path) => {
      seen.push(`lstat:${path}`);
      return Promise.resolve({ isFile: () => true, isSymbolicLink: () => false });
    },
    ...overrides,
  };
}

interface ExecCall {
  file: string;
  args: readonly string[];
  options: TaskkillExecOptions;
}

function deps(
  env: Record<string, string | undefined>,
  error: TaskkillExecError | null = null,
  extra: Partial<TaskkillDeps> = {},
): TaskkillDeps & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    env,
    fs: fakeFs(),
    calls,
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(error);
    },
    ...extra,
  };
}

describe('systemRootFrom', () => {
  it('uses C:\\Windows when SystemRoot is absent', () => {
    expect(systemRootFrom({})).toEqual({ ok: true, root: WIN32_DEFAULT_SYSTEM_ROOT });
    expect(systemRootFrom({ SystemRoot: undefined })).toEqual({ ok: true, root: 'C:\\Windows' });
  });

  it('accepts a plain drive-absolute path under any spelling of the name', () => {
    expect(systemRootFrom({ SystemRoot: 'D:\\WinNT' })).toEqual({ ok: true, root: 'D:\\WinNT' });
    expect(systemRootFrom({ SYSTEMROOT: 'c:\\windows', systemroot: 'c:\\windows' })).toEqual({
      ok: true,
      root: 'c:\\windows',
    });
    expect(systemRootFrom({ SystemRoot: 'E:\\a b\\Win-1' })).toEqual({
      ok: true,
      root: 'E:\\a b\\Win-1',
    });
  });

  it('refuses disagreeing spellings', () => {
    expect(systemRootFrom({ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Evil' })).toEqual({
      ok: false,
      reason: 'system-root-ambiguous',
    });
  });

  it.each([
    '',
    'Windows',
    '\\Windows',
    'C:Windows',
    'C:\\',
    'C:/Windows',
    'C:\\Windows/System32',
    '\\\\server\\share\\Windows',
    '\\\\?\\C:\\Windows',
    '\\\\.\\C:\\Windows',
    'C:\\Windows\\',
    'C:\\Win\\\\dows',
    'C:\\Windows\\..\\Evil',
    'C:\\Windows\\.',
    'C:\\Windows ',
    'C:\\Windows.',
    'C:\\CON',
    'C:\\Win:ads',
    'C:\\Win*',
    'C:\\Win\u0001',
    'C:\\Win\u0000',
    'C:\\Win\ud800',
  ])('refuses %j', (root) => {
    expect(systemRootFrom({ SystemRoot: root })).toEqual({
      ok: false,
      reason: 'system-root-invalid',
    });
  });
});

describe('resolveTaskkillPath', () => {
  it('resolves %SystemRoot%\\System32\\taskkill.exe and never consults PATH', async () => {
    const fs = fakeFs();
    const resolved = await resolveTaskkillPath({
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\evil', Path: 'C:\\evil' },
      fs,
    });
    expect(resolved).toEqual({ path: EXE, systemRoot: 'C:\\Windows' });
    expect(fs.seen).toEqual([`realpath:${EXE}`, `lstat:${EXE}`]);
  });

  it('accepts a realpath that differs only in case, and returns it', async () => {
    const fs = fakeFs({ realpath: () => Promise.resolve('C:\\WINDOWS\\system32\\TASKKILL.EXE') });
    expect(await resolveTaskkillPath({ env: {}, fs })).toEqual({
      path: 'C:\\WINDOWS\\system32\\TASKKILL.EXE',
      systemRoot: 'C:\\Windows',
    });
  });

  async function refusal(
    env: Record<string, string>,
    fs: TaskkillFs,
  ): Promise<TaskkillUnavailableError> {
    const error: unknown = await resolveTaskkillPath({ env, fs }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskkillUnavailableError);
    return error as TaskkillUnavailableError;
  }

  it('refuses an invalid or ambiguous SystemRoot without touching the filesystem', async () => {
    const fs = fakeFs();
    expect((await refusal({ SystemRoot: '\\\\host\\share' }, fs)).reason).toBe(
      'system-root-invalid',
    );
    expect((await refusal({ SystemRoot: 'C:\\A', SYSTEMROOT: 'C:\\B' }, fs)).reason).toBe(
      'system-root-ambiguous',
    );
    expect(fs.seen).toEqual([]);
  });

  it('refuses a missing file', async () => {
    const cause = Object.assign(new Error('nope'), { code: 'ENOENT' });
    const error = await refusal({}, fakeFs({ realpath: () => Promise.reject(cause) }));
    expect(error).toMatchObject({
      reason: 'not-found',
      code: 'TASKKILL_UNAVAILABLE',
      name: 'TaskkillUnavailableError',
      cause,
    });
    expect(error.message).toBe('taskkill.exe is unavailable: not-found');
    const lstatFails = await refusal({}, fakeFs({ lstat: () => Promise.reject(cause) }));
    expect(lstatFails.reason).toBe('not-found');
  });

  it('refuses a junction or link that redirects the path', async () => {
    const fs = fakeFs({ realpath: () => Promise.resolve('D:\\planted\\taskkill.exe') });
    expect((await refusal({}, fs)).reason).toBe('redirected');
  });

  it('refuses anything but a regular file', async () => {
    for (const stats of [
      { isFile: () => false, isSymbolicLink: () => false },
      { isFile: () => true, isSymbolicLink: () => true },
    ]) {
      const fs = fakeFs({ lstat: () => Promise.resolve(stats) });
      expect((await refusal({}, fs)).reason).toBe('not-regular-file');
    }
  });

  it.runIf(process.platform !== 'win32')('fails closed on a host without System32', async () => {
    const error: unknown = await resolveTaskkillPath({
      env: { SystemRoot: 'C:\\Windows' },
      ...nodeTaskkillDeps,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'not-found' });
  });

  it.runIf(process.platform === 'win32')('resolves the real taskkill.exe', async () => {
    const { path, systemRoot } = await resolveTaskkillPath({
      env: process.env,
      ...nodeTaskkillDeps,
    });
    expect(path.toLowerCase()).toBe(`${systemRoot}\\System32\\taskkill.exe`.toLowerCase());
  });
});

describe('taskkillArgv', () => {
  it('builds /T /F /PID <pid>', () => {
    expect(taskkillArgv(1234)).toEqual(['/T', '/F', '/PID', '1234']);
    expect(taskkillArgv(0xffff_ffff)).toEqual(['/T', '/F', '/PID', '4294967295']);
  });

  it.each([0, 4, -8, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32])(
    'refuses pid %d',
    (pid) => {
      expect(() => taskkillArgv(pid)).toThrow(RangeError);
    },
  );
});

describe('createTaskkillCalls', () => {
  it('runs the absolute System32 path with shell:false, a fixed env and a timeout', async () => {
    const d = deps({ SystemRoot: 'C:\\Windows', PATH: 'C:\\evil', NODE_OPTIONS: '--evil' });
    expect(await createTaskkillCalls(d).taskkillTree(4242)).toEqual({ exitCode: 0 });
    expect(d.calls).toEqual([
      {
        file: EXE,
        args: ['/T', '/F', '/PID', '4242'],
        options: {
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: false,
          cwd: 'C:\\Windows\\System32',
          env: { SystemRoot: 'C:\\Windows' },
          timeout: DEFAULT_TASKKILL_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 65536,
        },
      },
    ]);
  });

  it('honours a custom timeout', async () => {
    const d = deps({}, null, { timeoutMs: 1234 });
    await createTaskkillCalls(d).taskkillTree(8);
    expect(d.calls[0]?.options.timeout).toBe(1234);
  });

  it('maps the exit code, and spawn failures or timeouts to null', async () => {
    const cases: [TaskkillExecError, number | null][] = [
      [{ code: 128 }, 128],
      [{ code: 1 }, 1],
      [{ code: 'ENOENT' }, null],
      [{ code: null }, null],
      [{}, null],
    ];
    for (const [error, exitCode] of cases) {
      expect(await createTaskkillCalls(deps({}, error)).taskkillTree(8)).toEqual({ exitCode });
    }
  });

  it('spawns nothing for a refused pid or a refused executable', async () => {
    const badPid = deps({});
    await expect(createTaskkillCalls(badPid).taskkillTree(4)).rejects.toThrow(RangeError);
    expect(badPid.calls).toEqual([]);

    const badRoot = deps({ SystemRoot: 'C:\\Windows\\..\\Users' });
    await expect(createTaskkillCalls(badRoot).taskkillTree(8)).rejects.toBeInstanceOf(
      TaskkillUnavailableError,
    );
    expect(badRoot.calls).toEqual([]);
  });

  it('uses the host execFile and filesystem by default', () => {
    expect(typeof nodeTaskkillDeps.execFile).toBe('function');
    expect(typeof nodeTaskkillDeps.fs.realpath).toBe('function');
    expect(typeof nodeTaskkillDeps.fs.lstat).toBe('function');
  });
});
