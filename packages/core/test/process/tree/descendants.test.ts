import { describe, expect, it } from 'vitest';

import {
  descendantsOf,
  findIdentity,
  indexByPid,
  sameIdentity,
} from '../../../src/process/tree/descendants.js';
import type { ProcessRecord } from '../../../src/process/tree/types.js';

function rec(pid: number, ppid: number, startTime: string, pgid?: number): ProcessRecord {
  return pgid === undefined
    ? { pid, ppid, startTime, name: `p${String(pid)}` }
    : { pid, ppid, pgid, startTime, name: `p${String(pid)}` };
}

describe('indexByPid', () => {
  it('drops every record of a duplicated pid and counts them', () => {
    const records = [
      rec(2, 1, '1'),
      rec(3, 2, '2'),
      rec(3, 1, '9'),
      rec(3, 1, '8'),
      rec(4, 2, '3'),
    ];
    const { byPid, duplicates } = indexByPid(records);
    expect([...byPid.keys()]).toEqual([2, 4]);
    expect(duplicates).toBe(3);
  });
});

describe('sameIdentity / findIdentity', () => {
  it('requires pid and start time to match', () => {
    expect(sameIdentity({ pid: 2, startTime: '5' }, { pid: 2, startTime: '5' })).toBe(true);
    expect(sameIdentity({ pid: 2, startTime: '5' }, { pid: 2, startTime: '6' })).toBe(false);
    expect(sameIdentity({ pid: 2, startTime: '5' }, { pid: 3, startTime: '5' })).toBe(false);
    const records = [rec(2, 1, '5')];
    expect(findIdentity(records, { pid: 2, startTime: '5' })).toBe(records[0]);
    expect(findIdentity(records, { pid: 2, startTime: '6' })).toBeNull();
    expect(findIdentity(records, { pid: 3, startTime: '5' })).toBeNull();
  });

  it('never matches a duplicated pid', () => {
    expect(findIdentity([rec(2, 1, '5'), rec(2, 1, '5')], { pid: 2, startTime: '5' })).toBeNull();
  });
});

describe('descendantsOf', () => {
  const tree = [
    rec(1, 0, '0'),
    rec(10, 1, '100'),
    rec(11, 10, '110'),
    rec(12, 10, '120'),
    rec(13, 11, '130'),
    rec(14, 13, '140'),
    rec(20, 1, '105'),
  ];

  it('returns strict descendants breadth first', () => {
    const result = descendantsOf(tree, { pid: 10, startTime: '100' });
    expect(result.root).toBe(tree[1]);
    expect(result.descendants.map((record) => record.pid)).toEqual([11, 12, 13, 14]);
  });

  it('returns nothing when the root is absent or its start time differs (pid reused)', () => {
    expect(descendantsOf(tree, { pid: 99, startTime: '1' })).toEqual({
      root: null,
      descendants: [],
    });
    expect(descendantsOf(tree, { pid: 10, startTime: '101' })).toEqual({
      root: null,
      descendants: [],
    });
  });

  it('does not adopt a process older than the parent its ppid names (stale ppid, reused pid)', () => {
    // Windows: 30 was started by an earlier holder of pid 11 and keeps ppid 11.
    const records = [...tree, rec(30, 11, '50'), rec(31, 30, '60')];
    const result = descendantsOf(records, { pid: 10, startTime: '100' });
    expect(result.descendants.map((record) => record.pid)).not.toContain(30);
    expect(result.descendants.map((record) => record.pid)).not.toContain(31);
  });

  it('accepts a child with the same start time as its parent (one tick)', () => {
    const records = [rec(10, 1, '100'), rec(11, 10, '100')];
    expect(descendantsOf(records, { pid: 10, startTime: '100' }).descendants).toHaveLength(1);
  });

  it('terminates on cycles and never returns the root as its own descendant', () => {
    const records = [
      rec(10, 12, '100'),
      rec(11, 10, '100'),
      rec(12, 11, '100'),
      rec(13, 13, '100'),
    ];
    const result = descendantsOf(records, { pid: 10, startTime: '100' });
    expect(result.descendants.map((record) => record.pid)).toEqual([11, 12]);
    expect(descendantsOf(records, { pid: 13, startTime: '100' }).descendants).toEqual([]);
  });

  it('ignores duplicated pids entirely', () => {
    const records = [rec(10, 1, '100'), rec(11, 10, '110'), rec(11, 10, '110'), rec(12, 11, '120')];
    expect(descendantsOf(records, { pid: 10, startTime: '100' }).descendants).toEqual([]);
  });
});
