import type { LadderSweepSummary } from './ladder/types.js';
import type {
  DarwinPsTableCalls,
  LinuxProcTableCalls,
  PosixSignal,
  PosixSignalCalls,
  SignalOutcome,
} from './os/types.js';
import { planSweep, type SweepPlan } from './tree/select.js';
import { takeSnapshot } from './tree/snapshot.js';
import type { ProcessIdentity, ProcessSnapshot } from './tree/types.js';

/**
 * The POSIX sweep (ADR-0010 "Sweep"): after `SIGKILL` of the signal target
 * and the spawned process, signal whatever the snapshots S1 and S2 recorded
 * below the spawned root and is still the same process now.
 *
 * Every decision is made by {@link planSweep} over a fresh snapshot taken
 * immediately before the signals; this module only performs the calls:
 *
 * 1. `kill(-pgid, SIGKILL)` for each planned group (led by a verified
 *    descendant, every current member verified, never the host's, the
 *    spawned process's or the CLI's group).
 * 2. `kill(pid, SIGKILL)` for each planned process that is not a member of
 *    a group signalled in step 1. A member of a signalled group is not
 *    signalled again by pid: it was already reached, and a second call by
 *    pid would only widen the pid-reuse window.
 *
 * Groups go first so that a process forked into a tool group after the
 * latest snapshot is still reached. Residual, documented in
 * `tree/select.ts`: the latest snapshot and the `kill(2)` calls are not
 * atomic.
 */

/** The signal of the sweep. */
const SWEEP_SIGNAL: PosixSignal = 'SIGKILL';

/**
 * What the sweep needs from the operating system (POSIX).
 *
 * @public
 */
export interface SweepDeps {
  /** `process.pid` of the host. */
  readonly hostPid: number;
  readonly processTable: LinuxProcTableCalls | DarwinPsTableCalls;
  readonly signals: PosixSignalCalls;
}

/**
 * What to sweep.
 *
 * @public
 */
export interface SweepRequest {
  /** Identity of the spawned process: the root of the sweep (ADR-0011 J9). */
  readonly spawned: ProcessIdentity;
  /** The K1 signal target (the spawned process when no launcher was detected). */
  readonly signalTarget: ProcessIdentity;
  /** Snapshots recorded while the tree was intact (S1, S2), oldest first. */
  readonly recorded: readonly ProcessSnapshot[];
}

/**
 * Result of one `kill(2)` call by the sweep; `error` when the adapter threw.
 *
 * @public
 */
export type SweepSignalOutcome = SignalOutcome | 'error';

/**
 * What the sweep did. JSON data.
 *
 * @public
 */
export interface SweepResult {
  /** The plan over the latest snapshot; `null` when that snapshot could not be taken. */
  readonly plan: SweepPlan | null;
  readonly groups: readonly { readonly pgid: number; readonly outcome: SweepSignalOutcome }[];
  readonly processes: readonly { readonly pid: number; readonly outcome: SweepSignalOutcome }[];
  /** Planned processes not signalled by pid because their group was signalled. */
  readonly coveredByGroup: readonly number[];
  readonly summary: LadderSweepSummary;
}

function call(send: () => SignalOutcome): SweepSignalOutcome {
  try {
    return send();
  } catch {
    return 'error';
  }
}

/**
 * Plans the sweep over the recorded snapshots and a fresh one, then signals
 * the planned groups and processes with `SIGKILL`. Never rejects: a
 * failed snapshot yields `plan: null` and signals nothing; a failed signal
 * is recorded in its outcome. `summary.processesSignalled` counts the
 * successful calls by pid, `summary.groupsSignalled` the successful
 * `kill(-pgid)` calls.
 *
 * @public
 */
export async function sweep(request: SweepRequest, deps: SweepDeps): Promise<SweepResult> {
  let latest: ProcessSnapshot;
  try {
    latest = await takeSnapshot(deps.processTable);
  } catch {
    return {
      plan: null,
      groups: [],
      processes: [],
      coveredByGroup: [],
      summary: { processesSignalled: 0, groupsSignalled: 0, skipped: 0 },
    };
  }

  const plan = planSweep({
    spawned: request.spawned,
    signalTarget: request.signalTarget,
    hostPid: deps.hostPid,
    recorded: request.recorded,
    latest,
  });

  const groups = plan.groups.map((group) => ({
    pgid: group.pgid,
    outcome: call(() => deps.signals.signalGroup(group.pgid, SWEEP_SIGNAL)),
  }));
  const reached = new Set(
    groups.filter((group) => group.outcome === 'sent').map((group) => group.pgid),
  );
  // Membership by the latest snapshot, the one the plan verified.
  const pgidByPid = new Map(latest.records.map((record) => [record.pid, record.pgid]));

  const processes: { pid: number; outcome: SweepSignalOutcome }[] = [];
  const coveredByGroup: number[] = [];
  for (const identity of plan.processes) {
    const pgid = pgidByPid.get(identity.pid);
    if (pgid !== undefined && reached.has(pgid)) {
      coveredByGroup.push(identity.pid);
    } else {
      processes.push({
        pid: identity.pid,
        outcome: call(() => deps.signals.signalProcess(identity.pid, SWEEP_SIGNAL)),
      });
    }
  }

  return {
    plan,
    groups,
    processes,
    coveredByGroup,
    summary: {
      processesSignalled: processes.filter((entry) => entry.outcome === 'sent').length,
      groupsSignalled: reached.size,
      skipped: plan.skippedProcesses.length + plan.skippedGroups.length,
    },
  };
}
