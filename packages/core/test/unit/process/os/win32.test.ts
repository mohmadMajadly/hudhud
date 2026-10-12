// Windows adapters: the exact commands through a recording runner on every
// OS; on Windows the real CIM query and a real `taskkill /T /F` of this
// test's own child tree (verified by pid and start time first).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CIM_SCRIPT,
  createWin32CimTableCalls,
  createWin32TerminateCalls,
  POWERSHELL_ARGS,
  runCommand,
  system32Layout,
  systemRootOf,
  type CommandRunner,
} from '../../../../src/process/os/win32.js';
import { findIdentity } from '../../../../src/process/tree/descendants.js';
import { compareStartTime } from '../../../../src/process/tree/start-time.js';
import { parseWin32ProcessJson } from '../../../../src/process/tree/win32.js';
import {
  CHILD_CWD,
  ChildTracker,
  hostSnapshot,
  identityFromPidFile,
  PID_FILE_IDLER,
  within,
} from '../spawn-support.js';

const WIN32 = process.platform === 'win32';
const TIMEOUT = 60_000;

const tracker = new ChildTracker();
let scratch = '';

beforeAll(async () => {
  scratch = await mkdtemp(path.join(CHILD_CWD, 'hudhud-win32-'));
});

afterAll(async () => {
  await tracker.assertNoneListed();
  await rm(scratch, { recursive: true, force: true });
}, TIMEOUT);

afterEach(async () => {
  await tracker.assertNoLeaks();
}, TIMEOUT);

const HOST_ENV = { SystemRoot: 'D:\\Win' };

function recorder(exitCode: number | null = 0): {
  readonly run: CommandRunner;
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    run: (file, args, env) => {
      calls.push({ file, args, env });
      return Promise.resolve({ exitCode, stdout: new Uint8Array([0x5b, 0x5d]) });
    },
  };
}

describe('systemRootOf', () => {
  it('accepts a plain absolute drive path under any case of the name', () => {
    expect(systemRootOf({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows');
    expect(systemRootOf({ systemroot: 'c:\\WINDOWS' })).toBe('c:\\WINDOWS');
    expect(systemRootOf({ SYSTEMROOT: 'E:\\OS\\Win dows' })).toBe('E:\\OS\\Win dows');
  });

  it.each([
    [{}],
    [{ SystemRoot: undefined }],
    [{ SystemRoot: '' }],
    [{ SystemRoot: 'Windows' }],
    [{ SystemRoot: 'C:' }],
    [{ SystemRoot: 'C:\\' }],
    [{ SystemRoot: 'C:\\Windows\\' }],
    [{ SystemRoot: 'C:Windows' }],
    [{ SystemRoot: '\\\\server\\share\\Windows' }],
    [{ SystemRoot: '\\\\?\\C:\\Windows' }],
    [{ SystemRoot: 'C:\\Windows\\..\\Users\\x' }],
    [{ SystemRoot: 'C:\\.\\Windows' }],
    [{ SystemRoot: 'C:/Windows' }],
    [{ SystemRoot: 'C:\\Win\ndows' }],
    [{ SystemRoot: 'C:\\Win:dows' }],
  ])('refuses %j', (env) => {
    expect(() => systemRootOf(env)).toThrow(/SystemRoot/);
  });
});

describe('system32Layout', () => {
  it('derives absolute System32 paths and a System32-only environment', () => {
    expect(system32Layout('C:\\Windows')).toEqual({
      powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      taskkill: 'C:\\Windows\\System32\\taskkill.exe',
      env: {
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
        PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        WINDIR: 'C:\\Windows',
        HOMEDRIVE: '',
        HOMEPATH: '',
        LOGONSERVER: '',
        SYSTEMDRIVE: '',
        TEMP: 'C:\\Windows\\Temp',
        TMP: 'C:\\Windows\\Temp',
        USERDOMAIN: '',
        USERNAME: '',
        USERPROFILE: 'C:\\Windows',
      },
    });
  });
});

describe('createWin32CimTableCalls', () => {
  it('runs exactly powershell.exe -NoProfile -NonInteractive -Command <script> by absolute path', async () => {
    const { run, calls } = recorder();
    const table = createWin32CimTableCalls({ hostEnv: HOST_ENV, run });
    expect(table.source).toBe('win32-cim');
    await expect(table.queryProcesses()).resolves.toEqual(new Uint8Array([0x5b, 0x5d]));
    expect(calls).toEqual([
      {
        file: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', CIM_SCRIPT],
        env: system32Layout('D:\\Win').env,
      },
    ]);
    expect(POWERSHELL_ARGS).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(CIM_SCRIPT).toContain('[Console]::OutputEncoding = [Text.Encoding]::UTF8');
    expect(CIM_SCRIPT).toContain('ToFileTimeUtc()');
    expect(CIM_SCRIPT).toContain('ConvertTo-Json -Compress -InputObject $rows');
    expect(CIM_SCRIPT).not.toContain('"');
  });

  it('rejects on a non-zero exit, and before running anything without a valid SystemRoot', async () => {
    const failing = recorder(1);
    await expect(
      createWin32CimTableCalls({ hostEnv: HOST_ENV, run: failing.run }).queryProcesses(),
    ).rejects.toThrow(/exited with 1/);
    const unset = recorder();
    await expect(
      createWin32CimTableCalls({ hostEnv: {}, run: unset.run }).queryProcesses(),
    ).rejects.toThrow(/SystemRoot/);
    expect(unset.calls).toEqual([]);
  });

  it.runIf(WIN32)(
    'queries the real process table, which lists this process with its parent',
    async () => {
      const table = parseWin32ProcessJson(await createWin32CimTableCalls().queryProcesses());
      expect(table.records.find((record) => record.pid === process.pid)?.ppid).toBe(process.ppid);
      expect(table.records.length).toBeGreaterThan(10);
    },
    TIMEOUT,
  );
});

describe('createWin32TerminateCalls', () => {
  it('runs exactly taskkill.exe /T /F /PID <pid> by absolute path and returns its exit code', async () => {
    const { run, calls } = recorder(128);
    const terminate = createWin32TerminateCalls({ hostEnv: HOST_ENV, run });
    await expect(terminate.taskkillTree(4321)).resolves.toEqual({ exitCode: 128 });
    expect(calls).toEqual([
      {
        file: 'D:\\Win\\System32\\taskkill.exe',
        args: ['/T', '/F', '/PID', '4321'],
        env: system32Layout('D:\\Win').env,
      },
    ]);
  });

  it('refuses a pid that is not a positive safe integer without running anything', async () => {
    const { run, calls } = recorder();
    const terminate = createWin32TerminateCalls({ hostEnv: HOST_ENV, run });
    for (const pid of [0, -4, 1.5, Number.NaN]) {
      await expect(terminate.taskkillTree(pid)).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls).toEqual([]);
  });

  it.runIf(WIN32)(
    'ends its own child and grandchild, both verified by pid and start time first',
    async () => {
      const child = await tracker.node(
        "const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']," +
          " { stdio: 'ignore', windowsHide: true, env: {} });" +
          "g.once('spawn', () => process.stdout.write(String(g.pid))); setInterval(() => {}, 1000);",
      );
      const iterator = child.stdout[Symbol.asyncIterator]();
      const first = await iterator.next();
      const grandchildPid = Number(Buffer.from(first.value ?? []).toString());
      const snapshot = await hostSnapshot();
      expect(child.identity).not.toBeNull();
      const childRecord =
        child.identity === null ? null : findIdentity(snapshot.records, child.identity);
      const grandchild = snapshot.records.find((record) => record.pid === grandchildPid);
      expect(childRecord?.ppid).toBe(process.pid);
      expect(grandchild?.ppid).toBe(child.pid);
      expect(
        compareStartTime(grandchild?.startTime ?? '0', childRecord?.startTime ?? '0'),
      ).toBeGreaterThanOrEqual(0);
      if (grandchild !== undefined) tracker.trackDescendant(grandchild);

      const result = await createWin32TerminateCalls().taskkillTree(child.pid);
      expect(result).toEqual({ exitCode: 0 });
      await within(child.exited, 10_000, 'exit after taskkill');
      await iterator.return?.();
    },
    TIMEOUT,
  );
});

describe('runCommand (win32 copy)', () => {
  const node = process.execPath;

  it(
    'resolves with the exit code and stdout, whatever the code',
    async () => {
      const ok = await runCommand(
        node,
        [
          '-e',
          'process.stdout.write(JSON.stringify([process.argv.slice(1), process.env.HUDHUD_R]))',
          '& |',
        ],
        { HUDHUD_R: 'r' },
      );
      expect(ok.exitCode).toBe(0);
      expect(JSON.parse(Buffer.from(ok.stdout).toString('utf8'))).toEqual([['& |'], 'r']);
      await expect(runCommand(node, ['-e', 'process.exit(7)'], {})).resolves.toMatchObject({
        exitCode: 7,
      });
    },
    TIMEOUT,
  );

  it(
    'rejects when the command cannot be started',
    async () => {
      await expect(
        runCommand(path.join(scratch, 'missing', 'taskkill.exe'), [], {}),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
    TIMEOUT,
  );

  it(
    'ends the command through its handle after the timeout',
    async () => {
      const pidFile = path.join(scratch, 'timeout.pid');
      const settled = runCommand(
        node,
        ['-e', PID_FILE_IDLER, pidFile],
        {},
        {
          timeoutMs: 10_000,
          maxStdoutBytes: 1024,
        },
      ).catch((error: unknown) => error);
      tracker.trackDescendant(await identityFromPidFile(pidFile));
      await writeFile(`${pidFile}.go`, '');
      expect(String(await settled)).toMatch(/timed out after 10000 ms/);
    },
    TIMEOUT,
  );

  it(
    'rejects and ends the command when stdout exceeds the cap',
    async () => {
      const pidFile = path.join(scratch, 'cap.pid');
      const settled = runCommand(
        node,
        ['-e', PID_FILE_IDLER, pidFile, 'flood'],
        {},
        { timeoutMs: 30_000, maxStdoutBytes: 1000 },
      ).catch((error: unknown) => error);
      tracker.trackDescendant(await identityFromPidFile(pidFile));
      await writeFile(`${pidFile}.go`, '');
      expect(String(await settled)).toMatch(/more than 1000 bytes/);
    },
    TIMEOUT,
  );

  it(
    'collects stdout across chunks',
    async () => {
      const child = await runCommand(node, ['-e', "process.stdout.write('a'.repeat(200000))"], {});
      expect(child.stdout.length).toBe(200000);
    },
    TIMEOUT,
  );
});
