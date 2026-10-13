// Windows adapters: the exact commands through a recording runner on every
// OS; on Windows the real CIM query and a real `taskkill /T /F` of this
// test's own child tree (verified by pid and start time first).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CIM_SCRIPT,
  DEFAULT_LIMITS,
  createWin32CimTableCalls,
  POWERSHELL_ARGS,
  runCommand,
  system32Layout,
  systemRootOf,
  type CommandRunner,
} from '../../../../src/process/os/win32.js';
import { osCallsFor } from '../../../../src/process/spawn.js';
import { DEFAULT_TASKKILL_TIMEOUT_MS } from '../../../../src/process/taskkill.js';
import { findIdentity } from '../../../../src/process/tree/descendants.js';
import { compareStartTime } from '../../../../src/process/tree/start-time.js';
import type { ProcessRecord } from '../../../../src/process/tree/types.js';
import { parseWin32ProcessJson } from '../../../../src/process/tree/win32.js';
import {
  CHILD_CWD,
  hangGuard,
  NONE_LISTED_GUARD,
  noLeaksGuard,
  PID_FILE_IDENTITY_MS,
  TABLE_READ_MS,
  ChildTracker,
  hostSnapshot,
  identityFromPidFile,
  PID_FILE_IDLER,
  withFakeTimeouts,
  within,
} from '../spawn-support.js';

const WIN32 = process.platform === 'win32';
// Each test and hook timeout is a hang guard sized from the product bounds
// it consumes (spawn-support.ts hangGuard); TIMEOUT is for tests with none.
const TIMEOUT = 60_000;

const tracker = new ChildTracker();
let scratch = '';

beforeAll(async () => {
  scratch = await mkdtemp(path.join(CHILD_CWD, 'hudhud-win32-'));
});

afterAll(async () => {
  await tracker.assertNoneListed();
  await rm(scratch, { recursive: true, force: true, maxRetries: 10 });
}, NONE_LISTED_GUARD);

afterEach(
  async () => {
    await tracker.assertNoLeaks();
  },
  noLeaksGuard(1, true),
);

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
    expect(CIM_SCRIPT).toContain(
      "'SELECT ProcessId, ParentProcessId, CreationDate, Name FROM Win32_Process'",
    );
    expect(CIM_SCRIPT).toContain('ToFileTimeUtc()');
    expect(CIM_SCRIPT).toContain('[Text.UTF8Encoding]::new($false)');
    // No cmdlet: nothing makes PowerShell discover or auto-load a module.
    expect(CIM_SCRIPT).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
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
    hangGuard(TABLE_READ_MS),
  );

  it.runIf(WIN32)(
    'reports the start times Get-CimInstance reports (CreationDate.ToFileTimeUtc)',
    async () => {
      // The cmdlet form the script replaced, run with the host environment.
      const reference = [
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
        '$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
        "  $t = if ($null -eq $_.CreationDate) { '' } else { $_.CreationDate.ToFileTimeUtc().ToString() }",
        '  [pscustomobject]@{ p = [int64]$_.ProcessId; pp = [int64]$_.ParentProcessId; t = $t; n = $_.Name } })',
        'ConvertTo-Json -Compress -InputObject $rows',
      ].join('\n');
      const layout = system32Layout(systemRootOf(process.env));
      const hostEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      // Canonical microseconds since 1601 of this instant: a process that
      // started earlier and is listed by both queries is one process (its pid
      // cannot have been reused, the reuser would have started later).
      const before = (BigInt(Date.now()) + 11_644_473_600_000n) * 1000n;
      const [ours, theirs] = await Promise.all([
        createWin32CimTableCalls().queryProcesses(),
        runCommand(layout.powershell, [...POWERSHELL_ARGS, reference], hostEnv),
      ]);
      expect(theirs.exitCode).toBe(0);
      const older = (records: readonly ProcessRecord[]): ProcessRecord[] =>
        records.filter((record) => BigInt(record.startTime) < before);
      const cmdlet = new Map(
        older(parseWin32ProcessJson(theirs.stdout).records).map((record) => [record.pid, record]),
      );
      const common = older(parseWin32ProcessJson(ours).records).filter((record) =>
        cmdlet.has(record.pid),
      );
      expect(common.length).toBeGreaterThan(10);
      for (const record of common) {
        expect(record).toEqual(cmdlet.get(record.pid));
      }
    },
    // The two queries run in parallel, each bounded by DEFAULT_LIMITS.
    hangGuard(DEFAULT_LIMITS.timeoutMs),
  );
});

// The Windows terminate calls of the OS seam are the hardened `taskkill.ts`
// calls (W2-Z reconciliation); their command lines are tested in
// test/process/taskkill.test.ts, the composition here.
describe('the win32 terminate calls of osCallsFor', () => {
  const terminate = osCallsFor('win32', process.pid);

  it('are the taskkill.ts calls: the tree kill and the per-process kill', () => {
    if (terminate.platform !== 'win32') throw new Error('expected the win32 calls');
    expect(Object.keys(terminate.terminate).sort()).toEqual(['taskkillProcess', 'taskkillTree']);
  });

  it('refuse a pid that is not a positive safe integer, or 0 or 4, before resolving anything', async () => {
    if (terminate.platform !== 'win32') throw new Error('expected the win32 calls');
    for (const pid of [0, 4, -4, 1.5, Number.NaN]) {
      await expect(terminate.terminate.taskkillTree(pid)).rejects.toBeInstanceOf(RangeError);
      await expect(terminate.terminate.taskkillProcess(pid)).rejects.toBeInstanceOf(RangeError);
    }
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
      const { identity } = await child.identity;
      const snapshot = await hostSnapshot();
      expect(identity).not.toBeNull();
      const childRecord = identity === null ? null : findIdentity(snapshot.records, identity);
      const grandchild = snapshot.records.find((record) => record.pid === grandchildPid);
      expect(childRecord?.ppid).toBe(process.pid);
      expect(grandchild?.ppid).toBe(child.pid);
      expect(
        compareStartTime(grandchild?.startTime ?? '0', childRecord?.startTime ?? '0'),
      ).toBeGreaterThanOrEqual(0);
      if (grandchild !== undefined) tracker.trackDescendant(grandchild);

      const calls = osCallsFor('win32', process.pid);
      if (calls.platform !== 'win32') throw new Error('expected the win32 calls');
      const result = await calls.terminate.taskkillTree(child.pid);
      expect(result).toEqual({ exitCode: 0 });
      await within(child.exited, 10_000, 'exit after taskkill');
      await iterator.return?.();
    },
    // Identity read and snapshot (one table read each), taskkill, the exit wait.
    hangGuard(2 * TABLE_READ_MS, DEFAULT_TASKKILL_TIMEOUT_MS, 10_000),
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
    // Two commands, each bounded by DEFAULT_LIMITS.
    hangGuard(2 * DEFAULT_LIMITS.timeoutMs),
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
      // The timeout fires on the fake clock only after the child's identity
      // was recorded, however long that read takes.
      await withFakeTimeouts(async (advance) => {
        const pidFile = path.join(scratch, 'timeout.pid');
        let done = false;
        const settled = runCommand(
          node,
          ['-e', PID_FILE_IDLER, pidFile],
          {},
          {
            timeoutMs: 10_000,
            maxStdoutBytes: 1024,
          },
        )
          .catch((error: unknown) => error)
          .finally(() => {
            done = true;
          });
        tracker.trackDescendant(await identityFromPidFile(pidFile));
        await writeFile(`${pidFile}.go`, '');
        await advance(9_999);
        expect(done).toBe(false);
        await advance(1);
        expect(String(await settled)).toMatch(/timed out after 10000 ms/);
      });
    },
    // The command times out on the fake clock; the identity read is real.
    hangGuard(PID_FILE_IDENTITY_MS),
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
    // The command (30 s bound) runs while the identity is read.
    hangGuard(Math.max(PID_FILE_IDENTITY_MS, 30_000)),
  );

  it(
    'collects stdout across chunks',
    async () => {
      const child = await runCommand(node, ['-e', "process.stdout.write('a'.repeat(200000))"], {});
      expect(child.stdout.length).toBe(200000);
    },
    hangGuard(DEFAULT_LIMITS.timeoutMs),
  );
});
