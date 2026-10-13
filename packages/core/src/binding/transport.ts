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
 * - graceful EOF (W3-Z ruling 5, ADR-0008, ADR-0009, ADR-0010): the
 *   descendants are snapshotted first ({@link snapshotAtEof}), then stdin is
 *   ended. The harness is idle and waiting for EOF at that moment, so the
 *   snapshot cannot miss its root; after the exit {@link HarnessTransport.afterExit}
 *   sweeps the survivors of that snapshot ({@link sweepAfterExit});
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
   * Ends the harness's input; idempotent. `graceful` (the drain path, not the
   * ladder) lets the transport record what it needs to clean up after the
   * harness exits by itself; without it the end is immediate and synchronous
   * (the ladder, the host-exit hook).
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
   * After the exit: the sweep of the graceful close (`null` when input was
   * never ended gracefully). Never rejects.
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
  #ended = false;
  #eof: Promise<EofSnapshot | null> | undefined;
  #ladder: Promise<LadderReport<TerminationIntent>> | undefined;

  constructor(options: ProcessTransportOptions) {
    const proc = options.process;
    this.#proc = proc;
    this.pid = proc.pid;
    this.#os = options.os;
    this.#job = options.job ?? null;
    this.#timing = options.timing ?? DEFAULT_LADDER_TIMING;
    const clock = options.clock ?? systemClock;
    this.#clock = { now: () => clock.nowMs(), schedule: (ms, cb) => clock.schedule(ms, cb) };
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_INBOUND_FRAME_BYTES;
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
    if (this.#ended) return;
    this.#ended = true;
    if (!options.graceful) {
      this.#proc.endStdin();
      return;
    }
    // Snapshot first, then EOF: the harness is idle and waits for EOF, so its
    // root is still in the table (snapshotAtEof never rejects).
    const identity = this.#proc.identity.then((read) => read.identity);
    this.#eof = snapshotAtEof(this.#proc.pid, identity, this.#os).then((eof) => {
      this.#proc.endStdin();
      return eof;
    });
  }

  terminate(request: TerminateRequest): Promise<LadderReport<TerminationIntent>> {
    this.#ladder ??= this.#runLadder(request);
    return this.#ladder;
  }

  #runLadder(request: TerminateRequest): Promise<LadderReport<TerminationIntent>> {
    const proc = this.#proc;
    const identity = proc.identity.then((read) => read.identity);
    const hasExited = (): boolean => proc.exitStatus !== null;
    const endStdin = (): void => {
      this.#ended = true;
      proc.endStdin();
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
    if (this.#eof === undefined) return null;
    const eof = await this.#eof;
    const ladder = this.#ladder === undefined ? null : await this.#ladder;
    const target = ladder?.signalTarget ?? null;
    return sweepAfterExit(
      eof,
      target === null ? { os: this.#os } : { os: this.#os, signalTarget: target },
    );
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
