// POSIX adapters: real /proc reads and kill(2) on this test's own children
// (verified by pid and start time), plus injected failures for the errno
// mapping. Nothing here signals a process the test did not start.

import { spawn as nodeSpawn } from 'node:child_process';
import process from 'node:process';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  createLinuxProcTableCalls,
  createPosixSignalCalls,
  ForeignProcError,
} from '../../../../src/process/os/posix.js';
import { findIdentity } from '../../../../src/process/tree/descendants.js';
import { parseProcStat } from '../../../../src/process/tree/proc-stat.js';
import { PROC_READ_CONCURRENCY, takeSnapshot } from '../../../../src/process/tree/snapshot.js';
import {
  ChildTracker,
  hangGuard,
  hostSnapshot,
  NONE_LISTED_GUARD,
  noLeaksGuard,
  TABLE_READ_MS,
  within,
} from '../spawn-support.js';

const LINUX = process.platform === 'linux';
const POSIX = process.platform !== 'win32';
// Each test and hook timeout is a hang guard sized from the product bounds
// it consumes (spawn-support.ts hangGuard).

const tracker = new ChildTracker();

afterEach(
  async () => {
    await tracker.assertNoLeaks();
  },
  noLeaksGuard(1, false),
);

afterAll(async () => {
  await tracker.assertNoneListed();
}, NONE_LISTED_GUARD);

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
    const table = createLinuxProcTableCalls(
      {
        readdir: (path) => {
          read.push(path);
          return Promise.resolve(['1', '01', 'self', '23', 'net', '4194304', '-3']);
        },
        readFile: (path) => {
          read.push(path);
          return Promise.resolve(new Uint8Array([1]));
        },
        readlink: (path) => {
          read.push(path);
          return Promise.resolve('77');
        },
      },
      77,
    );
    await expect(table.listPids()).resolves.toEqual([1, 23, 4194304]);
    await expect(table.readStat(23)).resolves.toEqual(new Uint8Array([1]));
    // The namespace check reads /proc/self once.
    expect(read).toEqual(['/proc/self', '/proc', '/proc/23/stat']);
  });

  it('maps a vanished process to null and rethrows anything else', async () => {
    const failing = (code: string) =>
      createLinuxProcTableCalls({
        readdir: () => Promise.resolve([]),
        readFile: () => Promise.reject(errno(code)),
        readlink: () => Promise.resolve(String(process.pid)),
      });
    await expect(failing('ENOENT').readStat(5)).resolves.toBeNull();
    await expect(failing('ESRCH').readStat(5)).resolves.toBeNull();
    await expect(failing('EACCES').readStat(5)).rejects.toMatchObject({ code: 'EACCES' });
    const odd = createLinuxProcTableCalls({
      readdir: () => Promise.resolve([]),
      readFile: () => Promise.reject(new Error('no code')),
      readlink: () => Promise.resolve(String(process.pid)),
    });
    await expect(odd.readStat(5)).rejects.toThrow('no code');
  });

  // Review R3-U1 (confirmed in a Docker pid namespace, plan §5.9 review
  // fixes): with the parent namespace's /proc, pid 8 of this namespace is
  // another process there. The table refuses to read anything.
  it('refuses a /proc of another pid namespace, for good, and checks it once', async () => {
    let links = 0;
    const read: string[] = [];
    const table = createLinuxProcTableCalls(
      {
        readdir: (path) => {
          read.push(path);
          return Promise.resolve(['1', '8']);
        },
        readFile: (path) => {
          read.push(path);
          return Promise.resolve(new Uint8Array([1]));
        },
        readlink: () => {
          links += 1;
          return Promise.resolve('54');
        },
      },
      1,
    );
    await expect(table.listPids()).rejects.toBeInstanceOf(ForeignProcError);
    await expect(table.readStat(8)).rejects.toMatchObject({ code: 'EPIDNS' });
    expect(read).toEqual([]);
    expect(links).toBe(1);
  });

  it('retries a failed namespace check, and checks nothing without a /proc', async () => {
    let fail: string | null = 'EMFILE';
    const table = createLinuxProcTableCalls(
      {
        readdir: () => Promise.resolve(['3']),
        readFile: () => Promise.resolve(new Uint8Array([1])),
        readlink: () => (fail === null ? Promise.resolve('3') : Promise.reject(errno(fail))),
      },
      3,
    );
    await expect(table.listPids()).rejects.toMatchObject({ code: 'EMFILE' });
    fail = null;
    await expect(table.listPids()).resolves.toEqual([3]);
    const none = createLinuxProcTableCalls(
      {
        readdir: () => Promise.reject(errno('ENOENT')),
        readFile: () => Promise.reject(errno('ENOENT')),
        readlink: () => Promise.reject(errno('ENOENT')),
      },
      3,
    );
    await expect(none.listPids()).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(none.readStat(3)).resolves.toBeNull();
  });

  it('reads the stat files at most PROC_READ_CONCURRENCY at a time, in listing order, and stops at a failure', async () => {
    const stat = (pid: number): Uint8Array =>
      new TextEncoder().encode(
        `${String(pid)} (p) S 1 ${String(pid)} 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 ${String(pid)} 0 0
`,
      );
    const pids = Array.from({ length: 100 }, (_, i) => 1000 - i);
    let inFlight = 0;
    let most = 0;
    let started = 0;
    const table = (failAt: number | null) =>
      createLinuxProcTableCalls(
        {
          readdir: () => Promise.resolve(pids.map(String)),
          readFile: async (path) => {
            started += 1;
            inFlight += 1;
            most = Math.max(most, inFlight);
            await new Promise((resolve) => setImmediate(resolve));
            inFlight -= 1;
            const pid = Number(path.split('/')[2]);
            if (pid === failAt) throw errno('EIO');
            return stat(pid);
          },
          readlink: () => Promise.resolve('7'),
        },
        7,
      );
    const snapshot = await takeSnapshot(table(null));
    expect(snapshot.records.map((record) => record.pid)).toEqual(pids);
    expect(most).toBe(PROC_READ_CONCURRENCY);
    started = 0;
    await expect(takeSnapshot(table(pids[20] ?? 0))).rejects.toMatchObject({ code: 'EIO' });
    // The readers stop taking entries once one failed.
    expect(started).toBeLessThan(pids.length);
  });

  // Review R3-2: under `hidepid=1` other users' entries are listed but their
  // stat is refused (EPERM). The snapshot skips and counts them instead of
  // failing as a whole (it rejected before the fix).
  it('a snapshot skips entries whose stat is refused (hidepid=1) and counts them', async () => {
    const stat = (pid: number, ppid: number): Uint8Array =>
      new TextEncoder().encode(
        `${String(pid)} (p) S ${String(ppid)} ${String(pid)} 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 ${String(pid * 10)} 0 0\n`,
      );
    for (const code of ['EPERM', 'EACCES']) {
      const table = createLinuxProcTableCalls(
        {
          readdir: () => Promise.resolve(['1', '7', '9']),
          readFile: (path) =>
            path === '/proc/7/stat' ? Promise.resolve(stat(7, 1)) : Promise.reject(errno(code)),
          readlink: () => Promise.resolve('7'),
        },
        7,
      );
      const snapshot = await takeSnapshot(table);
      expect(snapshot.records.map((record) => record.pid)).toEqual([7]);
      expect(snapshot.rejected).toBe(2);
    }
    // Any other failure still fails the snapshot.
    const broken = createLinuxProcTableCalls(
      {
        readdir: () => Promise.resolve(['1']),
        readFile: () => Promise.reject(errno('EIO')),
        readlink: () => Promise.resolve('7'),
      },
      7,
    );
    await expect(takeSnapshot(broken)).rejects.toMatchObject({ code: 'EIO' });
    // ... also a failure without an errno code.
    const odd = createLinuxProcTableCalls(
      {
        readdir: () => Promise.resolve(['1']),
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection on purpose
        readFile: () => Promise.reject('no code'),
        readlink: () => Promise.resolve('7'),
      },
      7,
    );
    await expect(takeSnapshot(odd)).rejects.toBe('no code');
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
    // The identity read and a snapshot (one table read each), the exit wait.
    hangGuard(2 * TABLE_READ_MS, 10_000),
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
    // Two snapshots (one table read each), the exit wait.
    hangGuard(2 * TABLE_READ_MS, 10_000),
  );
});
