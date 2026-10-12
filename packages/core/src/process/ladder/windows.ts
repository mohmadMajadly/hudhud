/**
 * The Windows termination ladder (ADR-0009, plan §1.7).
 *
 * @remarks
 * With a job (`processContainment: 'job'`):
 * intent -> interrupt (at most `interruptWaitMs`) -> stdin EOF ->
 * `eofGraceMs` -> `TerminateJobObject`. If terminating the job fails, the
 * best-effort steps follow, with S1 taken at that point and the sweep.
 *
 * Best-effort (no job): intent -> interrupt -> snapshot S1 -> EOF ->
 * `eofGraceMs` -> `taskkill /T /F` (absolute `System32` path, `shell: false`,
 * see `taskkill.ts`) -> `taskkillGraceMs` -> `TerminateProcess` through the
 * child handle -> `taskkillGraceMs` to observe the exit. Whenever the spawned
 * process is observed to have exited after S1, the S1 descendants are swept:
 * the CLI can exit and still leave a tool tree outside every job (07 §2),
 * which `taskkill /T` can no longer reach through the exited parent.
 *
 * Identity guards (ADR-0011 J9; never act on a reused pid):
 * - Nothing is done to the process once its exit was observed. While the
 *   exit is not observed, the child handle that Node (libuv) holds is still
 *   open, and Windows does not reuse the pid of a process while a handle to
 *   it is open.
 * - Before `taskkill` (which takes a bare pid), a fresh snapshot must show the
 *   spawned pid with its recorded start time; when the snapshot cannot be
 *   taken, or the start time differs, `taskkill` is skipped. It is also
 *   skipped when a process in the snapshot names a member of the tree as its
 *   parent without being a verified descendant (it started before that
 *   parent, so its `ppid` is stale and names a reused pid): `taskkill /T`
 *   follows parent pids without checking start times and would kill that
 *   foreign process.
 * - Before `TerminateProcess`, a fresh snapshot that shows the pid with
 *   another start time skips the step. When no snapshot can be taken the
 *   step still runs: it acts through the child handle, which can only reach
 *   the spawned process.
 *
 * - The sweep acts only on S1 descendants of the spawned process whose pid
 *   and start time still match in a fresh snapshot, never on the host, leaf
 *   first, one `taskkill /F /PID` (no `/T`) each.
 *
 * Residual, documented: the snapshot and the `taskkill` call are not atomic.
 * A descendant that exits between the two, and whose pid is reused by a
 * process whose parent is another tree member, is not distinguishable.
 *
 * The termination intent is recorded first (ADR-0008 E8): a job kill
 * surfaces as exit code 0.
 *
 * @packageDocumentation
 */

import type { OsCalls } from '../os/types.js';
import type { TaskkillCalls } from '../taskkill.js';
import { takeSnapshot } from '../tree/snapshot.js';
import { descendantsOf, findIdentity } from '../tree/descendants.js';
import type { ProcessIdentity, ProcessSnapshot } from '../tree/types.js';
import type {
  InterruptOutcome,
  LadderClock,
  LadderHooks,
  LadderReport,
  LadderStep,
  LadderStepName,
  LadderSweepSummary,
  LadderTiming,
} from './types.js';

/**
 * The spawned child as the Windows ladder sees it.
 *
 * @public
 */
export interface WindowsLadderProcess {
  /** The spawned pid and its start time in the canonical Windows unit (microseconds). */
  readonly identity: ProcessIdentity;
  /**
   * True once the exit was observed (Node's `exit` event). Until then the
   * child handle is open and the pid cannot be reused.
   */
  hasExited(): boolean;
  /** Settles when the exit is observed. Never rejects. */
  readonly exited: Promise<unknown>;
  /** Ends stdin (EOF). Idempotent. */
  closeStdin(): void;
  /**
   * `TerminateProcess` through the child handle (Node's `child.kill()` on
   * Windows). Returns false when the process was no longer running.
   */
  terminate(): boolean;
}

/**
 * The job object the child was assigned to (plan §6.4; created by the job
 * addon, W3-T5).
 *
 * @public
 */
export interface JobHandle {
  /**
   * `TerminateJobObject`: kills every process in the job. Idempotent. Throws
   * an `Error` with a string `code` (`WIN32_<n>`, `ERR_JOB_CLOSED`) on failure.
   */
  terminate(): void;
}

/**
 * The Windows part of {@link OsCalls}, with the `taskkill` calls of
 * `taskkill.ts` (the tree kill plus the per-process kill the sweep uses).
 *
 * @public
 */
export type WindowsOsCalls = Omit<Extract<OsCalls, { readonly platform: 'win32' }>, 'terminate'> & {
  readonly terminate: TaskkillCalls;
};

/**
 * Dependencies of {@link runWindowsLadder}.
 *
 * @public
 */
export interface WindowsLadderDeps<Intent extends string> {
  /** The termination intent, recorded before anything is done. */
  readonly intent: Intent;
  /** `initialize.pid` when the handshake reported it, else `null`. */
  readonly initializePid: number | null;
  readonly clock: LadderClock;
  readonly os: WindowsOsCalls;
}

const DETAIL = /^[A-Za-z0-9_-]{1,64}$/;

/** A short machine-readable detail from an error: its string `code`, never its message. */
function errorDetail(error: unknown): string {
  if (typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')) {
    const code: unknown = (error as { code: unknown }).code;
    if (typeof code === 'string' && DETAIL.test(code)) return code;
  }
  return 'error';
}

function exitDetail(exitCode: number | null): string {
  return exitCode === null ? 'no-exit-code' : `exit-${String(exitCode)}`;
}

/** `absent`: the snapshot lacks the pid; `unverified`: no snapshot could be taken. */
type IdentityCheck = 'match' | 'changed' | 'absent' | 'foreign-child' | 'unverified';

/**
 * Runs the Windows ladder to its end and reports what it did. Never rejects
 * for a failed step; each failure is recorded in the report.
 *
 * @param job - the job the child was assigned to, or `null` for best-effort
 * @public
 */
export async function runWindowsLadder<Intent extends string>(
  proc: WindowsLadderProcess,
  hooks: LadderHooks,
  timing: LadderTiming,
  job: JobHandle | null,
  deps: WindowsLadderDeps<Intent>,
): Promise<LadderReport<Intent>> {
  const { clock, os } = deps;
  const steps: LadderStep[] = [];
  let exitedAfter: LadderStepName | null = null;
  /** The intent is recorded before the first observation, so this starts as `intent`. */
  let lastStep: LadderStepName = 'intent';

  const observe = (): boolean => {
    const exited = proc.hasExited();
    if (exited && exitedAfter === null) exitedAfter = lastStep;
    return exited;
  };

  const record = (
    name: LadderStepName,
    atMs: number,
    outcome: LadderStep['outcome'],
    detail?: string,
  ): void => {
    const step: LadderStep =
      detail === undefined ? { name, atMs, outcome } : { name, atMs, outcome, detail };
    steps.push(step);
    lastStep = name;
    try {
      hooks.onStep?.(step);
    } catch {
      // Diagnostics must not change the ladder.
    }
  };

  /** Resolves with true when the exit was observed within `ms`. */
  const waitForExit = async (ms: number): Promise<boolean> => {
    if (observe()) return true;
    const { promise: timeout, resolve } = Promise.withResolvers<undefined>();
    const cancel = clock.schedule(ms, () => {
      resolve(undefined);
    });
    await Promise.race([proc.exited, timeout]);
    cancel();
    return observe();
  };

  /** Whether the snapshot still shows the spawned process (and no foreign child of its tree). */
  const checkIdentity = async (forTaskkill: boolean): Promise<IdentityCheck> => {
    let snapshot: ProcessSnapshot;
    try {
      snapshot = await takeSnapshot(os.processTable);
    } catch {
      return 'unverified';
    }
    if (findIdentity(snapshot.records, proc.identity) === null) {
      return snapshot.records.some((record) => record.pid === proc.identity.pid)
        ? 'changed'
        : 'absent';
    }
    if (forTaskkill) {
      const tree = descendantsOf(snapshot.records, proc.identity);
      const members = new Set([proc.identity.pid, ...tree.descendants.map((d) => d.pid)]);
      const foreign = snapshot.records.some(
        (record) => members.has(record.ppid) && !members.has(record.pid),
      );
      if (foreign) return 'foreign-child';
    }
    return 'match';
  };

  let sweepSummary: LadderSweepSummary | null = null;

  const report = (): LadderReport<Intent> => ({
    intent: deps.intent,
    platform: 'win32',
    steps,
    exitedAfter,
    signalTarget: null,
    launcherDetected: deps.initializePid !== null && deps.initializePid !== proc.identity.pid,
    sweep: sweepSummary,
  });

  /** S1: the tree while the spawned process is alive, so its parent links are intact. */
  const snapshotS1 = async (): Promise<ProcessSnapshot | null> => {
    const at = clock.now();
    try {
      const snapshot = await takeSnapshot(os.processTable);
      const count = descendantsOf(snapshot.records, proc.identity).descendants.length;
      record('snapshot-s1', at, 'done', `descendants-${String(count)}`);
      return snapshot;
    } catch (error) {
      record('snapshot-s1', at, 'failed', errorDetail(error));
      return null;
    }
  };

  /**
   * Kills the S1 descendants that are still the same processes (pid and start
   * time match S1 in a fresh snapshot), leaf first, one `taskkill /F /PID`
   * each (no `/T`). The host is never touched.
   */
  const sweep = async (s1: ProcessSnapshot): Promise<void> => {
    const candidates = descendantsOf(s1.records, proc.identity).descendants.toReversed();
    if (candidates.length === 0) return;
    let processesSignalled = 0;
    let skipped = 0;
    const at = clock.now();
    let latest: ProcessSnapshot;
    try {
      latest = await takeSnapshot(os.processTable);
    } catch (error) {
      record('sweep', at, 'failed', errorDetail(error));
      sweepSummary = { processesSignalled, groupsSignalled: 0, skipped: candidates.length };
      return;
    }
    for (const candidate of candidates) {
      const stepAt = clock.now();
      const pid = `pid-${String(candidate.pid)}`;
      let reason: string | null = null;
      if (candidate.pid === os.hostPid) reason = 'protected';
      else if (findIdentity(latest.records, candidate) === null) {
        reason = latest.records.some((record) => record.pid === candidate.pid)
          ? 'identity-changed'
          : 'exited';
      }
      if (reason !== null) {
        skipped += 1;
        record('sweep', stepAt, 'skipped', `${pid}-${reason}`);
        continue;
      }
      try {
        const result = await os.terminate.taskkillProcess(candidate.pid);
        if (result.exitCode === 0) {
          processesSignalled += 1;
          record('sweep', stepAt, 'done', pid);
        } else {
          record('sweep', stepAt, 'failed', `${pid}-${exitDetail(result.exitCode)}`);
        }
      } catch (error) {
        record('sweep', stepAt, 'failed', `${pid}-${errorDetail(error)}`);
      }
    }
    sweepSummary = { processesSignalled, groupsSignalled: 0, skipped };
  };

  /** Ends the ladder: sweeps the S1 tree when the spawned process has exited. */
  const finish = async (s1: ProcessSnapshot | null): Promise<LadderReport<Intent>> => {
    if (observe() && s1 !== null) await sweep(s1);
    return report();
  };

  /** The last step: TerminateProcess through the child handle, then observe the exit. */
  const terminateProcess = async (): Promise<void> => {
    const at = clock.now();
    if (observe()) return;
    const identity = await checkIdentity(false);
    if (observe()) {
      record('terminate-process', at, 'skipped', 'exited');
      return;
    }
    if (identity === 'changed') {
      record('terminate-process', at, 'skipped', 'identity-changed');
      return;
    }
    try {
      if (proc.terminate()) record('terminate-process', at, 'done');
      else record('terminate-process', at, 'skipped', 'not-running');
    } catch (error) {
      record('terminate-process', at, 'failed', errorDetail(error));
    }
    await waitForExit(timing.taskkillGraceMs);
  };

  // Intent first (ADR-0008 E8).
  record('intent', clock.now(), 'done');
  if (observe()) return report();

  // Interrupt, bounded by interruptWaitMs whatever the hook does.
  const interruptAt = clock.now();
  let outcome: InterruptOutcome | 'failed';
  {
    const { promise: timeout, resolve } = Promise.withResolvers<'timeout'>();
    const cancel = clock.schedule(timing.interruptWaitMs, () => {
      resolve('timeout');
    });
    let hookResult: Promise<InterruptOutcome | 'failed'>;
    try {
      hookResult = hooks.interrupt().catch(() => 'failed' as const);
    } catch {
      hookResult = Promise.resolve('failed');
    }
    outcome = await Promise.race([hookResult, timeout]);
    cancel();
  }
  if (outcome === 'failed') record('interrupt', interruptAt, 'failed', 'hook-error');
  else if (outcome === 'not-applicable') record('interrupt', interruptAt, 'skipped', outcome);
  else record('interrupt', interruptAt, 'done', outcome);
  if (observe()) return report();

  // stdin EOF, then the grace. Without a job, S1 is taken first (the sweep's input).
  let s1 = job === null ? await snapshotS1() : null;
  if (observe()) return finish(s1);
  const eofAt = clock.now();
  try {
    proc.closeStdin();
    record('eof', eofAt, 'done');
  } catch (error) {
    record('eof', eofAt, 'failed', errorDetail(error));
  }
  if (await waitForExit(timing.eofGraceMs)) return finish(s1);

  if (job !== null) {
    const jobAt = clock.now();
    let terminated = false;
    try {
      job.terminate();
      terminated = true;
      record('terminate-job', jobAt, 'done');
    } catch (error) {
      record('terminate-job', jobAt, 'failed', errorDetail(error));
    }
    if (terminated) {
      if (await waitForExit(timing.taskkillGraceMs)) return report();
      await terminateProcess();
      return report();
    }
    // The job failed: the best-effort steps follow, sweep included.
    s1 = await snapshotS1();
    if (observe()) return finish(s1);
  }

  // Best-effort: taskkill /T /F, guarded by the identity.
  const taskkillAt = clock.now();
  const check = await checkIdentity(true);
  if (observe()) {
    record('taskkill', taskkillAt, 'skipped', 'exited');
    return finish(s1);
  }
  if (proc.identity.pid === os.hostPid) {
    record('taskkill', taskkillAt, 'skipped', 'protected');
  } else if (check !== 'match') {
    record('taskkill', taskkillAt, 'skipped', `identity-${check}`);
  } else {
    try {
      const result = await os.terminate.taskkillTree(proc.identity.pid);
      if (result.exitCode === 0) record('taskkill', taskkillAt, 'done');
      else record('taskkill', taskkillAt, 'failed', exitDetail(result.exitCode));
    } catch (error) {
      record('taskkill', taskkillAt, 'failed', errorDetail(error));
    }
    if (await waitForExit(timing.taskkillGraceMs)) return finish(s1);
  }

  await terminateProcess();
  return finish(s1);
}
