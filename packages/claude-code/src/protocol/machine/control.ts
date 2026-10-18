/**
 * The control-request correlator of the Claude session (plan §1.5, K3):
 * hudhud's own requests to the CLI and the CLI's requests to hudhud.
 *
 * @remarks
 * Pure and sans-IO (ADR-0006): every operation takes the state and returns
 * the next state with effects; time arrives as `atMs`, timeouts as timer
 * effects the binding schedules. State and effects are plain JSON.
 *
 * Outbound (hudhud to CLI): request ids are `hudhud_<n>`, unique per session
 * (deterministic, never reused). A `control_response` settles its request
 * exactly once; a response for an id that was issued but is no longer pending
 * (duplicate, after a timeout or a local cancel) is ignored with diagnostic
 * `control.late-response`, any other id with `control.unknown-response`
 * (02 §3). A timeout or local cancel writes nothing: no frame withdraws a
 * request the CLI already has (the strict outbound schema has no
 * `control_cancel_request`, and none was observed in 05/07).
 *
 * Inbound (CLI to hudhud): v1 handles `can_use_tool` only (02 §4.3). Every
 * other subtype is answered with a `control_response` error "Unsupported
 * control request subtype", except the never-answered set: `remote_*`
 * subtypes and `request_user_dialog` (v1 declares no dialog kinds, so every
 * kind is unhandled and must not be answered, 02 §4.3); at most
 * {@link MAX_UNANSWERED_ENTRIES} of them are remembered. `elicitation` gets
 * the unsupported error in v1 too; answering it with `{action: 'decline'}`
 * (02 §4.3) is a v1.x item. A duplicate in-flight
 * id is ignored; `control_cancel_request` removes the entry and yields
 * `inbound.cancel`; nothing is ever written for a cancelled request.
 *
 * Stdin authority (ADR-0012 §8): inbound data never produces an outbound
 * request; the only frames written in reaction to the CLI are
 * `control_response` answers. Untrusted ids are kept in arrays and compared by
 * value, never used as object keys.
 *
 * @packageDocumentation
 */

import {
  encodeJsonLine,
  makeErrorData,
  type ErrorData,
  type JsonObject,
  type KnownErrorData,
} from '@hudhudjs/core/protocol';

import { validateCanUseToolRequestFrame } from '../generated/validators.gen.js';
import type { InboundClass } from '../wire/inbound.js';
import {
  controlErrorResponse,
  encodeOutboundFrame,
  initializeRequest,
  interruptRequest,
  permissionResponse,
  rawControlRefusal,
  rawControlRequest,
  setPermissionModeRequest,
} from '../wire/outbound.js';
import type { InitializeBody, PermissionDecisionWire, PermissionModeWire } from '../wire/types.js';

/** Why hudhud sent a control request. @internal */
export type ControlPurpose = 'initialize' | 'interrupt' | 'set_permission_mode' | 'raw';

/** A pending request hudhud sent. @internal */
export interface OutboundEntry {
  readonly requestId: string;
  readonly purpose: ControlPurpose;
  readonly subtype: string;
  readonly correlation: string;
  readonly sentAtMs: number;
  /** Present when the request has a timeout: the timer name and its length. */
  readonly timeout?: { readonly timer: string; readonly ms: number };
}

/** A pending request from the CLI. @internal */
export interface InboundEntry {
  /** The request id; for a `never` entry its {@link keptIdKey}. */
  readonly requestId: string;
  /** The subtype; for a `never` entry cut to 128 code units. */
  readonly subtype: string;
  /**
   * `never`: a member of the never-answered set, kept only to route a cancel
   * and to recognise an in-flight duplicate; at most
   * {@link MAX_UNANSWERED_ENTRIES} of them.
   */
  readonly answer: 'expected' | 'never';
  readonly turnId?: string;
}

/** Correlator state (JSON). @internal */
export interface ControlState {
  /** The `<n>` of the next `hudhud_<n>` request id. */
  readonly nextId: number;
  /** hudhud's pending requests: each ends on its answer, its timeout, a local cancel or close. */
  readonly outbound: readonly OutboundEntry[];
  /**
   * The CLI's pending requests: a `can_use_tool` until it is answered or
   * cancelled, a never-answered one until it is cancelled or forgotten
   * ({@link MAX_UNANSWERED_ENTRIES}); all of them at close.
   */
  readonly inbound: readonly InboundEntry[];
}

/** Correlator configuration (JSON). @internal */
export interface ControlConfig {
  /** Outbound line cap in bytes (ADR-0011 §7), usually 33554432. */
  readonly maxOutboundBytes: number;
  /** `claudeCode.dangerouslyAllowRawControl` (plan §2.6). */
  readonly allowRawControl: boolean;
  /** `dangerouslyAllowConfigWrites`: permits `update_settings` (ADR-0012 §3). */
  readonly allowConfigWrites: boolean;
}

/** A control request hudhud wants to send. @internal */
export type OutboundRequest = {
  /**
   * The binding's handle for the caller. Binding contract: unique among
   * pending requests. A duplicate is refused with an `INVALID_OPTIONS` settle
   * that carries the same correlation, so the caller of the still-pending
   * request would see a second settle; the binding must never reuse one.
   */
  readonly correlation: string;
  /** Optional local timeout, a positive safe integer; none by default (02 §4.1). */
  readonly timeoutMs?: number;
} & (
  | {
      readonly purpose: 'initialize';
      /** `{}` in v1; no field of it is written (see `initializeRequest`). */
      readonly body: InitializeBody;
    }
  | { readonly purpose: 'interrupt'; readonly cancelQueued: boolean }
  | { readonly purpose: 'set_permission_mode'; readonly mode: PermissionModeWire }
  | { readonly purpose: 'raw'; readonly subtype: string; readonly body?: JsonObject }
);

/** The answer to a pending inbound request. @internal */
export type InboundAnswer =
  | { readonly type: 'decision'; readonly decision: PermissionDecisionWire }
  | { readonly type: 'error'; readonly message: string };

/** What the correlator asks its host to do. @internal */
export type ControlEffect =
  | { readonly type: 'write'; readonly line: string; readonly bytes: number }
  | { readonly type: 'timer.set'; readonly name: string; readonly ms: number }
  | { readonly type: 'timer.clear'; readonly name: string }
  | {
      readonly type: 'settle';
      readonly correlation: string;
      readonly purpose: ControlPurpose;
      readonly ok: true;
      /** `response.response` of the success frame, when it is an object. */
      readonly response?: JsonObject;
    }
  | {
      readonly type: 'settle';
      readonly correlation: string;
      readonly purpose: ControlPurpose;
      readonly ok: false;
      readonly error: ErrorData;
    }
  | {
      readonly type: 'inbound.request';
      readonly requestId: string;
      readonly subtype: string;
      readonly frame: JsonObject;
    }
  | {
      readonly type: 'inbound.cancel';
      readonly requestId: string;
      readonly subtype: string;
      readonly turnId?: string;
    }
  | {
      readonly type: 'diagnostic';
      readonly code: ControlDiagnosticCode;
      readonly message: string;
      readonly data: JsonObject;
    };

/** Diagnostic codes the correlator emits. @internal */
export type ControlDiagnosticCode =
  | 'control.unknown-response'
  | 'control.late-response'
  | 'control.duplicate-request'
  | 'control.unknown-cancel'
  | 'control.unsupported-request'
  | 'control.unanswered-request'
  | 'control.malformed-request'
  | 'control.answer-not-pending'
  | 'control.answer-failed';

/** The result of every correlator operation. @internal */
export interface ControlStep {
  readonly state: ControlState;
  readonly effects: readonly ControlEffect[];
}

/** Message prefix of the error answer to an unsupported inbound subtype. @internal */
export const UNSUPPORTED_SUBTYPE_MESSAGE = 'Unsupported control request subtype';

/** Longest untrusted string copied into an answer, error or diagnostic. */
const MAX_ECHO = 128;
/** Longest CLI error text kept in `details.cliError`. */
const MAX_CLI_ERROR = 1024;
const ID_PREFIX = 'hudhud_';
const TIMER_PREFIX = 'control.timeout:';

/**
 * Most entries of the never-answered set kept at once (see
 * {@link ControlState.inbound}). The CLI may never cancel such a request, so
 * without a cap the set would grow with the session's lifetime. When a new
 * one arrives at the cap, the oldest is forgotten. Forgetting one changes
 * diagnostics only: nothing is ever written for a never-answered request, and
 * the session machine ignores their cancels. A later cancel of a forgotten
 * one reports `control.unknown-cancel`, and a repeat of its id is recorded
 * again (`control.unanswered-request`, not `control.duplicate-request`).
 *
 * @internal
 */
export const MAX_UNANSWERED_ENTRIES = 64;

/**
 * Longest untrusted id a bounded record keeps verbatim (see {@link keptIdKey}).
 *
 * @internal
 */
export const MAX_KEPT_ID_CHARS = 256;

/**
 * The key under which a bounded record keeps an untrusted id: the id itself
 * when it has at most {@link MAX_KEPT_ID_CHARS} UTF-16 code units, otherwise
 * its first {@link MAX_KEPT_ID_CHARS} code units, `#` and its length. So one
 * entry never holds more than a few hundred code units, however long the id.
 * Two distinct ids share a key only when both are longer than the cap and
 * share the prefix and the length. A record that keys ids takes a shared key
 * as the same id, which can only make it refuse or ignore a request, never
 * accept one.
 *
 * @internal
 */
export function keptIdKey(id: string): string {
  return id.length <= MAX_KEPT_ID_CHARS
    ? id
    : `${id.slice(0, MAX_KEPT_ID_CHARS)}#${String(id.length)}`;
}

/** Whether `entry` is the pending inbound entry of `requestId`. */
function isEntryOf(entry: InboundEntry, requestId: string): boolean {
  return entry.requestId === (entry.answer === 'never' ? keptIdKey(requestId) : requestId);
}

/** A copy of untrusted text, cut to `max` UTF-16 code units. */
function cap(text: string, max: number = MAX_ECHO): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The initial correlator state.
 *
 * @internal
 */
export function initialControlState(): ControlState {
  return { nextId: 1, outbound: [], inbound: [] };
}

/** True when `subtype` is never answered (02 §4.3). @internal */
export function isNeverAnswered(subtype: string): boolean {
  return subtype.startsWith('remote_') || subtype === 'request_user_dialog';
}

function settleError(
  correlation: string,
  purpose: ControlPurpose,
  error: ErrorData,
): ControlEffect {
  return { type: 'settle', correlation, purpose, ok: false, error };
}

function diagnostic(code: ControlDiagnosticCode, message: string, data: JsonObject): ControlEffect {
  return { type: 'diagnostic', code, message, data };
}

function subtypeOf(request: OutboundRequest): string {
  return request.purpose === 'raw' ? request.subtype : request.purpose;
}

function buildFrame(
  request: OutboundRequest,
  requestId: string,
  config: ControlConfig,
): { ok: true; line: string; bytes: number } | { ok: false; error: KnownErrorData } {
  switch (request.purpose) {
    case 'initialize':
      return encodeOutboundFrame(initializeRequest(requestId), config.maxOutboundBytes);
    case 'interrupt':
      return encodeOutboundFrame(
        interruptRequest(requestId, request.cancelQueued),
        config.maxOutboundBytes,
      );
    case 'set_permission_mode':
      return encodeOutboundFrame(
        setPermissionModeRequest(requestId, request.mode),
        config.maxOutboundBytes,
      );
    case 'raw': {
      const refusal = rawControlRefusal(request.subtype, request.body, config);
      if (refusal !== undefined) return { ok: false, error: refusal };
      // Raw subtypes are outside the strict schema by design (plan §2.6).
      return encodeJsonLine(
        rawControlRequest(requestId, request.subtype, request.body),
        config.maxOutboundBytes,
      );
    }
  }
}

/**
 * Sends a control request: writes it and records it as pending, or settles it
 * at once with an error and writes nothing.
 *
 * @remarks
 * Refusals settle with: `INVALID_OPTIONS` for a duplicate pending
 * correlation, a bad `timeoutMs` or a raw request the policy forbids
 * (`initialize`, `update_settings` without the config-write opt-in, raw
 * control disabled); `PROTOCOL_ERROR` for a frame the strict schema refuses;
 * `OUTBOUND_FRAME_TOO_LARGE` above the cap. A refused request consumes no id.
 *
 * @internal
 */
export function sendControlRequest(
  state: ControlState,
  config: ControlConfig,
  request: OutboundRequest,
  atMs: number,
): ControlStep {
  const { correlation, purpose, timeoutMs } = request;
  if (state.outbound.some((entry) => entry.correlation === correlation)) {
    const error = makeErrorData(
      'INVALID_OPTIONS',
      'A control request with this correlation is already pending.',
      {
        rule: 'control-correlation-unique',
      },
    );
    return { state, effects: [settleError(correlation, purpose, error)] };
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    const error = makeErrorData('INVALID_OPTIONS', 'timeoutMs must be a positive safe integer.', {
      rule: 'control-timeout',
    });
    return { state, effects: [settleError(correlation, purpose, error)] };
  }
  const requestId = `${ID_PREFIX}${String(state.nextId)}`;
  const encoded = buildFrame(request, requestId, config);
  if (!encoded.ok) return { state, effects: [settleError(correlation, purpose, encoded.error)] };
  const subtype = subtypeOf(request);
  const effects: ControlEffect[] = [{ type: 'write', line: encoded.line, bytes: encoded.bytes }];
  let entry: OutboundEntry = { requestId, purpose, subtype, correlation, sentAtMs: atMs };
  if (timeoutMs !== undefined) {
    const timer = `${TIMER_PREFIX}${requestId}`;
    entry = { ...entry, timeout: { timer, ms: timeoutMs } };
    effects.push({ type: 'timer.set', name: timer, ms: timeoutMs });
  }
  return {
    state: { ...state, nextId: state.nextId + 1, outbound: [...state.outbound, entry] },
    effects,
  };
}

/** True when `requestId` is a `hudhud_<n>` id this correlator already issued. */
function wasIssued(state: ControlState, requestId: string): boolean {
  if (!requestId.startsWith(ID_PREFIX)) return false;
  const digits = requestId.slice(ID_PREFIX.length);
  if (!/^[1-9][0-9]{0,15}$/.test(digits)) return false;
  return Number(digits) < state.nextId;
}

function withoutOutbound(state: ControlState, entry: OutboundEntry): ControlState {
  return { ...state, outbound: state.outbound.filter((other) => other !== entry) };
}

function clearTimer(entry: OutboundEntry): ControlEffect[] {
  return entry.timeout === undefined ? [] : [{ type: 'timer.clear', name: entry.timeout.timer }];
}

function onResponse(
  state: ControlState,
  cls: Extract<InboundClass, { kind: 'control_response' }>,
): ControlStep {
  const entry = state.outbound.find((pending) => pending.requestId === cls.requestId);
  if (entry === undefined) {
    const late = wasIssued(state, cls.requestId);
    return {
      state,
      effects: [
        diagnostic(
          late ? 'control.late-response' : 'control.unknown-response',
          late
            ? 'Ignored a control_response for a request that is no longer pending.'
            : 'Ignored a control_response for a request hudhud never sent.',
          { requestId: cap(cls.requestId) },
        ),
      ],
    };
  }
  const { correlation, purpose, subtype, requestId } = entry;
  const settle: ControlEffect = cls.ok
    ? cls.response === undefined
      ? { type: 'settle', correlation, purpose, ok: true }
      : { type: 'settle', correlation, purpose, ok: true, response: cls.response }
    : settleError(
        correlation,
        purpose,
        makeErrorData(
          'CONTROL_REQUEST_FAILED',
          `The CLI answered the ${cap(subtype)} control request with an error.`,
          { subtype: cap(subtype), requestId, cliError: cap(cls.error, MAX_CLI_ERROR) },
        ),
      );
  return { state: withoutOutbound(state, entry), effects: [...clearTimer(entry), settle] };
}

function answerError(config: ControlConfig, requestId: string, message: string): ControlEffect {
  const encoded = encodeOutboundFrame(
    controlErrorResponse(requestId, message),
    config.maxOutboundBytes,
  );
  return encoded.ok
    ? { type: 'write', line: encoded.line, bytes: encoded.bytes }
    : diagnostic('control.answer-failed', 'Could not encode the answer to a control request.', {
        requestId: cap(requestId),
        code: encoded.error.code,
      });
}

function onRequest(
  state: ControlState,
  config: ControlConfig,
  cls: Extract<InboundClass, { kind: 'control_request' }>,
  turnId: string | undefined,
): ControlStep {
  const { requestId, subtype, frame } = cls;
  if (state.inbound.some((entry) => isEntryOf(entry, requestId))) {
    return {
      state,
      effects: [
        diagnostic('control.duplicate-request', 'Ignored a duplicate in-flight control request.', {
          requestId: cap(requestId),
          subtype: cap(subtype),
        }),
      ],
    };
  }
  const base = turnId === undefined ? { requestId, subtype } : { requestId, subtype, turnId };
  if (isNeverAnswered(subtype)) {
    // Bounded (MAX_UNANSWERED_ENTRIES): the CLI may never cancel these, and
    // each keeps a bounded key, never the whole untrusted id or subtype.
    const kept: InboundEntry = {
      ...base,
      requestId: keptIdKey(requestId),
      subtype: cap(subtype),
      answer: 'never',
    };
    const unanswered = state.inbound.filter((entry) => entry.answer === 'never');
    const forgotten = unanswered.length >= MAX_UNANSWERED_ENTRIES ? unanswered[0] : undefined;
    return {
      state: {
        ...state,
        inbound: [...state.inbound.filter((entry) => entry !== forgotten), kept],
      },
      effects: [
        diagnostic(
          'control.unanswered-request',
          'A control request that is never answered arrived.',
          {
            requestId: cap(requestId),
            subtype: cap(subtype),
          },
        ),
      ],
    };
  }
  if (subtype === 'can_use_tool') {
    if (!validateCanUseToolRequestFrame(frame).ok) {
      return {
        state,
        effects: [
          diagnostic('control.malformed-request', 'A can_use_tool request had a malformed body.', {
            requestId: cap(requestId),
          }),
          answerError(config, requestId, 'Malformed can_use_tool request'),
        ],
      };
    }
    return {
      state: { ...state, inbound: [...state.inbound, { ...base, answer: 'expected' }] },
      effects: [{ type: 'inbound.request', requestId, subtype, frame }],
    };
  }
  // Every other subtype, hook_callback, mcp_message and elicitation included.
  // v1.x item: answer elicitation with {action: 'decline'} (02 §4.3).
  return {
    state,
    effects: [
      diagnostic(
        'control.unsupported-request',
        'Answered an unsupported control request with an error.',
        {
          requestId: cap(requestId),
          subtype: cap(subtype),
        },
      ),
      answerError(config, requestId, `${UNSUPPORTED_SUBTYPE_MESSAGE}: ${cap(subtype)}`),
    ],
  };
}

function onCancel(state: ControlState, requestId: string): ControlStep {
  const entry = state.inbound.find((pending) => isEntryOf(pending, requestId));
  if (entry === undefined) {
    return {
      state,
      effects: [
        diagnostic(
          'control.unknown-cancel',
          'Ignored a cancel for a control request that is not pending.',
          {
            requestId: cap(requestId),
          },
        ),
      ],
    };
  }
  const cancel: ControlEffect =
    entry.turnId === undefined
      ? { type: 'inbound.cancel', requestId, subtype: entry.subtype }
      : { type: 'inbound.cancel', requestId, subtype: entry.subtype, turnId: entry.turnId };
  return {
    state: { ...state, inbound: state.inbound.filter((other) => other !== entry) },
    effects: [cancel],
  };
}

/**
 * Routes one classified inbound frame. Control frames (`control_request`,
 * `control_response`, `control_cancel_request`, `keep_alive`) are consumed
 * (`handled: true`); every other class is left to the caller with no effects.
 *
 * @param turnId - The turn active when a `can_use_tool` arrives, recorded on
 * the inbound entry and repeated on its cancel.
 * @internal
 */
export function receiveControlFrame(
  state: ControlState,
  config: ControlConfig,
  cls: InboundClass,
  turnId?: string,
): ControlStep & { readonly handled: boolean } {
  switch (cls.kind) {
    case 'control_response':
      return { ...onResponse(state, cls), handled: true };
    case 'control_request':
      return { ...onRequest(state, config, cls, turnId), handled: true };
    case 'control_cancel_request':
      return { ...onCancel(state, cls.requestId), handled: true };
    case 'keep_alive':
      return { state, effects: [], handled: true };
    case 'conversation':
    case 'malformed':
      return { state, effects: [], handled: false };
  }
}

/**
 * Answers a pending inbound request (`can_use_tool`).
 *
 * @remarks
 * `written`: the answer was written and the entry removed. `not-pending`: the
 * request was cancelled, never arrived, was already answered or is in the
 * never-answered set; nothing is written (diagnostic
 * `control.answer-not-pending`). `failed`: the answer could not be encoded
 * (for example above the outbound cap); nothing is written and the entry stays
 * pending so the caller can answer again, for example with a deny.
 *
 * @internal
 */
export function answerInbound(
  state: ControlState,
  config: ControlConfig,
  requestId: string,
  answer: InboundAnswer,
): ControlStep &
  (
    | { readonly outcome: 'written' | 'not-pending' }
    | { readonly outcome: 'failed'; readonly error: KnownErrorData }
  ) {
  const entry = state.inbound.find(
    (pending) => pending.requestId === requestId && pending.answer === 'expected',
  );
  if (entry === undefined) {
    return {
      state,
      outcome: 'not-pending',
      effects: [
        diagnostic(
          'control.answer-not-pending',
          'Did not answer a control request that is no longer pending.',
          { requestId: cap(requestId) },
        ),
      ],
    };
  }
  const frame =
    answer.type === 'decision'
      ? permissionResponse(requestId, answer.decision)
      : controlErrorResponse(requestId, answer.message);
  const encoded = encodeOutboundFrame(frame, config.maxOutboundBytes);
  if (!encoded.ok) return { state, outcome: 'failed', error: encoded.error, effects: [] };
  return {
    state: { ...state, inbound: state.inbound.filter((other) => other !== entry) },
    outcome: 'written',
    effects: [{ type: 'write', line: encoded.line, bytes: encoded.bytes }],
  };
}

/**
 * Handles a fired timer. A correlator timeout settles its request with
 * `CONTROL_REQUEST_FAILED` (`details.cause: 'timeout'`) and writes nothing; a
 * later response is a `control.late-response`. Other timer names are not the
 * correlator's (`handled: false`).
 *
 * @internal
 */
export function controlTimerFired(
  state: ControlState,
  name: string,
): ControlStep & { readonly handled: boolean } {
  const entry = state.outbound.find((pending) => pending.timeout?.timer === name);
  if (entry?.timeout === undefined) {
    return { state, effects: [], handled: name.startsWith(TIMER_PREFIX) };
  }
  const error = makeErrorData(
    'CONTROL_REQUEST_FAILED',
    `The ${cap(entry.subtype)} control request timed out.`,
    {
      cause: 'timeout',
      subtype: cap(entry.subtype),
      requestId: entry.requestId,
      timeoutMs: entry.timeout.ms,
    },
  );
  return {
    state: withoutOutbound(state, entry),
    effects: [settleError(entry.correlation, entry.purpose, error)],
    handled: true,
  };
}

/**
 * Abandons one pending outbound request locally (for example its signal
 * aborted), settling it with `error`. Nothing is written; a later response is
 * a `control.late-response`. An unknown correlation is a no-op.
 *
 * @internal
 */
export function cancelControlRequest(
  state: ControlState,
  correlation: string,
  error: ErrorData,
): ControlStep {
  const entry = state.outbound.find((pending) => pending.correlation === correlation);
  if (entry === undefined) return { state, effects: [] };
  return {
    state: withoutOutbound(state, entry),
    effects: [...clearTimer(entry), settleError(correlation, entry.purpose, error)],
  };
}

/**
 * Ends the correlator (the session is ending): every pending outbound request
 * settles with `error`, its timer is cleared, and every pending inbound
 * request yields `inbound.cancel`. Nothing is written. The id counter is
 * kept, so a response arriving afterwards is a `control.late-response`.
 *
 * @internal
 */
export function closeControl(state: ControlState, error: ErrorData): ControlStep {
  const effects: ControlEffect[] = [];
  for (const entry of state.outbound) {
    effects.push(...clearTimer(entry), settleError(entry.correlation, entry.purpose, error));
  }
  for (const entry of state.inbound) {
    effects.push(
      entry.turnId === undefined
        ? { type: 'inbound.cancel', requestId: entry.requestId, subtype: entry.subtype }
        : {
            type: 'inbound.cancel',
            requestId: entry.requestId,
            subtype: entry.subtype,
            turnId: entry.turnId,
          },
    );
  }
  return { state: { ...state, outbound: [], inbound: [] }, effects };
}
