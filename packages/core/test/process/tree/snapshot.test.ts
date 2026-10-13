import { describe, expect, it, vi } from 'vitest';

import type { LinuxProcTableCalls } from '../../../src/process/os/types.js';
import {
  buildSnapshot,
  snapshotDescendants,
  takeSnapshot,
} from '../../../src/process/tree/snapshot.js';
import { bytes, fixture, fixtureProcTable } from './support.js';

describe('takeSnapshot (reads only, through injected calls)', () => {
  it('reads the recorded Linux /proc tree', async () => {
    const snapshot = await takeSnapshot(fixtureProcTable());
    expect(snapshot.source).toBe('linux-proc');
    expect(snapshot.rejected).toBe(0);
    expect(snapshot.records.map((record) => record.pid).sort((a, b) => a - b)).toEqual([
      1, 8, 16, 17, 18, 19, 20, 22, 23,
    ]);
  });

  it('skips processes that exited between listing and reading, and rejects bad entries', async () => {
    const readStat = vi.fn((pid: number) =>
      Promise.resolve(
        pid === 5
          ? null
          : pid === 6
            ? bytes('garbage')
            : pid === 7
              ? fixture('linux/proc/8/stat')
              : fixture(`linux/proc/${String(pid)}/stat`),
      ),
    );
    const calls: LinuxProcTableCalls = {
      source: 'linux-proc',
      listPids: () => Promise.resolve([8, 5, 6, 7, -1, 1.5]),
      readStat,
    };
    const snapshot = await takeSnapshot(calls);
    expect(snapshot.records.map((record) => record.pid)).toEqual([8]);
    // 6 is garbage, 7 holds the stat of pid 8, -1 and 1.5 are not pids.
    expect(snapshot.rejected).toBe(4);
    expect(readStat).not.toHaveBeenCalledWith(-1);
  });

  it('parses macOS ps output and drops a forged duplicate pid entirely', async () => {
    const snapshot = await takeSnapshot({
      source: 'darwin-ps',
      runPs: () => Promise.resolve(fixture('darwin/ps.synthesized.out')),
    });
    expect(snapshot.source).toBe('darwin-ps');
    expect(snapshot.records.some((record) => record.pid === 480)).toBe(false);
    // three malformed lines (wrong weekday, procps gap, garbage) plus both copies of pid 480
    expect(snapshot.rejected).toBe(5);
    expect(snapshot.records.find((record) => record.pid === 532)).toMatchObject({
      name: '(security)',
      zombie: true,
    });
  });

  it('parses the Windows CIM output', async () => {
    const snapshot = await takeSnapshot({
      source: 'win32-cim',
      queryProcesses: () => Promise.resolve(fixture('win32/cim-array.out')),
    });
    expect(snapshot.source).toBe('win32-cim');
    expect(snapshot.records).toHaveLength(8);
  });

  it('propagates a failing OS call', async () => {
    await expect(
      takeSnapshot({ source: 'darwin-ps', runPs: () => Promise.reject(new Error('ps failed')) }),
    ).rejects.toThrow('ps failed');
  });
});

describe('buildSnapshot', () => {
  it('adds dropped duplicates to the parser rejections', () => {
    const record = { pid: 2, ppid: 1, startTime: '1', name: 'a' };
    expect(buildSnapshot('win32-cim', { records: [record, record], rejected: 3 })).toEqual({
      source: 'win32-cim',
      records: [],
      rejected: 5,
    });
  });
});

describe('snapshotDescendants', () => {
  it('returns the recorded tree under bash (pid 8) with its start time', async () => {
    const result = await snapshotDescendants(
      { pid: 8, startTime: '35280232' },
      { processTable: fixtureProcTable() },
    );
    expect(result.root?.name).toBe('bash');
    expect(result.descendants.map((record) => record.pid).sort((a, b) => a - b)).toEqual([
      16, 17, 18, 19, 20, 22, 23,
    ]);
    expect(result.snapshot.records).toHaveLength(9);
  });

  it('returns no descendants when the root start time does not match', async () => {
    const result = await snapshotDescendants(
      { pid: 8, startTime: '35280233' },
      { processTable: fixtureProcTable() },
    );
    expect(result.root).toBeNull();
    expect(result.descendants).toEqual([]);
  });

  it('follows a stale Windows ppid only when the child is not older (recorded CIM fixture)', async () => {
    const processTable = {
      source: 'win32-cim' as const,
      queryProcesses: () => Promise.resolve(fixture('win32/cim-array.out')),
    };
    const fromCmd = await snapshotDescendants(
      { pid: 56924, startTime: '13436248430959174' },
      { processTable },
    );
    expect(fromCmd.descendants.map((record) => record.name)).toEqual([
      'claude.exe',
      'cmd.exe',
      'powershell.exe',
      'powershell.exe',
    ]);
    // pid 0 names itself and pid 4 as children; neither is a descendant of anything else.
    const fromIdle = await snapshotDescendants(
      { pid: 0, startTime: '13435773053817224' },
      { processTable },
    );
    expect(fromIdle.descendants.map((record) => record.pid)).toEqual([4]);
  });
});
