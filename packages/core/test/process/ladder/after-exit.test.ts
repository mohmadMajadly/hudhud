// The graceful close path's sweep (W3-Z ruling 5): snapshot at EOF, sweep
// the survivors of that snapshot after the CLI exited (the Linux `rg --files`
// orphan of the W3-T6 recordings). Fake OS calls only; nothing real is killed.

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
  async function eofOf(w: FakeWorld): Promise<EofSnapshot> {
    const eof = await snapshotAtEof(CLI.pid, Promise.resolve(identity(CLI)), w.os);
    if (eof === null) throw new Error('no snapshot');
    return eof;
  }

  it('kills the orphan the CLI left after a normal exit, never the host or its group', async () => {
    const w = world();
    const eof = await eofOf(w);
    // The CLI exits by itself; rg and the tool group are reparented to init.
    w.remove(CLI.pid);
    const report = await sweepAfterExit(eof, { os: w.os });
    expect(report.status).toBe('done');
    expect(w.calls.map((call) => [call.kind, call.id, call.signal])).toEqual([
      ['group', 300, 'SIGKILL'],
      ['process', 500, 'SIGKILL'],
    ]);
    expect(w.records.has(RG.pid)).toBe(false);
    expect(w.records.has(SLEEP.pid)).toBe(false);
    expect(w.records.has(HOST.pid)).toBe(true);
    expect(report.status === 'done' ? report.summary : null).toEqual({
      processesSignalled: 1,
      groupsSignalled: 1,
      skipped: 0,
    });
  });

  it('spares a reused pid and processes that exited by themselves', async () => {
    const w = world();
    const eof = await eofOf(w);
    w.remove(CLI.pid);
    w.remove(SLEEP.pid);
    w.set({ ...RG, startTime: '77' });
    const report = await sweepAfterExit(eof, { os: w.os });
    expect(report.status).toBe('done');
    // Only the tool group leader is still the same process; its group has no
    // foreign member, so the group is signalled.
    expect(w.calls.map((call) => [call.kind, call.id])).toEqual([['group', 300]]);
    expect(w.records.get(RG.pid)?.startTime).toBe('77');
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

  it('kills the survivors leaf first, one taskkill /F /PID each', async () => {
    let rows: CimRow[] = [HOST_ROW, CLI_ROW, SHELL_ROW, CHILD_ROW, OTHER_ROW];
    const { os, killed } = windows(
      () => rows,
      (pid) => Promise.resolve({ exitCode: pid === 302 ? 128 : 0 }),
    );
    const eof = await snapshotAtEof(201, Promise.resolve({ pid: 201, startTime: '21' }), os);
    // The CLI exits; 301 exited too; nothing else changed.
    rows = [HOST_ROW, SHELL_ROW, OTHER_ROW];
    const report = await sweepAfterExit(eof, { os });
    expect(killed).toEqual([302, 300]);
    expect(report).toEqual({
      status: 'done',
      summary: { processesSignalled: 1, groupsSignalled: 0, skipped: 1 },
      win32: [
        { pid: 302, outcome: 'failed' },
        { pid: 301, outcome: 'skipped-exited' },
        { pid: 300, outcome: 'done' },
      ],
    });
  });

  it('spares the host, a reused pid, and records a failing taskkill', async () => {
    let rows: CimRow[] = [HOST_ROW, CLI_ROW, SHELL_ROW, CHILD_ROW];
    const { os, killed } = windows(
      () => rows,
      () => Promise.reject(new Error('spawn failed')),
      301,
    );
    const eof = await snapshotAtEof(201, Promise.resolve({ pid: 201, startTime: '21' }), os);
    rows = [HOST_ROW, { ...SHELL_ROW, start: '99' }, CHILD_ROW];
    const report = await sweepAfterExit(eof, { os });
    expect(killed).toEqual([]);
    expect(report).toMatchObject({
      status: 'done',
      win32: [
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
      win32: [
        { pid: 301, outcome: 'failed' },
        { pid: 300, outcome: 'failed' },
      ],
    });
  });
});
