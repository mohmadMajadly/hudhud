import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostProcessTable } from '../../src/leaks/process-table.js';
import type { ProcessRow, ProcessTable } from '../../src/leaks/process-table.js';
import {
  assertNoSurvivors,
  findSurvivors,
  KILL_CHECK_MS,
  KILL_DEADLINE_MS,
  killVerified,
  LeakError,
  LeakTracker,
} from '../../src/leaks/tracker.js';
import type { ProcessIdentity } from '../../src/leaks/tracker.js';
import { hangGuard, HOST_TABLE_READ_MS } from '../hang-guard.js';

function row(pid: number, ppid: number, startTime: number, commandLine = ''): ProcessRow {
  return { pid, ppid, startTime: String(startTime), name: `p${String(pid)}`, commandLine };
}

class FakeTable implements ProcessTable {
  readonly source: ProcessTable['source'];
  rows: ProcessRow[] = [];
  reads = 0;
  failWith: Error | undefined = undefined;

  constructor(source: ProcessTable['source'] = 'linux-proc') {
    this.source = source;
  }

  read(): Promise<readonly ProcessRow[]> {
    this.reads += 1;
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve([...this.rows]);
  }
}

const SELF = 1;
const noSleep = (): Promise<void> => Promise.resolve();

describe('LeakTracker with a scripted table', () => {
  it('reports tracked survivors, late descendants and marked command lines, never itself', async () => {
    const table = new FakeTable();
    table.rows = [row(SELF, 0, 1, '/marker/self'), row(50, 1, 5), row(60, 1, 5, 'old /marker/run')];
    const tracker = new LeakTracker({
      table,
      selfPid: SELF,
      marker: '/marker/run',
      kill: () => undefined,
      sleep: noSleep,
    });
    await tracker.begin();
    table.rows.push(row(100, SELF, 10), row(101, 100, 11));
    await tracker.recordRoot(100);
    expect(await tracker.sample()).toBe(2);
    expect(tracker.tracked.map((r) => r.pid)).toEqual([100, 101]);
    // root 100 exits; 101 survives; 102 was born from 101 after the last sample;
    // 103 claims parent 101 but started earlier (pid reuse), so it is unrelated;
    // 104 is unrelated but names the marker; 50 is old and unrelated.
    table.rows = [
      row(SELF, 0, 1, '/marker/self'),
      row(50, 1, 5),
      row(60, 1, 5, 'old /marker/run'),
      row(101, 100, 11),
      row(102, 101, 12),
      row(103, 101, 9),
      row(104, 1, 13, 'x /marker/run y'),
    ];
    const leaks = await tracker.findLeaks();
    expect(leaks.map((leak) => [leak.pid, leak.reason])).toEqual([
      [60, 'command-line'],
      [101, 'tracked'],
      [102, 'descendant'],
      [104, 'command-line'],
    ]);
  });

  it('does not count the child of a process that reused a known pid (W6-Z, Windows conhost)', async () => {
    const table = new FakeTable();
    table.rows = [row(SELF, 0, 1)];
    const tracker = new LeakTracker({
      table,
      selfPid: SELF,
      kill: () => undefined,
      sleep: noSleep,
    });
    await tracker.begin();
    tracker.recordIdentity({ pid: 400, startTime: '10' });
    // Root 400 exited; pid 400 now names the host's own table query (started
    // at 20) whose console host 401 started at 21. 402 started at 15, before
    // the new holder: an orphan of the root, still its descendant.
    table.rows = [row(SELF, 0, 1), row(400, SELF, 20), row(401, 400, 21), row(402, 400, 15)];
    expect((await tracker.findLeaks()).map((leak) => [leak.pid, leak.reason])).toEqual([
      [402, 'descendant'],
    ]);
    // Through sampling too: a reused pid's child is never absorbed.
    expect(await tracker.sample()).toBe(1 + 1);
    expect(tracker.tracked.map((r) => r.pid)).toEqual([402]);
  });

  it('passes when nothing is left', async () => {
    const table = new FakeTable();
    table.rows = [row(200, SELF, 3)];
    const tracker = new LeakTracker({ table, selfPid: SELF });
    await tracker.recordRoot(200);
    table.rows = [];
    await expect(tracker.assertNoLeaks()).resolves.toBeUndefined();
  });

  it('kills leaks by verified identity and fails with a report', async () => {
    const table = new FakeTable();
    const killed: number[] = [];
    table.rows = [row(300, SELF, 3)];
    const tracker = new LeakTracker({
      table,
      selfPid: SELF,
      kill: (pid) => {
        killed.push(pid);
        table.rows = table.rows.filter((r) => r.pid !== pid);
      },
      sleep: noSleep,
    });
    await tracker.recordRoot(300);
    const error: unknown = await tracker.assertNoLeaks().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LeakError);
    const leak = error as LeakError;
    expect(leak.leaks.map((l) => l.pid)).toEqual([300]);
    expect(leak.outcomes).toEqual(['killed']);
    expect(leak.message).toMatch(
      /1 leaked process\(es\)\n {2}pid 300 start 3 tracked "p300" "" -> killed/,
    );
    expect(killed).toEqual([300]);
  });

  it('refuses an unknown root and a short marker', async () => {
    const table = new FakeTable();
    await expect(new LeakTracker({ table }).recordRoot(999)).rejects.toThrow(/not running/);
    expect(() => new LeakTracker({ table, marker: 'short' })).toThrow(/too short/);
  });

  it('matches markers case-insensitively and with either slash on Windows', async () => {
    const table = new FakeTable('win32-cim');
    table.rows = [
      row(10, 1, 1, 'NODE C:\\TEMP\\HUDHUD-RUN-1\\x'),
      row(11, 1, 1, 'node c:/temp/hudhud-run-1/y'),
      row(12, 1, 1, 'node c:\\temp\\other'),
    ];
    const tracker = new LeakTracker({ table, selfPid: SELF, marker: 'C:\\Temp\\hudhud-run-1' });
    expect((await tracker.findLeaks()).map((l) => l.pid)).toEqual([10, 11]);
  });

  it('samples periodically until stopped', async () => {
    const table = new FakeTable();
    table.rows = [row(400, SELF, 4)];
    const tracker = new LeakTracker({ table, selfPid: SELF });
    await tracker.recordRoot(400);
    const stop = tracker.startSampling(1);
    expect(() => tracker.startSampling(1)).toThrow(/already started/);
    table.rows.push(row(401, 400, 5));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stop();
    expect(tracker.tracked.map((r) => r.pid)).toEqual([400, 401]);
    const readsAfterStop = table.reads;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(table.reads).toBe(readsAfterStop);
    const again = tracker.startSampling(1);
    await again();
  });

  it('records a root by its spawn identity, without a table read', async () => {
    const table = new FakeTable();
    table.rows = [row(500, SELF, 50)];
    const tracker = new LeakTracker({ table, selfPid: SELF, kill: () => undefined });
    await tracker.begin();
    const reads = table.reads;
    tracker.recordIdentity({ pid: 500, startTime: '50' });
    expect(table.reads).toBe(reads);
    expect(tracker.roots).toEqual([{ pid: 500, startTime: '50' }]);
    expect(tracker.tracked).toEqual([]);
    expect(() => {
      tracker.recordIdentity({ pid: SELF, startTime: '1' });
    }).toThrow(/host process/);
    // Its descendants are sampled through it; the root itself is not a row.
    table.rows.push(row(501, 500, 51), row(502, 501, 52));
    expect(await tracker.sample()).toBe(3);
    expect(tracker.tracked.map((r) => r.pid)).toEqual([501, 502]);
    // A child born after the last sample is found through the root as well;
    // a reused pid (another start time) is not the root.
    table.rows = [row(500, SELF, 50), row(503, 500, 53), row(504, 999, 54)];
    expect((await tracker.findLeaks()).map((leak) => [leak.pid, leak.reason])).toEqual([
      [500, 'tracked'],
      [503, 'descendant'],
    ]);
    table.rows = [row(500, SELF, 60)];
    expect(await tracker.findLeaks()).toEqual([]);
  });

  it('surfaces a sampling failure when stopped', async () => {
    const table = new FakeTable();
    const tracker = new LeakTracker({ table, selfPid: SELF });
    table.failWith = new Error('ps failed');
    const stop = tracker.startSampling(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(stop()).rejects.toThrow(/process sampling failed/);
  });
});

describe('killVerified', () => {
  const identity: ProcessIdentity = { pid: 500, startTime: '7' };

  it('never kills itself or a process that is gone or reused', async () => {
    const table = new FakeTable();
    const kills: number[] = [];
    const host = { table, selfPid: 500, kill: (pid: number) => kills.push(pid), sleep: noSleep };
    expect(await killVerified(identity, host)).toBe('gone');
    table.rows = [row(500, 1, 8)];
    expect(await killVerified(identity, { ...host, selfPid: SELF })).toBe('gone');
    expect(kills).toEqual([]);
  });

  it('reports a process that survives the kill, and tolerates a kill that throws', async () => {
    const table = new FakeTable();
    table.rows = [row(500, 1, 7)];
    // An injected clock that the waits advance.
    let clock = 0;
    const outcome = await killVerified(identity, {
      table,
      selfPid: SELF,
      kill: () => {
        throw new Error('ESRCH');
      },
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    expect(outcome).toBe('survived');
    // The identity check, then one check every KILL_CHECK_MS until the deadline.
    expect(table.reads).toBe(1 + KILL_DEADLINE_MS / KILL_CHECK_MS);
    expect(clock).toBe(KILL_DEADLINE_MS);
  });

  describe('on the fake clock with the default timers', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A table that lists `identity`; every read after the first `hangAfter` never answers. */
    function scripted(hangAfter: number): FakeTable {
      const table = new FakeTable();
      table.rows = [row(500, 1, 7)];
      const read = table.read.bind(table);
      table.read = () => (table.reads >= hangAfter ? new Promise(() => undefined) : read());
      return table;
    }

    it('fails as survived at the deadline, not a moment before', async () => {
      vi.useFakeTimers();
      const kills: number[] = [];
      let settled: string | undefined;
      void killVerified(identity, {
        table: scripted(Number.POSITIVE_INFINITY),
        selfPid: SELF,
        kill: (pid) => kills.push(pid),
      }).then((outcome) => (settled = outcome));
      await vi.advanceTimersByTimeAsync(KILL_DEADLINE_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe('survived');
      expect(kills).toEqual([500]);
    });

    it('kills nothing when no read confirms the identity by the deadline', async () => {
      vi.useFakeTimers();
      const kills: number[] = [];
      const outcome = killVerified(identity, {
        table: scripted(0),
        selfPid: SELF,
        kill: (pid) => kills.push(pid),
      });
      await vi.advanceTimersByTimeAsync(KILL_DEADLINE_MS);
      await expect(outcome).resolves.toBe('unverified');
      expect(kills).toEqual([]);
    });

    it('reports a kill no read confirmed by the deadline as unconfirmed', async () => {
      vi.useFakeTimers();
      const kills: number[] = [];
      const outcome = killVerified(identity, {
        table: scripted(1),
        selfPid: SELF,
        kill: (pid) => kills.push(pid),
      });
      await vi.advanceTimersByTimeAsync(KILL_DEADLINE_MS);
      await expect(outcome).resolves.toBe('unconfirmed');
      expect(kills).toEqual([500]);
    });

    it('takes its deadline as an argument', async () => {
      vi.useFakeTimers();
      const outcome = killVerified(identity, { table: scripted(0), selfPid: SELF }, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(outcome).resolves.toBe('unverified');
    });

    it('fails a leak whose kill cannot be verified by the deadline, naming the outcome', async () => {
      vi.useFakeTimers();
      // Reads: begin, findLeaks; the kill's identity check hangs.
      const table = scripted(2);
      const tracker = new LeakTracker({
        table,
        selfPid: SELF,
        marker: '/marker/run',
        kill: () => undefined,
      });
      table.rows = [];
      await tracker.begin();
      table.rows = [row(500, 1, 7, 'cli /marker/run')];
      const failure = tracker.assertNoLeaks().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(KILL_DEADLINE_MS);
      const error = await failure;
      expect(error).toBeInstanceOf(LeakError);
      expect((error as LeakError).outcomes).toEqual(['unverified']);
      expect((error as LeakError).message).toMatch(/-> unverified$/);
    });
  });

  it('waits with a real timer between checks by default', async () => {
    const table = new FakeTable();
    table.rows = [row(500, 1, 7)];
    let checks = 0;
    const read = table.read.bind(table);
    table.read = () => {
      checks += 1;
      if (checks === 3) table.rows = [];
      return read();
    };
    expect(await killVerified(identity, { table, selfPid: SELF, kill: () => undefined })).toBe(
      'killed',
    );
  });
});

describe('suite sweep', () => {
  it('finds and kills processes naming the marker, sparing itself', async () => {
    const table = new FakeTable();
    table.rows = [
      row(SELF, 0, 1, 'vitest /sandbox/root'),
      row(600, 1, 2, 'claude --x /sandbox/root/work'),
    ];
    const host = {
      table,
      selfPid: SELF,
      kill: (pid: number) => {
        table.rows = table.rows.filter((r) => r.pid !== pid);
      },
      sleep: noSleep,
    };
    expect((await findSurvivors(host, '/sandbox/root')).map((r) => r.pid)).toEqual([600]);
    expect((await findSurvivors({ table }, '/sandbox/root')).map((r) => r.pid)).toEqual([1, 600]);
    await expect(assertNoSurvivors(host, '/sandbox/root')).rejects.toBeInstanceOf(LeakError);
    await expect(assertNoSurvivors(host, '/sandbox/root')).resolves.toBeUndefined();
  });
});

// Hang guards: every table read is bounded by HOST_TABLE_READ_MS; each
// killVerified runs within KILL_DEADLINE_MS.
/** How long the sampling test polls for the child (100 polls, 100 ms apart). */
const SAMPLING_POLL_MS = 100 * 100;

describe('a planted orphan on the real host', () => {
  const table = hostProcessTable(process.platform, process.env);
  const host = { table };
  let marker = '';
  let orphan: ProcessIdentity | undefined;

  afterEach(async () => {
    // Cleanup never passes silently: the orphan is gone or verifiably killed.
    if (orphan !== undefined)
      expect(['gone', 'killed']).toContain(await killVerified(orphan, host));
    orphan = undefined;
    if (marker !== '') await rm(marker, { recursive: true, force: true, maxRetries: 10 });
    marker = '';
  }, hangGuard(KILL_DEADLINE_MS));

  /** Spawns a node parent that starts a detached node child, prints its pid, and exits on EOF. */
  async function plant(): Promise<{
    parentPid: number;
    childPid: number;
    release: () => Promise<void>;
  }> {
    if (marker === '') marker = await mkdtemp(path.join(tmpdir(), 'hudhud-orphan-'));
    const script = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore', windowsHide: true });`,
      'child.unref();',
      "process.stdout.write(String(child.pid) + '\\n');",
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => process.exit(0));",
    ].join('\n');
    const parent = spawn(process.execPath, ['-e', script, marker], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
    const exited = new Promise((resolve) => parent.once('exit', resolve));
    const line = await new Promise<string>((resolve) => {
      createInterface({ input: parent.stdout }).once('line', resolve);
    });
    return {
      parentPid: Number(parent.pid),
      childPid: Number(line),
      release: async () => {
        parent.stdin.end();
        await exited;
      },
    };
  }

  it(
    'catches the detached child of a recorded root through sampling',
    async () => {
      const tracker = new LeakTracker({ table });
      await tracker.begin();
      const { parentPid, childPid, release } = await plant();
      await tracker.recordRoot(parentPid);
      const stop = tracker.startSampling(250);
      for (let i = 0; i < 100 && !tracker.tracked.some((r) => r.pid === childPid); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await stop();
      const child = tracker.tracked.find((r) => r.pid === childPid);
      expect(child).toBeDefined();
      orphan = child;
      await release();
      const error: unknown = await tracker.assertNoLeaks().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LeakError);
      const leak = (error as LeakError).leaks.find((l) => l.pid === childPid);
      expect(leak?.reason).toBe('tracked');
      expect((error as LeakError).leaks.some((l) => l.pid === parentPid)).toBe(false);
      expect(
        (await table.read()).some((r) => r.pid === childPid && r.startTime === child?.startTime),
      ).toBe(false);
      // Reads: begin, recordRoot, the sample in flight at stop, findLeaks, the
      // final one; the poll; killVerified of the one leak.
    },
    hangGuard(5 * HOST_TABLE_READ_MS, SAMPLING_POLL_MS, KILL_DEADLINE_MS),
  );

  it(
    'catches it without sampling, by stale parent or by the marker',
    async () => {
      marker = await mkdtemp(path.join(tmpdir(), 'hudhud-orphan-'));
      const tracker = new LeakTracker({ table, marker });
      await tracker.begin();
      const { parentPid, childPid, release } = await plant();
      await tracker.recordRoot(parentPid);
      const child = (await table.read()).find((r) => r.pid === childPid);
      orphan = child;
      await release();
      const error: unknown = await tracker.assertNoLeaks().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LeakError);
      const leak = (error as LeakError).leaks.find((l) => l.pid === childPid);
      expect(['descendant', 'command-line']).toContain(leak?.reason);
      expect((error as LeakError).outcomes.every((o) => o === 'killed')).toBe(true);
      // Reads: begin, recordRoot, the child's row, findLeaks; killVerified of the one leak.
    },
    hangGuard(4 * HOST_TABLE_READ_MS, KILL_DEADLINE_MS),
  );
});
