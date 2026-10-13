/**
 * The sweep of the graceful close path (W3-Z ruling 5, ADR-0008, ADR-0009,
 * ADR-0010).
 *
 * @remarks
 * Finding of the golden-fixture recordings (W3-T6): on Linux the pinned CLI
 * exited normally after stdin EOF and left its `rg --files` child running,
 * reparented to init. A close that never needs the ladder (the CLI exits by
 * itself) must still leave no survivor, so:
 *
 * 1. {@link snapshotAtEof}: when the binding ends stdin for a graceful close,
 *    it records the descendants of the spawned process, rooted at its
 *    verified identity (no identity, no snapshot).
 * 2. {@link sweepAfterExit}: after the CLI has exited, it kills every
 *    survivor it can identify soundly:
 *    - every descendant of the EOF snapshot that is still the same process
 *      (pid and start time match a fresh snapshot);
 *    - Windows (no reparenting: a child keeps its parent's pid as `ppid`):
 *      processes started after EOF, found by a fresh walk by `ppid` from the
 *      dead root and from every snapshot descendant. A child is accepted only
 *      when it did not start before its parent's verified start time (the
 *      pid-reuse guard of `descendantsOf`), and, when the parent's pid is held
 *      by another process now, only when it started before that process (a
 *      child of the new holder cannot predate it);
 *    - POSIX: members of a process group whose leader is a snapshot
 *      descendant that is still alive with its verified identity, started no
 *      earlier than that leader. While the leader lives its pid, and so the
 *      group id, cannot have been reused, so such a member is in the group the
 *      tool created, even when it was reparented to init.
 *
 *    POSIX kills go through the ladder's {@link sweep} (`SIGKILL`, verified
 *    groups first, never the host's, the spawned process's or the signal
 *    target's group), then `SIGKILL` by pid for the group members above.
 *    Windows (best effort): one `taskkill /F /PID` per survivor, leaf first,
 *    as the best-effort ladder's sweep does. With the job addon the job close
 *    (`KILL_ON_JOB_CLOSE`) already ends every process of the tree; this
 *    sweep is for sessions without a job.
 *
 * Nothing is signalled while the spawned process is still running (status
 * `skipped`, reason `root-alive`): the sweep ends a tree whose root is gone,
 * it never shortens a running session.
 *
 * Residuals (documented in ADR-0010 and ADR-0009):
 *
 * - POSIX: a process started after EOF whose parent chain broke (its parent
 *   exited, so it was reparented to init or a subreaper) and that is not in
 *   a live tool group stays unidentified: the CLI runs in the host's process
 *   group and session (it is not detached), so neither identifies it, and
 *   after reparenting nothing ties it to the CLI. It is not killed.
 * - Every sweep: the fresh snapshot and the kill calls are not atomic; a
 *   process that exits and whose pid is reused in between can be signalled.
 *   The window is one table read plus the calls; pid reuse that fast needs
 *   pid exhaustion.
 *
 * @packageDocumentation
 */

import type { OsCalls, PosixSignalCalls, SignalOutcome } from '../os/types.js';
import { sweep, type SweepResult } from '../sweep.js';
import { descendantsOf, findIdentity, indexByPid } from '../tree/descendants.js';
import { takeSnapshot } from '../tree/snapshot.js';
import { compareStartTime } from '../tree/start-time.js';
import type { ProcessIdentity, ProcessRecord, ProcessSnapshot } from '../tree/types.js';
import type { LadderIdentity, LadderSweepSummary } from './types.js';

/**
 * The descendants of the spawned process when stdin was ended, rooted at
 * its verified identity.
 *
 * @public
 */
export interface EofSnapshot {
  readonly root: ProcessIdentity;
  readonly snapshot: ProcessSnapshot;
}

/**
 * Takes the snapshot of step 1 (see the module remarks). Resolves `null`
 * when there is no verified identity, the root is no longer in the table
 * (it already exited), or the table cannot be read. Never rejects.
 *
 * @param identity - the spawned process's identity read (`HarnessProcess.identity` as `LadderIdentity`)
 * @public
 */
export async function snapshotAtEof(
  pid: number,
  identity: LadderIdentity,
  os: Pick<OsCalls, 'processTable'>,
): Promise<EofSnapshot | null> {
  let root: ProcessIdentity | null;
  try {
    const read = await identity;
    root = read !== null && read.pid === pid ? read : null;
  } catch {
    root = null;
  }
  if (root === null) return null;
  let snapshot: ProcessSnapshot;
  try {
    snapshot = await takeSnapshot(os.processTable);
  } catch {
    return null;
  }
  return findIdentity(snapshot.records, root) === null ? null : { root, snapshot };
}

/**
 * Why `sweepAfterExit` signalled nothing.
 *
 * @public
 */
export type AfterExitSkipReason =
  /** No EOF snapshot (no identity, root gone, table unreadable). */
  | 'no-snapshot'
  /** Nothing to sweep: no descendant in the snapshot and (Windows) none found by the walk. */
  | 'no-descendants'
  /** The fresh table could not be read. */
  | 'table-failed'
  /** The spawned process is still running. */
  | 'root-alive';

/**
 * One kill of the sweep after the exit, by pid.
 *
 * @public
 */
export interface AfterExitKill {
  readonly pid: number;
  /** `eof-snapshot`: recorded at EOF; `started-after-eof`: found by the walk (Windows) or the live group (POSIX). */
  readonly source: 'eof-snapshot' | 'started-after-eof';
  readonly outcome:
    'done' | 'failed' | 'skipped-exited' | 'skipped-identity-changed' | 'skipped-protected';
}

/**
 * What `sweepAfterExit` did. JSON data.
 *
 * @public
 */
export type AfterExitSweepReport =
  | { readonly status: 'skipped'; readonly reason: AfterExitSkipReason }
  | {
      readonly status: 'done';
      readonly summary: LadderSweepSummary;
      /** POSIX: the result of the ladder sweep over the EOF snapshot. */
      readonly posix?: SweepResult;
      /**
       * Windows: one entry per survivor candidate, leaf first. POSIX: the
       * members of live tool groups that were not in the EOF snapshot.
       */
      readonly kills: readonly AfterExitKill[];
    };

/**
 * Dependencies of {@link sweepAfterExit}.
 *
 * @public
 */
export interface AfterExitDeps {
  readonly os: OsCalls;
  /**
   * POSIX: the K1 signal target (its group is never signalled); the spawned
   * process when absent.
   */
  readonly signalTarget?: ProcessIdentity;
}

/**
 * Live processes of `records` that descend from `roots` by `ppid`
 * (Windows), with the pid-reuse guards of the module remarks, in
 * breadth-first order. The roots themselves are walked through, never
 * returned.
 */
function walkByParent(
  records: readonly ProcessRecord[],
  roots: readonly ProcessIdentity[],
): ProcessRecord[] {
  const { byPid } = indexByPid(records);
  const children = new Map<number, ProcessRecord[]>();
  for (const record of byPid.values()) {
    const siblings = children.get(record.ppid);
    if (siblings === undefined) children.set(record.ppid, [record]);
    else siblings.push(record);
  }
  const seen = new Set<number>(roots.map((root) => root.pid));
  const found: ProcessRecord[] = [];
  const queue: ProcessIdentity[] = [...roots];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    const holder = byPid.get(parent.pid);
    const reusedAt =
      holder !== undefined && holder.startTime !== parent.startTime ? holder.startTime : null;
    for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      if (compareStartTime(child.startTime, parent.startTime) < 0) continue;
      if (reusedAt !== null && compareStartTime(child.startTime, reusedAt) >= 0) continue;
      seen.add(child.pid);
      queue.push(child);
      found.push(child);
    }
  }
  return found;
}

/**
 * POSIX: members of the groups led by live, verified snapshot descendants,
 * not in the snapshot, started no earlier than their leader (module remarks).
 */
function liveGroupMembers(
  latest: readonly ProcessRecord[],
  descendants: readonly ProcessRecord[],
  protectedPids: ReadonlySet<number>,
): ProcessRecord[] {
  const known = new Set(descendants.map((record) => record.pid));
  const leaders = descendants.filter((record) => {
    if (record.pgid !== record.pid) return false;
    const now = findIdentity(latest, record);
    return now !== null && now.zombie !== true;
  });
  return latest.filter((record) => {
    if (known.has(record.pid) || protectedPids.has(record.pid) || record.zombie === true) {
      return false;
    }
    const leader = leaders.find((candidate) => candidate.pid === record.pgid);
    return leader !== undefined && compareStartTime(record.startTime, leader.startTime) >= 0;
  });
}

function signalSafely(signals: PosixSignalCalls, pid: number): SignalOutcome | 'error' {
  try {
    return signals.signalProcess(pid, 'SIGKILL');
  } catch {
    return 'error';
  }
}

/**
 * The outcome for one live-group member, re-verified against `now` (the
 * snapshot right before the kill; `null` when it could not be read: nothing
 * is signalled without a fresh identity).
 */
function memberOutcome(
  extra: ProcessIdentity,
  now: readonly ProcessRecord[] | null,
  kill: (pid: number) => SignalOutcome | 'error',
): AfterExitKill['outcome'] {
  if (now === null) return 'failed';
  const current = findIdentity(now, extra);
  if (current === null) {
    return now.some((record) => record.pid === extra.pid)
      ? 'skipped-identity-changed'
      : 'skipped-exited';
  }
  if (current.zombie === true) return 'skipped-exited';
  return kill(extra.pid) === 'sent' ? 'done' : 'failed';
}

function summarize(kills: readonly AfterExitKill[], base?: LadderSweepSummary): LadderSweepSummary {
  return {
    processesSignalled:
      (base?.processesSignalled ?? 0) + kills.filter((kill) => kill.outcome === 'done').length,
    groupsSignalled: base?.groupsSignalled ?? 0,
    skipped:
      (base?.skipped ?? 0) + kills.filter((kill) => kill.outcome.startsWith('skipped')).length,
  };
}

/**
 * Step 2 (see the module remarks): after the CLI exited, kills the
 * survivors it can identify soundly. Never rejects; every failure is in the
 * report.
 *
 * @public
 */
export async function sweepAfterExit(
  eof: EofSnapshot | null,
  deps: AfterExitDeps,
): Promise<AfterExitSweepReport> {
  if (eof === null) return { status: 'skipped', reason: 'no-snapshot' };
  const { os } = deps;
  let latest: ProcessSnapshot;
  try {
    latest = await takeSnapshot(os.processTable);
  } catch {
    return { status: 'skipped', reason: 'table-failed' };
  }
  const root = findIdentity(latest.records, eof.root);
  if (root !== null && root.zombie !== true) return { status: 'skipped', reason: 'root-alive' };
  const descendants = descendantsOf(eof.snapshot.records, eof.root).descendants;

  if (os.platform !== 'win32') {
    const extras = liveGroupMembers(
      latest.records,
      descendants,
      new Set([os.hostPid, eof.root.pid, deps.signalTarget?.pid ?? eof.root.pid]),
    );
    if (descendants.length === 0) return { status: 'skipped', reason: 'no-descendants' };
    const result = await sweep(
      { spawned: eof.root, signalTarget: deps.signalTarget ?? eof.root, recorded: [eof.snapshot] },
      { hostPid: os.hostPid, processTable: os.processTable, signals: os.signals },
    );
    const kills: AfterExitKill[] = [];
    if (extras.length > 0) {
      let now: readonly ProcessRecord[] | null;
      try {
        now = (await takeSnapshot(os.processTable)).records;
      } catch {
        now = null;
      }
      for (const extra of extras) {
        const outcome = memberOutcome(extra, now, (pid) => signalSafely(os.signals, pid));
        kills.push({ pid: extra.pid, source: 'started-after-eof', outcome });
      }
    }
    return {
      status: 'done',
      summary: summarize(kills, result.summary),
      posix: result,
      kills,
    };
  }

  const walked = walkByParent(latest.records, [eof.root, ...descendants]);
  const candidates: { identity: ProcessIdentity; source: AfterExitKill['source'] }[] = [
    ...descendants.map((identity) => ({ identity, source: 'eof-snapshot' as const })),
    ...walked.map((identity) => ({ identity, source: 'started-after-eof' as const })),
  ];
  if (candidates.length === 0) return { status: 'skipped', reason: 'no-descendants' };
  const kills: AfterExitKill[] = [];
  for (const { identity, source } of candidates.toReversed()) {
    const { pid } = identity;
    if (pid === os.hostPid) {
      kills.push({ pid, source, outcome: 'skipped-protected' });
    } else if (findIdentity(latest.records, identity) === null) {
      const reused = latest.records.some((record) => record.pid === pid);
      kills.push({ pid, source, outcome: reused ? 'skipped-identity-changed' : 'skipped-exited' });
    } else {
      let outcome: AfterExitKill['outcome'];
      try {
        outcome = (await os.terminate.taskkillProcess(pid)).exitCode === 0 ? 'done' : 'failed';
      } catch {
        outcome = 'failed';
      }
      kills.push({ pid, source, outcome });
    }
  }
  return { status: 'done', summary: summarize(kills), kills };
}
