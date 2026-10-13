/**
 * The generic session driver: drives any {@link HarnessMachine} over a
 * {@link HarnessTransport} (plan §1.6, ADR-0006, ADR-0007, ADR-0008, K3).
 *
 * @remarks
 * Harness-neutral: the driver knows the neutral contract only. It owns the
 * input queue, the effect executor, the timers, the transport I/O, the
 * hand-off to the termination ladder and the graceful close's sweep, the
 * event fanout and the permission bridge.
 *
 * Invariants:
 *
 * - One input at a time, no re-entrancy: every input (transport output,
 *   timer, command, permission answer) goes through one FIFO; `step` runs
 *   for one input and its effects are executed before the next input is
 *   taken. Input that arrives meanwhile (from an effect, a callback, a
 *   timer) is queued. Application code never runs inside a step: handlers
 *   and abort listeners are called in microtasks, promises settle
 *   asynchronously.
 * - Stdout is read continuously, independent of subscribers (ADR-0007): the
 *   reader takes the next output as soon as the previous one was processed.
 *   At most one output is held at a time, so memory stays bounded and the
 *   pipe backpressures the harness instead.
 * - `ask()` and `turn.done` never wait on a subscriber: turn results are
 *   settled while the step's effects run; events are handed to the fanout
 *   in order behind them.
 * - Only an `overflow: 'block'` subscriber can pause input processing: a
 *   step whose events reach a full `'block'` subscriber holds the next input
 *   until that subscriber takes them (ADR-0007 hazard: control frames,
 *   timers and the close deadline wait too). Abort and dispose always cut
 *   through: they cancel every `'block'` subscriber that still holds the
 *   session (its iterator rejects with `SESSION_CLOSED`).
 * - Handler exceptions never reach the driver (`permission-bridge.ts`); a
 *   machine that throws or never ends is contained: the session ends
 *   `failed` with `PROTOCOL_ERROR` after the abort ladder.
 * - No signal handlers (K22); the only process hook is the host-exit hook.
 *
 * Event `seq`: the driver numbers the events it publishes (the machine's
 * own numbering is replaced), starting at 1 after the replayed `compat` at 0,
 * so the binding's own diagnostics (ladder, sweep, permission failures,
 * containment) share one gapless stream with the machine's events. Each
 * event counts the byte size of the line it came from when it carries that
 * frame as `raw`, else 256 bytes (plan §1.6).
 *
 * End of a session: when the process exits, the driver waits for the
 * ladder (if one runs) and for the graceful close's sweep, reports both as
 * diagnostics, waits for the end of stdout (at most `outputDrainMs`), then
 * feeds `process.exit`; the machine answers with `session.terminated` and
 * `session.end`, and the session is closed. `session.terminated` therefore
 * comes after every other event of the session.
 *
 * @packageDocumentation
 */

import type { CompatInfo, HudhudEvent, TurnResult } from '../protocol/events/types.js';
import type { JsonObject, JsonValue } from '../protocol/json.js';
import { isHudhudErrorCode, makeErrorData, type ErrorData } from '../protocol/errors.js';
import type { ProcessContainment } from '../protocol/capabilities.js';
import type {
  CommandInput,
  HarnessMachine,
  MachineEffect,
  SessionInfoData,
  TransportInput,
} from '../protocol/machine/contract.js';
import type {
  ExitObservation,
  SessionOutcome,
  TerminationIntent,
} from '../protocol/machine/outcome.js';
import type { InterruptOutcome } from '../process/ladder/types.js';
import { cryptoIds, systemClock, type Clock, type IdSource } from './clock.js';
import {
  AbortError,
  HudhudError,
  InvalidOptionsError,
  ProtocolError,
  SessionClosedError,
  SubscriberOverflowError,
} from './errors.js';
import {
  Fanout,
  resolveSubscriberOptions,
  type AbortSignalLike,
  type FanoutSubscriberOptions,
  type SubscriberOptions,
} from './fanout.js';
import {
  createSession,
  normalizeUserInput,
  type Session,
  type SessionCore,
  type SessionInfo,
  type TurnCore,
  type UserInput,
} from './handles.js';
import { hostExit as defaultHostExit, type HostExitHook } from './host-exit.js';
import { PermissionBridge, type PermissionHandler } from './permission-bridge.js';
import type { OverflowInfo } from './queue.js';
import type { HarnessTransport, TransportOutput } from './transport.js';

// ---- options ----------------------------------------------------------------------------

/**
 * A diagnostic the binding publishes itself (for example the
 * `containment.fallback` of the session's containment, K2).
 *
 * @beta
 */
export interface BindingDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly data?: JsonObject;
}

/**
 * Everything a {@link SessionDriver} needs.
 *
 * @beta
 */
export interface DriverOptions<State, Config> {
  /** The harness protocol (adapter-supplied; the core never names one). */
  readonly machine: HarnessMachine<State, Config>;
  readonly config: Config;
  readonly transport: HarnessTransport;
  /** The session id events carry before the handshake reports it (the expected id). */
  readonly sessionId: string;
  /** Replayed as the first event (`seq` 0) of every `events()` stream (K20). */
  readonly compat?: CompatInfo;
  readonly onPermission?: PermissionHandler;
  /** Subscriber defaults of this session (`SessionOptions.events`). */
  readonly events?: SubscriberOptions;
  /** What the session got (K2); `'best-effort'` when absent. */
  readonly containment?: ProcessContainment;
  /** Published before the machine sees `process.started`. */
  readonly diagnostics?: readonly BindingDiagnostic[];
  /**
   * Turns checked user input into the machine's `cmd.send` content. Default:
   * a string as is, `{ content }` as the array of neutral blocks.
   */
  readonly encodeUserInput?: (input: UserInput) => JsonValue;
  /** Longest wait for the end of stdout after the exit; default 2000 ms. */
  readonly outputDrainMs?: number;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  /** The host-exit hook; `null` for none (loopback). Default: the host's. */
  readonly hostExit?: HostExitHook | null;
}

/**
 * How a session ended.
 *
 * @beta
 */
export interface SessionEnd {
  readonly outcome: SessionOutcome;
  readonly error?: ErrorData;
}

/**
 * Default of {@link DriverOptions.outputDrainMs}.
 *
 * @beta
 */
export const DEFAULT_OUTPUT_DRAIN_MS = 2000;

/**
 * Queue bytes of an event that does not carry a frame (plan §1.6).
 *
 * @beta
 */
export const SYNTHESIZED_EVENT_BYTES = 256;

// ---- fanout items --------------------------------------------------------------------------

/** What travels through the fanout: events plus the binding's own markers. */
type Item =
  | { readonly kind: 'event'; readonly event: HudhudEvent }
  | { readonly kind: 'gap'; readonly dropped: number }
  | { readonly kind: 'turn-end'; readonly turnId: string; readonly error: HudhudError | undefined };

/** Wraps the error a subscription is cut with, so it is not taken for an `AbortSignal` reason. */
class CutReason {
  readonly error: HudhudError;
  constructor(error: HudhudError) {
    this.error = error;
  }
}

/**
 * The abort signal of one subscription: follows the application's signal
 * and can be aborted by the driver (abort cutting through a stalled
 * `'block'` subscriber).
 */
class SubscriptionSignal implements AbortSignalLike {
  aborted = false;
  reason: unknown;
  readonly #listeners = new Set<() => void>();
  readonly #onRelease: () => void;
  #unlink: () => void = () => undefined;

  constructor(parent: AbortSignal | undefined, onRelease: () => void) {
    this.#onRelease = onRelease;
    if (parent === undefined) return;
    if (parent.aborted) {
      this.aborted = true;
      this.reason = parent.reason;
      return;
    }
    const fromParent = (): void => {
      this.abort(parent.reason);
    };
    parent.addEventListener('abort', fromParent, { once: true });
    this.#unlink = () => {
      parent.removeEventListener('abort', fromParent);
    };
  }

  addEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'abort', listener: () => void): void {
    // The fanout registers one listener and detaches it once the consumer
    // is finished.
    this.#listeners.delete(listener);
    this.#release();
  }

  /** Called once at most: both callers drop the signal afterwards (`#release`). */
  abort(reason: unknown): void {
    this.aborted = true;
    this.reason = reason;
    this.#release();
    for (const listener of [...this.#listeners]) listener();
  }

  #release(): void {
    this.#unlink();
    this.#onRelease();
  }
}

function turnIdOf(event: HudhudEvent): unknown {
  return Object.hasOwn(event, 'turnId')
    ? (event as { readonly turnId?: unknown }).turnId
    : undefined;
}

// ---- turn and control records -------------------------------------------------------------

class TurnRecord {
  readonly id: string;
  readonly promise: Promise<TurnResult>;
  settled = false;
  /** The error the turn failed with. */
  error: HudhudError | undefined;
  readonly #resolve: (result: TurnResult) => void;
  readonly #reject: (error: HudhudError) => void;

  constructor(id: string) {
    this.id = id;
    const { promise, resolve, reject } = Promise.withResolvers<TurnResult>();
    // Never an unhandled rejection: the application may never await `done`.
    promise.catch(() => undefined);
    this.promise = promise;
    this.#resolve = resolve;
    this.#reject = reject;
  }

  settle(result: TurnResult): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.#resolve(result);
    return true;
  }

  fail(error: HudhudError): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.error = error;
    this.#reject(error);
    return true;
  }
}

interface ControlRecord {
  readonly resolve: () => void;
  readonly reject: (error: HudhudError) => void;
}

interface QueueItem {
  readonly body: TransportInput | CommandInput;
  /** Byte size of the line this input carries. */
  readonly bytes?: number;
  /** The turn of a `cmd.send`. */
  readonly send?: TurnRecord;
  /** The arming a `timer` input belongs to; stale firings are dropped. */
  readonly timer?: { readonly name: string; readonly generation: number };
  readonly processed?: () => void;
}

/** A short, display-safe name of a thrown value. */
function nameOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[\w.-]{1,64}$/u.test(name) ? name : 'unknown';
}

/** Default {@link DriverOptions.encodeUserInput}: neutral JSON. */
function neutralContent(input: UserInput): JsonValue {
  if (typeof input === 'string') return input;
  return input.content.map((block): JsonObject =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', mediaType: block.mediaType, dataBase64: block.dataBase64 },
  );
}

/** Codes whose errors get the redacted stderr tail (plan §3.3). */
const TAIL_CODES: ReadonlySet<string> = new Set(['PROCESS_EXITED', 'HANDSHAKE_FAILED']);

// ---- the driver -------------------------------------------------------------------------------

/**
 * Drives one harness session (see the module remarks).
 *
 * @beta
 */
export class SessionDriver<State, Config> implements SessionCore {
  readonly #machine: HarnessMachine<State, Config>;
  #state: State;
  readonly #transport: HarnessTransport;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #sessionId: string;
  readonly #compat: HudhudEvent | undefined;
  readonly #defaults: SubscriberOptions;
  readonly #containment: ProcessContainment;
  readonly #diagnostics: readonly BindingDiagnostic[];
  readonly #encode: (input: UserInput) => JsonValue;
  readonly #drainMs: number;
  readonly #hostExit: HostExitHook | null;
  readonly #fanout: Fanout<Item>;
  readonly #bridge: PermissionBridge;

  // input queue
  readonly #queue: QueueItem[] = [];
  #pumping = false;
  #steps = 0;

  // event stream
  #seq = 1;
  readonly #outbox: { readonly item: Item; readonly bytes: number }[] = [];
  #blocked: Promise<void> | undefined;
  readonly #blockSignals = new Set<SubscriptionSignal>();

  // timers
  readonly #timers = new Map<
    string,
    { readonly generation: number; readonly cancel: () => void }
  >();
  #timerGeneration = 0;

  // turns and control requests
  readonly #turns = new Map<string, TurnRecord>();
  readonly #controls = new Map<string, ControlRecord>();
  #correlation = 0;

  // lifecycle
  #begun = false;
  #info: SessionInfo | undefined;
  #handshake: 'pending' | 'ok' | 'failed' = 'pending';
  #handshakeError: ErrorData | undefined;
  readonly #started = Promise.withResolvers<SessionInfo>();
  #closeRequested = false;
  #abortRequested = false;
  #inputEnded = false;
  #writeFailed = false;
  #interruptWaiters: ((outcome: InterruptOutcome) => void)[] = [];
  #ladder: Promise<void> | undefined;
  #exit: ExitObservation | undefined;
  #exitHandled: Promise<void> | undefined;
  #outputEnded = false;
  readonly #outputEnd = Promise.withResolvers<undefined>();
  #machineEnded = false;
  /** The machine broke (threw or never ended); the binding ends the session itself. */
  #broken: ErrorData | undefined;
  #end: SessionEnd | undefined;
  #finishing = false;
  #unregisterHostExit: (() => void) | undefined;
  readonly #finished = Promise.withResolvers<SessionEnd>();
  readonly #closed: Promise<void>;

  constructor(options: DriverOptions<State, Config>) {
    this.#machine = options.machine;
    this.#transport = options.transport;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? cryptoIds;
    this.#sessionId = options.sessionId;
    this.#defaults = options.events ?? {};
    this.#containment = options.containment ?? 'best-effort';
    this.#diagnostics = options.diagnostics ?? [];
    this.#encode = options.encodeUserInput ?? neutralContent;
    this.#drainMs = options.outputDrainMs ?? DEFAULT_OUTPUT_DRAIN_MS;
    this.#hostExit = options.hostExit === undefined ? defaultHostExit : options.hostExit;
    this.#compat =
      options.compat === undefined
        ? undefined
        : {
            type: 'compat',
            seq: 0,
            ts: this.#clock.nowIso(),
            sessionId: options.sessionId,
            compat: options.compat,
          };
    this.#fanout = new Fanout<Item>({
      gapMarker: (dropped) => ({ kind: 'gap', dropped }),
      overflowError: (info: OverflowInfo) =>
        new SubscriberOverflowError('The subscriber queue overflowed.', {
          details: { ...info },
        }),
      abortError: (reason) =>
        reason instanceof CutReason ? reason.error : new AbortError(undefined, { cause: reason }),
    });
    this.#bridge = new PermissionBridge({
      handler: options.onPermission,
      answer: (requestId, decision) => {
        this.#enqueue({ body: { type: 'cmd.permission', requestId, decision } });
      },
      fail: (requestId, reason) => {
        this.#enqueue({ body: { type: 'cmd.permission-error', requestId, reason } });
      },
      diagnostic: (code, message, data) => {
        this.#diagnostic(code, message, data);
      },
    });
    this.#state = options.machine.initialState(options.config);
    this.#started.promise.catch(() => undefined);
    this.#closed = this.#finished.promise.then(() => undefined);
  }

  // ---- SessionCore -----------------------------------------------------------------------

  get id(): string {
    return this.#info?.id ?? this.#sessionId;
  }

  /**
   * The session's facts.
   *
   * @throws Error before the handshake succeeded
   */
  get info(): SessionInfo {
    if (this.#info === undefined) throw new Error('the session has not started');
    return this.#info;
  }

  get closed(): Promise<void> {
    return this.#closed;
  }

  /** Settles once the session ended and everything was released. Never rejects. */
  get ended(): Promise<SessionEnd> {
    return this.#finished.promise;
  }

  /**
   * Counters for tests and diagnostics: what the driver still holds.
   *
   * @internal
   */
  get pending(): {
    readonly queue: number;
    readonly outbox: number;
    readonly timers: number;
    readonly turns: number;
    readonly controls: number;
    readonly permissions: number;
    readonly subscribers: number;
    readonly steps: number;
  } {
    return {
      queue: this.#queue.length,
      outbox: this.#outbox.length,
      timers: this.#timers.size,
      turns: this.#turns.size,
      controls: this.#controls.size,
      permissions: this.#bridge.pending,
      subscribers: this.#fanout.subscriberCount,
      steps: this.#steps,
    };
  }

  /**
   * Starts the session: begins reading output, feeds `process.started` and
   * resolves with the session's facts once the handshake succeeded. Rejects
   * with the handshake's error only after the session ended (the ladder ran,
   * nothing is left running, plan §3.2). Idempotent.
   */
  start(): Promise<SessionInfo> {
    this.#begin();
    return this.#started.promise;
  }

  sendTurn(
    input: UserInput,
    options: {
      readonly iterate: boolean;
      readonly events?: SubscriberOptions | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): TurnCore {
    const content = this.#encode(normalizeUserInput(input));
    const id = this.#ids.uuid();
    const record = new TurnRecord(id);
    const events = options.iterate
      ? this.#subscribeTurn(id, options.events, options.signal)
      : undefined;
    const refusal = this.#refusal();
    if (refusal !== undefined) {
      this.#failTurn(record, refusal);
    } else {
      this.#begin();
      // A live turn keeps its id: a duplicate from the id source stays
      // unregistered and is refused by the machine (`send.rejected`).
      if (!this.#turns.has(id)) this.#turns.set(id, record);
      this.#enqueue({ body: { type: 'cmd.send', turnId: id, content }, send: record });
    }
    return { id, done: record.promise, events };
  }

  interrupt(turnId: string | undefined, cancelQueued: boolean): Promise<void> {
    return this.#control((correlation) =>
      turnId === undefined
        ? { type: 'cmd.interrupt', cancelQueued, correlation }
        : { type: 'cmd.interrupt', turnId, cancelQueued, correlation },
    );
  }

  setPermissionMode(mode: string): Promise<void> {
    if (typeof mode !== 'string' || mode === '') {
      return Promise.reject(
        new InvalidOptionsError('A permission mode must be a non-empty string.', {
          details: { path: 'mode', rule: 'permission-mode' },
        }),
      );
    }
    const refusal = this.#refusal();
    if (refusal !== undefined) return Promise.reject(refusal);
    return this.#control((correlation) => ({ type: 'cmd.set-permission-mode', mode, correlation }));
  }

  subscribe(
    options: SubscriberOptions | undefined,
  ): AsyncIterableIterator<HudhudEvent, undefined, undefined> {
    const signal = this.#signalFor(options?.signal, options?.overflow ?? this.#defaults.overflow);
    const source = this.#fanout.subscribe(
      {
        match: (item) => item.kind === 'event',
        replay:
          this.#compat === undefined
            ? []
            : [{ event: { kind: 'event', event: this.#compat }, bytes: SYNTHESIZED_EVENT_BYTES }],
      },
      this.#subscriberOptions(options, signal),
    );
    return this.#eventsOf(source);
  }

  /**
   * Queues a raw command input, bypassing the handles' bookkeeping (no turn
   * record, no permission bridge): for replays of recorded inputs through
   * the loopback binding. Effects bound to unknown turns or correlations
   * are ignored.
   */
  command(input: CommandInput): void {
    this.#begin();
    this.#enqueue({ body: input });
  }

  close(): Promise<void> {
    this.#begin();
    if (!this.#closeRequested && !this.#abortRequested) {
      this.#closeRequested = true;
      this.#enqueue({ body: { type: 'cmd.close' } });
    }
    return this.#closed;
  }

  abort(intent: 'abort' | 'dispose'): Promise<void> {
    this.#begin();
    if (!this.#abortRequested) {
      this.#abortRequested = true;
      this.#cutBlocked();
      this.#enqueue({ body: { type: 'cmd.abort', intent } });
    }
    return this.#closed;
  }

  // ---- start ------------------------------------------------------------------------------

  #begin(): void {
    if (this.#begun) return;
    this.#begun = true;
    this.#unregisterHostExit = this.#hostExit?.register({
      endInputNow: () => {
        this.#transport.endInput({ graceful: false });
      },
    });
    void this.#readOutput();
    void this.#transport.exited.then((exit) => {
      this.#exitHandled = this.#onExit(exit);
    });
    for (const diagnostic of this.#diagnostics) {
      this.#diagnostic(diagnostic.code, diagnostic.message, diagnostic.data);
    }
    this.#enqueue({ body: { type: 'process.started', pid: this.#transport.pid } });
  }

  async #readOutput(): Promise<void> {
    try {
      for await (const output of this.#transport.output) {
        await this.#feed(output);
        if (this.#finishing) break;
      }
    } catch (error) {
      this.#diagnostic('stdout.error', 'Reading the harness output failed.', {
        error: nameOf(error),
      });
    }
    this.#outputEnded = true;
    this.#outputEnd.resolve(undefined);
    await this.#feed({ type: 'stdout.end' });
  }

  /** Queues one transport report and resolves once it was processed. */
  #feed(body: TransportOutput | TransportInput): Promise<void> {
    return new Promise((resolve) => {
      this.#enqueue(
        body.type === 'line'
          ? { body, bytes: body.bytes, processed: resolve }
          : { body, processed: resolve },
      );
    });
  }

  // ---- the input queue ------------------------------------------------------------------

  #enqueue(item: QueueItem): void {
    this.#queue.push(item);
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let item = this.#queue.shift(); item !== undefined; item = this.#queue.shift()) {
        this.#process(item);
        // Only a full 'block' subscriber can hold the next input (ADR-0007).
        while (this.#blocked !== undefined) await this.#blocked;
        item.processed?.();
      }
    } finally {
      this.#pumping = false;
    }
  }

  #process(item: QueueItem): void {
    const { body } = item;
    if (body.type === 'timer') {
      const armed = this.#timers.get(body.name);
      if (armed === undefined || armed.generation !== item.timer?.generation) return;
      this.#timers.delete(body.name);
    }
    if (body.type === 'stdin.error') this.#inputClosed();
    if (this.#machineEnded || this.#broken !== undefined) {
      if (item.send !== undefined) this.#failTurn(item.send, this.#endRefusal());
      return;
    }
    let step: ReturnType<HarnessMachine<State, Config>['step']>;
    this.#steps += 1;
    try {
      step = this.#machine.step(this.#state, {
        ...body,
        atMs: this.#clock.nowMs(),
        at: this.#clock.nowIso(),
      });
    } catch (error) {
      this.#breakMachine('The harness machine threw.', error);
      return;
    }
    this.#state = step.state;
    this.#execute(step.effects, item);
  }

  // ---- effects --------------------------------------------------------------------------

  #execute(effects: readonly MachineEffect[], item: QueueItem): void {
    const ladderInStep = effects.some((effect) => effect.type === 'ladder.start');
    const ended: TurnRecord[] = [];
    const current = item.send;
    for (const effect of effects) {
      switch (effect.type) {
        case 'write':
          this.#write(effect.line);
          break;
        case 'stdin.end':
          this.#endInput(!ladderInStep && this.#ladder === undefined);
          break;
        case 'timer.set':
          this.#armTimer(effect.name, effect.ms);
          break;
        case 'timer.clear':
          this.#timers.get(effect.name)?.cancel();
          this.#timers.delete(effect.name);
          break;
        case 'event':
          this.#publish(effect.event, item.bytes);
          break;
        case 'permission.ask':
          this.#bridge.ask(effect.requestId, effect.request);
          break;
        case 'permission.cancel':
          this.#bridge.cancel(effect.requestId, effect.reason);
          break;
        case 'handshake.ok':
          this.#handshakeOk(effect.info);
          break;
        case 'handshake.fail':
          if (this.#handshake === 'pending') {
            this.#handshake = 'failed';
            this.#handshakeError = effect.error;
          }
          break;
        case 'turn.settle': {
          const record = this.#turns.get(effect.turnId);
          if (record?.settle(effect.result) === true) ended.push(record);
          break;
        }
        case 'turn.fail': {
          const record = this.#turns.get(effect.turnId);
          if (record?.fail(this.#errorFrom(effect.error)) === true) ended.push(record);
          break;
        }
        case 'send.rejected':
          // Bound to this step's send only; a live turn with that id is untouched.
          if (current?.id === effect.turnId && current.fail(this.#errorFrom(effect.error))) {
            ended.push(current);
          }
          break;
        case 'control.settle': {
          const record = this.#controls.get(effect.correlation);
          this.#controls.delete(effect.correlation);
          if (effect.ok) record?.resolve();
          else record?.reject(this.#errorFrom(effect.error));
          break;
        }
        case 'ladder.start':
          this.#startLadder(effect.intent);
          break;
        case 'session.end':
          this.#sessionEnd(effect.outcome, effect.error);
          break;
      }
    }
    for (const record of ended) this.#turnEnded(record);
  }

  #write(line: string): void {
    if (this.#inputEnded) return;
    this.#transport.write(line).catch((error: unknown) => {
      if (this.#inputEnded || this.#writeFailed) return;
      this.#writeFailed = true;
      const code =
        typeof error === 'object' &&
        error !== null &&
        typeof Reflect.get(error, 'code') === 'string'
          ? (Reflect.get(error, 'code') as string)
          : 'EIO';
      this.#enqueue({ body: { type: 'stdin.error', code } });
    });
  }

  #endInput(graceful: boolean): void {
    if (!this.#inputEnded) this.#transport.endInput({ graceful });
    this.#inputClosed();
  }

  /** Input can take no more writes: wakes the ladder's interrupt step. */
  #inputClosed(): void {
    this.#inputEnded = true;
    this.#wakeInterrupt('acknowledged');
  }

  #wakeInterrupt(outcome: InterruptOutcome): void {
    const waiters = this.#interruptWaiters;
    this.#interruptWaiters = [];
    for (const wake of waiters) wake(outcome);
  }

  #armTimer(name: string, ms: number): void {
    this.#timers.get(name)?.cancel();
    this.#timerGeneration += 1;
    const generation = this.#timerGeneration;
    const cancel = this.#clock.schedule(ms, () => {
      this.#enqueue({ body: { type: 'timer', name }, timer: { name, generation } });
    });
    this.#timers.set(name, { generation, cancel });
  }

  #handshakeOk(data: SessionInfoData): void {
    if (this.#handshake !== 'pending') return;
    this.#handshake = 'ok';
    const info: SessionInfo = {
      id: data.id,
      mode: data.mode,
      ...(data.forkedFrom === undefined ? {} : { forkedFrom: data.forkedFrom }),
      pid: data.pid,
      ...(data.cliPid === undefined ? {} : { cliPid: data.cliPid }),
      version: data.version,
      ...(data.apiKeySource === undefined ? {} : { apiKeySource: data.apiKeySource }),
      ...(data.tokenSource === undefined ? {} : { tokenSource: data.tokenSource }),
      features: [...data.features],
      containment: this.#containment,
    };
    this.#info = Object.freeze(info);
    this.#started.resolve(this.#info);
  }

  #startLadder(intent: TerminationIntent): void {
    if (this.#ladder !== undefined || this.#exit !== undefined) return;
    this.#ladder = this.#transport
      .terminate({
        intent,
        initializePid: this.#info?.cliPid ?? null,
        interrupt: () => this.#interruptStep(),
      })
      .then(
        (report) => {
          if (report !== null) {
            this.#diagnostic(
              'termination.ladder',
              'The termination ladder ran.',
              toJsonObject(report),
            );
          }
        },
        (error: unknown) => {
          this.#diagnostic('termination.ladder', 'The termination ladder failed.', {
            error: nameOf(error),
          });
        },
      )
      .then(() => this.#feed({ type: 'ladder.done' }));
  }

  /** The ladder's interrupt hook: the machine's interrupt step ends with `stdin.end`. */
  #interruptStep(): Promise<InterruptOutcome> {
    if (this.#inputEnded || this.#broken !== undefined || this.#machineEnded) {
      return Promise.resolve('not-applicable');
    }
    return new Promise((resolve) => {
      this.#interruptWaiters.push(resolve);
    });
  }

  #control(build: (correlation: string) => CommandInput): Promise<void> {
    const refusal =
      this.#end === undefined && this.#broken === undefined ? undefined : this.#refusal();
    if (refusal !== undefined) return Promise.reject(refusal);
    this.#correlation += 1;
    const correlation = `c${String(this.#correlation)}`;
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    this.#controls.set(correlation, {
      resolve: () => {
        resolve(undefined);
      },
      reject,
    });
    this.#begin();
    this.#enqueue({ body: build(correlation) });
    return promise;
  }

  // ---- events ---------------------------------------------------------------------------

  #publish(event: HudhudEvent, lineBytes: number | undefined): void {
    const bytes =
      lineBytes !== undefined && Object.hasOwn(event, 'raw') ? lineBytes : SYNTHESIZED_EVENT_BYTES;
    this.#outbox.push({ item: { kind: 'event', event: { ...event, seq: this.#seq } }, bytes });
    this.#seq += 1;
    this.#drainOutbox();
  }

  /** Publishes a diagnostic of the binding itself. */
  #diagnostic(code: string, message: string, data: JsonObject | undefined): void {
    if (this.#fanout.closed) return;
    const base = {
      type: 'diagnostic',
      code,
      message,
      seq: 0,
      ts: this.#clock.nowIso(),
      sessionId: this.id,
    } as const;
    this.#publish(data === undefined ? base : { ...base, data }, undefined);
  }

  #drainOutbox(): void {
    while (this.#blocked === undefined) {
      const next = this.#outbox.shift();
      if (next === undefined) return;
      if (this.#fanout.closed) continue;
      const wait = this.#fanout.publish(next.item, next.bytes);
      if (wait !== undefined) {
        const blocked = wait.then(() => {
          this.#blocked = undefined;
          this.#drainOutbox();
        });
        this.#blocked = blocked;
        if (this.#abortRequested) this.#cutBlocked();
      }
    }
  }

  /** Abort and dispose cut through stalled `'block'` subscribers. */
  #cutBlocked(): void {
    const reason = new CutReason(
      new SessionClosedError('The session was aborted while this subscriber stalled it.'),
    );
    for (const signal of [...this.#blockSignals]) signal.abort(reason);
  }

  #signalFor(parent: AbortSignal | undefined, overflow: unknown): SubscriptionSignal {
    const signal: SubscriptionSignal = new SubscriptionSignal(parent, () => {
      this.#blockSignals.delete(signal);
    });
    if (overflow === 'block' && !signal.aborted) this.#blockSignals.add(signal);
    return signal;
  }

  #subscriberOptions(
    options: SubscriberOptions | undefined,
    signal: SubscriptionSignal,
  ): FanoutSubscriberOptions {
    const maxEvents = options?.maxEvents ?? this.#defaults.maxEvents;
    const maxBytes = options?.maxBytes ?? this.#defaults.maxBytes;
    const overflow = options?.overflow ?? this.#defaults.overflow;
    const merged: FanoutSubscriberOptions = {
      ...(maxEvents === undefined ? {} : { maxEvents }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(overflow === undefined ? {} : { overflow }),
    };
    try {
      return { ...resolveSubscriberOptions(merged), signal };
    } catch (error) {
      signal.abort(undefined);
      throw new InvalidOptionsError('Invalid subscriber options.', {
        details: { path: 'events', rule: 'subscriber-options' },
        cause: error,
      });
    }
  }

  #subscribeTurn(
    turnId: string,
    options: SubscriberOptions | undefined,
    parent: AbortSignal | undefined,
  ): AsyncIterableIterator<HudhudEvent, undefined, undefined> {
    const signal = this.#signalFor(parent, options?.overflow ?? this.#defaults.overflow);
    const source = this.#fanout.subscribe(
      {
        match: (item) =>
          (item.kind === 'event' && turnIdOf(item.event) === turnId) ||
          (item.kind === 'turn-end' && item.turnId === turnId),
        endAfter: (item) =>
          item.kind === 'turn-end' ||
          (item.kind === 'event' && item.event.type === 'turn.completed'),
      },
      this.#subscriberOptions(options, signal),
    );
    return this.#eventsOf(source);
  }

  /** The public view of a subscription: events, gap markers numbered in place, turn ends. */
  #eventsOf(
    source: AsyncIterableIterator<Item, undefined, undefined>,
  ): AsyncIterableIterator<HudhudEvent, undefined, undefined> {
    // Events published from now on start at the current seq.
    let lastSeq = this.#seq - 1;
    let done = false;
    const finish = async (): Promise<IteratorReturnResult<undefined>> => {
      done = true;
      await source.return?.();
      return { done: true, value: undefined };
    };
    const next = async (): Promise<IteratorResult<HudhudEvent, undefined>> => {
      if (done) return { done: true, value: undefined };
      const result = await source.next();
      if (result.done === true) {
        done = true;
        return result;
      }
      const item = result.value;
      switch (item.kind) {
        case 'event':
          // The replayed compat (seq 0) does not move the position back.
          lastSeq = Math.max(lastSeq, item.event.seq);
          return { done: false, value: item.event };
        case 'gap':
          // Numbered as the first dropped event: the last delivered seq plus one.
          lastSeq += 1;
          return {
            done: false,
            value: {
              type: 'gap',
              dropped: item.dropped,
              seq: lastSeq,
              ts: this.#clock.nowIso(),
              sessionId: this.id,
            },
          };
        case 'turn-end':
          await finish();
          if (item.error !== undefined) throw item.error;
          return { done: true, value: undefined };
      }
    };
    const iterator: AsyncIterableIterator<HudhudEvent, undefined, undefined> = {
      next,
      return: finish,
      throw: async (error?: unknown) => {
        await finish();
        throw error;
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  /**
   * The turn is over: the marker follows the turn's events through the
   * outbox and ends its iterator (a failed turn's iterator rejects with the
   * turn's error after its buffered events).
   */
  #turnEnded(record: TurnRecord): void {
    if (this.#turns.get(record.id) === record) this.#turns.delete(record.id);
    this.#outbox.push({
      item: { kind: 'turn-end', turnId: record.id, error: record.error },
      bytes: 0,
    });
    this.#drainOutbox();
  }

  #failTurn(record: TurnRecord, error: HudhudError): void {
    record.fail(error);
    this.#turnEnded(record);
  }

  // ---- errors ----------------------------------------------------------------------------

  /** An error class for machine error data, with the stderr tail where plan §3.3 asks for it. */
  #errorFrom(data: ErrorData): HudhudError {
    let details = data.details;
    if (
      TAIL_CODES.has(data.code) &&
      (details === undefined || !Object.hasOwn(details, 'stderrTail'))
    ) {
      const tail = this.#transport.stderrTail();
      if (tail !== '') details = { ...details, stderrTail: tail };
    }
    if (!isHudhudErrorCode(data.code)) {
      return new ProtocolError(data.message, {
        details: { ...details, unknownCode: data.code },
      });
    }
    return HudhudError.fromData(
      details === undefined
        ? makeErrorData(data.code, data.message)
        : makeErrorData(data.code, data.message, details),
    );
  }

  /** The error of a call refused because the session ends: its ending error, else `SESSION_CLOSED`. */
  #endRefusal(): HudhudError {
    const ending = this.#broken ?? this.#end?.error;
    return ending === undefined
      ? new SessionClosedError('The session is closed or closing.')
      : this.#errorFrom(ending);
  }

  /** Why a new call is refused now, or `undefined` when it may proceed. */
  #refusal(): HudhudError | undefined {
    const ending =
      this.#closeRequested ||
      this.#abortRequested ||
      this.#end !== undefined ||
      this.#broken !== undefined;
    return ending ? this.#endRefusal() : undefined;
  }

  // ---- the end -----------------------------------------------------------------------------

  #sessionEnd(outcome: SessionOutcome, error: ErrorData | undefined): void {
    this.#machineEnded = true;
    this.#end = error === undefined ? { outcome } : { outcome, error };
    void this.#finish(this.#end);
  }

  /** The machine threw or did not end: the binding ends the session itself (failed). */
  #breakMachine(message: string, error: unknown): void {
    if (this.#broken !== undefined) return;
    this.#broken = makeErrorData('PROTOCOL_ERROR', message, { error: nameOf(error) });
    this.#diagnostic('binding.machine-error', message, { error: nameOf(error) });
    if (this.#handshake === 'pending') {
      this.#handshake = 'failed';
      this.#handshakeError = this.#broken;
    }
    this.#wakeInterrupt('not-applicable');
    this.#startLadder('abort');
    void this.#finish({ outcome: 'failed', error: this.#broken });
  }

  async #onExit(exit: ExitObservation): Promise<void> {
    this.#exit = exit;
    if (this.#ladder !== undefined) await this.#ladder;
    const sweep = await this.#transport.afterExit();
    if (sweep !== null) {
      this.#diagnostic(
        'termination.sweep-after-exit',
        'The graceful close swept the process tree.',
        toJsonObject(sweep),
      );
    }
    if (!this.#outputEnded) {
      const cancel = this.#clock.schedule(this.#drainMs, () => {
        this.#outputEnd.resolve(undefined);
      });
      await this.#outputEnd.promise;
      cancel();
    }
    await this.#feed({ type: 'process.exit', code: exit.code, signal: exit.signal });
    if (!this.#machineEnded)
      this.#breakMachine('The harness machine did not end after the exit.', undefined);
  }

  async #finish(ending: SessionEnd): Promise<void> {
    if (this.#finishing) return;
    this.#finishing = true;
    // The machine ended (or broke) before the exit: make sure nothing runs on
    // (no-op once a ladder runs or the exit was seen).
    this.#startLadder('abort');
    const exit = await this.#transport.exited;
    // `#onExit` runs from the same promise and was attached first.
    await this.#exitHandled;
    await this.#ladder;
    for (const timer of this.#timers.values()) timer.cancel();
    this.#timers.clear();
    this.#wakeInterrupt('not-applicable');
    this.#bridge.cancelAll('harness');
    if (this.#broken !== undefined) {
      this.#publish(
        {
          type: 'session.terminated',
          intent: 'abort',
          outcome: 'failed',
          ...(exit.code === null ? {} : { exitCode: exit.code }),
          ...(exit.signal === null ? {} : { signal: exit.signal }),
          seq: 0,
          ts: this.#clock.nowIso(),
          sessionId: this.id,
        },
        undefined,
      );
    }
    this.#end = ending;
    const refusal = this.#endRefusal();
    for (const record of [...this.#turns.values()]) this.#failTurn(record, refusal);
    for (const [correlation, record] of [...this.#controls]) {
      this.#controls.delete(correlation);
      record.reject(refusal);
    }
    if (this.#abortRequested) this.#cutBlocked();
    while (this.#blocked !== undefined) await this.#blocked;
    this.#fanout.close();
    this.#unregisterHostExit?.();
    if (this.#handshake !== 'ok') {
      const error = this.#handshakeError ?? ending.error;
      this.#started.reject(
        error === undefined
          ? new SessionClosedError('The session ended before it started.')
          : this.#errorFrom(error),
      );
    }
    this.#finished.resolve(ending);
  }
}

/** Our own JSON report data (ladder, sweep) as a `JsonObject`. */
function toJsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/**
 * Builds a driver, starts it and returns the public {@link Session} once the
 * handshake succeeded. Rejects with the handshake's error after the session
 * ended (nothing is left running).
 *
 * @beta
 */
export async function openSession<State, Config>(
  options: DriverOptions<State, Config>,
): Promise<Session> {
  const driver = new SessionDriver(options);
  await driver.start();
  return createSession(driver);
}
