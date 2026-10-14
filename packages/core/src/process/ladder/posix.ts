import type { OsCalls, PosixSignal, SignalOutcome } from '../os/types.js';
import { sweep } from '../sweep.js';
import { maySignal, selectSignalTarget } from '../tree/select.js';
import { takeSnapshot } from '../tree/snapshot.js';
import type { ProcessIdentity, ProcessSnapshot } from '../tree/types.js';
import { awaitIdentity } from './identity.js';
import type {
  LadderClock,
  LadderHooks,
  LadderIdentity,
  LadderReport,
  LadderStep,
  LadderStepName,
  LadderSweepSummary,
  LadderTiming,
} from './types.js';

/**
 * The POSIX abort ladder (ADR-0010 as amended by K1; plan §1.7):
 *
 * 1. record the termination intent (ADR-0008 E8);
 * 2. interrupt through the driver's hook (`cancel_queued`), bounded by
 *    `interruptWaitMs`;
 * 3. stdin EOF, then wait `eofGraceMs`;
 * 4. the spawned process's identity (awaited here, read since the spawn),
 *    snapshot S1, then `SIGTERM` to the K1 signal target only, then wait
 *    `termGraceMs`;
 * 5. snapshot S2, then `SIGKILL` to the signal target (only if its pid and
 *    start time still match S2) and to the spawned process, then the sweep
 *    over S1 ∪ S2 (`../sweep.ts`).
 *
 * Without a verified identity of the spawned process (the read failed), no
 * snapshot is taken and nothing is swept: the snapshots and the sweep are
 * rooted at that identity. `SIGTERM` and `SIGKILL` then go to the spawned
 * pid only, which is safe for the reason below.
 *
 * The ladder stops at the first point where the spawned process is seen to
 * have exited, and it never sends a signal after that: each signal is
 * preceded, without an intervening `await`, by an exit check. The spawned
 * process is the host's own child: until Node has observed its exit (and
 * reaped it), its pid cannot have been reused, so it is signalled by pid
 * like `ChildProcess.kill` does. Every other pid is signalled only with an
 * identity verified against the latest snapshot. `kill(-pgid)` is reached
 * only through the sweep plan, which never selects the host's, the spawned
 * process's or the CLI's group.
 *
 * The ladder never rejects for an OS failure: a failed snapshot, hook or
 * signal is recorded as a `failed` step and the ladder goes on.
 */

/**
 * The spawned process as the POSIX ladder sees it.
 *
 * @public
 */
export interface PosixLadderProcess {
  /** The spawned pid (the host's own child). */
  readonly pid: number;
  /**
   * The spawned pid plus its start time (ADR-0011 J9): root of snapshots
   * and sweep. Awaited right before snapshot S1; without it (`null`) the
   * ladder signals only the spawned pid and takes no snapshot and no sweep.
   */
  readonly identity: LadderIdentity;
  /** `initialize.pid` reported by the harness, or `null` before the handshake. */
  readonly initializePid: number | null;
  /** True once the host observed the exit of the spawned process. */
  hasExited(): boolean;
  /** Settles (either way) when the spawned process exited; settled once `hasExited()` is true. */
  readonly exited: Promise<unknown>;
  /** Closes the child's stdin (EOF). */
  endStdin(): void;
}

/**
 * The operating-system calls of a POSIX host.
 *
 * @public
 */
export type PosixOsCalls = Extract<OsCalls, { readonly platform: 'linux' | 'darwin' }>;

/**
 * Dependencies of {@link runPosixLadder}.
 *
 * @public
 */
export interface PosixLadderDeps<Intent extends string = string> {
  /** The termination intent, recorded before any signal (ADR-0008 E8). */
  readonly intent: Intent;
  readonly os: PosixOsCalls;
  readonly clock: LadderClock;
}

type InterruptResult = 'acknowledged' | 'timeout' | 'not-applicable' | 'hook-error' | 'exited';

const INTERRUPT_STEP: Readonly<
  Record<InterruptResult, Pick<LadderStep, 'outcome'> & { readonly detail: string }>
> = {
  acknowledged: { outcome: 'done', detail: 'acknowledged' },
  timeout: { outcome: 'done', detail: 'timeout' },
  exited: { outcome: 'done', detail: 'exited' },
  'not-applicable': { outcome: 'skipped', detail: 'not-applicable' },
  'hook-error': { outcome: 'failed', detail: 'hook-error' },
};

const ERRNO: Readonly<Record<Exclude<SignalOutcome, 'sent'>, string>> = {
  'no-such-process': 'ESRCH',
  'not-permitted': 'EPERM',
};

/**
 * Runs the POSIX abort ladder against one spawned process.
 *
 * @param proc - the spawned process.
 * @param hooks - the driver's interrupt hook and step observer.
 * @param timing - the ladder timing (`interruptWaitMs`, `eofGraceMs`, `termGraceMs`).
 * @param deps - intent, OS calls and clock.
 * @returns what the ladder did. Never rejects for an OS or hook failure.
 *
 * @public
 */
export async function runPosixLadder<Intent extends string>(
  proc: PosixLadderProcess,
  hooks: LadderHooks,
  timing: LadderTiming,
  deps: PosixLadderDeps<Intent>,
): Promise<LadderReport<Intent>> {
  const { os, clock } = deps;
  const { initializePid } = proc;
  const steps: LadderStep[] = [];
  // Subscribed at once, so a rejected read is handled even when the ladder
  // ends before it needs the identity (step 4).
  const identityRead = awaitIdentity(proc.pid, proc.identity, proc.exited);
  let signalTarget: ProcessIdentity | null = null;
  let sweepSummary: LadderSweepSummary | null = null;

  const report = (exitedAfter: LadderStepName | null): LadderReport<Intent> => ({
    intent: deps.intent,
    platform: 'posix',
    steps,
    exitedAfter,
    signalTarget,
    launcherDetected: initializePid !== null && initializePid !== proc.pid,
    sweep: sweepSummary,
  });

  const record = (
    name: LadderStepName,
    atMs: number,
    outcome: LadderStep['outcome'],
    detail?: string,
  ): void => {
    const step: LadderStep =
      detail === undefined ? { name, atMs, outcome } : { name, atMs, outcome, detail };
    steps.push(step);
    try {
      hooks.onStep?.(step);
    } catch {
      // An observer must not throw; if it does, the ladder still goes on.
    }
  };

  /** Resolves with `fallback()` after `ms`, or `exited` as soon as the process exited. */
  const race = <T>(
    ms: number,
    fallback: () => T,
    exited: T,
    other?: (settle: (value: T) => void) => void,
  ): Promise<T> =>
    new Promise<T>((resolve) => {
      let done = false;
      const settle = (value: T): void => {
        if (done) return;
        done = true;
        cancel();
        resolve(value);
      };
      const cancel = clock.schedule(ms, () => {
        settle(fallback());
      });
      const onExit = (): void => {
        settle(exited);
      };
      proc.exited.then(onExit, onExit);
      other?.(settle);
    });

  /** True when the process exited within `ms` (or already had: `exited` is then settled). */
  const waitForExit = (ms: number): Promise<boolean> => race(ms, () => proc.hasExited(), true);

  /**
   * After the SIGKILL: whether the host observed the exit, waiting for it at
   * most `termGraceMs`. The kernel ends the process at once, but the host
   * learns of it only when Node reaps the child, later (measured on Linux,
   * W6-Z: with Node 26 the exit was not yet observed in 22 of 40 such
   * reports), so reading `hasExited()` right away reported a killed process
   * as never exited.
   */
  const exitedAfterKill = async (): Promise<boolean> =>
    proc.hasExited() || (await waitForExit(timing.termGraceMs));

  const signal = (name: LadderStepName, pid: number, sig: PosixSignal, label: string): void => {
    const atMs = clock.now();
    let outcome: SignalOutcome | 'error';
    try {
      outcome = os.signals.signalProcess(pid, sig);
    } catch {
      outcome = 'error';
    }
    if (outcome === 'sent') record(name, atMs, 'done', label);
    else record(name, atMs, 'failed', `${label}:${outcome === 'error' ? 'error' : ERRNO[outcome]}`);
  };

  const snapshot = async (name: 'snapshot-s1' | 'snapshot-s2'): Promise<ProcessSnapshot | null> => {
    const atMs = clock.now();
    try {
      const taken = await takeSnapshot(os.processTable);
      record(name, atMs, 'done');
      return taken;
    } catch {
      record(name, atMs, 'failed', 'error');
      return null;
    }
  };

  /**
   * Steps 4 and 5 without a verified identity: the spawned pid only (the
   * host's unreaped child), no snapshot, no sweep. Called right after an
   * exit check; each signal follows an exit check without an `await`.
   */
  const withoutIdentity = async (pid: number): Promise<LadderReport<Intent>> => {
    record('snapshot-s1', clock.now(), 'skipped', 'no-identity');
    signal('sigterm', pid, 'SIGTERM', 'spawned');
    if (await waitForExit(timing.termGraceMs)) return report('sigterm');
    record('snapshot-s2', clock.now(), 'skipped', 'no-identity');
    signal('sigkill', pid, 'SIGKILL', 'spawned');
    record('sweep', clock.now(), 'skipped', 'no-identity');
    return report((await exitedAfterKill()) ? 'sigkill' : null);
  };

  // 1. Intent first, before anything that may signal (ADR-0008 E8).
  record('intent', clock.now(), 'done');
  if (proc.hasExited()) return report('intent');

  // 2. Interrupt through the machine, bounded here as well as by the hook.
  const interruptAt = clock.now();
  const interrupted = await race<InterruptResult>(
    timing.interruptWaitMs,
    () => 'timeout',
    'exited',
    (settle) => {
      Promise.resolve()
        .then(() => hooks.interrupt())
        .then(settle, () => {
          settle('hook-error');
        });
    },
  );
  const interruptStep = INTERRUPT_STEP[interrupted];
  record('interrupt', interruptAt, interruptStep.outcome, interruptStep.detail);
  if (proc.hasExited()) return report('interrupt');

  // 3. EOF, then the grace period.
  const eofAt = clock.now();
  try {
    proc.endStdin();
    record('eof', eofAt, 'done');
  } catch {
    record('eof', eofAt, 'failed', 'error');
  }
  if (await waitForExit(timing.eofGraceMs)) return report('eof');

  // 4. The identity (read since the spawn), S1, then SIGTERM to the K1 signal target only.
  const awaited = await identityRead;
  if (awaited.exited || proc.hasExited()) return report('eof');
  const spawned = awaited.identity;
  if (spawned === null) return withoutIdentity(proc.pid);
  const s1 = await snapshot('snapshot-s1');
  if (proc.hasExited()) return report('snapshot-s1');
  const decision = selectSignalTarget({
    spawned,
    initializePid,
    hostPid: os.hostPid,
    // Without S1 nothing can be verified, so K1 falls back to the spawned pid.
    s1: s1 ?? { source: os.processTable.source, records: [], rejected: 0 },
  });
  signalTarget = decision.target;
  signal('sigterm', decision.target.pid, 'SIGTERM', decision.source);
  if (await waitForExit(timing.termGraceMs)) return report('sigterm');

  // 5. S2, then SIGKILL of the signal target (re-verified) and the spawned pid, then the sweep.
  const s2 = await snapshot('snapshot-s2');
  if (proc.hasExited()) return report('snapshot-s2');
  if (decision.source === 'initialize-pid') {
    if (s2 !== null && maySignal(decision.target, s2, os.hostPid)) {
      signal('sigkill', decision.target.pid, 'SIGKILL', 'signal-target');
    } else {
      // S2 is missing, or the CLI exited or its pid was reused between S1 and S2.
      const target = decision.target.pid;
      const why =
        s2 === null
          ? 'unverified'
          : s2.records.some((entry) => entry.pid === target)
            ? 'identity-changed'
            : 'exited';
      record('sigkill', clock.now(), 'skipped', `signal-target:${why}`);
    }
  }
  if (proc.hasExited()) {
    record('sigkill', clock.now(), 'skipped', 'spawned:exited');
  } else {
    signal('sigkill', spawned.pid, 'SIGKILL', 'spawned');
  }

  const recorded = [s1, s2].filter((taken) => taken !== null);
  const sweepAt = clock.now();
  if (recorded.length === 0) {
    record('sweep', sweepAt, 'skipped', 'no-snapshot');
  } else {
    const swept = await sweep(
      { spawned, signalTarget: decision.target, recorded },
      { hostPid: os.hostPid, processTable: os.processTable, signals: os.signals },
    );
    if (swept.plan === null) {
      record('sweep', sweepAt, 'failed', 'snapshot-failed');
    } else {
      sweepSummary = swept.summary;
      record('sweep', sweepAt, 'done');
    }
  }
  return report((await exitedAfterKill()) ? 'sweep' : null);
}
