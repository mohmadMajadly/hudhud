/**
 * The sweep of the graceful close path (W3-Z ruling 5, ADR-0008, ADR-0010).
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
 * 2. {@link sweepAfterExit}: after the CLI has exited, every descendant of
 *    that snapshot that is still the same process (pid and start time match
 *    a fresh snapshot) is killed. POSIX: the ladder's {@link sweep}
 *    (`SIGKILL`, verified groups first, never the host's group). Windows
 *    (best effort): one `taskkill /F /PID` per survivor, leaf first, as the
 *    best-effort ladder's sweep does. With the job addon the job close
 *    (`KILL_ON_JOB_CLOSE`) already ends every process of the tree; this
 *    sweep is for sessions without a job.
 *
 * Nothing is signalled while the spawned process is still running (status
 * `skipped`, reason `root-alive`): the sweep ends a tree whose root is gone,
 * it never shortens a running session. Residual, as for every sweep: the
 * fresh snapshot and the kill calls are not atomic.
 *
 * @packageDocumentation
 */

import type { OsCalls } from '../os/types.js';
import { sweep, type SweepResult } from '../sweep.js';
import { descendantsOf, findIdentity } from '../tree/descendants.js';
import { takeSnapshot } from '../tree/snapshot.js';
import type { ProcessIdentity, ProcessSnapshot } from '../tree/types.js';
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
 * Why {@link sweepAfterExit} signalled nothing.
 *
 * @public
 */
export type AfterExitSkipReason =
  /** No EOF snapshot (no identity, root gone, table unreadable). */
  | 'no-snapshot'
  /** The snapshot recorded no descendant. */
  | 'no-descendants'
  /** The fresh table could not be read. */
  | 'table-failed'
  /** The spawned process is still running. */
  | 'root-alive';

/**
 * One `taskkill /F /PID` of the Windows sweep.
 *
 * @public
 */
export interface AfterExitKill {
  readonly pid: number;
  readonly outcome:
    'done' | 'failed' | 'skipped-exited' | 'skipped-identity-changed' | 'skipped-protected';
}

/**
 * What {@link sweepAfterExit} did. JSON data.
 *
 * @public
 */
export type AfterExitSweepReport =
  | { readonly status: 'skipped'; readonly reason: AfterExitSkipReason }
  | {
      readonly status: 'done';
      readonly summary: LadderSweepSummary;
      /** POSIX: the result of the ladder sweep. */
      readonly posix?: SweepResult;
      /** Windows: one entry per descendant of the snapshot, leaf first. */
      readonly win32?: readonly AfterExitKill[];
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
 * Step 2 (see the module remarks): after the CLI exited, kills the
 * descendants of the EOF snapshot that are still the same processes.
 * Never rejects; every failure is in the report.
 *
 * @public
 */
export async function sweepAfterExit(
  eof: EofSnapshot | null,
  deps: AfterExitDeps,
): Promise<AfterExitSweepReport> {
  if (eof === null) return { status: 'skipped', reason: 'no-snapshot' };
  const candidates = descendantsOf(eof.snapshot.records, eof.root).descendants;
  if (candidates.length === 0) return { status: 'skipped', reason: 'no-descendants' };
  const { os } = deps;
  let latest: ProcessSnapshot;
  try {
    latest = await takeSnapshot(os.processTable);
  } catch {
    return { status: 'skipped', reason: 'table-failed' };
  }
  const root = findIdentity(latest.records, eof.root);
  if (root !== null && root.zombie !== true) return { status: 'skipped', reason: 'root-alive' };

  if (os.platform !== 'win32') {
    const result = await sweep(
      { spawned: eof.root, signalTarget: deps.signalTarget ?? eof.root, recorded: [eof.snapshot] },
      { hostPid: os.hostPid, processTable: os.processTable, signals: os.signals },
    );
    return { status: 'done', summary: result.summary, posix: result };
  }

  const kills: AfterExitKill[] = [];
  for (const candidate of candidates.toReversed()) {
    const { pid } = candidate;
    if (pid === os.hostPid) {
      kills.push({ pid, outcome: 'skipped-protected' });
    } else if (findIdentity(latest.records, candidate) === null) {
      const reused = latest.records.some((record) => record.pid === pid);
      kills.push({ pid, outcome: reused ? 'skipped-identity-changed' : 'skipped-exited' });
    } else {
      let outcome: AfterExitKill['outcome'];
      try {
        outcome = (await os.terminate.taskkillProcess(pid)).exitCode === 0 ? 'done' : 'failed';
      } catch {
        outcome = 'failed';
      }
      kills.push({ pid, outcome });
    }
  }
  return {
    status: 'done',
    summary: {
      processesSignalled: kills.filter((kill) => kill.outcome === 'done').length,
      groupsSignalled: 0,
      skipped: kills.filter((kill) => kill.outcome.startsWith('skipped')).length,
    },
    win32: kills,
  };
}
