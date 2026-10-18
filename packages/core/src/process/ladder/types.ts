import type { ProcessIdentity } from '../tree/types.js';

/**
 * Types shared by the termination ladders (ADR-0009, ADR-0010, plan §1.7).
 * The ladders themselves land in W2-T7 (POSIX) and W2-T8 (Windows).
 */

/**
 * The identity of the spawned process as a ladder receives it: the identity
 * read that `spawnHarnessProcess` started at the spawn (for example
 * `handle.identity.then((read) => read.identity)`). `null`, a rejection or
 * an identity with another pid all mean "no verified identity": the ladder
 * then acts on the spawned process only through its handle or as the
 * host's unreaped child, never through a snapshot, a tree kill or a sweep.
 * Ladders await it only right before their first step that needs it, so
 * the interrupt and EOF steps never wait for it.
 *
 * @beta
 */
export type LadderIdentity = PromiseLike<ProcessIdentity | null>;

/**
 * Ladder timing, injected (never read from ambient state). Each ladder uses
 * its own subset: POSIX `interruptWaitMs`, `eofGraceMs`, `termGraceMs`;
 * Windows `interruptWaitMs`, `eofGraceMs`, `taskkillGraceMs`.
 *
 * @beta
 */
export interface LadderTiming {
  /** Longest wait for the interrupt acknowledgement before EOF. */
  readonly interruptWaitMs: number;
  /** Grace after stdin EOF before the first forced step. */
  readonly eofGraceMs: number;
  /** POSIX: grace after SIGTERM before SIGKILL and the sweep. */
  readonly termGraceMs: number;
  /** Windows best-effort: grace after `taskkill /T /F` before `TerminateProcess`. */
  readonly taskkillGraceMs: number;
}

/**
 * Initial, tunable defaults (plan §1.7, H5; option `termination.*`).
 *
 * @beta
 */
export const DEFAULT_LADDER_TIMING: LadderTiming = Object.freeze({
  interruptWaitMs: 1000,
  eofGraceMs: 2000,
  termGraceMs: 5000,
  taskkillGraceMs: 2000,
});

/**
 * Result of the interrupt hook (plan §1.7: supplied by the driver from the machine).
 *
 * @beta
 */
export type InterruptOutcome = 'acknowledged' | 'timeout' | 'not-applicable';

/**
 * Every step a ladder can take, in the order the ladders may take them.
 *
 * @beta
 */
export type LadderStepName =
  | 'intent'
  | 'interrupt'
  | 'eof'
  | 'snapshot-s1'
  | 'sigterm'
  | 'snapshot-s2'
  | 'sigkill'
  | 'sweep'
  | 'terminate-job'
  | 'taskkill'
  | 'terminate-process';

/**
 * One step as it was taken. JSON data.
 *
 * @beta
 */
export interface LadderStep {
  readonly name: LadderStepName;
  /** Clock time at which the step started. */
  readonly atMs: number;
  /**
   * `done`: performed; `skipped`: not needed (the process had exited, or the
   * step does not apply); `failed`: attempted and failed (see `detail`).
   */
  readonly outcome: 'done' | 'skipped' | 'failed';
  /** Short machine-readable detail, such as an errno name. Never a secret or a path. */
  readonly detail?: string;
}

/**
 * Summary of a sweep (POSIX).
 *
 * @beta
 */
export interface LadderSweepSummary {
  readonly processesSignalled: number;
  readonly groupsSignalled: number;
  readonly skipped: number;
}

/**
 * What a ladder did. JSON data. The termination intent is recorded before
 * the first signal (ADR-0008 E8); its type is the neutral
 * `TerminationIntent`, kept generic here so the process layer does not
 * depend on the protocol layer's outcome module.
 *
 * @beta
 */
export interface LadderReport<Intent extends string = string> {
  readonly intent: Intent;
  readonly platform: 'posix' | 'win32';
  readonly steps: readonly LadderStep[];
  /** The step during or after which the process was observed to exit; `null` if it never exited. */
  readonly exitedAfter: LadderStepName | null;
  /**
   * POSIX: the K1 signal target; `null` on Windows, when no signal was
   * needed, or when the spawned process had no verified identity (the
   * signals then went to the spawned pid only).
   */
  readonly signalTarget: ProcessIdentity | null;
  /** `initialize.pid` differed from the spawned pid. */
  readonly launcherDetected: boolean;
  /** POSIX: the sweep summary; `null` when no sweep ran. */
  readonly sweep: LadderSweepSummary | null;
}

/**
 * Hooks the driver gives a ladder.
 *
 * @beta
 */
export interface LadderHooks {
  /**
   * Requests an interrupt through the machine and resolves when it is
   * acknowledged, when `interruptWaitMs` passed, or immediately when no
   * interrupt applies (before the handshake, stdin already closed).
   */
  interrupt(): Promise<InterruptOutcome>;
  /** Observes each step as it is taken (diagnostics). Must not throw. */
  onStep?(step: LadderStep): void;
}

/**
 * Time source and one-shot timers of both ladders, injected so tests never
 * use real timers.
 *
 * @beta
 */
export interface LadderClock {
  /** Current time in milliseconds (any epoch; only differences are used). */
  now(): number;
  /**
   * Calls `callback` once after `ms` milliseconds. The returned function
   * cancels the timer; calling it after the timer fired, or twice, is a
   * no-op.
   */
  schedule(ms: number, callback: () => void): () => void;
}
