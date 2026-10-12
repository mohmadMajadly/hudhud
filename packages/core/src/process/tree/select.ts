import { descendantsOf, findIdentity, indexByPid, sameIdentity } from './descendants.js';
import type { ProcessIdentity, ProcessRecord, ProcessSnapshot } from './types.js';

/**
 * Pure decisions of the POSIX ladder and the sweep (ADR-0010, K1). Nothing
 * here signals anything: each function maps snapshots to the identities and
 * groups that **may** be signalled, and the ladder (W2-T7) does the calls.
 *
 * Invariants (property-tested):
 * - only strict descendants of the spawned root are ever selected;
 * - a pid is selected only with the start time it has in the latest
 *   snapshot and in the snapshot that recorded it;
 * - pid 0, pid 1, the host pid and the spawned pid are never selected for
 *   the sweep, and no group with id 0 or 1, the host's group, the spawned
 *   process's group or the CLI's group is ever selected.
 *
 * Residual, documented: the latest snapshot and the `kill(2)` call are not
 * atomic; a pid reused in between (and within one start-time tick) is not
 * detectable without pidfds, which Node does not expose.
 */

/** Lowest pid that may ever be signalled: never 0 (own group) or 1 (init). */
const MIN_SIGNALLABLE = 2;

function signallable(pid: number, hostPid: number): boolean {
  return pid >= MIN_SIGNALLABLE && pid !== hostPid;
}

/** Outcome of the K1 signal-target rule. */
export interface SignalTargetDecision {
  /** The process that receives SIGTERM (and SIGKILL along with the spawned pid). */
  readonly target: ProcessIdentity;
  readonly source: 'initialize-pid' | 'spawned';
  /** `initialize.pid` was reported and differs from the spawned pid (diagnostic `binary.launcher-detected`). */
  readonly launcherDetected: boolean;
}

/**
 * K1: the signal target is `initialize.pid` only when it appears in S1 as a
 * strict descendant of the spawned process (whose identity must match in
 * S1); otherwise it is the spawned process. The returned identity of an
 * `initialize.pid` target carries its start time from S1.
 */
export function selectSignalTarget(input: {
  readonly spawned: ProcessIdentity;
  readonly initializePid: number | null;
  readonly hostPid: number;
  readonly s1: ProcessSnapshot;
}): SignalTargetDecision {
  const { spawned, initializePid, hostPid, s1 } = input;
  const launcherDetected = initializePid !== null && initializePid !== spawned.pid;
  if (launcherDetected && signallable(initializePid, hostPid)) {
    const cli = descendantsOf(s1.records, spawned).descendants.find(
      (record) => record.pid === initializePid,
    );
    if (cli !== undefined) {
      return {
        target: { pid: cli.pid, startTime: cli.startTime },
        source: 'initialize-pid',
        launcherDetected,
      };
    }
  }
  return { target: spawned, source: 'spawned', launcherDetected };
}

/**
 * True when `identity` may be signalled now: it is still present in the
 * latest snapshot with the same start time, and it is neither pid 0, pid 1
 * nor the host.
 */
export function maySignal(
  identity: ProcessIdentity,
  latest: ProcessSnapshot,
  hostPid: number,
): boolean {
  return signallable(identity.pid, hostPid) && findIdentity(latest.records, identity) !== null;
}

/** A process group that may be signalled with `kill(-pgid)`. */
export interface GroupTarget {
  readonly pgid: number;
  /** The group leader (`pid === pgid`), a verified descendant. */
  readonly leader: ProcessIdentity;
}

export type SweepSkipReason =
  /** The pid is absent from the latest snapshot. */
  | 'exited'
  /** The pid is present with another start time (reused). */
  | 'identity-changed'
  /** pid 0 or 1, the host, or the spawned process. */
  | 'protected';

export type GroupSkipReason =
  /** The group id is 0 or 1, or the group of the host, the spawned process or the CLI. */
  | 'protected-group'
  /** A member of the group in the latest snapshot is not a verified descendant. */
  | 'foreign-member'
  /** The host's own group is unknown, so no group can be proven foreign to it. */
  | 'host-group-unknown';

/** What the sweep may signal. */
export interface SweepPlan {
  /** Verified descendants, each with its identity from the latest snapshot, ordered by pid. */
  readonly processes: readonly ProcessIdentity[];
  /** Groups led by a verified descendant whose every current member is a verified descendant. */
  readonly groups: readonly GroupTarget[];
  readonly skippedProcesses: readonly { readonly pid: number; readonly reason: SweepSkipReason }[];
  readonly skippedGroups: readonly { readonly pgid: number; readonly reason: GroupSkipReason }[];
}

/** Input of {@link planSweep}. */
export interface SweepInput {
  /** Identity of the spawned process: the root of containment (ADR-0011 J9). */
  readonly spawned: ProcessIdentity;
  /** The CLI signal target chosen by {@link selectSignalTarget}. */
  readonly signalTarget: ProcessIdentity;
  /** `process.pid` of the host. */
  readonly hostPid: number;
  /** Snapshots recorded while the tree was intact: S1 (before SIGTERM) and S2 (before SIGKILL). */
  readonly recorded: readonly ProcessSnapshot[];
  /** Snapshot taken immediately before the sweep signals. */
  readonly latest: ProcessSnapshot;
}

function pgidOf(identity: ProcessIdentity, snapshots: readonly ProcessSnapshot[]): number | null {
  for (const snapshot of snapshots) {
    const pgid = findIdentity(snapshot.records, identity)?.pgid;
    if (pgid !== undefined) return pgid;
  }
  return null;
}

/**
 * Plans the sweep over S1 ∪ S2 (ADR-0010 "Sweep").
 *
 * @remarks
 * 1. Candidates are the strict descendants of the spawned root in each
 *    recorded snapshot (the root must match there).
 * 2. A candidate is verified when the latest snapshot has the same pid with
 *    the same start time.
 * 3. Processes that descend, in the latest snapshot, from a verified
 *    candidate (forked after the recorded snapshots) are verified too.
 * 4. A group is selected only when its leader (`pid === pgid`) is verified,
 *    its id is not protected, the host's group is known, and every member of
 *    that group in the latest snapshot is verified; otherwise its members
 *    are still signalled one by one.
 */
export function planSweep(input: SweepInput): SweepPlan {
  const { spawned, signalTarget, hostPid, recorded, latest } = input;
  const latestByPid = indexByPid(latest.records).byPid;

  const skippedProcesses = new Map<number, SweepSkipReason>();
  const verified = new Map<number, ProcessRecord>();
  const admit = (record: ProcessRecord): void => {
    if (!signallable(record.pid, hostPid) || record.pid === spawned.pid) {
      skippedProcesses.set(record.pid, 'protected');
    } else {
      verified.set(record.pid, record);
    }
  };

  for (const snapshot of recorded) {
    for (const candidate of descendantsOf(snapshot.records, spawned).descendants) {
      const current = latestByPid.get(candidate.pid);
      if (current === undefined) {
        // Absent from the latest snapshot, so it cannot have been verified.
        skippedProcesses.set(candidate.pid, 'exited');
      } else if (!sameIdentity(current, candidate)) {
        // Another recorded snapshot may already have verified the current holder.
        if (!verified.has(candidate.pid)) skippedProcesses.set(candidate.pid, 'identity-changed');
      } else {
        skippedProcesses.delete(candidate.pid);
        admit(current);
      }
    }
  }
  for (const record of [...verified.values()]) {
    for (const forked of descendantsOf(latest.records, record).descendants) {
      if (!verified.has(forked.pid)) admit(forked);
    }
  }

  const hostRecord = latestByPid.get(hostPid);
  const hostPgid = hostRecord?.pgid ?? pgidOfPid(hostPid, recorded);
  const protectedGroups = new Set<number>([0, 1, hostPid, spawned.pid, signalTarget.pid]);
  for (const pgid of [
    hostPgid,
    pgidOf(spawned, [latest, ...recorded]),
    pgidOf(signalTarget, [latest, ...recorded]),
  ]) {
    if (pgid !== null) protectedGroups.add(pgid);
  }

  const groups: GroupTarget[] = [];
  const skippedGroups: { pgid: number; reason: GroupSkipReason }[] = [];
  for (const leader of verified.values()) {
    if (leader.pgid !== leader.pid) continue;
    const pgid = leader.pid;
    let reason: GroupSkipReason | null = null;
    if (hostPgid === null) reason = 'host-group-unknown';
    else if (protectedGroups.has(pgid)) reason = 'protected-group';
    else if (
      latest.records.some((record) => record.pgid === pgid && verified.get(record.pid) !== record)
    ) {
      reason = 'foreign-member';
    }
    if (reason === null)
      groups.push({ pgid, leader: { pid: leader.pid, startTime: leader.startTime } });
    else skippedGroups.push({ pgid, reason });
  }

  return {
    processes: [...verified.values()]
      .map((record) => ({ pid: record.pid, startTime: record.startTime }))
      .sort((a, b) => a.pid - b.pid),
    groups: groups.sort((a, b) => a.pgid - b.pgid),
    skippedProcesses: [...skippedProcesses]
      .map(([pid, reason]) => ({ pid, reason }))
      .sort((a, b) => a.pid - b.pid),
    skippedGroups: skippedGroups.sort((a, b) => a.pgid - b.pgid),
  };
}

/**
 * The host's group from the recorded snapshots when the latest one lacks
 * the host. The host is alive while it runs the sweep, so its pid cannot
 * have been reused; matching by pid is sound here.
 */
function pgidOfPid(pid: number, snapshots: readonly ProcessSnapshot[]): number | null {
  for (const snapshot of snapshots) {
    const pgid = indexByPid(snapshot.records).byPid.get(pid)?.pgid;
    if (pgid !== undefined) return pgid;
  }
  return null;
}
