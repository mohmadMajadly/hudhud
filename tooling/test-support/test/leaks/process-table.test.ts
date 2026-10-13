import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hostProcessTable,
  linuxProcessTable,
  parseLinuxProcess,
  parseWin32Processes,
  powerShellRunner,
  procReads,
  runCommand,
  win32ProcessTable,
  WIN32_PROCESS_SCRIPT,
} from '../../src/leaks/process-table.js';
import type { ProcReads } from '../../src/leaks/process-table.js';

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
      'ToFileTimeUtc',
      'CommandLine',
      'ConvertTo-Json',
    ]) {
      expect(WIN32_PROCESS_SCRIPT).toContain(name);
    }
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
  it('runs a command and reports failures', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'])).resolves.toBe(
      'ok',
    );
    await expect(runCommand(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow(/failed/);
  });

  it('runs PowerShell by its absolute System32 path (and fails off Windows)', async () => {
    const run = powerShellRunner({ SystemRoot: process.env['SystemRoot'] });
    const outcome = run("Write-Output 'hudhud'").then(
      (text) => text.trim(),
      () => 'unavailable',
    );
    expect(await outcome).toBe(process.platform === 'win32' ? 'hudhud' : 'unavailable');
  }, 60_000);

  it('picks the source of each platform', () => {
    expect(hostProcessTable('win32', {}).source).toBe('win32-cim');
    expect(hostProcessTable('linux', {}).source).toBe('linux-proc');
    expect(() => hostProcessTable('darwin', {})).toThrow(/M1/);
  });

  it('reads the real table of this host, including this process and its command line', async () => {
    const table = hostProcessTable(process.platform, process.env);
    const self = (await table.read()).find((row) => row.pid === process.pid);
    expect(self?.startTime).toMatch(/^[0-9]+$/);
    expect(self?.commandLine).toMatch(/node/i);
  }, 60_000);

  it('fails to read the other platform', async () => {
    const other = hostProcessTable(process.platform === 'win32' ? 'linux' : 'win32', {});
    await expect(other.read()).rejects.toThrow();
  }, 60_000);
});
