import { compareStartTime } from './start-time.js';
import type { ProcessIdentity, ProcessRecord } from './types.js';

/**
 * Indexes records by pid, dropping **every** record of a pid that occurs
 * more than once. Two live processes never share a pid, so a duplicate means
 * a forged or torn read and neither copy can be trusted.
 *
 * @internal
 */
export function indexByPid(records: readonly ProcessRecord[]): {
  readonly byPid: ReadonlyMap<number, ProcessRecord>;
  readonly duplicates: number;
} {
  const byPid = new Map<number, ProcessRecord>();
  const duplicated = new Set<number>();
  for (const record of records) {
    if (byPid.has(record.pid)) duplicated.add(record.pid);
    else byPid.set(record.pid, record);
  }
  let duplicates = 0;
  for (const pid of duplicated) {
    duplicates += records.filter((record) => record.pid === pid).length;
    byPid.delete(pid);
  }
  return { byPid, duplicates };
}

/**
 * True when both name the same process: equal pid and equal start time.
 *
 * @beta
 */
export function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.startTime === b.startTime;
}

/**
 * The record of `identity` in `records` when pid and start time both match (and the pid is unique).
 *
 * @beta
 */
export function findIdentity(
  records: readonly ProcessRecord[],
  identity: ProcessIdentity,
): ProcessRecord | null {
  const record = indexByPid(records).byPid.get(identity.pid);
  return record?.startTime === identity.startTime ? record : null;
}

/**
 * The root's record (identity-matched) and its strict descendants in breadth-first order.
 *
 * @beta
 */
export interface DescendantTree {
  readonly root: ProcessRecord | null;
  readonly descendants: readonly ProcessRecord[];
}

/**
 * Strict descendants of `root` within one snapshot.
 *
 * @remarks
 * The root must be present with the same start time, otherwise nothing is
 * returned (the root exited, or its pid was reused). A parent link
 * `child.ppid === parent.pid` is followed only when the child did not start
 * before the parent: a child cannot predate its parent, so an older process
 * whose stale `ppid` names a reused pid (Windows never updates `ppid`) is
 * not adopted. Each pid is visited once, so cycles terminate. Residual: a
 * pid reused within one start-time tick (one second on macOS) is not
 * distinguishable.
 *
 * @beta
 */
export function descendantsOf(
  records: readonly ProcessRecord[],
  root: ProcessIdentity,
): DescendantTree {
  const { byPid } = indexByPid(records);
  const rootRecord = byPid.get(root.pid);
  if (rootRecord?.startTime !== root.startTime) return { root: null, descendants: [] };

  const children = new Map<number, ProcessRecord[]>();
  for (const record of byPid.values()) {
    const siblings = children.get(record.ppid);
    if (siblings === undefined) children.set(record.ppid, [record]);
    else siblings.push(record);
  }

  const visited = new Set<number>([rootRecord.pid]);
  const descendants: ProcessRecord[] = [];
  const queue: ProcessRecord[] = [rootRecord];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of children.get(parent.pid) ?? []) {
      if (visited.has(child.pid) || compareStartTime(child.startTime, parent.startTime) < 0) {
        continue;
      }
      visited.add(child.pid);
      descendants.push(child);
      queue.push(child);
    }
  }
  return { root: rootRecord, descendants };
}
