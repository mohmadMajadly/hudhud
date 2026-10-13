/**
 * Claude Code turn bookkeeping and interrupt gating (plan §1.5, ADR-0008
 * "Turns and interrupts").
 *
 * @remarks
 * A pure sub-machine: `(state, input) -> (state, effects)`, JSON in and out,
 * no clock, no randomness, no I/O (ADR-0006). The session machine (W3-T1)
 * composes it onto the neutral contract; until then it has its own input and
 * effect types. Ids are deterministic: application turn ids are the user
 * message `uuid` supplied by the binding, harness-originated turns are
 * `bg-<n>`, interrupt writes are `int-<n>` (mapped to control request ids by
 * the composing machine).
 *
 * Rules:
 *
 * - `send` creates a `queued` turn and emits the user frame write with its
 *   `uuid` (ADR-0008 §4).
 * - Turn start: `command_lifecycle` `state:"started"` with `command_uuid`
 *   once `msg_lifecycle_v1` was seen; otherwise the next `system/init` starts
 *   the oldest queued turn. A `system/init` belongs to the oldest started turn
 *   that has not seen one yet; with no such turn and no queued turn it starts
 *   a harness-originated turn `bg-<n>` (background shell after EOF, 07 §7).
 * - Dropped message (research 10 §3): a `command_lifecycle` frame is
 *   correlated strictly by `command_uuid` with an application turn, before
 *   or after `system/init` (the frame itself proves the lifecycle feature),
 *   and its state is recorded on the turn. `completed` for a turn that is
 *   still `queued` and never reported `started` means the harness dropped
 *   the message (Claude Code 2.1.296 does so for a `uuid` the session
 *   transcript already holds): the turn fails with `TURN_DROPPED` and
 *   diagnostic `turn.dropped` carries the observed states. Every other turn
 *   is untouched. A `result` naming the turn first settles it, so a later
 *   `completed` finds no turn; a `result` after the drop matches no turn
 *   (`turn.unmatched-result`). A message merged into another turn reports
 *   `started` before `completed` (recorded with 2.1.296), so it is never
 *   taken for a drop.
 * - Interrupt gating (GH#98713, D5): an interrupt of a turn whose
 *   `system/init` has not been observed is held and written in the step that
 *   observes it, never in the step of the user frame write. Held interrupts
 *   of one turn merge (`cancel_queued` is OR-ed). An interrupt of a settled
 *   or unknown turn is a no-op. An interrupt without a turn id is
 *   session-wide (abort ladder) and is written at once.
 * - If the interrupt response's `still_queued` names the target after its
 *   `system/init`, the interrupt is re-sent once after
 *   {@link INTERRUPT_RETRY_DELAY_MS} and `interrupt.still-queued-retry` is
 *   reported (05 §7).
 * - Turn end: a `result` whose `user_message_uuid(s)` name unsettled turns
 *   settles those turns; a `result` without them settles the oldest started
 *   turn. `session_state_changed` `idle` synthesizes the end of every started
 *   turn; `end` (process exit, decided by the composing machine) settles or
 *   fails every remaining turn. A `cancelled` list in an interrupt response
 *   settles the named queued turns. Every turn terminates exactly once.
 * - Outcomes, `isError` and the stop reason of an observed `result` frame
 *   come from `classifyResult` (`../events/normalize.ts`), the one mapping of
 *   result frames (an `aborted*` `terminal_reason` is `cancelled`); an error
 *   result is a `TurnResult`, never a failure (K21), the raw frame kept.
 *   Results hudhud synthesizes (idle, `cancelled` list, end) are built here
 *   and always carry `isError: true`.
 *
 * @packageDocumentation
 */

import {
  isJsonObject,
  makeErrorData,
  ownArray,
  ownNumber,
  ownObject,
  ownString,
  type ErrorData,
  type JsonObject,
  type JsonValue,
  type TurnResult,
  type UsageTotals,
} from '@hudhud/core/protocol';

import { classifyResult } from '../events/normalize.js';

/**
 * Delay before the single re-send of an interrupt whose response still lists
 * its turn as queued (05 §7: a 50 ms gap after `system/init` avoids
 * GH#98713).
 *
 * @internal
 */
export const INTERRUPT_RETRY_DELAY_MS = 50;

/**
 * The `system/init` capability that announces `command_lifecycle` frames.
 *
 * @internal
 */
export const LIFECYCLE_CAPABILITY = 'msg_lifecycle_v1';

/**
 * Most lifecycle states kept per turn (evidence for `turn.dropped`; the
 * frames come from the harness, so the record is bounded).
 *
 * @internal
 */
export const MAX_LIFECYCLE_STATES = 16;

/**
 * Prefix of the retry timer names (`turn.interrupt-retry:<interruptId>`).
 *
 * @internal
 */
export const INTERRUPT_RETRY_TIMER_PREFIX = 'turn.interrupt-retry:';

/**
 * Who started a turn.
 *
 * @internal
 */
export type TurnOrigin = 'application' | 'harness';

/**
 * The phase of an unsettled turn. Settled turns leave the table.
 *
 * @internal
 */
export type TurnPhase = 'queued' | 'started' | 'interrupting';

/**
 * Interrupts of one turn held until its `system/init`.
 *
 * @internal
 */
export interface HeldInterrupt {
  readonly cancelQueued: boolean;
  readonly correlations: readonly string[];
}

/**
 * One unsettled turn.
 *
 * @internal
 */
export interface TurnEntry {
  readonly turnId: string;
  readonly origin: TurnOrigin;
  readonly phase: TurnPhase;
  readonly initSeen: boolean;
  readonly pendingInterrupt?: HeldInterrupt;
  /**
   * The `command_lifecycle` states reported for this turn's `uuid`, in order
   * (at most {@link MAX_LIFECYCLE_STATES}; absent until the first one).
   */
  readonly lifecycleStates?: readonly string[];
  /** A `command_lifecycle` `started` was reported for it. */
  readonly lifecycleStarted?: true;
}

/**
 * An interrupt that was written and not yet answered, or whose re-send is
 * waiting for its timer.
 *
 * @internal
 */
export interface InflightInterrupt {
  readonly interruptId: string;
  /** Absent for a session-wide interrupt. */
  readonly turnId?: string;
  readonly cancelQueued: boolean;
  readonly correlations: readonly string[];
  /** True once re-sent (or for session-wide interrupts): no further retry. */
  readonly retried: boolean;
  /** True while the retry timer runs. */
  readonly waitingRetry: boolean;
}

/**
 * Turn machine configuration (JSON).
 *
 * @internal
 */
export interface TurnMachineConfig {
  /** The session id reported in every `TurnResult`. */
  readonly sessionId: string;
}

/**
 * Turn machine state (JSON).
 *
 * @internal
 */
export interface TurnMachineState {
  readonly sessionId: string;
  /** Unsettled turns in FIFO order. */
  readonly turns: readonly TurnEntry[];
  readonly inflight: readonly InflightInterrupt[];
  /** The last `system/init.capabilities`. */
  readonly features: readonly string[];
  /** The last `system/init.model`. */
  readonly model?: string;
  /** `msg_lifecycle_v1` was seen. */
  readonly lifecycle: boolean;
  readonly nextBg: number;
  readonly nextInterrupt: number;
  readonly stdinOpen: boolean;
  readonly ended: boolean;
  /** The failure every later `send` gets, when `end` failed the turns. */
  readonly endError?: ErrorData;
}

/**
 * How `end` terminates the remaining turns: settle them with a synthesized
 * outcome or fail them (plan §3.3, decided by the composing machine).
 *
 * @internal
 */
export type TurnEndDisposition =
  | { readonly kind: 'settle'; readonly outcome: 'cancelled' | 'error' }
  | { readonly kind: 'fail'; readonly error: ErrorData };

/**
 * Inputs of the turn machine.
 *
 * @internal
 */
export type TurnInput =
  /** A host send; `turnId` is the user message `uuid`. */
  | { readonly type: 'send'; readonly turnId: string; readonly content: JsonValue }
  /** `turnId` absent: session-wide, written at once. */
  | {
      readonly type: 'interrupt';
      readonly turnId?: string;
      readonly cancelQueued: boolean;
      readonly correlation: string;
    }
  /** A conversation frame (`system`, `command_lifecycle`, `result`, ...). */
  | { readonly type: 'frame'; readonly frame: JsonObject }
  | {
      readonly type: 'interrupt.response';
      readonly interruptId: string;
      readonly ok: true;
      readonly response?: JsonObject;
    }
  | {
      readonly type: 'interrupt.response';
      readonly interruptId: string;
      readonly ok: false;
      readonly error: string;
    }
  | { readonly type: 'timer'; readonly name: string }
  /** hudhud closed stdin: nothing more can be written. */
  | { readonly type: 'stdin.closed' }
  /** The process ended: every remaining turn terminates. */
  | { readonly type: 'end'; readonly disposition: TurnEndDisposition };

/**
 * Effects of the turn machine.
 *
 * @internal
 */
export type TurnEffect =
  | { readonly type: 'write.user'; readonly turnId: string; readonly content: JsonValue }
  | {
      readonly type: 'write.interrupt';
      readonly interruptId: string;
      readonly cancelQueued: boolean;
      readonly turnId?: string;
    }
  | { readonly type: 'timer.set'; readonly name: string; readonly ms: number }
  | { readonly type: 'timer.clear'; readonly name: string }
  | { readonly type: 'turn.queued'; readonly turnId: string }
  | {
      readonly type: 'turn.started';
      readonly turnId: string;
      readonly origin: TurnOrigin;
      readonly features: readonly string[];
      readonly model?: string;
      readonly raw: JsonValue;
    }
  | { readonly type: 'turn.settle'; readonly turnId: string; readonly result: TurnResult }
  | { readonly type: 'turn.fail'; readonly turnId: string; readonly error: ErrorData }
  /** A send refused without creating a turn (invalid or duplicate id). */
  | { readonly type: 'send.rejected'; readonly turnId: string; readonly error: ErrorData }
  | { readonly type: 'interrupt.settle'; readonly correlation: string; readonly ok: true }
  | {
      readonly type: 'interrupt.settle';
      readonly correlation: string;
      readonly ok: false;
      readonly error: ErrorData;
    }
  | {
      readonly type: 'diagnostic';
      readonly code: string;
      readonly message: string;
      readonly data?: JsonObject;
    };

/**
 * One step's output.
 *
 * @internal
 */
export interface TurnStepResult {
  readonly state: TurnMachineState;
  readonly effects: readonly TurnEffect[];
}

/**
 * The initial state.
 *
 * @internal
 */
export function initialTurnState(config: TurnMachineConfig): TurnMachineState {
  return {
    sessionId: config.sessionId,
    turns: [],
    inflight: [],
    features: [],
    lifecycle: false,
    nextBg: 1,
    nextInterrupt: 1,
    stdinOpen: true,
    ended: false,
  };
}

/** Mutable working copy of one step. */
interface Draft {
  readonly sessionId: string;
  turns: TurnEntry[];
  inflight: InflightInterrupt[];
  features: readonly string[];
  model: string | undefined;
  lifecycle: boolean;
  nextBg: number;
  nextInterrupt: number;
  stdinOpen: boolean;
  ended: boolean;
  endError: ErrorData | undefined;
  readonly effects: TurnEffect[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a `send` with `turnId` would be refused for its id: not a UUID, or
 * the id of a turn that is still live. Such a send is rejected as a command
 * (`send.rejected`) and never touches the live turn.
 *
 * @internal
 */
export function sendIdRefused(state: TurnMachineState, turnId: string): boolean {
  return !UUID.test(turnId) || state.turns.some((turn) => turn.turnId === turnId);
}

/**
 * Advances the turn machine by one input.
 *
 * @internal
 */
export function turnStep(state: TurnMachineState, input: TurnInput): TurnStepResult {
  const d: Draft = {
    sessionId: state.sessionId,
    turns: [...state.turns],
    inflight: [...state.inflight],
    features: state.features,
    model: state.model,
    lifecycle: state.lifecycle,
    nextBg: state.nextBg,
    nextInterrupt: state.nextInterrupt,
    stdinOpen: state.stdinOpen,
    ended: state.ended,
    endError: state.endError,
    effects: [],
  };
  switch (input.type) {
    case 'send':
      onSend(d, input.turnId, input.content);
      break;
    case 'interrupt':
      onInterrupt(d, input.turnId, input.cancelQueued, input.correlation);
      break;
    case 'frame':
      if (!d.ended) onFrame(d, input.frame);
      break;
    case 'interrupt.response':
      onInterruptResponse(d, input);
      break;
    case 'timer':
      onTimer(d, input.name);
      break;
    case 'stdin.closed':
      onStdinClosed(d);
      break;
    case 'end':
      onEnd(d, input.disposition);
      break;
  }
  return { state: freeze(d), effects: d.effects };
}

function freeze(d: Draft): TurnMachineState {
  const base = {
    sessionId: d.sessionId,
    turns: d.turns,
    inflight: d.inflight,
    features: d.features,
    lifecycle: d.lifecycle,
    nextBg: d.nextBg,
    nextInterrupt: d.nextInterrupt,
    stdinOpen: d.stdinOpen,
    ended: d.ended,
  };
  const withModel = d.model === undefined ? base : { ...base, model: d.model };
  return d.endError === undefined ? withModel : { ...withModel, endError: d.endError };
}

// ---- commands -----------------------------------------------------------------

function onSend(d: Draft, turnId: string, content: JsonValue): void {
  // The id check comes first: a refused id must never produce a `turn.fail`,
  // which would name (and end) a live turn with the same id.
  if (!UUID.test(turnId) || findTurn(d, turnId) !== undefined) {
    d.effects.push({
      type: 'send.rejected',
      turnId,
      error: makeErrorData('PROTOCOL_ERROR', 'turn id must be a fresh UUID'),
    });
    return;
  }
  if (d.ended || !d.stdinOpen) {
    d.effects.push({ type: 'turn.fail', turnId, error: d.endError ?? sessionClosed() });
    return;
  }
  d.turns.push({ turnId, origin: 'application', phase: 'queued', initSeen: false });
  d.effects.push({ type: 'write.user', turnId, content }, { type: 'turn.queued', turnId });
}

function onInterrupt(
  d: Draft,
  turnId: string | undefined,
  cancelQueued: boolean,
  correlation: string,
): void {
  const turn = turnId === undefined ? undefined : findTurn(d, turnId);
  if (d.ended || (turnId !== undefined && turn === undefined)) {
    // The target already terminated (or never existed): nothing to interrupt.
    settleCorrelations(d, [correlation]);
    return;
  }
  if (!d.stdinOpen) {
    failCorrelations(d, [correlation], sessionClosed());
    return;
  }
  if (turn === undefined) {
    // Session-wide (abort ladder): written at once, no retry.
    for (const entry of d.turns) {
      if (entry.phase === 'started') replaceTurn(d, { ...entry, phase: 'interrupting' });
    }
    writeInterrupt(d, undefined, cancelQueued, [correlation], true);
    return;
  }
  if (!turn.initSeen) {
    const held = turn.pendingInterrupt;
    replaceTurn(d, {
      ...turn,
      pendingInterrupt: {
        cancelQueued: cancelQueued || held?.cancelQueued === true,
        correlations: [...(held?.correlations ?? []), correlation],
      },
    });
    return;
  }
  writeInterrupt(d, turn.turnId, cancelQueued, [correlation], false);
}

// ---- frames -------------------------------------------------------------------

function onFrame(d: Draft, frame: JsonObject): void {
  const type = ownString(frame, 'type');
  if (type === 'result') {
    onResult(d, frame);
  } else if (type === 'system') {
    const subtype = ownString(frame, 'subtype');
    if (subtype === 'init') onInit(d, frame);
    else if (subtype === 'session_state_changed' && ownString(frame, 'state') === 'idle') {
      onIdle(d, frame);
    }
  } else if (type === 'command_lifecycle') {
    onLifecycle(d, frame);
  }
}

/**
 * A `command_lifecycle` frame: recorded on the application turn its
 * `command_uuid` names (strict correlation, before or after `system/init`).
 * `started` starts a queued turn once `msg_lifecycle_v1` was seen (before
 * that, `system/init` starts it with its capabilities); `completed` on a
 * queued turn that never started is a dropped message.
 */
function onLifecycle(d: Draft, frame: JsonObject): void {
  const uuid = ownString(frame, 'command_uuid');
  const state = ownString(frame, 'state');
  const turn = uuid === undefined ? undefined : findTurn(d, uuid);
  if (turn?.origin !== 'application' || state === undefined) return;
  const states = turn.lifecycleStates ?? [];
  const lifecycleStates = states.length < MAX_LIFECYCLE_STATES ? [...states, state] : states;
  const recorded: TurnEntry = {
    ...turn,
    lifecycleStates,
    ...(state === 'started' ? { lifecycleStarted: true as const } : {}),
  };
  replaceTurn(d, recorded);
  if (state === 'started') {
    if (d.lifecycle && recorded.phase === 'queued') startTurn(d, recorded, false, frame);
  } else if (
    state === 'completed' &&
    recorded.phase === 'queued' &&
    recorded.lifecycleStarted !== true
  ) {
    dropTurn(d, recorded, lifecycleStates);
  }
}

/** Fails a turn whose message the harness dropped (`TURN_DROPPED`, research 10 §3). */
function dropTurn(d: Draft, turn: TurnEntry, states: readonly string[]): void {
  const lifecycle = [...states];
  d.effects.push({
    type: 'diagnostic',
    code: 'turn.dropped',
    message: 'the harness reported the user message completed without starting it; the turn fails',
    data: { turnId: turn.turnId, lifecycle },
  });
  terminateTurn(d, turn, {
    type: 'turn.fail',
    turnId: turn.turnId,
    error: makeErrorData(
      'TURN_DROPPED',
      'The harness dropped the user message without running a turn for it.',
      { turnId: turn.turnId, lifecycle },
    ),
  });
}

function onInit(d: Draft, frame: JsonObject): void {
  const capabilities = ownArray(frame, 'capabilities');
  if (capabilities !== undefined) {
    d.features = capabilities.filter((item): item is string => typeof item === 'string');
    d.lifecycle = d.features.includes(LIFECYCLE_CAPABILITY);
  }
  d.model = ownString(frame, 'model') ?? d.model;
  const awaiting = d.turns.find((turn) => turn.phase !== 'queued' && !turn.initSeen);
  if (awaiting !== undefined) {
    const current = { ...awaiting, initSeen: true };
    replaceTurn(d, current);
    releaseHeld(d, current);
    return;
  }
  const queued = d.turns.find((turn) => turn.phase === 'queued');
  if (queued !== undefined) {
    releaseHeld(d, startTurn(d, queued, true, frame));
    return;
  }
  const turnId = `bg-${String(d.nextBg)}`;
  d.nextBg += 1;
  const bg: TurnEntry = { turnId, origin: 'harness', phase: 'queued', initSeen: false };
  d.turns.push(bg);
  startTurn(d, bg, true, frame);
}

function startTurn(d: Draft, turn: TurnEntry, initSeen: boolean, raw: JsonObject): TurnEntry {
  const started: TurnEntry = { ...turn, phase: 'started', initSeen };
  replaceTurn(d, started);
  const event = {
    type: 'turn.started',
    turnId: turn.turnId,
    origin: turn.origin,
    features: d.features,
    raw,
  } as const;
  d.effects.push(d.model === undefined ? event : { ...event, model: d.model });
  return started;
}

/** Writes the interrupts held for `turn` now that its `system/init` arrived. */
function releaseHeld(d: Draft, turn: TurnEntry): void {
  const held = turn.pendingInterrupt;
  if (held === undefined) return;
  replaceTurn(d, withoutHeld(turn));
  writeInterrupt(d, turn.turnId, held.cancelQueued, held.correlations, false);
}

function onResult(d: Draft, frame: JsonObject): void {
  const uuids = [
    ownString(frame, 'user_message_uuid'),
    ...(ownArray(frame, 'user_message_uuids') ?? []),
  ].filter((item): item is string => typeof item === 'string');
  const targets =
    uuids.length > 0
      ? d.turns.filter((turn) => uuids.includes(turn.turnId))
      : d.turns.filter((turn) => turn.phase !== 'queued').slice(0, 1);
  if (targets.length === 0) {
    d.effects.push({
      type: 'diagnostic',
      code: 'turn.unmatched-result',
      message: 'a result frame matched no unsettled turn; ignored',
      data: { userMessageUuids: uuids },
    });
    return;
  }
  for (const turn of targets) settleTurn(d, turn, resultFromFrame(d.sessionId, turn, frame));
}

function onIdle(d: Draft, frame: JsonObject): void {
  for (const turn of d.turns.filter((entry) => entry.phase !== 'queued')) {
    settleTurn(
      d,
      turn,
      synthesized(
        d.sessionId,
        turn.turnId,
        turn.phase === 'interrupting' ? 'cancelled' : 'unknown',
        frame,
      ),
    );
  }
}

// ---- interrupt responses and timers ---------------------------------------------

function onInterruptResponse(
  d: Draft,
  input: Extract<TurnInput, { type: 'interrupt.response' }>,
): void {
  const entry = d.inflight.find(
    (item) => item.interruptId === input.interruptId && !item.waitingRetry,
  );
  if (entry === undefined) return;
  if (!input.ok) {
    removeInflight(d, entry);
    failCorrelations(
      d,
      entry.correlations,
      makeErrorData('CONTROL_REQUEST_FAILED', 'the harness refused the interrupt', {
        harnessError: input.error,
      }),
    );
    return;
  }
  const response = input.response ?? {};
  const cancelled = strings(ownArray(response, 'cancelled'));
  for (const turn of d.turns.filter((item) => cancelled.includes(item.turnId))) {
    settleTurn(d, turn, synthesized(d.sessionId, turn.turnId, 'cancelled', response));
  }
  const target = entry.turnId === undefined ? undefined : findTurn(d, entry.turnId);
  if (
    target !== undefined &&
    !entry.retried &&
    strings(ownArray(response, 'still_queued')).includes(target.turnId)
  ) {
    removeInflight(d, entry);
    d.inflight.push({ ...entry, waitingRetry: true });
    d.effects.push(
      {
        type: 'diagnostic',
        code: 'interrupt.still-queued-retry',
        message: 'the interrupt response still lists the turn as queued; re-sending once',
        data: { turnId: target.turnId, interruptId: entry.interruptId },
      },
      { type: 'timer.set', name: retryTimer(entry.interruptId), ms: INTERRUPT_RETRY_DELAY_MS },
    );
    return;
  }
  removeInflight(d, entry);
  settleCorrelations(d, entry.correlations);
}

function onTimer(d: Draft, name: string): void {
  const entry = d.inflight.find(
    (item) => item.waitingRetry && retryTimer(item.interruptId) === name,
  );
  if (entry === undefined) return;
  // A waiting retry exists only while its turn is unsettled and stdin is open:
  // settling the turn and closing stdin both cancel it.
  removeInflight(d, entry);
  writeInterrupt(d, entry.turnId, entry.cancelQueued, entry.correlations, true);
}

function onStdinClosed(d: Draft): void {
  if (d.ended || !d.stdinOpen) return;
  d.stdinOpen = false;
  for (const turn of d.turns) {
    const held = turn.pendingInterrupt;
    if (held === undefined) continue;
    replaceTurn(d, withoutHeld(turn));
    failCorrelations(d, held.correlations, sessionClosed());
  }
  for (const entry of d.inflight.filter((item) => item.waitingRetry)) {
    cancelRetry(d, entry);
    failCorrelations(d, entry.correlations, sessionClosed());
  }
}

function onEnd(d: Draft, disposition: TurnEndDisposition): void {
  if (d.ended) return;
  d.ended = true;
  if (disposition.kind === 'fail') d.endError = disposition.error;
  for (const turn of [...d.turns]) {
    if (disposition.kind === 'settle') {
      settleTurn(d, turn, synthesized(d.sessionId, turn.turnId, disposition.outcome, null));
    } else {
      terminateTurn(d, turn, { type: 'turn.fail', turnId: turn.turnId, error: disposition.error });
    }
  }
  // The process is gone: unanswered interrupts have nothing left to stop.
  // (Waiting retries were cancelled with their turns above.)
  for (const entry of d.inflight) settleCorrelations(d, entry.correlations);
  d.inflight = [];
}

// ---- helpers ------------------------------------------------------------------

function writeInterrupt(
  d: Draft,
  turnId: string | undefined,
  cancelQueued: boolean,
  correlations: readonly string[],
  retried: boolean,
): void {
  const interruptId = `int-${String(d.nextInterrupt)}`;
  d.nextInterrupt += 1;
  const turn = turnId === undefined ? undefined : findTurn(d, turnId);
  if (turn !== undefined) replaceTurn(d, { ...turn, phase: 'interrupting' });
  const base = { interruptId, cancelQueued, correlations, retried, waitingRetry: false };
  d.inflight.push(turnId === undefined ? base : { ...base, turnId });
  const write = { type: 'write.interrupt', interruptId, cancelQueued } as const;
  d.effects.push(turnId === undefined ? write : { ...write, turnId });
}

function settleTurn(d: Draft, turn: TurnEntry, result: TurnResult): void {
  terminateTurn(d, turn, { type: 'turn.settle', turnId: turn.turnId, result });
}

/**
 * Removes `turn` and emits its terminal effect; interrupts held for it or
 * waiting to be re-sent are resolved as no-ops (the turn is over).
 */
function terminateTurn(
  d: Draft,
  turn: TurnEntry,
  effect: Extract<TurnEffect, { type: 'turn.settle' | 'turn.fail' }>,
): void {
  d.turns = d.turns.filter((item) => item.turnId !== turn.turnId);
  d.effects.push(effect);
  settleCorrelations(d, turn.pendingInterrupt?.correlations ?? []);
  for (const entry of d.inflight.filter(
    (item) => item.waitingRetry && item.turnId === turn.turnId,
  )) {
    cancelRetry(d, entry);
    settleCorrelations(d, entry.correlations);
  }
}

function cancelRetry(d: Draft, entry: InflightInterrupt): void {
  removeInflight(d, entry);
  d.effects.push({ type: 'timer.clear', name: retryTimer(entry.interruptId) });
}

function removeInflight(d: Draft, entry: InflightInterrupt): void {
  d.inflight = d.inflight.filter((item) => item.interruptId !== entry.interruptId);
}

function settleCorrelations(d: Draft, correlations: readonly string[]): void {
  for (const correlation of correlations) {
    d.effects.push({ type: 'interrupt.settle', correlation, ok: true });
  }
}

function failCorrelations(d: Draft, correlations: readonly string[], error: ErrorData): void {
  for (const correlation of correlations) {
    d.effects.push({ type: 'interrupt.settle', correlation, ok: false, error });
  }
}

function findTurn(d: Draft, turnId: string): TurnEntry | undefined {
  return d.turns.find((turn) => turn.turnId === turnId);
}

function replaceTurn(d: Draft, next: TurnEntry): void {
  d.turns = d.turns.map((turn) => (turn.turnId === next.turnId ? next : turn));
}

function withoutHeld(turn: TurnEntry): TurnEntry {
  const next: Mutable<TurnEntry> = { ...turn };
  delete next.pendingInterrupt;
  return next;
}

function retryTimer(interruptId: string): string {
  return `${INTERRUPT_RETRY_TIMER_PREFIX}${interruptId}`;
}

function sessionClosed(): ErrorData {
  return makeErrorData('SESSION_CLOSED', 'stdin is closed; nothing more can be written');
}

function strings(values: readonly JsonValue[] | undefined): string[] {
  return (values ?? []).filter((item): item is string => typeof item === 'string');
}

// ---- result mapping -------------------------------------------------------------

/** The `TurnResult` of an observed `result` frame (classification: `classifyResult`). */
function resultFromFrame(sessionId: string, turn: TurnEntry, frame: JsonObject): TurnResult {
  const { outcome, isError, stopReason } = classifyResult(frame);
  const result: Mutable<TurnResult> = {
    turnId: turn.turnId,
    sessionId,
    outcome,
    isError,
    permissionDenials: denialsOf(frame),
    synthesized: false,
    raw: frame,
  };
  const text = ownString(frame, 'result');
  if (text !== undefined) result.text = text;
  if (stopReason !== undefined) result.stopReason = stopReason;
  const terminalReason = ownString(frame, 'terminal_reason');
  if (terminalReason !== undefined) result.terminalReason = terminalReason;
  const errors = ownArray(frame, 'errors');
  if (errors !== undefined) result.errors = strings(errors);
  const apiErrorStatus = ownNumber(frame, 'api_error_status');
  if (apiErrorStatus !== undefined) result.apiErrorStatus = apiErrorStatus;
  const usage = usageOf(frame);
  if (usage !== undefined) result.usage = usage;
  return result;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const USAGE_FIELDS: readonly (readonly [string, keyof UsageTotals])[] = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
];

function usageOf(frame: JsonObject): UsageTotals | undefined {
  const usage: Mutable<UsageTotals> = {};
  const reported = ownObject(frame, 'usage') ?? {};
  for (const [wire, name] of USAGE_FIELDS) {
    const value = ownNumber(reported, wire);
    if (isCount(value)) usage[name] = value;
  }
  const cost = ownNumber(frame, 'total_cost_usd');
  if (isCount(cost)) usage.costUsd = cost;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function isCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function denialsOf(frame: JsonObject): { toolName: string; toolUseId: string }[] {
  const denials: { toolName: string; toolUseId: string }[] = [];
  for (const item of ownArray(frame, 'permission_denials') ?? []) {
    if (!isJsonObject(item)) continue;
    const toolName = ownString(item, 'tool_name');
    const toolUseId = ownString(item, 'tool_use_id');
    if (toolName !== undefined && toolUseId !== undefined) denials.push({ toolName, toolUseId });
  }
  return denials;
}

/**
 * A result hudhud synthesized because no `result` frame arrived (idle,
 * `cancelled` list, process end). Never claims success.
 */
function synthesized(
  sessionId: string,
  turnId: string,
  outcome: 'cancelled' | 'error' | 'unknown',
  raw: JsonValue,
): TurnResult {
  const base = {
    turnId,
    sessionId,
    outcome,
    isError: true,
    permissionDenials: [],
    synthesized: true,
  };
  const withStop = outcome === 'cancelled' ? { ...base, stopReason: 'cancelled' } : base;
  return raw === null ? withStop : { ...withStop, raw };
}
