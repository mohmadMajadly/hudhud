/**
 * The transport seam between the session driver and a harness process (or
 * the loopback), plan §1.6, ADR-0001 §3, K18.
 *
 * @remarks
 * The driver never touches a process: it reads {@link HarnessTransport.output},
 * writes lines, ends input, asks for termination and waits for the exit. The
 * process transport ({@link createProcessTransport}) implements the seam over
 * a spawned {@link HarnessProcess}:
 *
 * - output: stdout through the bounded NDJSON framer; reading is pulled, so
 *   the pipe backpressures the child and nothing is buffered without bound;
 * - input: serialized writes; a failed write rejects with
 *   {@link TransportWriteError} carrying the errno name;
 * - recorded EOF (W3-Z ruling 5, ADR-0008, ADR-0009, ADR-0010; review
 *   R3-1): the descendants are snapshotted first ({@link snapshotAtEof}),
 *   then stdin is ended, for the graceful close and for every end of input
 *   once a ladder runs (the snapshot then starts with the ladder, so it
 *   overlaps the interrupt step). The harness is alive at that moment, so the
 *   snapshot cannot miss its root; after the exit {@link HarnessTransport.afterExit}
 *   sweeps the survivors of that snapshot ({@link sweepAfterExit}) whichever
 *   way the harness ended. With a job there is no snapshot: closing the job
 *   after the exit ends the tree, and `afterExit` reports that (review R2-1);
 * - termination: the platform's abort ladder (`runPosixLadder` with the K1
 *   signal target, `runWindowsLadder` with the session's job or best effort),
 *   with the driver's interrupt hook as its first step.
 *
 * Not a public extension point in v1 (K18): applications never supply a
 * transport; adapters build one over the process they spawned.
 *
 * @packageDocumentation
 */

import { createFramer, DEFAULT_MAX_INBOUND_FRAME_BYTES } from '../process/framer.js';
import type { FramerOutput } from '../process/framer.js';
import {
  snapshotAtEof,
  sweepAfterExit,
  type AfterExitSweepReport,
  type EofSnapshot,
} from '../process/ladder/after-exit.js';
import { runPosixLadder } from '../process/ladder/posix.js';
import {
  DEFAULT_LADDER_TIMING,
  type InterruptOutcome,
  type LadderClock,
  type LadderReport,
  type LadderTiming,
} from '../process/ladder/types.js';
import { runWindowsLadder, type JobHandle } from '../process/ladder/windows.js';
import type { OsCalls } from '../process/os/types.js';
import type { HarnessProcess } from '../process/spawn.js';
import { ProcessStreamError } from '../process/spawn.js';
import { epochMsToWindowsStartTime } from '../process/tree/start-time.js';
import type { TransportInput } from '../protocol/machine/contract.js';
import type { ExitObservation, TerminationIntent } from '../protocol/machine/outcome.js';
import { systemClock, type Clock } from './clock.js';

/**
 * What a transport reports while the harness runs. The end of
 * {@link HarnessTransport.output} is `stdout.end`; the exit arrives through
 * {@link HarnessTransport.exited}.
 *
 * @beta
 */
export type TransportOutput = Extract<
  TransportInput,
  { readonly type: 'line' | 'line.oversized' | 'line.invalid-utf8' | 'stderr.line' }
>;

/**
 * A write to the harness failed. `code` is the errno name (`EPIPE`, ...), or
 * `ENDED` when input was already ended, or `EIO` when nothing more is known.
 *
 * @beta
 */
export class TransportWriteError extends Error {
  override readonly name = 'TransportWriteError';
  readonly code: string;

  constructor(code: string, options?: { readonly cause?: unknown }) {
    super(`writing to the harness failed: ${code}`, options);
    this.code = code;
  }
}

/**
 * What the driver hands a transport when the machine asks for the ladder.
 *
 * @beta
 */
export interface TerminateRequest {
  /** Recorded before any signal (ADR-0008 E8). */
  readonly intent: TerminationIntent;
  /** The pid the harness reported for itself (K1 signal target), else `null`. */
  readonly initializePid: number | null;
  /**
   * The machine's interrupt step (`LadderHooks.interrupt`): resolves when the
   * machine ended input after its interrupt, or at once when input is
   * already ended. The ladder bounds the wait by `interruptWaitMs`.
   */
  interrupt(): Promise<InterruptOutcome>;
}

/**
 * The seam between the driver and a harness. Internal in v1 (K18).
 *
 * @beta
 */
export interface HarnessTransport {
  /** The spawned pid, fed to the machine as `process.started`. */
  readonly pid: number;
  /**
   * Harness output in order. Single consumer; the driver reads it
   * continuously. The iteration ends at stdout EOF and throws on a stdout
   * failure.
   */
  readonly output: AsyncIterable<TransportOutput>;
  /** Writes one line (it carries its own `\n`); rejects with {@link TransportWriteError}. */
  write(line: string): Promise<void>;
  /**
   * Ends the harness's input; idempotent. `graceful` (every end the machine
   * asks for) lets the transport record what it needs to clean up after the
   * harness exits, first; without it the end is immediate and synchronous
   * (the host-exit hook), also when a recorded end is still pending.
   */
  endInput(options: { readonly graceful: boolean }): void;
  /** Settles once with the exit. Never rejects. */
  readonly exited: Promise<ExitObservation>;
  /**
   * Runs the abort ladder once and resolves with its report; never rejects.
   * A second call returns the first call's promise.
   */
  terminate(request: TerminateRequest): Promise<LadderReport<TerminationIntent> | null>;
  /**
   * After the exit: the sweep of the recorded tree (`null` when input was
   * never ended gracefully and no ladder ran). Never rejects.
   */
  afterExit(): Promise<AfterExitSweepReport | null>;
  /** The redacted, bounded stderr tail (`''` when there is none). */
  stderrTail(): string;
}

/**
 * Options of {@link createProcessTransport}.
 *
 * @beta
 */
export interface ProcessTransportOptions {
  /** The spawned process (containment already attached, ADR-0009 §1). */
  readonly process: HarnessProcess;
  /** The host's OS calls (`osCallsFor(process.platform, process.pid)`). */
  readonly os: OsCalls;
  /** The session's job (`SessionContainmentResult.job`); `null` or absent for best effort. */
  readonly job?: JobHandle | null;
  /**
   * With a job: `SessionContainmentResult.released`, which settles once the
   * job was closed after the exit. `afterExit` reports `job-closed` or
   * `job-close-failed` from it (absent: `no-snapshot`).
   */
  readonly jobReleased?: Promise<'closed' | 'close-failed' | 'no-job'>;
  /**
   * The wall clock in epoch milliseconds (`Date.now` when absent), read on
   * Windows when the exit is observed (`AfterExitDeps.rootExitObservedAt`).
   * Not the ladder clock: it is compared with the kernel's process creation
   * times.
   */
  readonly wallClockMs?: () => number;
  /** Ladder timing (`termination.*` options); the defaults of plan §1.7 when absent. */
  readonly timing?: LadderTiming;
  /** The clock of the ladders; the real clock when absent. */
  readonly clock?: Clock;
  /** Inbound line cap (`maxFrameBytes`); 64 MiB when absent. */
  readonly maxLineBytes?: number;
}

function toOutput(output: FramerOutput): TransportOutput {
  switch (output.kind) {
    case 'line':
      return { type: 'line', text: output.text, bytes: output.bytes };
    case 'oversized':
      return { type: 'line.oversized', bytes: output.bytes };
    case 'invalid-utf8':
      return { type: 'line.invalid-utf8', bytes: output.bytes };
  }
}

/** The errno name of a failed write. */
function writeCode(error: unknown): string {
  if (error instanceof ProcessStreamError) {
    return error.errno ?? (error.reason === 'ended' ? 'ENDED' : 'EIO');
  }
  return 'EIO';
}

class ProcessTransport implements HarnessTransport {
  readonly pid: number;
  readonly exited: Promise<ExitObservation>;
  readonly #proc: HarnessProcess;
  readonly #os: OsCalls;
  readonly #job: JobHandle | null;
  readonly #timing: LadderTiming;
  readonly #clock: LadderClock;
  readonly #maxLineBytes: number;
  readonly #jobReleased: Promise<'closed' | 'close-failed' | 'no-job'> | undefined;
  /** Input end was asked for (recorded or immediate). */
  #ended = false;
  /** An end of input went through the recorded path (graceful, or with a ladder running). */
  #recorded = false;
  /** The snapshot before EOF; never with a job. */
  #eof: Promise<EofSnapshot | null> | undefined;
  /** Windows: the wall clock when the exit was observed, as a canonical start time. */
  #exitObservedAt: string | undefined;
  #ladder: Promise<LadderReport<TerminationIntent>> | undefined;

  constructor(options: ProcessTransportOptions) {
    const proc = options.process;
    this.#proc = proc;
    this.pid = proc.pid;
    this.#os = options.os;
    this.#job = options.job ?? null;
    this.#jobReleased = options.jobReleased;
    this.#timing = options.timing ?? DEFAULT_LADDER_TIMING;
    const clock = options.clock ?? systemClock;
    this.#clock = { now: () => clock.nowMs(), schedule: (ms, cb) => clock.schedule(ms, cb) };
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_INBOUND_FRAME_BYTES;
    const wallClockMs = options.wallClockMs ?? Date.now;
    if (options.os.platform === 'win32' && proc.exitStatus === null) {
      // Read in the exit's own turn, before libuv closes the process handle
      // (the handle closes in its loop's close phase, after this callback),
      // so no other process can have held the pid yet (review R2-1). Not
      // when the exit was already seen before this transport existed: the
      // reading would come too late to bound anything.
      void proc.exited.then(() => {
        this.#exitObservedAt = epochMsToWindowsStartTime(wallClockMs());
      });
    }
    this.exited = proc.exited.then((exit) => ({ code: exit.code, signal: exit.signal }));
  }

  get output(): AsyncIterable<TransportOutput> {
    return { [Symbol.asyncIterator]: () => this.#frames() };
  }

  async *#frames(): AsyncGenerator<TransportOutput, void, undefined> {
    const framer = createFramer({ maxLineBytes: this.#maxLineBytes });
    for await (const chunk of this.#proc.stdout) {
      for (const output of framer.push(chunk)) yield toOutput(output);
    }
    for (const output of framer.end()) yield toOutput(output);
  }

  async write(line: string): Promise<void> {
    try {
      await this.#proc.write(line);
    } catch (error) {
      throw new TransportWriteError(writeCode(error), { cause: error });
    }
  }

  endInput(options: { readonly graceful: boolean }): void {
    if (options.graceful) {
      this.#endRecorded();
      return;
    }
    // Immediate (the host-exit hook), also when a recorded end still waits
    // for its snapshot; endStdin is idempotent.
    this.#ended = true;
    this.#proc.endStdin();
  }

  /**
   * Starts the snapshot before EOF once, unless there is a job or input
   * already ended. Never rejects.
   */
  #snapshotBeforeEof(): Promise<EofSnapshot | null> | undefined {
    if (this.#job !== null || (this.#ended && this.#eof === undefined)) return this.#eof;
    if (this.#eof === undefined) {
      const identity = this.#proc.identity.then((read) => read.identity);
      this.#eof = snapshotAtEof(this.#proc.pid, identity, this.#os);
    }
    return this.#eof;
  }

  /**
   * Snapshot first, then EOF: the harness is alive until it sees EOF, so its
   * root is still in the table (`snapshotAtEof` never rejects). With a job,
   * EOF at once.
   */
  #endRecorded(): void {
    if (this.#ended) return;
    const eof = this.#snapshotBeforeEof();
    this.#ended = true;
    this.#recorded = true;
    if (eof === undefined) {
      this.#proc.endStdin();
      return;
    }
    void eof.then(() => {
      this.#proc.endStdin();
    });
  }

  terminate(request: TerminateRequest): Promise<LadderReport<TerminationIntent>> {
    if (this.#ladder === undefined) {
      // The tree as the ladder starts, before any end of input (review R3-1);
      // it overlaps the interrupt step.
      void this.#snapshotBeforeEof();
      this.#ladder = this.#runLadder(request);
    }
    return this.#ladder;
  }

  #runLadder(request: TerminateRequest): Promise<LadderReport<TerminationIntent>> {
    const proc = this.#proc;
    const identity = proc.identity.then((read) => read.identity);
    const hasExited = (): boolean => proc.exitStatus !== null;
    const endStdin = (): void => {
      this.#endRecorded();
    };
    const hooks = { interrupt: () => request.interrupt() };
    const os = this.#os;
    if (os.platform === 'win32') {
      return runWindowsLadder(
        {
          pid: proc.pid,
          identity,
          hasExited,
          exited: proc.exited,
          closeStdin: endStdin,
          terminate: () => proc.killViaHandle('SIGKILL'),
        },
        hooks,
        this.#timing,
        this.#job,
        { intent: request.intent, initializePid: request.initializePid, clock: this.#clock, os },
      );
    }
    return runPosixLadder(
      {
        pid: proc.pid,
        identity,
        initializePid: request.initializePid,
        hasExited,
        exited: proc.exited,
        endStdin,
      },
      hooks,
      this.#timing,
      { intent: request.intent, os, clock: this.#clock },
    );
  }

  async afterExit(): Promise<AfterExitSweepReport | null> {
    if (!this.#recorded && this.#ladder === undefined) return null;
    if (this.#job !== null) {
      // The job's close after the exit ends the whole tree (no breakaway is
      // allowed); a walk could only find processes that are not ours (R2-1).
      const released = await this.#jobReleased;
      if (released === 'closed') return { status: 'skipped', reason: 'job-closed' };
      if (released === 'close-failed') return { status: 'skipped', reason: 'job-close-failed' };
      return { status: 'skipped', reason: 'no-snapshot' };
    }
    const eof = this.#eof === undefined ? null : await this.#eof;
    const ladder = this.#ladder === undefined ? null : await this.#ladder;
    const target = ladder?.signalTarget ?? null;
    return sweepAfterExit(eof, {
      os: this.#os,
      ...(target === null ? {} : { signalTarget: target }),
      ...(this.#exitObservedAt === undefined ? {} : { rootExitObservedAt: this.#exitObservedAt }),
    });
  }

  stderrTail(): string {
    return this.#proc.stderrTail();
  }
}

/**
 * The transport over a spawned harness process (see the module remarks).
 *
 * @beta
 */
export function createProcessTransport(options: ProcessTransportOptions): HarnessTransport {
  return new ProcessTransport(options);
}
