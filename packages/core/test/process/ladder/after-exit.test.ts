// The graceful close path's sweep (W3-Z ruling 5, lead review): snapshot at
// EOF, then after the CLI exited sweep the survivors of that snapshot plus
// what can be identified soundly as started after EOF (Windows: a ppid walk
// with pid-reuse guards; POSIX: members of live tool groups). Fake OS calls
// only; nothing real is killed.

import { describe, expect, it } from 'vitest';

import type { OsCalls, Win32TerminateCalls } from '../../../src/process/os/types.js';
import {
  snapshotAtEof,
  sweepAfterExit,
  type EofSnapshot,
} from '../../../src/process/ladder/after-exit.js';
import { CLI, FakeWorld, HOST, identity, INIT, rec } from './fake-os.js';
import { fakeCim, type CimRow } from './windows-support.js';

/** host 100 -> CLI 201 (group 90) -> rg 500 (same group) and a tool group 300 {300, 301}. */
const RG = rec(500, 201, 90, '50', 'rg');
const TOOL = rec(300, 201, 300, '30');
const SLEEP = rec(301, 300, 300, '31');

function world(): FakeWorld {
  return new FakeWorld([INIT, HOST, CLI, RG, TOOL, SLEEP], identity(CLI), CLI.pid);
}

async function eofOf(w: FakeWorld): Promise<EofSnapshot> {
  const eof = await snapshotAtEof(CLI.pid, Promise.resolve(identity(CLI)), w.os);
  if (eof === null) throw new Error('no snapshot');
  return eof;
}

describe('snapshotAtEof', () => {
  it('records the tree rooted at the verified identity', async () => {
    const w = world();
    const eof = await snapshotAtEof(CLI.pid, Promise.resolve(identity(CLI)), w.os);
    expect(eof?.root).toEqual(identity(CLI));
    expect(eof?.snapshot.records.map((record) => record.pid).sort()).toEqual([
      1, 100, 201, 300, 301, 500,
    ]);
  });

  it('takes nothing without a verified identity of that pid, or when the read fails', async () => {
    const w = world();
    expect(await snapshotAtEof(CLI.pid, Promise.resolve(null), w.os)).toBeNull();
    expect(await snapshotAtEof(CLI.pid, Promise.resolve(identity(HOST)), w.os)).toBeNull();
    expect(await snapshotAtEof(CLI.pid, Promise.reject(new Error('read')), w.os)).toBeNull();
    expect(w.reads).toBe(0);
  });

  it('takes nothing when the root is gone or the table cannot be read', async () => {
    const gone = world();
    gone.records.delete(CLI.pid);
    expect(await snapshotAtEof(CLI.pid, Promise.resolve(identity(CLI)), gone.os)).toBeNull();
    const reused = world();
    reused.set({ ...CLI, startTime: '99' });
    expect(await snapshotAtEof(CLI.pid, Promise.resolve(identity(CLI)), reused.os)).toBeNull();
    const failing = world();
    failing.failingReads.add(0);
    expect(await snapshotAtEof(CLI.pid, Promise.resolve(identity(CLI)), failing.os)).toBeNull();
  });
});

describe('sweepAfterExit on POSIX', () => {
  it('kills the orphan the CLI left after a normal exit, never the host or its group', async () => {
    const w = world();
    const eof = await eofOf(w);
    // The CLI exits by itself; rg and the tool group are reparented to init.
    w.remove(CLI.pid);
    const report = await sweepAfterExit(eof, { os: w.os });
    expect(w.calls.map((call) => [call.kind, call.id, call.signal])).toEqual([
      ['group', 300, 'SIGKILL'],
      ['process', 500, 'SIGKILL'],
    ]);
    expect(w.records.has(RG.pid)).toBe(false);
    expect(w.records.has(SLEEP.pid)).toBe(false);
    expect(w.records.has(HOST.pid)).toBe(true);
    expect(report).toMatchObject({
      status: 'done',
      kills: [],
      summary: { processesSignalled: 1, groupsSignalled: 1, skipped: 0 },
    });
  });

  it('kills a member of a live tool group started after EOF, even reparented', async () => {
    const w = world();
    const eof = await eofOf(w);
    w.remove(CLI.pid);
    // Started after EOF in the tool's group, its parent gone: ppid 1.
    const late = rec(302, 1, 300, '35');
    // Same group but older than the leader: not the tool's (pid-reuse guard).
    const older = rec(303, 1, 300, '29');
    w.set(late);
    w.set(older);
    const report = await sweepAfterExit(eof, { os: w.os, signalTarget: identity(CLI) });
    // The group has members the snapshot cannot verify, so the sweep kills by pid.
    expect(w.calls.map((call) => [call.kind, call.id])).toEqual([
      ['process', 300],
      ['process', 301],
      ['process', 500],
      ['process', 302],
    ]);
    expect(w.records.has(older.pid)).toBe(true);
    expect(report).toMatchObject({
      status: 'done',
      kills: [{ pid: 302, source: 'started-after-eof', outcome: 'done' }],
      summary: { processesSignalled: 4, groupsSignalled: 0 },
    });
  });

  it('leaves a reparented process whose group leader exited (documented residual)', async () => {
    const w = world();
    const eof = await eofOf(w);
    w.remove(CLI.pid);
    w.remove(TOOL.pid);
    w.set(rec(302, 1, 300, '35'));
    const report = await sweepAfterExit(eof, { os: w.os });
    expect(w.calls.some((call) => call.id === 302)).toBe(false);
    expect(report).toMatchObject({ status: 'done', kills: [] });
  });

  it('re-verifies each group member right before its kill', async () => {
    type Change = (w: FakeWorld) => void;
    const cases: [string, Change | 'fail' | 'refuse', string][] = [
      [
        'exited',
        (w) => {
          w.remove(302);
        },
        'skipped-exited',
      ],
      [
        'reused',
        (w) => {
          w.set(rec(302, 1, 300, '99'));
        },
        'skipped-identity-changed',
      ],
      [
        'zombie',
        (w) => {
          w.set({ ...rec(302, 1, 300, '35'), zombie: true });
        },
        'skipped-exited',
      ],
      ['unreadable table', 'fail', 'failed'],
      ['refused signal', 'refuse', 'failed'],
    ];
    for (const [, change, outcome] of cases) {
      const w = world();
      const eof = await eofOf(w);
      w.remove(CLI.pid);
      w.set(rec(302, 1, 300, '35'));
      // Reads: 0 the EOF snapshot, 1 the fresh table, 2 the ladder sweep, 3 the member check.
      if (change === 'fail') w.failingReads.add(3);
      else if (change === 'refuse') {
        w.onSignal = ({ call }) => (call.id === 302 ? 'not-permitted' : undefined);
      } else {
        w.beforeRead = (index) => {
          if (index === 3) change(w);
        };
      }
      const report = await sweepAfterExit(eof, { os: w.os });
      expect(report).toMatchObject({ kills: [{ pid: 302, outcome }] });
    }
    const throwing = world();
    const eof = await eofOf(throwing);
    throwing.remove(CLI.pid);
    throwing.set(rec(302, 1, 300, '35'));
    throwing.onSignal = ({ call }) => {
      if (call.id === 302) throw new Error('EPERM');
      return undefined;
    };
    expect(await sweepAfterExit(eof, { os: throwing.os })).toMatchObject({
      kills: [{ pid: 302, outcome: 'failed' }],
    });
  });

  it('signals nothing while the CLI still runs', async () => {
    const w = world();
    const eof = await eofOf(w);
    expect(await sweepAfterExit(eof, { os: w.os })).toEqual({
      status: 'skipped',
      reason: 'root-alive',
    });
    expect(w.calls).toEqual([]);
  });

  it('treats a zombie root as exited', async () => {
    const w = world();
    const eof = await eofOf(w);
    w.set({ ...CLI, zombie: true });
    const report = await sweepAfterExit(eof, { os: w.os, signalTarget: identity(CLI) });
    expect(report.status).toBe('done');
    expect(w.calls.length).toBeGreaterThan(0);
  });

  it('skips without a snapshot, without descendants, or when the table fails', async () => {
    const w = world();
    expect(await sweepAfterExit(null, { os: w.os })).toEqual({
      status: 'skipped',
      reason: 'no-snapshot',
    });
    const leaf = new FakeWorld([INIT, HOST, CLI], identity(CLI), CLI.pid);
    const lone = await eofOf(leaf);
    leaf.remove(CLI.pid);
    expect(await sweepAfterExit(lone, { os: leaf.os })).toEqual({
      status: 'skipped',
      reason: 'no-descendants',
    });
    const eof = await eofOf(w);
    w.remove(CLI.pid);
    w.failingReads.add(w.reads);
    expect(await sweepAfterExit(eof, { os: w.os })).toEqual({
      status: 'skipped',
      reason: 'table-failed',
    });
    expect(w.calls).toEqual([]);
  });
});

describe('sweepAfterExit on Windows (best effort)', () => {
  const HOST_ROW: CimRow = { pid: 100, ppid: 4, start: '10' };
  const CLI_ROW: CimRow = { pid: 201, ppid: 100, start: '21' };
  const SHELL_ROW: CimRow = { pid: 300, ppid: 201, start: '30' };
  const CHILD_ROW: CimRow = { pid: 301, ppid: 300, start: '31' };
  const OTHER_ROW: CimRow = { pid: 302, ppid: 300, start: '32' };

  function windows(
    rows: () => readonly CimRow[] | Error,
    taskkill: Win32TerminateCalls['taskkillProcess'],
    hostPid = 100,
  ): { os: OsCalls; killed: number[] } {
    const killed: number[] = [];
    return {
      killed,
      os: {
        platform: 'win32',
        hostPid,
        processTable: fakeCim(rows),
        terminate: {
          taskkillTree: () => Promise.reject(new Error('never a tree kill')),
          taskkillProcess: (pid) => {
            killed.push(pid);
            return taskkill(pid);
          },
        },
      },
    };
  }

  const ok = (): Promise<{ exitCode: number }> => Promise.resolve({ exitCode: 0 });
  const rootIdentity = Promise.resolve({ pid: 201, startTime: '21' });

  it('kills the survivors leaf first, one taskkill /F /PID each', async () => {
    let rows: CimRow[] = [HOST_ROW, CLI_ROW, SHELL_ROW, CHILD_ROW, OTHER_ROW];
    const { os, killed } = windows(
      () => rows,
      (pid) => Promise.resolve({ exitCode: pid === 302 ? 128 : 0 }),
    );
    const eof = await snapshotAtEof(201, rootIdentity, os);
    // The CLI exits; 301 exited too; nothing else changed.
    rows = [HOST_ROW, SHELL_ROW, OTHER_ROW];
    const report = await sweepAfterExit(eof, { os });
    expect(killed).toEqual([302, 300]);
    expect(report).toEqual({
      status: 'done',
      summary: { processesSignalled: 1, groupsSignalled: 0, skipped: 1 },
      kills: [
        { pid: 302, source: 'eof-snapshot', outcome: 'failed' },
        { pid: 301, source: 'eof-snapshot', outcome: 'skipped-exited' },
        { pid: 300, source: 'eof-snapshot', outcome: 'done' },
      ],
    });
  });

  it('finds processes started after EOF by their parent pid, with the pid-reuse guards', async () => {
    let rows: CimRow[] = [HOST_ROW, CLI_ROW, SHELL_ROW];
    const { os, killed } = windows(() => rows, ok);
    const eof = await snapshotAtEof(201, rootIdentity, os);
    rows = [
      HOST_ROW,
      SHELL_ROW,
      // Started after EOF under the snapshot's shell, and its child.
      { pid: 303, ppid: 300, start: '40' },
      { pid: 307, ppid: 303, start: '41' },
      // Started after EOF under the dead CLI (Windows keeps the ppid).
      { pid: 304, ppid: 201, start: '50' },
      // Older than the CLI: its ppid is stale, it is not the CLI's child.
      { pid: 305, ppid: 201, start: '10' },
      // pid 201 is held by a new process now; its child is not the CLI's.
      { pid: 201, ppid: 4, start: '60' },
      { pid: 306, ppid: 201, start: '70' },
    ];
    const report = await sweepAfterExit(eof, { os });
    expect(killed).toEqual([307, 303, 304, 300]);
    expect(report).toMatchObject({
      status: 'done',
      kills: [
        { pid: 307, source: 'started-after-eof', outcome: 'done' },
        { pid: 303, source: 'started-after-eof', outcome: 'done' },
        { pid: 304, source: 'started-after-eof', outcome: 'done' },
        { pid: 300, source: 'eof-snapshot', outcome: 'done' },
      ],
    });
  });

  it('sweeps what the walk finds when the snapshot had no descendant', async () => {
    let rows: CimRow[] = [HOST_ROW, CLI_ROW];
    const { os, killed } = windows(() => rows, ok);
    const eof = await snapshotAtEof(201, rootIdentity, os);
    rows = [HOST_ROW];
    expect(await sweepAfterExit(eof, { os })).toEqual({
      status: 'skipped',
      reason: 'no-descendants',
    });
    rows = [HOST_ROW, { pid: 304, ppid: 201, start: '50' }];
    expect(await sweepAfterExit(eof, { os })).toMatchObject({
      status: 'done',
      kills: [{ pid: 304, source: 'started-after-eof', outcome: 'done' }],
    });
    expect(killed).toEqual([304]);
  });

  it('spares the host, a reused pid, and records a failing taskkill', async () => {
    let rows: CimRow[] = [HOST_ROW, CLI_ROW, SHELL_ROW, CHILD_ROW];
    const { os, killed } = windows(
      () => rows,
      () => Promise.reject(new Error('spawn failed')),
      301,
    );
    const eof = await snapshotAtEof(201, rootIdentity, os);
    rows = [HOST_ROW, { ...SHELL_ROW, start: '99' }, CHILD_ROW];
    const report = await sweepAfterExit(eof, { os });
    expect(killed).toEqual([]);
    expect(report).toMatchObject({
      status: 'done',
      kills: [
        { pid: 301, outcome: 'skipped-protected' },
        { pid: 300, outcome: 'skipped-identity-changed' },
      ],
    });
    rows = [HOST_ROW, SHELL_ROW, CHILD_ROW];
    const again = windows(
      () => rows,
      () => Promise.reject(new Error('spawn failed')),
    );
    expect(await sweepAfterExit(eof, { os: again.os })).toMatchObject({
      kills: [
        { pid: 301, outcome: 'failed' },
        { pid: 300, outcome: 'failed' },
      ],
    });
  });
});
