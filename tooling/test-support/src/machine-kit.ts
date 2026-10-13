/**
 * Machine kit: a deterministic driver and a fast-check property that assert
 * the neutral machine contract against any harness machine (plan §1.4,
 * §1.11, ADR-0006, K3).
 *
 * @remarks
 * The kit drives a machine the way the binding layer does, without I/O: a
 * fake clock stamps every input, armed timers fire only when the driver
 * chooses, and fast-check generates the interleaving of transport reports,
 * application commands, permission answers, timer firings and clock
 * advances. Each run ends with a fixed finale (abort, end of output, exit,
 * ladder done by default) after which the session must have ended.
 *
 * Checked on every step: `step` neither throws nor mutates its input state,
 * is deterministic, and its output survives a JSON round trip unchanged.
 * Checked over the trace: every turn settles exactly once (a
 * `send.rejected` ends only the send of its own step); each
 * `permission.ask` ends exactly once (a `permission.cancel` effect or a
 * `cmd.permission` / `cmd.permission-abort` / `cmd.permission-error`
 * input); a `cmd.permission-error` is answered fail-closed (its step
 * resolves the ask as a deny and never as an allow); no `write` after
 * `stdin.end`; event `seq` strictly increases by 1; timers are cleared or
 * fired before `session.end`; nothing is emitted after `session.end`; a
 * control correlation settles at most once.
 *
 * The input types are the contract's own (`@hudhud/core/protocol`). Effects
 * are read loosely ({@link KitEffect}) and every field is checked at run
 * time, so the kit also reports a malformed machine instead of trusting its
 * types; every `HarnessMachine` is a {@link KitMachine}. The module also
 * exports {@link referenceMachine}, a trivial neutral machine that satisfies
 * the contract, for driver tests.
 */

import { Buffer } from 'node:buffer';
import process from 'node:process';

import type {
  CommandInput,
  JsonObject,
  JsonValue,
  MachineInput,
  PermissionErrorReason,
  TransportInput,
} from '@hudhud/core/protocol';
import fc from 'fast-check';

// ---- contract -------------------------------------------------------------------

/** An input without its clock stamp. */
export type KitInputBody = TransportInput | CommandInput;

/** An effect as the kit reads it: the kit checks every other field at run time. */
export interface KitEffect {
  readonly type: string;
}

/**
 * What the kit needs of a machine: the core `HarnessMachine` with its
 * effects read as {@link KitEffect}, so malformed machines can be driven
 * too. Every `HarnessMachine` is one.
 */
export interface KitMachine<State, Config> {
  readonly initialState: (config: Config) => State;
  readonly step: (
    state: State,
    input: MachineInput,
  ) => { readonly state: State; readonly effects: readonly KitEffect[] };
}

// ---- actions --------------------------------------------------------------------

/**
 * One driver action. Actions that target something (`target`) pick it by
 * index modulo the candidates the driver knows at that moment; with no
 * candidate the action does nothing.
 */
export type KitAction =
  /** Feed this input as is. */
  | { readonly kind: 'input'; readonly input: KitInputBody }
  /** Feed a `line` with this text; the driver computes `bytes`. */
  | { readonly kind: 'line'; readonly text: string }
  /** `cmd.send` with the next driver turn id. */
  | { readonly kind: 'send'; readonly content: JsonValue }
  /** `cmd.interrupt` of a sent turn (or of none when `target` is negative). */
  | { readonly kind: 'interrupt'; readonly target: number; readonly cancelQueued: boolean }
  /** `cmd.set-permission-mode` with the next driver correlation. */
  | { readonly kind: 'set-mode'; readonly mode: string }
  /** `cmd.permission` for a pending ask. */
  | { readonly kind: 'answer'; readonly target: number; readonly decision: JsonObject }
  /** `cmd.permission-abort` for a pending ask. */
  | { readonly kind: 'abort-ask'; readonly target: number }
  /** `cmd.permission-error` for a pending ask: the binding got no valid decision. */
  | { readonly kind: 'fail-ask'; readonly target: number; readonly reason: PermissionErrorReason }
  /** Advance the clock to an armed timer's deadline and fire it. */
  | { readonly kind: 'fire-timer'; readonly target: number }
  /** Advance the clock. */
  | { readonly kind: 'advance'; readonly ms: number };

/** Options of {@link machineActions}. */
export interface MachineActionOptions {
  /** Harness lines (stdout frames) to interleave; none by default. */
  readonly lines?: fc.Arbitrary<string>;
  /** Further inputs to interleave as is. */
  readonly inputs?: fc.Arbitrary<KitInputBody>;
  /** Content of `cmd.send`. Default: short strings. */
  readonly content?: fc.Arbitrary<JsonValue>;
  /** Most actions per run. Default 40. */
  readonly maxActions?: number;
}

/** Every reason of `cmd.permission-error` (the contract's closed vocabulary). */
export const PERMISSION_ERROR_REASONS: readonly PermissionErrorReason[] = [
  'no-handler',
  'handler-failed',
  'invalid-decision',
];

/** Exit observations worth exploring: success, error, signals, the Windows `-1`. */
const EXITS: readonly KitInputBody[] = [
  { type: 'process.exit', code: 0, signal: null },
  { type: 'process.exit', code: 1, signal: null },
  { type: 'process.exit', code: 2, signal: null },
  { type: 'process.exit', code: 129, signal: null },
  { type: 'process.exit', code: 143, signal: null },
  { type: 'process.exit', code: 4294967295, signal: null },
  { type: 'process.exit', code: null, signal: 'SIGTERM' },
  { type: 'process.exit', code: null, signal: 'SIGKILL' },
];

/** Harness-neutral inputs the binding may deliver at any time after the process started. */
export function neutralInputs(): fc.Arbitrary<KitInputBody> {
  return fc.oneof(
    fc.constantFrom<KitInputBody>(
      ...EXITS,
      { type: 'stdout.end' },
      { type: 'ladder.done' },
      { type: 'cmd.close' },
      { type: 'cmd.abort', intent: 'abort' },
      { type: 'cmd.abort', intent: 'dispose' },
      { type: 'stdin.error', code: 'EPIPE' },
    ),
    fc.string({ maxLength: 20 }).map((text): KitInputBody => ({ type: 'stderr.line', text })),
    fc
      .integer({ min: 1, max: 1 << 30 })
      .map((bytes): KitInputBody => ({ type: 'line.oversized', bytes })),
    fc
      .integer({ min: 1, max: 4096 })
      .map((bytes): KitInputBody => ({ type: 'line.invalid-utf8', bytes })),
  );
}

/** The interleavings the kit explores: commands, transport reports, timers, clock. */
export function machineActions(options: MachineActionOptions = {}): fc.Arbitrary<KitAction[]> {
  const index = fc.integer({ min: 0, max: 7 });
  const content = options.content ?? fc.string({ maxLength: 12 });
  const extra =
    options.inputs === undefined ? neutralInputs() : fc.oneof(neutralInputs(), options.inputs);
  const arms: fc.Arbitrary<KitAction>[] = [
    content.map((value): KitAction => ({ kind: 'send', content: value })),
    fc
      .record({ target: fc.integer({ min: -1, max: 7 }), cancelQueued: fc.boolean() })
      .map(({ target, cancelQueued }): KitAction => ({ kind: 'interrupt', target, cancelQueued })),
    fc.constantFrom('default', 'plan').map((mode): KitAction => ({ kind: 'set-mode', mode })),
    fc.record({ target: index, allow: fc.boolean() }).map(({ target, allow }): KitAction => ({
      kind: 'answer',
      target,
      decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'no' },
    })),
    index.map((target): KitAction => ({ kind: 'abort-ask', target })),
    fc
      .record({ target: index, reason: fc.constantFrom(...PERMISSION_ERROR_REASONS) })
      .map(({ target, reason }): KitAction => ({ kind: 'fail-ask', target, reason })),
    index.map((target): KitAction => ({ kind: 'fire-timer', target })),
    fc.integer({ min: 0, max: 60_000 }).map((ms): KitAction => ({ kind: 'advance', ms })),
    extra.map((input): KitAction => ({ kind: 'input', input })),
  ];
  if (options.lines !== undefined) {
    const line = options.lines.map((text): KitAction => ({ kind: 'line', text }));
    // Lines carry the harness protocol; weight them like all commands together.
    arms.push(line, line, line);
  }
  return fc.array(fc.oneof(...arms), { maxLength: options.maxActions ?? 40 });
}

// ---- driver ---------------------------------------------------------------------

/** Options of {@link runMachine}. */
export interface RunMachineOptions extends KitDriverOptions {
  /** Inputs before the actions. Default: `process.started` with pid 4242. */
  readonly prelude?: readonly KitInputBody[];
  /** Inputs after the actions. Default: abort, `stdout.end`, a SIGKILL exit, `ladder.done`. */
  readonly finale?: readonly KitInputBody[];
  /** Whether the session must have ended after the finale. Default `true`. */
  readonly requireEnd?: boolean;
}

/** One step of a run. */
export interface KitStep<State> {
  readonly input: MachineInput;
  readonly effects: readonly KitEffect[];
  readonly state: State;
}

/** What {@link runMachine} observed. */
export interface MachineRun<State> {
  readonly steps: readonly KitStep<State>[];
  /** Contract violations; the run stops at the step that produced the first. */
  readonly violations: readonly string[];
  readonly ended: boolean;
}

/** The default prelude: the process started. */
export const DEFAULT_PRELUDE: readonly KitInputBody[] = [{ type: 'process.started', pid: 4242 }];

/** The default finale: abort, then the process goes away. */
export const DEFAULT_FINALE: readonly KitInputBody[] = [
  { type: 'cmd.abort', intent: 'abort' },
  { type: 'stdout.end' },
  { type: 'process.exit', code: null, signal: 'SIGKILL' },
  { type: 'ladder.done' },
];

const DEFAULT_START_MS = Date.UTC(2026, 0, 1);

/** Reads a field of an effect or event without trusting its shape. */
function field(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? (Reflect.get(value, key) as unknown) : undefined;
}

/** Whether a value survives a JSON round trip unchanged; `false` when it cannot be serialized. */
function jsonStable(value: unknown): boolean {
  try {
    // `undefined` for values JSON cannot represent at the top level (a function,
    // `undefined`), although the declared return type is `string`.
    const text = JSON.stringify(value) as string | undefined;
    return text !== undefined && sameAfterRoundTrip(value, JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * Whether `parsed` (the JSON round trip of `original`) equals `original`:
 * same primitives (`Object.is`, so `-0` and `NaN` differ), arrays of the same
 * length, plain objects (prototype `Object.prototype` or `null`) with the same
 * own keys. Class instances, symbol and non-enumerable keys, `undefined`
 * values and holes do not survive.
 */
function sameAfterRoundTrip(original: unknown, parsed: unknown): boolean {
  if (typeof original !== 'object' || original === null) return Object.is(original, parsed);
  if (typeof parsed !== 'object' || parsed === null) return false;
  if (Array.isArray(original)) {
    if (!Array.isArray(parsed) || parsed.length !== original.length) return false;
    // A loop, not `every`: `every` skips holes, which JSON turns into `null`.
    for (let index = 0; index < original.length; index += 1) {
      if (!Object.hasOwn(original, index)) return false;
      if (!sameAfterRoundTrip(original[index], parsed[index])) return false;
    }
    // The indices and `length`: any other own property is lost by JSON.
    return Reflect.ownKeys(original).length === original.length + 1;
  }
  const proto: unknown = Object.getPrototypeOf(original);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(original);
  return (
    keys.length === Object.keys(parsed).length &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        Object.hasOwn(parsed, key) &&
        sameAfterRoundTrip(Reflect.get(original, key), Reflect.get(parsed, key)),
    )
  );
}

/** Contract bookkeeping over the effects of a run. */
class ContractTracker {
  readonly known = new Set<string>();
  readonly settled = new Set<string>();
  readonly pendingAsks: string[] = [];
  readonly endedAsks = new Set<string>();
  readonly armed = new Map<string, number>();
  readonly controls = new Set<string>();
  /** The turn id of the `cmd.send` being fed, while its step is recorded. */
  stepSend: string | undefined;
  stdinEnded = false;
  ended = false;
  lastSeq: number | undefined;
  private readonly firstSeq: number | undefined;

  constructor(firstSeq: number | undefined) {
    this.firstSeq = firstSeq;
  }

  /** Records the effects of one step at clock `now`; returns violations. */
  record(effects: readonly KitEffect[], now: number): string[] {
    const violations: string[] = [];
    for (const effect of effects) {
      if (this.ended) {
        violations.push(`effect ${effect.type} after session.end`);
        continue;
      }
      this.recordOne(effect, now, violations);
    }
    return violations;
  }

  private recordOne(effect: KitEffect, now: number, violations: string[]): void {
    const text = (key: string): string | undefined => {
      const value = field(effect, key);
      if (typeof value === 'string') return value;
      violations.push(`${effect.type} without a string ${key}`);
      return undefined;
    };
    switch (effect.type) {
      case 'write':
        if (this.stdinEnded) violations.push('write after stdin.end');
        break;
      case 'stdin.end':
        this.stdinEnded = true;
        break;
      case 'timer.set': {
        const name = text('name');
        const ms = field(effect, 'ms');
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
          violations.push(`timer.set ${String(name)} with an invalid ms`);
        } else if (name !== undefined) {
          this.armed.set(name, now + ms);
        }
        break;
      }
      case 'timer.clear': {
        const name = text('name');
        if (name !== undefined) this.armed.delete(name);
        break;
      }
      case 'event':
        this.recordEvent(field(effect, 'event'), violations);
        break;
      case 'permission.ask': {
        const id = text('requestId');
        if (id === undefined) break;
        if (this.pendingAsks.includes(id) || this.endedAsks.has(id)) {
          violations.push(`permission ${id} asked twice`);
        } else {
          this.pendingAsks.push(id);
        }
        break;
      }
      case 'permission.cancel': {
        const id = text('requestId');
        if (id === undefined) break;
        if (!this.endAsk(id)) violations.push(`permission ${id} cancelled but not pending`);
        break;
      }
      case 'turn.settle':
      case 'turn.fail': {
        const id = text('turnId');
        if (id === undefined) break;
        if (!this.known.has(id)) violations.push(`turn ${id} settled but never sent or started`);
        else if (this.settled.has(id)) violations.push(`turn ${id} settled twice`);
        this.settled.add(id);
        break;
      }
      case 'send.rejected': {
        // Bound to the send of this step; it ends that send, never another turn.
        const id = text('turnId');
        if (id === undefined) break;
        if (id !== this.stepSend)
          violations.push(`send.rejected ${id} is not the send of this step`);
        else if (this.settled.has(id)) violations.push(`turn ${id} settled twice`);
        this.settled.add(id);
        break;
      }
      case 'control.settle': {
        const id = text('correlation');
        if (id === undefined) break;
        if (this.controls.has(id)) violations.push(`control ${id} settled twice`);
        this.controls.add(id);
        break;
      }
      case 'session.end':
        this.ended = true;
        this.checkEnd(violations);
        break;
      default:
        break;
    }
  }

  private recordEvent(event: unknown, violations: string[]): void {
    if (typeof event !== 'object' || event === null) {
      violations.push('event effect without an event object');
      return;
    }
    const seq = field(event, 'seq');
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
      violations.push('event without an integer seq');
      return;
    }
    const expected = this.lastSeq === undefined ? this.firstSeq : this.lastSeq + 1;
    if (expected !== undefined && seq !== expected) {
      violations.push(`event seq ${String(seq)}, expected ${String(expected)}`);
    }
    this.lastSeq = seq;
    const turnId = field(event, 'turnId');
    if (field(event, 'type') === 'turn.started' && typeof turnId === 'string') {
      this.known.add(turnId);
    }
  }

  /** Ends a pending ask; `false` when it was not pending. */
  endAsk(id: string): boolean {
    const at = this.pendingAsks.indexOf(id);
    if (at < 0) return false;
    this.pendingAsks.splice(at, 1);
    this.endedAsks.add(id);
    return true;
  }

  private checkEnd(violations: string[]): void {
    for (const id of this.known) {
      if (!this.settled.has(id)) violations.push(`turn ${id} never settled`);
    }
    for (const id of this.pendingAsks) violations.push(`permission ${id} never ended`);
    for (const name of this.armed.keys()) violations.push(`timer ${name} armed at session.end`);
  }
}

/** Options of {@link KitDriver}. */
export interface KitDriverOptions {
  /** The `seq` the first event must carry; any integer when absent. */
  readonly firstSeq?: number;
  /** Clock start in milliseconds since the epoch. Default 2026-01-01T00:00:00Z. */
  readonly startMs?: number;
}

/**
 * An incremental, contract-checking driver: feeds inputs one at a time with
 * a fake clock and checks every step and the trace exactly as
 * {@link runMachine} does (which is built on it). For replays whose next
 * input depends on the effects so far, such as the conformance runner
 * (timers fire at their deadlines, request ids are learned from writes).
 *
 * @remarks
 * The first violation stops the driver: every later call does nothing and
 * returns `false`. The commands whose bookkeeping the contract needs go
 * through their own methods ({@link KitDriver.send}, {@link KitDriver.answer},
 * {@link KitDriver.abortAsk}, {@link KitDriver.fireTimer}); everything else
 * through {@link KitDriver.feed}.
 */
export class KitDriver<State, Config> {
  readonly steps: KitStep<State>[] = [];
  readonly violations: string[] = [];
  private readonly machine: KitMachine<State, Config>;
  private readonly tracker: ContractTracker;
  private current: State | undefined;
  private clock: number;

  constructor(machine: KitMachine<State, Config>, config: Config, options: KitDriverOptions = {}) {
    this.machine = machine;
    this.tracker = new ContractTracker(options.firstSeq);
    this.clock = options.startMs ?? DEFAULT_START_MS;
    let state: State;
    try {
      state = machine.initialState(config);
    } catch (error) {
      this.violations.push(`initialState threw: ${String(error)}`);
      return;
    }
    if (!jsonStable(state)) {
      this.violations.push('initialState is not JSON-stable');
      return;
    }
    this.current = state;
  }

  /** The current state; `undefined` when the initial state failed. */
  get state(): State | undefined {
    return this.current;
  }

  /** The clock in milliseconds since the epoch. */
  get now(): number {
    return this.clock;
  }

  /** Whether `session.end` was emitted. */
  get ended(): boolean {
    return this.tracker.ended;
  }

  /** Whether a violation stopped the driver. */
  get stopped(): boolean {
    return this.violations.length > 0;
  }

  /** Armed timers and their deadlines, in arming order. */
  get timers(): readonly (readonly [string, number])[] {
    return [...this.tracker.armed.entries()];
  }

  /** Request ids of the permission asks still pending, oldest first. */
  get pendingAsks(): readonly string[] {
    return [...this.tracker.pendingAsks];
  }

  /** Moves the clock forward by `ms`. */
  advance(ms: number): void {
    this.clock += ms;
  }

  /** Moves the clock to `atMs` when that is later; never back. */
  advanceTo(atMs: number): void {
    this.clock = Math.max(this.clock, atMs);
  }

  /** Feeds one input at the current clock; `false` once a violation stopped the driver. */
  feed(body: KitInputBody): boolean {
    return this.stepOf(body) !== undefined;
  }

  /** Feeds one input; its recorded step, or `undefined` when a violation stopped the driver. */
  private stepOf(body: KitInputBody): KitStep<State> | undefined {
    const state = this.current;
    if (state === undefined || this.stopped) return undefined;
    const now = this.clock;
    const input: MachineInput = { ...body, atMs: now, at: new Date(now).toISOString() };
    const found = stepChecked(this.machine, state, input);
    if (typeof found === 'string') {
      this.violations.push(`${body.type}: ${found}`);
      return undefined;
    }
    const recorded = this.tracker.record(found.effects, now);
    const step: KitStep<State> = { input, effects: found.effects, state: found.state };
    this.steps.push(step);
    this.current = found.state;
    for (const message of recorded) this.violations.push(`${body.type}: ${message}`);
    return recorded.length === 0 ? step : undefined;
  }

  /** `cmd.send` of a turn that the contract then expects to settle exactly once. */
  send(turnId: string, content: JsonValue): boolean {
    if (this.stopped) return false;
    this.tracker.known.add(turnId);
    this.tracker.stepSend = turnId;
    const fed = this.feed({ type: 'cmd.send', turnId, content });
    this.tracker.stepSend = undefined;
    return fed;
  }

  /** `cmd.permission` for a pending ask; `true` without a step when it is not pending. */
  answer(requestId: string, decision: JsonObject): boolean {
    if (this.stopped) return false;
    if (!this.tracker.endAsk(requestId)) return true;
    return this.feed({ type: 'cmd.permission', requestId, decision });
  }

  /** `cmd.permission-abort` for a pending ask; `true` without a step when it is not pending. */
  abortAsk(requestId: string): boolean {
    if (this.stopped) return false;
    if (!this.tracker.endAsk(requestId)) return true;
    return this.feed({ type: 'cmd.permission-abort', requestId });
  }

  /**
   * `cmd.permission-error` for a pending ask; `true` without a step when it
   * is not pending. The contract requires a fail-closed answer: the step
   * must resolve the ask as a deny (a `permission.resolved` event for it
   * with behavior `deny`) and never as an allow; anything else is a
   * violation (a machine that ignores the input included).
   */
  permissionError(requestId: string, reason: PermissionErrorReason): boolean {
    if (this.stopped) return false;
    if (!this.tracker.endAsk(requestId)) return true;
    const step = this.stepOf({ type: 'cmd.permission-error', requestId, reason });
    if (step === undefined) return false;
    // The step passed the trace checks: every event effect carries an event object.
    const behaviors = step.effects
      .filter((effect) => effect.type === 'event')
      .map((effect) => field(effect, 'event') as object)
      .filter(
        (event) =>
          field(event, 'type') === 'permission.resolved' && field(event, 'requestId') === requestId,
      )
      .map((event) => field(event, 'behavior'));
    if (behaviors.length === 1 && behaviors[0] === 'deny') return true;
    this.violations.push(
      `cmd.permission-error: permission ${requestId} not resolved as one deny (fail closed): ${JSON.stringify(behaviors)}`,
    );
    return false;
  }

  /**
   * Moves the clock to an armed timer's deadline (never back) and fires it;
   * `true` without a step when the timer is not armed.
   */
  fireTimer(name: string): boolean {
    if (this.stopped) return false;
    const deadline = this.tracker.armed.get(name);
    if (deadline === undefined) return true;
    this.advanceTo(deadline);
    this.tracker.armed.delete(name);
    return this.feed({ type: 'timer', name });
  }
}

/**
 * Runs a machine through prelude, actions and finale with a fake clock and
 * checks the contract on every step.
 */
export function runMachine<State, Config>(
  machine: KitMachine<State, Config>,
  config: Config,
  actions: readonly KitAction[],
  options: RunMachineOptions = {},
): MachineRun<State> {
  const driver = new KitDriver(machine, config, options);
  const sent: string[] = [];
  let correlations = 0;

  const perform = (action: KitAction): boolean => {
    switch (action.kind) {
      case 'input':
        return driver.feed(action.input);
      case 'line':
        return driver.feed({
          type: 'line',
          text: action.text,
          bytes: Buffer.byteLength(action.text),
        });
      case 'send': {
        const turnId = `turn-${String(sent.length + 1)}`;
        sent.push(turnId);
        return driver.send(turnId, action.content);
      }
      case 'interrupt': {
        correlations += 1;
        const correlation = `corr-${String(correlations)}`;
        const turnId = action.target < 0 ? undefined : pick(sent, action.target);
        return driver.feed(
          turnId === undefined
            ? { type: 'cmd.interrupt', cancelQueued: action.cancelQueued, correlation }
            : { type: 'cmd.interrupt', turnId, cancelQueued: action.cancelQueued, correlation },
        );
      }
      case 'set-mode':
        correlations += 1;
        return driver.feed({
          type: 'cmd.set-permission-mode',
          mode: action.mode,
          correlation: `corr-${String(correlations)}`,
        });
      case 'answer':
      case 'abort-ask':
      case 'fail-ask': {
        const requestId = pick(driver.pendingAsks, action.target);
        if (requestId === undefined) return true;
        if (action.kind === 'answer') return driver.answer(requestId, action.decision);
        return action.kind === 'abort-ask'
          ? driver.abortAsk(requestId)
          : driver.permissionError(requestId, action.reason);
      }
      case 'fire-timer': {
        const timer = pick(driver.timers, action.target);
        return timer === undefined || driver.fireTimer(timer[0]);
      }
      case 'advance':
        driver.advance(action.ms);
        return true;
    }
  };

  const outcome = (): MachineRun<State> => ({
    steps: driver.steps,
    violations: driver.violations,
    ended: driver.ended,
  });
  if (driver.stopped) return outcome();
  const script: (() => boolean)[] = [
    ...(options.prelude ?? DEFAULT_PRELUDE).map((body) => () => driver.feed(body)),
    ...actions.map((action) => () => perform(action)),
    ...(options.finale ?? DEFAULT_FINALE).map((body) => () => driver.feed(body)),
  ];
  for (const run of script) {
    if (!run()) return outcome();
  }
  if (options.requireEnd !== false && !driver.ended) {
    driver.violations.push('the session did not end after the finale');
  }
  return outcome();
}

/** The element at `index` modulo the length; `undefined` when empty. */
function pick<T>(items: readonly T[], index: number): T | undefined {
  return items.length === 0 ? undefined : items[index % items.length];
}

/**
 * Calls `step` and checks it: no throw, JSON-stable output, input state not
 * mutated, deterministic. Returns the output or the violation.
 */
function stepChecked<State, Config>(
  machine: KitMachine<State, Config>,
  state: State,
  input: MachineInput,
): { readonly state: State; readonly effects: readonly KitEffect[] } | string {
  // The state is JSON-stable here: the initial state and every step output are checked.
  const snapshot = JSON.stringify(state);
  let first: { readonly state: State; readonly effects: readonly KitEffect[] };
  let second: unknown;
  try {
    first = machine.step(state, input);
    second = machine.step(JSON.parse(snapshot) as State, input);
  } catch (error) {
    return `step threw: ${String(error)}`;
  }
  if (!jsonStable(first)) return 'step output is not JSON-stable';
  if (JSON.stringify(state) !== snapshot) return 'step mutated its input state';
  // Compared as JSON: the replay ran on a plain copy of the state.
  if (!sameAfterRoundTrip(second, JSON.parse(JSON.stringify(first)))) {
    return 'step is not deterministic';
  }
  return first;
}

// ---- property ---------------------------------------------------------------------

/** Options of {@link assertMachineContract}. */
export interface MachineContractOptions<Config> extends RunMachineOptions, MachineActionOptions {
  /** The machine configuration, or an arbitrary of configurations to explore. */
  readonly config: Config | fc.Arbitrary<Config>;
  /** Replaces the generated interleavings entirely. */
  readonly actions?: fc.Arbitrary<readonly KitAction[]>;
  /** Default 200; plan §4.2 asks 2000 or more on CI for the session machine. */
  readonly numRuns?: number;
  /** Default: `FC_SEED` from the environment, else a fresh seed. */
  readonly seed?: number;
  /** Receives the seed before the run, so a CI log reproduces it. */
  readonly log?: (message: string) => void;
}

/** The seed of a run: explicit, else `FC_SEED`, else fresh. */
export function resolveSeed(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const env = process.env['FC_SEED'];
  if (env !== undefined && env !== '' && Number.isSafeInteger(Number(env))) return Number(env);
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) | 0;
}

/**
 * Asserts the contract invariants with fast-check: throws the shrunk
 * counterexample with its violations and seed when one fails.
 */
export function assertMachineContract<State, Config>(
  machine: KitMachine<State, Config>,
  options: MachineContractOptions<Config>,
): void {
  const seed = resolveSeed(options.seed);
  options.log?.(`machine-kit: seed ${String(seed)} (FC_SEED=${String(seed)} reproduces)`);
  const actions = options.actions ?? machineActions(options);
  const configs: fc.Arbitrary<Config> =
    options.config instanceof fc.Arbitrary ? options.config : fc.constant(options.config);
  fc.assert(
    fc.property(configs, actions, (config, list) => {
      const run = runMachine(machine, config, list, options);
      if (run.violations.length > 0) throw new Error(run.violations.join('\n'));
    }),
    { numRuns: options.numRuns ?? 200, seed, includeErrorInReport: true },
  );
}

// ---- reference machine ------------------------------------------------------------

/** Configuration of {@link referenceMachine}. */
export interface ReferenceConfig {
  readonly sessionId: string;
  readonly handshakeTimeoutMs: number;
  readonly closeTimeoutMs: number;
}

/** Why the reference machine is ending the process. */
export type ReferenceIntent = 'none' | 'close' | 'close-timeout' | 'abort' | 'dispose' | 'watchdog';

/** State of {@link referenceMachine}: plain JSON. */
export interface ReferenceState {
  readonly config: ReferenceConfig;
  readonly phase: 'spawning' | 'handshake' | 'ready' | 'ended';
  readonly pid: number;
  /** `seq` of the next event. */
  readonly seq: number;
  readonly stdinOpen: boolean;
  readonly active: string | null;
  readonly queued: readonly string[];
  readonly asks: readonly string[];
  /** Number of permission requests so far; request ids are `ref_<n>`. */
  readonly requests: number;
  readonly timers: readonly string[];
  readonly intent: ReferenceIntent;
}

/** An effect with its fields. */
function fx(type: string, fields: JsonObject = {}): KitEffect {
  return { ...fields, type };
}

function errorData(code: string, retryable: boolean): JsonObject {
  return { code, message: code.toLowerCase().replaceAll('_', ' '), retryable };
}

/** A mutable draft of one step of the reference machine; `commit` returns JSON state. */
class Draft {
  readonly effects: KitEffect[] = [];
  readonly prior: ReferenceState;
  readonly at: string;
  phase: ReferenceState['phase'];
  pid: number;
  seq: number;
  stdinOpen: boolean;
  active: string | null;
  queued: string[];
  asks: string[];
  requests: number;
  timers: string[];
  intent: ReferenceIntent;

  constructor(prior: ReferenceState, at: string) {
    this.prior = prior;
    this.at = at;
    this.phase = prior.phase;
    this.pid = prior.pid;
    this.seq = prior.seq;
    this.stdinOpen = prior.stdinOpen;
    this.active = prior.active;
    this.queued = [...prior.queued];
    this.asks = [...prior.asks];
    this.requests = prior.requests;
    this.timers = [...prior.timers];
    this.intent = prior.intent;
  }

  commit(): { state: ReferenceState; effects: KitEffect[] } {
    const state: ReferenceState = {
      config: this.prior.config,
      phase: this.phase,
      pid: this.pid,
      seq: this.seq,
      stdinOpen: this.stdinOpen,
      active: this.active,
      queued: this.queued,
      asks: this.asks,
      requests: this.requests,
      timers: this.timers,
      intent: this.intent,
    };
    return { state, effects: this.effects };
  }

  get sessionId(): string {
    return this.prior.config.sessionId;
  }

  event(type: string, fields: JsonObject): void {
    const event = { ...fields, type, seq: this.seq, ts: this.at, sessionId: this.sessionId };
    this.effects.push(fx('event', { event }));
    this.seq += 1;
  }

  write(message: JsonObject): void {
    if (this.stdinOpen) this.effects.push(fx('write', { line: `${JSON.stringify(message)}\n` }));
  }

  endStdin(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    this.effects.push(fx('stdin.end'));
  }

  setTimer(name: string, ms: number): void {
    this.timers.push(name);
    this.effects.push(fx('timer.set', { name, ms }));
  }

  clearTimer(name: string): void {
    if (!this.timers.includes(name)) return;
    this.timers = this.timers.filter((other) => other !== name);
    this.effects.push(fx('timer.clear', { name }));
  }

  startTurn(turnId: string): void {
    this.active = turnId;
    this.write({ type: 'user', turnId });
    this.event('turn.started', { turnId, origin: 'application', features: [], raw: null });
  }

  /** Starts the oldest queued turn when the harness can take it. */
  startNext(): void {
    const next = this.queued[0];
    if (next === undefined || !this.stdinOpen) return;
    this.queued.shift();
    this.startTurn(next);
  }

  settle(turnId: string, outcome: string, synthesized: boolean): void {
    const isError = outcome === 'error';
    const result = {
      turnId,
      sessionId: this.sessionId,
      outcome,
      isError,
      permissionDenials: [],
      synthesized,
    };
    this.effects.push(fx('turn.settle', { turnId, result }));
    this.event('turn.completed', { turnId, result });
  }

  fail(turnId: string, code: string, retryable: boolean): void {
    this.effects.push(fx('turn.fail', { turnId, error: errorData(code, retryable) }));
  }

  cancelAsks(reason: 'harness' | 'close' | 'abort'): void {
    for (const requestId of this.asks) {
      this.effects.push(fx('permission.cancel', { requestId, reason }));
      this.event('permission.resolved', { requestId, behavior: 'cancelled', by: reason });
    }
    this.asks = [];
  }

  /** Answers a control command: settled when the harness can take it, refused otherwise. */
  control(correlation: string, act: () => void): void {
    if (this.stdinOpen && this.phase === 'ready') {
      act();
      this.effects.push(fx('control.settle', { correlation, ok: true, response: null }));
    } else {
      const error = errorData('SESSION_CLOSED', false);
      this.effects.push(fx('control.settle', { correlation, ok: false, error }));
    }
  }

  /** Settles everything still open and emits `session.end`. */
  end(outcome: string): void {
    for (const turnId of this.queued) this.fail(turnId, 'SESSION_CLOSED', false);
    this.queued = [];
    this.cancelAsks(
      this.intent === 'none' ? 'harness' : this.intent === 'close' ? 'close' : 'abort',
    );
    for (const name of [...this.timers]) this.clearTimer(name);
    this.effects.push(fx('session.end', { outcome }));
    this.phase = 'ended';
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a reference wire line into an object; `undefined` when it is not one. */
function parseLine(text: string): JsonObject | undefined {
  try {
    const value = JSON.parse(text) as JsonValue;
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A trivial neutral machine over a toy line protocol, for kit and driver
 * tests. On `process.started` it writes `{"type":"hello"}` and arms the
 * `handshake` timer until `{"type":"ready","version":...}` arrives; turns run
 * one at a time and settle on `{"type":"result","isError":...}`;
 * `{"type":"ask","toolName":...}` asks a permission during a turn and
 * `{"type":"cancel-ask"}` cancels the oldest; other lines become
 * `harness.frame` events. `cmd.close` ends stdin and arms the `close` timer;
 * the session ends on `process.exit` or a spawn error.
 */
export const referenceMachine: KitMachine<ReferenceState, ReferenceConfig> = {
  initialState: (config) => ({
    config,
    phase: 'spawning',
    pid: 0,
    seq: 0,
    stdinOpen: true,
    active: null,
    queued: [],
    asks: [],
    requests: 0,
    timers: [],
    intent: 'none',
  }),
  step: (state, input) => {
    if (state.phase === 'ended') return { state, effects: [] };
    const draft = new Draft(state, input.at);
    referenceStep(draft, input);
    return draft.commit();
  },
};

function referenceStep(d: Draft, input: MachineInput): void {
  const { config } = d.prior;
  switch (input.type) {
    case 'process.started':
      if (d.phase !== 'spawning') return;
      d.phase = 'handshake';
      d.pid = input.pid;
      d.write({ type: 'hello' });
      d.setTimer('handshake', config.handshakeTimeoutMs);
      return;
    case 'process.spawn-error':
      if (d.phase !== 'spawning') return;
      d.effects.push(fx('handshake.fail', { error: errorData('SPAWN_FAILED', false) }));
      d.end('failed');
      return;
    case 'line':
      referenceLine(d, input.text);
      return;
    case 'line.oversized':
      d.event('diagnostic', {
        code: 'frame.skipped-oversized',
        message: 'skipped an oversized line',
        data: { bytes: input.bytes },
      });
      return;
    case 'stdin.error':
      d.stdinOpen = false;
      d.event('diagnostic', { code: 'stdin.error', message: input.code });
      return;
    case 'timer':
      referenceTimer(d, input.name);
      return;
    case 'process.exit':
      referenceExit(d, input.code, input.signal);
      return;
    case 'cmd.send':
      if (!d.stdinOpen) {
        d.fail(input.turnId, 'SESSION_CLOSED', false);
      } else {
        d.queued.push(input.turnId);
        d.event('turn.queued', { turnId: input.turnId });
        if (d.phase === 'ready' && d.active === null) d.startNext();
      }
      return;
    case 'cmd.interrupt':
      d.control(input.correlation, () => {
        d.write({ type: 'interrupt' });
        if (!input.cancelQueued) return;
        for (const turnId of d.queued) d.settle(turnId, 'cancelled', true);
        d.queued = [];
      });
      return;
    case 'cmd.set-permission-mode':
      d.control(input.correlation, () => {
        d.write({ type: 'mode', mode: input.mode });
      });
      return;
    case 'cmd.permission':
    case 'cmd.permission-abort': {
      if (!d.asks.includes(input.requestId)) return;
      d.asks = d.asks.filter((id) => id !== input.requestId);
      const answered = input.type === 'cmd.permission';
      const allow = answered && input.decision['behavior'] === 'allow';
      d.write({ type: 'answer', requestId: input.requestId, allow });
      d.event('permission.resolved', {
        requestId: input.requestId,
        behavior: allow ? 'allow' : answered ? 'deny' : 'cancelled',
        by: answered ? 'application' : 'abort',
      });
      return;
    }
    case 'cmd.permission-error':
      // Fail closed: the reference machine's own deny.
      if (!d.asks.includes(input.requestId)) return;
      d.asks = d.asks.filter((id) => id !== input.requestId);
      d.write({ type: 'answer', requestId: input.requestId, allow: false });
      d.event('permission.resolved', {
        requestId: input.requestId,
        behavior: 'deny',
        by: 'application',
      });
      return;
    case 'cmd.close':
      if (!d.stdinOpen || d.intent !== 'none') return;
      d.intent = 'close';
      d.cancelAsks('close');
      d.endStdin();
      d.setTimer('close', config.closeTimeoutMs);
      return;
    case 'cmd.abort':
      if (d.intent === 'abort' || d.intent === 'dispose') return;
      d.intent = input.intent;
      d.cancelAsks('abort');
      d.endStdin();
      d.clearTimer('close');
      d.effects.push(fx('ladder.start', { intent: input.intent }));
      return;
    case 'stdout.end':
    case 'stderr.line':
    case 'line.invalid-utf8':
    case 'ladder.done':
      return;
  }
}

function referenceLine(d: Draft, text: string): void {
  const frame = parseLine(text);
  if (frame === undefined) {
    d.event('diagnostic', {
      code: 'stdout.non-json-line',
      message: 'a line that is not a JSON object',
    });
    return;
  }
  const type = frame['type'];
  const oldestAsk = d.asks[0];
  if (type === 'ready' && d.phase === 'handshake') {
    d.phase = 'ready';
    d.clearTimer('handshake');
    const version = typeof frame['version'] === 'string' ? frame['version'] : 'unknown';
    const info = { id: d.sessionId, mode: 'create', pid: d.pid, version, features: [] };
    d.effects.push(fx('handshake.ok', { info }));
    d.event('session.started', { mode: 'create', pid: d.pid, version, raw: frame });
    d.startNext();
  } else if (type === 'result' && d.active !== null) {
    d.settle(d.active, frame['isError'] === true ? 'error' : 'completed', false);
    d.active = null;
    d.startNext();
  } else if (type === 'ask' && d.active !== null && d.stdinOpen) {
    d.requests += 1;
    const requestId = `ref_${String(d.requests)}`;
    const toolUseId = `use_${String(d.requests)}`;
    const toolName = typeof frame['toolName'] === 'string' ? frame['toolName'] : 'tool';
    const turnId = d.active;
    d.asks.push(requestId);
    const request = {
      requestId,
      sessionId: d.sessionId,
      turnId,
      toolName,
      toolUseId,
      input: null,
      suggestions: [],
      raw: frame,
    };
    d.effects.push(fx('permission.ask', { requestId, request }));
    d.event('permission.requested', { requestId, turnId, toolName, toolUseId, raw: frame });
  } else if (type === 'cancel-ask' && oldestAsk !== undefined) {
    d.asks.shift();
    d.effects.push(fx('permission.cancel', { requestId: oldestAsk, reason: 'harness' }));
    d.event('permission.resolved', { requestId: oldestAsk, behavior: 'cancelled', by: 'harness' });
  } else {
    d.event('harness.frame', {
      frameType: typeof type === 'string' ? type : 'unknown',
      raw: frame,
    });
  }
}

function referenceTimer(d: Draft, name: string): void {
  if (!d.timers.includes(name)) return;
  d.timers = d.timers.filter((other) => other !== name);
  if (name === 'handshake') {
    d.intent = 'watchdog';
    d.effects.push(fx('handshake.fail', { error: errorData('HANDSHAKE_TIMEOUT', true) }));
    d.endStdin();
    d.effects.push(fx('ladder.start', { intent: 'watchdog' }));
  } else {
    d.intent = 'close-timeout';
    d.effects.push(fx('ladder.start', { intent: 'close-timeout' }));
  }
}

function referenceExit(d: Draft, code: number | null, signal: string | null): void {
  const requested = d.intent === 'abort' || d.intent === 'dispose' || d.intent === 'close-timeout';
  if (d.phase === 'handshake' && d.intent !== 'watchdog') {
    d.effects.push(fx('handshake.fail', { error: errorData('HANDSHAKE_FAILED', true) }));
  }
  let outcome: string;
  if (requested) outcome = 'aborted';
  else if (d.intent === 'watchdog') outcome = 'failed';
  else outcome = code === 0 && signal === null && d.active === null ? 'closed' : 'unknown';
  if (d.active !== null) {
    if (requested) d.settle(d.active, 'cancelled', true);
    else d.fail(d.active, 'PROCESS_EXITED', true);
    d.active = null;
  }
  d.event('session.terminated', { intent: d.intent, outcome });
  d.end(outcome);
}
