// POSIX adapters: real /proc reads and kill(2) on this test's own children
// (verified by pid and start time), plus injected failures for the errno
// mapping. Nothing here signals a process the test did not start.

import { spawn as nodeSpawn } from 'node:child_process';
import process from 'node:process';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  createLinuxProcTableCalls,
  createPosixSignalCalls,
} from '../../../../src/process/os/posix.js';
import { findIdentity } from '../../../../src/process/tree/descendants.js';
import { parseProcStat } from '../../../../src/process/tree/proc-stat.js';
import { ChildTracker, hostSnapshot, within } from '../spawn-support.js';

const LINUX = process.platform === 'linux';
const POSIX = process.platform !== 'win32';
const TIMEOUT = 60_000;

const tracker = new ChildTracker();

afterEach(async () => {
  await tracker.assertNoLeaks();
}, TIMEOUT);

afterAll(async () => {
  await tracker.assertNoneListed();
}, TIMEOUT);

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('createLinuxProcTableCalls', () => {
  it.runIf(LINUX)('lists this process and reads its stat', async () => {
    const table = createLinuxProcTableCalls();
    expect(table.source).toBe('linux-proc');
    const pids = await table.listPids();
    expect(pids).toContain(process.pid);
    expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
    const stat = await table.readStat(process.pid);
    expect(stat).not.toBeNull();
    expect(parseProcStat(stat ?? new Uint8Array(), process.pid)?.pid).toBe(process.pid);
  });

  it.runIf(LINUX)('returns null for a pid above every possible pid_max (ENOENT)', async () => {
    await expect(createLinuxProcTableCalls().readStat(4_194_305)).resolves.toBeNull();
  });

  it.runIf(POSIX && !LINUX)('has no /proc to read on other POSIX hosts', async () => {
    const table = createLinuxProcTableCalls();
    await expect(table.listPids()).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(table.readStat(1)).resolves.toBeNull();
  });

  it('reads exactly /proc and /proc/<pid>/stat, keeping only pid entries', async () => {
    const read: string[] = [];
    const table = createLinuxProcTableCalls({
      readdir: (path) => {
        read.push(path);
        return Promise.resolve(['1', '01', 'self', '23', 'net', '4194304', '-3']);
      },
      readFile: (path) => {
        read.push(path);
        return Promise.resolve(new Uint8Array([1]));
      },
    });
    await expect(table.listPids()).resolves.toEqual([1, 23, 4194304]);
    await expect(table.readStat(23)).resolves.toEqual(new Uint8Array([1]));
    expect(read).toEqual(['/proc', '/proc/23/stat']);
  });

  it('maps a vanished process to null and rethrows anything else', async () => {
    const failing = (code: string) =>
      createLinuxProcTableCalls({
        readdir: () => Promise.resolve([]),
        readFile: () => Promise.reject(errno(code)),
      });
    await expect(failing('ENOENT').readStat(5)).resolves.toBeNull();
    await expect(failing('ESRCH').readStat(5)).resolves.toBeNull();
    await expect(failing('EACCES').readStat(5)).rejects.toMatchObject({ code: 'EACCES' });
    const odd = createLinuxProcTableCalls({
      readdir: () => Promise.resolve([]),
      readFile: () => Promise.reject(new Error('no code')),
    });
    await expect(odd.readStat(5)).rejects.toThrow('no code');
  });

  it('refuses a pid that is not a positive safe integer', async () => {
    const table = createLinuxProcTableCalls();
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      await expect(table.readStat(pid)).rejects.toBeInstanceOf(RangeError);
    }
  });
});

describe('createPosixSignalCalls', () => {
  it('calls kill(pid) and kill(-pgid) and maps the errno', () => {
    const calls: [number, string][] = [];
    const outcomes = [undefined, errno('ESRCH'), errno('EPERM')];
    const signals = createPosixSignalCalls((pid, signal) => {
      calls.push([pid, signal]);
      const outcome = outcomes.shift();
      if (outcome !== undefined) throw outcome;
      return true;
    });
    expect(signals.signalProcess(123, 'SIGTERM')).toBe('sent');
    expect(signals.signalGroup(456, 'SIGKILL')).toBe('no-such-process');
    expect(signals.signalProcess(789, 'SIGKILL')).toBe('not-permitted');
    expect(calls).toEqual([
      [123, 'SIGTERM'],
      [-456, 'SIGKILL'],
      [789, 'SIGKILL'],
    ]);
  });

  it('rethrows an unexpected kill failure', () => {
    const signals = createPosixSignalCalls(() => {
      throw errno('EINVAL');
    });
    expect(() => signals.signalProcess(5, 'SIGTERM')).toThrow('EINVAL');
  });

  it('never lets 0 or a negative value reach kill(2): no own-group, no broadcast', () => {
    const calls: number[] = [];
    const signals = createPosixSignalCalls((pid) => calls.push(pid));
    for (const pid of [0, -1, -42, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => signals.signalProcess(pid, 'SIGKILL')).toThrow(RangeError);
    }
    for (const pgid of [1, 0, -1, 2.5]) {
      expect(() => signals.signalGroup(pgid, 'SIGKILL')).toThrow(RangeError);
    }
    expect(calls).toEqual([]);
  });

  it.runIf(POSIX)(
    'signals its own child, verified by pid and start time',
    async () => {
      const child = await tracker.node('process.stdin.resume(); setInterval(() => {}, 1000)');
      const { identity } = await child.identity;
      expect(identity).not.toBeNull();
      const snapshot = await hostSnapshot();
      expect(identity === null ? null : findIdentity(snapshot.records, identity)).not.toBeNull();
      expect(createPosixSignalCalls().signalProcess(child.pid, 'SIGTERM')).toBe('sent');
      await expect(within(child.exited, 10_000, 'SIGTERM')).resolves.toEqual({
        code: null,
        signal: 'SIGTERM',
      });
    },
    TIMEOUT,
  );

  it.runIf(LINUX)(
    'signals the group of its own detached child (pgid equals the child pid)',
    async () => {
      const child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        shell: false,
        detached: true,
        env: {},
        stdio: 'ignore',
      });
      const exited = new Promise<NodeJS.Signals | null>((resolve) => {
        child.once('exit', (_code, signal) => {
          resolve(signal);
        });
      });
      await new Promise((resolve) => child.once('spawn', resolve));
      const pid = child.pid ?? 0;
      const record = (await hostSnapshot()).records.find((entry) => entry.pid === pid);
      // Verified: our child, leader of its own group.
      expect(record).toMatchObject({ pid, ppid: process.pid, pgid: pid });
      expect(createPosixSignalCalls().signalGroup(pid, 'SIGKILL')).toBe('sent');
      await expect(within(exited, 10_000, 'group SIGKILL')).resolves.toBe('SIGKILL');
      const after = await hostSnapshot();
      expect(record === undefined ? null : findIdentity(after.records, record)).toBeNull();
    },
    TIMEOUT,
  );
});
