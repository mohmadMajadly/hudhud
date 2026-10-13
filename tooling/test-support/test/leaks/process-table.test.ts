import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DARWIN_ARGS_PS,
  DARWIN_READ_LIMITS,
  DARWIN_PS_ENV,
  DARWIN_PS_PATH,
  darwinProcessTable,
  hostProcessTable,
  linuxProcessTable,
  parseDarwinProcesses,
  parseLinuxProcess,
  parseWin32Processes,
  powerShellRunner,
  procReads,
  runCommand,
  runCommandBytes,
  win32ProcessTable,
  WIN32_PROCESS_SCRIPT,
  WIN32_READ_LIMITS,
} from '../../src/leaks/process-table.js';
import type { ProcReads } from '../../src/leaks/process-table.js';
import { hangGuard, HOST_TABLE_READ_MS } from '../hang-guard.js';

/** The real `setTimeout`, captured before any test fakes the timers. */
const realSetTimeout = setTimeout;

const STAT_TAIL = 'S 1 100 100 0 -1 4194560 10 0 0 0 0 0 0 0 20 0 1 0 98765 1000 100';

describe('parseWin32Processes', () => {
  it('parses rows, defaults missing names and command lines, skips malformed entries', () => {
    const text = `${String.fromCharCode(0xfeff)}${JSON.stringify([
      { p: 10, pp: 4, t: '133000000000000000', n: 'node.exe', c: 'node a.js' },
      { p: 11, pp: 10, t: '133000000000000010', n: null, c: null },
      { p: 0, pp: 0, t: '', n: 'System Idle Process', c: null },
      { p: 0, pp: 0, t: '1', n: 'System Idle Process', c: 'idle' },
      { p: 12, pp: -1, t: '1', n: 'x', c: '' },
      { p: 13, pp: 1, t: 'abc', n: 'x', c: '' },
      { p: 14, pp: 1, t: 5, n: 'x', c: '' },
      'junk',
      null,
    ])}`;
    expect(parseWin32Processes(text)).toEqual([
      {
        pid: 10,
        ppid: 4,
        // FILETIME (100 ns) truncated to the canonical microseconds of the core parser.
        startTime: '13300000000000000',
        name: 'node.exe',
        commandLine: 'node a.js',
      },
      { pid: 11, ppid: 10, startTime: '13300000000000001', name: '', commandLine: '' },
    ]);
  });

  it('accepts a single object and survives junk', () => {
    expect(parseWin32Processes('{"p":5,"pp":0,"t":"7","n":"a","c":"b"}')).toHaveLength(1);
    expect(parseWin32Processes('not json')).toEqual([]);
  });

  it('asks for every field it parses', () => {
    for (const name of [
      'ProcessId',
      'ParentProcessId',
      'CreationDate',
      'ToFileTimeUtc',
      'Name',
      'CommandLine',
      'JavaScriptSerializer',
    ]) {
      expect(WIN32_PROCESS_SCRIPT).toContain(name);
    }
    // No cmdlet: nothing makes PowerShell discover or auto-load a module.
    expect(WIN32_PROCESS_SCRIPT).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
  });
});

describe('parseLinuxProcess', () => {
  it('takes fields after the last parenthesis and joins the command line', () => {
    expect(parseLinuxProcess(`42 (we ird) (name) ${STAT_TAIL}`, 'node\0-e\0x\0')).toEqual({
      pid: 42,
      ppid: 1,
      startTime: '98765',
      name: 'we ird) (name',
      commandLine: 'node -e x',
    });
  });

  it.each([
    'no parens',
    `x (a) ${STAT_TAIL}`,
    '42 (a) S',
    `42 (a) S -3 ${STAT_TAIL}`,
    ') 42 (',
    `0 (idle) ${STAT_TAIL}`,
    `42 (a) S ${'1 '.repeat(18)}xx`,
  ])('refuses %j', (stat) => {
    expect(parseLinuxProcess(stat, '')).toBeNull();
  });
});

describe('table sources', () => {
  it('reads Windows through the injected runner', async () => {
    const scripts: string[] = [];
    const table = win32ProcessTable((script) => {
      scripts.push(script);
      return Promise.resolve('[{"p":9,"pp":1,"t":"3","n":"a","c":"b"}]');
    });
    expect(table.source).toBe('win32-cim');
    expect(await table.read()).toHaveLength(1);
    expect(scripts).toEqual([WIN32_PROCESS_SCRIPT]);
  });

  it('reads Linux through the injected /proc reads', async () => {
    const files: Record<string, string | null> = {
      '7/stat': `7 (init) ${STAT_TAIL}`,
      '7/cmdline': null,
      '8/stat': null,
      '9/stat': 'garbage',
      '9/cmdline': '',
    };
    const reads: ProcReads = {
      list: () => Promise.resolve(['self', '7', '8', '9']),
      read: (pid, file) => Promise.resolve(files[`${pid}/${file}`] ?? null),
    };
    const table = linuxProcessTable(reads);
    expect(table.source).toBe('linux-proc');
    expect(await table.read()).toEqual([
      { pid: 7, ppid: 1, startTime: '98765', name: 'init', commandLine: '' },
    ]);
  });

  describe('procReads', () => {
    let root = '';

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'hudhud-proc-'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    });

    it('lists and reads a /proc-shaped tree; missing files read as null', async () => {
      await mkdir(path.join(root, '5'));
      await writeFile(path.join(root, '5', 'stat'), `5 (a) ${STAT_TAIL}`);
      const reads = procReads(root);
      expect(await reads.list()).toEqual(['5']);
      expect(await reads.read('5', 'stat')).toContain('(a)');
      expect(await reads.read('5', 'cmdline')).toBeNull();
      expect(await linuxProcessTable(reads).read()).toHaveLength(1);
    });
  });
});

describe('host commands', () => {
  it('runs a command with exactly the given environment and returns its bytes', async () => {
    vi.stubEnv('HUDHUD_HOST_CANARY', 'host-only');
    const out = await runCommandBytes(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)) + "\xe9")'],
      { HUDHUD_ONLY: '1' },
    );
    const text = Buffer.from(out).toString('utf8');
    expect(text.endsWith('\u00e9')).toBe(true);
    const names = JSON.parse(text.slice(0, -1)) as string[];
    vi.unstubAllEnvs();
    expect(names).toContain('HUDHUD_ONLY');
    expect(names).not.toContain('HUDHUD_HOST_CANARY');
    await expect(runCommandBytes(process.execPath, ['-e', 'process.exit(3)'], {})).rejects.toThrow(
      /failed/,
    );
  });

  it('runs a command and reports failures', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'])).resolves.toBe(
      'ok',
    );
    await expect(runCommand(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow(
      /failed: exit code 3, signal null$/,
    );
    const missing = path.join(tmpdir(), 'hudhud-missing-dir', 'missing.exe');
    const error = await runCommandBytes(missing, [], {}).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/failed$/);
    expect((error as Error).cause).toMatchObject({ code: 'ENOENT' });
  });

  it('bounds the reads like the core process-table reads', () => {
    expect(WIN32_READ_LIMITS).toEqual({ timeoutMs: 60_000, maxStdoutBytes: 64 * 1024 * 1024 });
    expect(DARWIN_READ_LIMITS).toEqual({ timeoutMs: 30_000, maxStdoutBytes: 64 * 1024 * 1024 });
    expect(Object.isFrozen(WIN32_READ_LIMITS)).toBe(true);
    expect(Object.isFrozen(DARWIN_READ_LIMITS)).toBe(true);
  });

  describe('bounds', () => {
    let scratch = '';

    beforeEach(async () => {
      scratch = await mkdtemp(path.join(tmpdir(), 'hudhud-bounded-'));
    });

    afterEach(async () => {
      await rm(scratch, { recursive: true, force: true, maxRetries: 10 });
    });

    /** Polls of {@link poll}, 50 ms apart. */
    const POLLS = 200;
    /** The real-time bound of one {@link poll}, besides its probes. */
    const POLL_MS = POLLS * 50;

    /** A node script that writes its pid to `argv[1]`, optionally floods stdout, then idles. */
    const IDLER =
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid));" +
      "if (process.argv[2] === 'flood') process.stdout.write('x'.repeat(100000));" +
      'setInterval(() => {}, 1000);';

    /** Polls `ready` every 50 ms of real time (also under fake timers), for at most 10 s. */
    async function poll<T>(ready: () => Promise<T | undefined>): Promise<T | undefined> {
      for (let i = 0; i < POLLS; i += 1) {
        const value = await ready();
        if (value !== undefined) return value;
        await new Promise((resolve) => realSetTimeout(resolve, 50));
      }
      return undefined;
    }

    /** Whether `pid` (this test's own command) still runs; probed with signal 0 only. */
    function isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    /** Whether `pid` is gone within one {@link poll}. */
    async function gone(pid: number): Promise<boolean> {
      const result = await poll(() => Promise.resolve(isAlive(pid) ? undefined : true));
      return result === true;
    }

    /** The pid the command wrote to `file`. */
    async function pidFrom(file: string): Promise<number> {
      const text = await poll(async () => {
        const read = await readFile(file, 'utf8').catch(() => '');
        return read === '' ? undefined : read;
      });
      if (text === undefined) throw new Error(`no pid in ${file}`);
      return Number(text);
    }

    it(
      'kills a command that runs past its timeout, and rejects',
      async () => {
        // The timeout fires on the fake clock, only after the command wrote its pid.
        const pidFile = path.join(scratch, 'timeout.pid');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const started = (async () => {
          const run = runCommand(process.execPath, ['-e', IDLER, pidFile], {
            timeoutMs: 2000,
            maxStdoutBytes: 1024,
          });
          run.catch(() => undefined);
          const pid = await pidFrom(pidFile);
          vi.advanceTimersByTime(1999);
          expect(isAlive(pid)).toBe(true);
          vi.advanceTimersByTime(1);
          return { run, pid };
        })();
        const { run, pid } = await started.finally(() => {
          vi.useRealTimers();
        });
        await expect(run).rejects.toThrow(/timed out after 2000 ms$/);
        expect(await gone(pid)).toBe(true);
      },
      hangGuard(2 * POLL_MS),
    );

    it(
      'kills a command that writes more than its cap, and rejects',
      async () => {
        const pidFile = path.join(scratch, 'cap.pid');
        const run = runCommandBytes(
          process.execPath,
          ['-e', IDLER, pidFile, 'flood'],
          {},
          { timeoutMs: 30_000, maxStdoutBytes: 1000 },
        );
        await expect(run).rejects.toThrow(/wrote more than 1000 bytes$/);
        expect(await gone(await pidFrom(pidFile))).toBe(true);
      },
      hangGuard(30_000, 2 * POLL_MS),
    );

    it(
      'bounds each PowerShell run',
      async () => {
        const run = powerShellRunner(
          { SystemRoot: process.env['SystemRoot'] },
          { timeoutMs: 30_000, maxStdoutBytes: 3 },
        );
        // Over the cap on Windows; no PowerShell elsewhere.
        await expect(run("Write-Output 'hudhud'")).rejects.toThrow(
          process.platform === 'win32' ? /wrote more than 3 bytes$/ : /failed$/,
        );
      },
      hangGuard(30_000),
    );
  });

  it(
    'runs PowerShell by its absolute System32 path (and fails off Windows)',
    async () => {
      const run = powerShellRunner({ SystemRoot: process.env['SystemRoot'] });
      const outcome = run("Write-Output 'hudhud'").then(
        (text) => text.trim(),
        () => 'unavailable',
      );
      expect(await outcome).toBe(process.platform === 'win32' ? 'hudhud' : 'unavailable');
    },
    hangGuard(WIN32_READ_LIMITS.timeoutMs),
  );

  it('picks the source of each platform', () => {
    expect(hostProcessTable('win32', {}).source).toBe('win32-cim');
    expect(hostProcessTable('linux', {}).source).toBe('linux-proc');
    expect(hostProcessTable('darwin', {}).source).toBe('darwin-ps');
    expect(() => hostProcessTable('aix', {})).toThrow(/no process table source for aix/);
  });

  it(
    'reads the real table of this host, including this process and its command line',
    async () => {
      const table = hostProcessTable(process.platform, process.env);
      const self = (await table.read()).find((row) => row.pid === process.pid);
      expect(self?.startTime).toMatch(/^[0-9]+$/);
      expect(self?.commandLine).toMatch(/node/i);
    },
    hangGuard(HOST_TABLE_READ_MS),
  );

  it(
    'reads the macOS table through /bin/ps, and fails closed on Windows, which has none',
    async () => {
      const outcome = await hostProcessTable('darwin', {})
        .read()
        .then(
          (rows) => (rows.some((row) => row.pid === process.pid) ? 'lists-self' : 'no-self'),
          () => 'failed',
        );
      // procps on Linux, when installed, prints the same columns with a narrower
      // lstart, which the macOS (BSD) layout rejects line by line (research 09).
      const expected =
        process.platform === 'win32'
          ? ['failed']
          : process.platform === 'darwin'
            ? ['lists-self']
            : ['no-self', 'failed'];
      expect(expected).toContain(outcome);
    },
    hangGuard(DARWIN_READ_LIMITS.timeoutMs),
  );

  it(
    'fails to read the other platform',
    async () => {
      const other = hostProcessTable(process.platform === 'win32' ? 'linux' : 'win32', {});
      await expect(other.read()).rejects.toThrow();
      // The other platform's read: the CIM query (bounded) or a /proc read (no child).
    },
    hangGuard(WIN32_READ_LIMITS.timeoutMs),
  );
});

describe('darwin source', () => {
  /**
   * One `ps` line in the macOS layout of the core: pid ppid pgid stat, then
   * lstart (C locale, UTC) padded to 28 columns, and the last column.
   */
  const line = (pid: number, ppid: number, lstart: string, last: string): string =>
    `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pid).padStart(5)} S    ${lstart.padEnd(28)} ${last}`;
  const START = 'Mon Oct 12 17:02:31 2026';
  const LATER = 'Mon Oct 12 17:02:32 2026';
  const bytes = (lines: readonly string[]): Uint8Array =>
    new TextEncoder().encode(`${lines.join('\n')}\n`);

  it('joins the identity table and the command lines by pid and start time', () => {
    const table = bytes([
      line(1, 0, START, '/sbin/launchd'),
      line(501, 1, START, '/usr/local/bin/node'),
      line(502, 501, START, 'node'),
      line(503, 501, START, 'sh'),
      line(504, 501, START, 'forged'),
      line(504, 501, START, 'forged'),
      'garbage',
      line(0, 0, START, 'kernel_task'),
    ]);
    const commandLines = bytes([
      line(501, 1, START, '/usr/local/bin/node /private/tmp/hudhud-run-x/work a b'),
      // pid 502 was reused between the two runs: another start time, so no command line.
      line(502, 501, LATER, 'node /somewhere/else'),
      line(503, 501, START, 'sh -c x'),
      line(503, 501, START, 'sh -c forged'),
    ]);
    expect(parseDarwinProcesses(table, commandLines)).toEqual([
      { pid: 1, ppid: 0, startTime: '1791824551', name: '/sbin/launchd', commandLine: '' },
      {
        pid: 501,
        ppid: 1,
        startTime: '1791824551',
        name: '/usr/local/bin/node',
        commandLine: '/usr/local/bin/node /private/tmp/hudhud-run-x/work a b',
      },
      { pid: 502, ppid: 501, startTime: '1791824551', name: 'node', commandLine: '' },
      { pid: 503, ppid: 501, startTime: '1791824551', name: 'sh', commandLine: '' },
    ]);
  });

  it('reads both ps runs through the injected reads', async () => {
    const table = darwinProcessTable({
      identities: () => Promise.resolve(bytes([line(7, 1, START, 'a')])),
      commandLines: () => Promise.resolve(bytes([line(7, 1, START, 'a --flag')])),
    });
    expect(table.source).toBe('darwin-ps');
    expect(await table.read()).toEqual([
      { pid: 7, ppid: 1, startTime: '1791824551', name: 'a', commandLine: 'a --flag' },
    ]);
    const failing = darwinProcessTable({
      identities: () => Promise.reject(new Error('ps failed')),
      commandLines: () => Promise.resolve(new Uint8Array()),
    });
    await expect(failing.read()).rejects.toThrow('ps failed');
  });

  it('runs /bin/ps by absolute path in the core ps contract, with args for comm', () => {
    expect(DARWIN_PS_PATH).toBe('/bin/ps');
    expect(DARWIN_ARGS_PS).toEqual(['-A', '-ww', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,args=']);
    expect(DARWIN_PS_ENV).toEqual({ LC_ALL: 'C', TZ: 'UTC0' });
  });
});
