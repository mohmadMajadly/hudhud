/**
 * The loopback binding (ADR-0006 "JSON-only boundary", plan §1.6).
 *
 * @remarks
 * Proves the core boundary: the session driver runs a machine through a
 * serialize / deserialize round trip, the way a daemon client in another
 * language would. Every config, state, input and step result crosses
 * `JSON.stringify` / `JSON.parse`, the parsed value must be deeply equal to
 * the original, and the machine and the driver only ever see the parsed
 * copies. A value that does not survive (an `undefined` member, a `Date`, a
 * class instance, a non-finite number, a shared mutable reference the
 * machine relies on) is a {@link LoopbackViolation}: recorded, then thrown,
 * so the driver ends the session with `PROTOCOL_ERROR`.
 *
 * The machine is supplied by the caller; the core never names one (K3). The
 * transport is in memory ({@link LoopbackTransport}): the test or replay
 * scripts what the harness writes, how it exits and how the ladder behaves,
 * on a {@link ManualClock}.
 *
 * @packageDocumentation
 */

import { isDeepStrictEqual } from 'node:util';

import type { ProcessContainment } from '../protocol/capabilities.js';
import type { CompatInfo } from '../protocol/events/types.js';
import type { HarnessMachine, MachineInput, MachineStep } from '../protocol/machine/contract.js';
import type { ExitObservation, TerminationIntent } from '../protocol/machine/outcome.js';
import type { LadderReport } from '../process/ladder/types.js';
import type { AfterExitSweepReport } from '../process/ladder/after-exit.js';
import { counterIds, ManualClock, type Clock, type IdSource } from './clock.js';
import { SessionDriver, type DriverOptions } from './driver.js';
import { createSession, type Session } from './handles.js';
import type { PermissionHandler } from './permission-bridge.js';
import {
  TransportWriteError,
  type HarnessTransport,
  type TerminateRequest,
  type TransportOutput,
} from './transport.js';

/**
 * A value that did not survive the JSON round trip.
 *
 * @beta
 */
export class LoopbackViolation extends Error {
  override readonly name = 'LoopbackViolation';
  /** What was being serialized: `config`, `state`, `input` or `step`. */
  readonly what: string;

  constructor(what: string) {
    super(`the ${what} did not survive the JSON round trip`);
    this.what = what;
  }
}

/**
 * The machine of the loopback binding: `machine` behind a JSON round trip.
 *
 * @beta
 */
export interface LoopbackMachine<State, Config> extends HarnessMachine<State, Config> {
  /** Every round-trip failure so far, in order. */
  readonly violations: readonly LoopbackViolation[];
}

/**
 * Wraps `machine` so every value crosses `JSON.stringify` / `JSON.parse`
 * (see the module remarks).
 *
 * @beta
 */
export function loopbackMachine<State, Config>(
  machine: HarnessMachine<State, Config>,
): LoopbackMachine<State, Config> {
  const violations: LoopbackViolation[] = [];
  const roundTrip = <T>(value: T, what: string): T => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      parsed = undefined;
    }
    if (!isDeepStrictEqual(parsed, value)) {
      const violation = new LoopbackViolation(what);
      violations.push(violation);
      throw violation;
    }
    return parsed as T;
  };
  return {
    violations,
    initialState: (config) => roundTrip(machine.initialState(roundTrip(config, 'config')), 'state'),
    step: (state: State, input: MachineInput): MachineStep<State> =>
      roundTrip(machine.step(roundTrip(state, 'state'), roundTrip(input, 'input')), 'step'),
  };
}

/**
 * What the loopback transport does when the machine asks for the ladder.
 *
 * @beta
 */
export type LoopbackTerminate = (
  request: TerminateRequest,
  transport: LoopbackTransport,
) => Promise<LadderReport<TerminationIntent> | null | undefined>;

/**
 * The default ladder of the loopback: run the interrupt step, end input,
 * then exit as killed (`SIGKILL`) unless the harness already exited.
 *
 * @beta
 */
export const loopbackLadder: LoopbackTerminate = async (request, transport) => {
  await request.interrupt();
  transport.endInput({ graceful: false });
  transport.exit({ code: null, signal: 'SIGKILL' });
  return null;
};

/**
 * Options of {@link LoopbackTransport}.
 *
 * @beta
 */
export interface LoopbackTransportOptions {
  readonly pid?: number;
  /** The ladder; {@link loopbackLadder} when absent. */
  readonly terminate?: LoopbackTerminate;
  /** What {@link HarnessTransport.afterExit} reports after a graceful end or a ladder; `null` when absent. */
  readonly afterExit?: AfterExitSweepReport | null;
  readonly stderrTail?: string;
}

/**
 * An in-memory harness for the loopback binding: the caller scripts the
 * harness's output and exit and reads what was written.
 *
 * @beta
 */
export class LoopbackTransport implements HarnessTransport {
  readonly pid: number;
  /** Every line written, in order. */
  readonly written: string[] = [];
  /** How input was ended, or `null` while open. */
  inputEnd: 'graceful' | 'immediate' | null = null;
  /** The intents the ladder was asked for, in order. */
  readonly terminations: TerminationIntent[] = [];
  /** How many outputs the reader has taken so far. */
  pulls = 0;
  /** When set, every later write rejects with this errno name. */
  failWritesWith: string | null = null;
  readonly #terminate: LoopbackTerminate;
  readonly #afterExit: AfterExitSweepReport | null;
  readonly #stderrTail: string;
  readonly #output: TransportOutput[] = [];
  #outputEnd: 'open' | 'ended' | Error = 'open';
  #wake: (() => void) | undefined;
  #reading = false;
  readonly #exited = Promise.withResolvers<ExitObservation>();
  #exit: ExitObservation | null = null;
  #ladder: Promise<LadderReport<TerminationIntent> | null> | undefined;

  constructor(options: LoopbackTransportOptions = {}) {
    this.pid = options.pid ?? 4242;
    this.#terminate = options.terminate ?? loopbackLadder;
    this.#afterExit = options.afterExit ?? null;
    this.#stderrTail = options.stderrTail ?? '';
  }

  // ---- the harness side (scripted by the caller) -----------------------------------

  /** The harness writes one stdout line (`bytes` defaults to its UTF-8 length, as the framer counts it). */
  line(text: string, bytes: number = new TextEncoder().encode(text).byteLength): void {
    this.push({ type: 'line', text, bytes });
  }

  /** The harness produces any transport output. */
  push(output: TransportOutput): void {
    if (this.#outputEnd !== 'open') throw new Error('output already ended');
    this.#output.push(output);
    this.#wakeReader();
  }

  /** Stdout ends (EOF), or fails with `error`. */
  endOutput(error?: Error): void {
    if (this.#outputEnd !== 'open') return;
    this.#outputEnd = error ?? 'ended';
    this.#wakeReader();
  }

  /**
   * The harness exits; its stdout ends too unless `keepOutputOpen` (a
   * descendant still holds the pipe). Later calls do nothing.
   */
  exit(exit: ExitObservation, options: { readonly keepOutputOpen?: boolean } = {}): void {
    if (this.#exit !== null) return;
    this.#exit = exit;
    if (options.keepOutputOpen !== true) this.endOutput();
    this.#exited.resolve(exit);
  }

  /** Outputs not yet taken by the reader. */
  get buffered(): number {
    return this.#output.length;
  }

  /** The exit, once it happened. */
  get exitStatus(): ExitObservation | null {
    return this.#exit;
  }

  // ---- HarnessTransport ----------------------------------------------------------------

  get exited(): Promise<ExitObservation> {
    return this.#exited.promise;
  }

  readonly output: AsyncIterable<TransportOutput> = {
    [Symbol.asyncIterator]: () => this.#read(),
  };

  async *#read(): AsyncGenerator<TransportOutput, void, undefined> {
    if (this.#reading) throw new Error('output has a single consumer');
    this.#reading = true;
    for (;;) {
      const next = this.#output.shift();
      if (next !== undefined) {
        this.pulls += 1;
        yield next;
        continue;
      }
      const end = this.#outputEnd;
      if (end === 'ended') return;
      if (end instanceof Error) throw end;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  #wakeReader(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  write(line: string): Promise<void> {
    if (this.inputEnd !== null) return Promise.reject(new TransportWriteError('ENDED'));
    if (this.failWritesWith !== null) {
      return Promise.reject(new TransportWriteError(this.failWritesWith));
    }
    this.written.push(line);
    return Promise.resolve();
  }

  endInput(options: { readonly graceful: boolean }): void {
    this.inputEnd ??= options.graceful ? 'graceful' : 'immediate';
  }

  terminate(request: TerminateRequest): Promise<LadderReport<TerminationIntent> | null> {
    this.#ladder ??= (async () => {
      this.terminations.push(request.intent);
      return (await this.#terminate(request, this)) ?? null;
    })();
    return this.#ladder;
  }

  afterExit(): Promise<AfterExitSweepReport | null> {
    // As the process transport: a report once input ended through the
    // recorded path or a ladder ran.
    return Promise.resolve(
      this.inputEnd === 'graceful' || this.#ladder !== undefined ? this.#afterExit : null,
    );
  }

  stderrTail(): string {
    return this.#stderrTail;
  }
}

/**
 * Options of {@link createLoopbackDriver}: the driver options without the
 * machine, config and transport.
 *
 * @beta
 */
export interface LoopbackDriverOptions extends LoopbackTransportOptions {
  readonly sessionId?: string;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly compat?: CompatInfo;
  readonly onPermission?: PermissionHandler;
  readonly containment?: ProcessContainment;
  readonly driver?: Partial<
    Omit<DriverOptions<unknown, unknown>, 'machine' | 'config' | 'transport'>
  >;
}

/**
 * A loopback session: the driver, its public handle, the in-memory
 * transport, the clock and the round-trip violations.
 *
 * @beta
 */
export interface LoopbackSession<State, Config> {
  readonly driver: SessionDriver<State, Config>;
  readonly session: Session;
  readonly transport: LoopbackTransport;
  readonly clock: Clock;
  readonly machine: LoopbackMachine<State, Config>;
}

/**
 * Drives `machine` through the loopback binding. Nothing is started: call
 * `driver.start()` (or any command), then script the transport. Defaults:
 * a {@link ManualClock}, deterministic ids ({@link counterIds}), no
 * host-exit hook.
 *
 * @beta
 */
export function createLoopbackDriver<State, Config>(
  machine: HarnessMachine<State, Config>,
  config: Config,
  options: LoopbackDriverOptions = {},
): LoopbackSession<State, Config> {
  const transport = new LoopbackTransport(options);
  const clock = options.clock ?? new ManualClock();
  const wrapped = loopbackMachine(machine);
  const driver = new SessionDriver<State, Config>({
    hostExit: null,
    ...options.driver,
    machine: wrapped,
    config,
    transport,
    sessionId: options.sessionId ?? '00000000-0000-4000-8000-000000000000',
    clock,
    ids: options.ids ?? counterIds(),
    ...(options.compat === undefined ? {} : { compat: options.compat }),
    ...(options.onPermission === undefined ? {} : { onPermission: options.onPermission }),
    ...(options.containment === undefined ? {} : { containment: options.containment }),
  });
  return { driver, session: createSession(driver), transport, clock, machine: wrapped };
}
