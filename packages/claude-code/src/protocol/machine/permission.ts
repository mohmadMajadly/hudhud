/**
 * Claude Code permission machine: the `can_use_tool` lifecycle (plan §1.5,
 * ADR-0007, ADR-0012 §3, K12).
 *
 * @remarks
 * Sans-IO (ADR-0006): a pure `(state, input) -> (state, effects)` function.
 * State, inputs and effects are JSON. Time arrives in each input (`atMs`);
 * request ids come from the CLI. Inputs and effects are local to this
 * sub-machine; the session machine composes them onto the neutral contract.
 *
 * Rules:
 * - No default timeout. Every asked request ends exactly once, answered or
 *   cancelled: by the application, by the CLI (`control_cancel_request`), by
 *   close (drain), by abort, or because the CLI went away.
 * - Close (drain, K12): pending requests are answered with a
 *   non-interrupting deny so the turn can reach `idle`; requests that arrive
 *   while draining get the same answer without asking the application.
 * - Abort (K12): nothing is written, because hudhud's `interrupt` makes the
 *   CLI withdraw its requests.
 * - Decisions are checked strictly and rebuilt from known keys only. An
 *   invalid decision, like a failed handler, is answered with a
 *   non-interrupting deny with a fixed message (fail closed, 05 §6) and a
 *   diagnostic to the application; control errors are written only for
 *   malformed CLI requests.
 * - Permission updates whose `destination` is not `session` are stripped
 *   unless `dangerouslyAllowConfigWrites` is set (ADR-0012 §3, R6). More than
 *   {@link MAX_PERMISSION_UPDATES} updates are rejected.
 * - `permission_suggestions` are passed to the application as raw data,
 *   never applied and never shape-checked (D17).
 *
 * @packageDocumentation
 */

import type { JsonObject, JsonValue } from '@hudhud/core/protocol';
import { isJsonObject, ownArray, ownBoolean, ownObject, ownString } from '@hudhud/core/protocol';

import type {
  ControlErrorResponseFrame,
  PermissionDecisionWire,
  PermissionResponseFrame,
} from '../wire/types.js';

// ---- constants --------------------------------------------------------------

/**
 * Most permission updates one decision may carry; larger lists are rejected
 * locally (plan §1.5).
 *
 * @internal
 */
export const MAX_PERMISSION_UPDATES = 4096;

/**
 * The deny message written for pending requests when the session drains (K12).
 *
 * @internal
 */
export const CLOSING_DENY_MESSAGE = 'hudhud session closing';

/**
 * The deny message written when the application withdraws a pending request.
 *
 * @internal
 */
export const CANCELLED_DENY_MESSAGE = 'hudhud permission request cancelled';

/**
 * The deny message written for a decision that fails validation.
 *
 * @internal
 */
export const INVALID_DECISION_DENY_MESSAGE = 'hudhud: invalid permission decision';

/**
 * The deny message written when the application's handler failed. Fixed
 * text: the handler's own error never reaches the CLI or the model; it goes
 * to the application in a `permission.handler-failed` diagnostic.
 *
 * @internal
 */
export const HANDLER_FAILED_DENY_MESSAGE = 'hudhud: permission handler failed';

/**
 * Control error written for a `can_use_tool` request without the fields
 * hudhud needs to ask.
 *
 * @internal
 */
export const MALFORMED_REQUEST_ERROR = 'hudhud: malformed can_use_tool request';

/** The only destination kept by default: it never touches the disk. */
const SESSION_DESTINATION = 'session';

// ---- types ------------------------------------------------------------------

/**
 * One `can_use_tool` request. Entries in the state are always `asked`; the
 * terminal state is reported by the `permission.resolved` effect.
 *
 * @internal
 */
export interface PermissionEntry {
  readonly requestId: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly turnId?: string;
  readonly state: 'asked' | 'answered' | 'cancelled';
  readonly askedAtMs: number;
}

/**
 * Configuration of the permission machine.
 *
 * @internal
 */
export interface PermissionMachineConfig {
  /** Keep non-`session` permission destinations (ADR-0012 §3). */
  readonly dangerouslyAllowConfigWrites: boolean;
}

/**
 * `open`: requests are asked. `draining`: close was requested, requests are
 * denied without asking. `aborted`: nothing is written. `ended`: the CLI is
 * gone; every input yields no effects.
 *
 * @internal
 */
export type PermissionPhase = 'open' | 'draining' | 'aborted' | 'ended';

/**
 * Machine state (JSON).
 *
 * @internal
 */
export interface PermissionMachineState {
  readonly dangerouslyAllowConfigWrites: boolean;
  readonly phase: PermissionPhase;
  readonly pending: readonly PermissionEntry[];
}

/**
 * What the application is asked. Untrusted CLI text; `suggestions` is raw
 * data (D17).
 *
 * @internal
 */
export interface PermissionAskData {
  readonly requestId: string;
  readonly turnId?: string;
  readonly toolName: string;
  readonly displayName?: string;
  readonly toolUseId: string;
  readonly input: JsonObject;
  readonly suggestions: readonly JsonValue[];
  readonly blockedPath?: string;
  readonly decisionReasonType?: string;
  readonly title?: string;
  readonly description?: string;
  readonly raw: JsonObject;
}

/**
 * Inputs of the permission machine. `atMs` is the injected clock.
 *
 * @internal
 */
export type PermissionInput = { readonly atMs: number } & (
  | {
      /** A `can_use_tool` control request, routed by the control correlator. */
      readonly type: 'cli.can-use-tool';
      readonly requestId: string;
      readonly frame: JsonObject;
      readonly turnId?: string;
    }
  | { readonly type: 'cli.cancel'; readonly requestId: string }
  | { readonly type: 'cli.gone' }
  | { readonly type: 'cmd.permission'; readonly requestId: string; readonly decision: JsonObject }
  | {
      /** The handler threw or rejected; `error` is reported to the application only. */
      readonly type: 'cmd.permission-error';
      readonly requestId: string;
      readonly error: string;
    }
  | { readonly type: 'cmd.permission-abort'; readonly requestId: string }
  | { readonly type: 'cmd.close' }
  | { readonly type: 'cmd.abort' }
);

/**
 * Who ended a request.
 *
 * @internal
 */
export type PermissionResolvedBy = 'application' | 'harness' | 'close' | 'abort';

/**
 * Every diagnostic code the permission machine emits; the session machine
 * (W3) registers them with the neutral diagnostic vocabulary.
 *
 * - `permission.malformed-request`: a `can_use_tool` request lacked
 *   `tool_name`, `tool_use_id` or `input`; answered with a control error.
 * - `permission.duplicate-request`: an in-flight request id was reused; ignored.
 * - `permission.unknown-request`: an answer or cancel for no pending request
 *   (late, repeated or unknown); ignored, nothing written.
 * - `permission.invalid-decision`: the application's decision was refused
 *   (`data.reason`); a non-interrupting deny was written.
 * - `permission.handler-failed`: the handler failed (`data.error`); a
 *   non-interrupting deny with a fixed message was written.
 * - `permission.updates-stripped`: non-session updates were not sent
 *   (`data.strippedCount`).
 * - `permission.ignored-after-abort`: a request arrived after abort; nothing
 *   was written.
 *
 * @internal
 */
export const PERMISSION_DIAGNOSTIC_CODES = [
  'permission.malformed-request',
  'permission.duplicate-request',
  'permission.unknown-request',
  'permission.invalid-decision',
  'permission.handler-failed',
  'permission.updates-stripped',
  'permission.ignored-after-abort',
] as const;

/**
 * A diagnostic code of the permission machine.
 *
 * @internal
 */
export type PermissionDiagnosticCode = (typeof PERMISSION_DIAGNOSTIC_CODES)[number];

/**
 * Why a decision was refused.
 *
 * @internal
 */
export type DecisionFailure =
  | 'not-object'
  | 'bad-behavior'
  | 'unknown-key'
  | 'bad-updated-input'
  | 'bad-updated-permissions'
  | 'too-many-updates'
  | 'bad-message'
  | 'bad-interrupt';

/**
 * Effects of the permission machine (JSON).
 *
 * @internal
 */
export type PermissionEffect =
  | { readonly type: 'write'; readonly frame: PermissionResponseFrame | ControlErrorResponseFrame }
  | {
      readonly type: 'permission.ask';
      readonly requestId: string;
      readonly request: PermissionAskData;
    }
  | {
      /** Fires the handler's `AbortSignal`. */
      readonly type: 'permission.cancel';
      readonly requestId: string;
      readonly reason: 'harness' | 'close' | 'abort';
    }
  | {
      readonly type: 'permission.resolved';
      readonly entry: PermissionEntry;
      readonly behavior: 'allow' | 'deny' | 'cancelled';
      readonly by: PermissionResolvedBy;
      readonly waitedMs: number;
      readonly strippedCount: number;
    }
  | {
      readonly type: 'diagnostic';
      readonly code: PermissionDiagnosticCode;
      readonly message: string;
      readonly data: JsonObject;
    };

/**
 * One step's result.
 *
 * @internal
 */
export interface PermissionStep {
  readonly state: PermissionMachineState;
  readonly effects: readonly PermissionEffect[];
}

// ---- pure helpers -----------------------------------------------------------

/**
 * Drops every update whose own `destination` is not the string `session`,
 * unless `allowConfigWrites`. Kept updates are returned unchanged (same
 * objects, same order); nothing is merged or copied.
 *
 * @internal
 */
export function stripNonSessionDestinations(
  updates: readonly JsonObject[],
  allowConfigWrites: boolean,
): { kept: JsonObject[]; strippedCount: number } {
  if (allowConfigWrites) return { kept: [...updates], strippedCount: 0 };
  const kept = updates.filter((update) => ownString(update, 'destination') === SESSION_DESTINATION);
  return { kept, strippedCount: updates.length - kept.length };
}

/**
 * Validates an application decision and rebuilds it from known keys, with
 * non-session destinations stripped.
 *
 * @internal
 */
export function parseDecision(
  decision: unknown,
  allowConfigWrites: boolean,
):
  | { readonly ok: true; readonly decision: PermissionDecisionWire; readonly strippedCount: number }
  | { readonly ok: false; readonly reason: DecisionFailure } {
  if (!isJsonObject(decision)) return { ok: false, reason: 'not-object' };
  const behavior = ownString(decision, 'behavior');
  if (behavior === 'allow') return parseAllow(decision, allowConfigWrites);
  if (behavior === 'deny') return parseDeny(decision);
  return { ok: false, reason: 'bad-behavior' };
}

function hasOnlyKeys(obj: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((key) => allowed.includes(key));
}

function parseAllow(
  decision: JsonObject,
  allowConfigWrites: boolean,
):
  | { readonly ok: true; readonly decision: PermissionDecisionWire; readonly strippedCount: number }
  | { readonly ok: false; readonly reason: DecisionFailure } {
  if (!hasOnlyKeys(decision, ['behavior', 'updatedInput', 'updatedPermissions'])) {
    return { ok: false, reason: 'unknown-key' };
  }
  let updatedInput: JsonObject | undefined;
  if (Object.hasOwn(decision, 'updatedInput')) {
    updatedInput = ownObject(decision, 'updatedInput');
    if (updatedInput === undefined) return { ok: false, reason: 'bad-updated-input' };
  }
  let updates: readonly JsonObject[] | undefined;
  if (Object.hasOwn(decision, 'updatedPermissions')) {
    const list = ownArray(decision, 'updatedPermissions');
    if (list === undefined) return { ok: false, reason: 'bad-updated-permissions' };
    if (list.length > MAX_PERMISSION_UPDATES) return { ok: false, reason: 'too-many-updates' };
    const objects = list.filter(isJsonObject);
    if (objects.length !== list.length) return { ok: false, reason: 'bad-updated-permissions' };
    updates = objects;
  }
  const { kept, strippedCount } =
    updates === undefined
      ? { kept: undefined, strippedCount: 0 }
      : stripNonSessionDestinations(updates, allowConfigWrites);
  return {
    ok: true,
    decision: {
      behavior: 'allow',
      ...(updatedInput === undefined ? {} : { updatedInput }),
      ...(kept === undefined ? {} : { updatedPermissions: kept }),
    },
    strippedCount,
  };
}

function parseDeny(
  decision: JsonObject,
):
  | { readonly ok: true; readonly decision: PermissionDecisionWire; readonly strippedCount: number }
  | { readonly ok: false; readonly reason: DecisionFailure } {
  if (!hasOnlyKeys(decision, ['behavior', 'message', 'interrupt'])) {
    return { ok: false, reason: 'unknown-key' };
  }
  const message = ownString(decision, 'message');
  if (message === undefined) return { ok: false, reason: 'bad-message' };
  const interrupt = ownBoolean(decision, 'interrupt');
  if (Object.hasOwn(decision, 'interrupt') && interrupt === undefined) {
    return { ok: false, reason: 'bad-interrupt' };
  }
  return {
    ok: true,
    decision: {
      behavior: 'deny',
      message,
      ...(interrupt === undefined ? {} : { interrupt }),
    },
    strippedCount: 0,
  };
}

function successFrame(requestId: string, decision: PermissionDecisionWire): PermissionEffect {
  return {
    type: 'write',
    frame: {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: decision },
    },
  };
}

function errorFrame(requestId: string, error: string): PermissionEffect {
  return {
    type: 'write',
    frame: {
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    },
  };
}

function nonInterruptingDeny(requestId: string, message: string): PermissionEffect {
  return successFrame(requestId, { behavior: 'deny', message, interrupt: false });
}

function closingDeny(requestId: string): PermissionEffect {
  return nonInterruptingDeny(requestId, CLOSING_DENY_MESSAGE);
}

function resolved(
  entry: PermissionEntry,
  atMs: number,
  behavior: 'allow' | 'deny' | 'cancelled',
  by: PermissionResolvedBy,
  strippedCount = 0,
): PermissionEffect {
  return {
    type: 'permission.resolved',
    entry: { ...entry, state: behavior === 'cancelled' ? 'cancelled' : 'answered' },
    behavior,
    by,
    waitedMs: Math.max(0, atMs - entry.askedAtMs),
    strippedCount,
  };
}

function diagnostic(
  code: PermissionDiagnosticCode,
  message: string,
  data: JsonObject,
): PermissionEffect {
  return { type: 'diagnostic', code, message, data };
}

/** The request body, or `undefined` when a field needed to ask is missing. */
function readAsk(
  requestId: string,
  frame: JsonObject,
  turnId: string | undefined,
): PermissionAskData | undefined {
  const request = ownObject(frame, 'request');
  if (request === undefined) return undefined;
  if (ownString(request, 'subtype') !== 'can_use_tool') return undefined;
  const toolName = ownString(request, 'tool_name');
  const toolUseId = ownString(request, 'tool_use_id');
  const input = ownObject(request, 'input');
  if (toolName === undefined || toolUseId === undefined || input === undefined) return undefined;
  const optional = (key: string): string | undefined => ownString(request, key);
  const displayName = optional('display_name');
  const blockedPath = optional('blocked_path');
  const decisionReasonType = optional('decision_reason_type');
  const title = optional('title');
  const description = optional('description');
  return {
    requestId,
    ...(turnId === undefined ? {} : { turnId }),
    toolName,
    ...(displayName === undefined ? {} : { displayName }),
    toolUseId,
    input,
    // Raw data, never shape-checked or applied (D17).
    suggestions: ownArray(request, 'permission_suggestions') ?? [],
    ...(blockedPath === undefined ? {} : { blockedPath }),
    ...(decisionReasonType === undefined ? {} : { decisionReasonType }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    raw: frame,
  };
}

// ---- machine ----------------------------------------------------------------

/**
 * The initial state.
 *
 * @internal
 */
export function initialPermissionState(config: PermissionMachineConfig): PermissionMachineState {
  return {
    dangerouslyAllowConfigWrites: config.dangerouslyAllowConfigWrites,
    phase: 'open',
    pending: [],
  };
}

/**
 * One step of the permission machine.
 *
 * @internal
 */
export function stepPermission(
  state: PermissionMachineState,
  input: PermissionInput,
): PermissionStep {
  if (state.phase === 'ended') return { state, effects: [] };
  switch (input.type) {
    case 'cli.can-use-tool':
      return onRequest(state, input.requestId, input.frame, input.turnId, input.atMs);
    case 'cli.cancel':
      return settle(state, input.requestId, input.atMs, (entry) => [
        { type: 'permission.cancel', requestId: entry.requestId, reason: 'harness' },
        resolved(entry, input.atMs, 'cancelled', 'harness'),
      ]);
    case 'cmd.permission':
      return settle(state, input.requestId, input.atMs, (entry) => {
        const parsed = parseDecision(input.decision, state.dangerouslyAllowConfigWrites);
        if (!parsed.ok) {
          return [
            diagnostic('permission.invalid-decision', 'The permission decision was refused.', {
              requestId: entry.requestId,
              reason: parsed.reason,
            }),
            nonInterruptingDeny(entry.requestId, INVALID_DECISION_DENY_MESSAGE),
            resolved(entry, input.atMs, 'deny', 'application'),
          ];
        }
        const effects: PermissionEffect[] = [];
        if (parsed.strippedCount > 0) {
          effects.push(
            diagnostic(
              'permission.updates-stripped',
              'Permission updates with a non-session destination were not sent.',
              { requestId: entry.requestId, strippedCount: parsed.strippedCount },
            ),
          );
        }
        effects.push(
          successFrame(entry.requestId, parsed.decision),
          resolved(
            entry,
            input.atMs,
            parsed.decision.behavior,
            'application',
            parsed.strippedCount,
          ),
        );
        return effects;
      });
    case 'cmd.permission-error':
      return settle(state, input.requestId, input.atMs, (entry) => [
        diagnostic('permission.handler-failed', 'The permission handler failed.', {
          requestId: entry.requestId,
          error: input.error,
        }),
        nonInterruptingDeny(entry.requestId, HANDLER_FAILED_DENY_MESSAGE),
        resolved(entry, input.atMs, 'deny', 'application'),
      ]);
    case 'cmd.permission-abort':
      return settle(state, input.requestId, input.atMs, (entry) => [
        nonInterruptingDeny(entry.requestId, CANCELLED_DENY_MESSAGE),
        resolved(entry, input.atMs, 'cancelled', 'application'),
      ]);
    case 'cmd.close':
      if (state.phase !== 'open') return { state, effects: [] };
      return {
        state: { ...state, phase: 'draining', pending: [] },
        effects: state.pending.flatMap((entry) => [
          { type: 'permission.cancel', requestId: entry.requestId, reason: 'close' } as const,
          closingDeny(entry.requestId),
          resolved(entry, input.atMs, 'cancelled', 'close'),
        ]),
      };
    case 'cmd.abort':
      if (state.phase === 'aborted') return { state, effects: [] };
      return cancelAll(state, 'aborted', 'abort', input.atMs);
    case 'cli.gone':
      return cancelAll(state, 'ended', 'harness', input.atMs);
  }
}

function onRequest(
  state: PermissionMachineState,
  requestId: string,
  frame: JsonObject,
  turnId: string | undefined,
  atMs: number,
): PermissionStep {
  if (state.phase === 'aborted') {
    return {
      state,
      effects: [
        diagnostic(
          'permission.ignored-after-abort',
          'A permission request arrived after abort; nothing was written.',
          { requestId },
        ),
      ],
    };
  }
  if (state.pending.some((entry) => entry.requestId === requestId)) {
    return {
      state,
      effects: [
        diagnostic(
          'permission.duplicate-request',
          'A permission request reused an in-flight request id; ignored.',
          { requestId },
        ),
      ],
    };
  }
  const ask = readAsk(requestId, frame, turnId);
  if (ask === undefined) {
    return {
      state,
      effects: [
        diagnostic(
          'permission.malformed-request',
          'A can_use_tool request lacked tool_name, tool_use_id or input; answered with an error.',
          { requestId },
        ),
        errorFrame(requestId, MALFORMED_REQUEST_ERROR),
      ],
    };
  }
  const entry: PermissionEntry = {
    requestId,
    toolUseId: ask.toolUseId,
    toolName: ask.toolName,
    ...(turnId === undefined ? {} : { turnId }),
    state: 'asked',
    askedAtMs: atMs,
  };
  if (state.phase === 'draining') {
    // Never asked: the session is closing and the CLI must not block (K12).
    return {
      state,
      effects: [closingDeny(requestId), resolved(entry, atMs, 'deny', 'close')],
    };
  }
  return {
    state: { ...state, pending: [...state.pending, entry] },
    effects: [{ type: 'permission.ask', requestId, request: ask }],
  };
}

/** Ends one pending entry, or reports an unknown (or already ended) id. */
function settle(
  state: PermissionMachineState,
  requestId: string,
  atMs: number,
  end: (entry: PermissionEntry) => readonly PermissionEffect[],
): PermissionStep {
  const entry = state.pending.find((candidate) => candidate.requestId === requestId);
  if (entry === undefined) {
    return {
      state,
      effects: [
        diagnostic(
          'permission.unknown-request',
          'No pending permission request has this id; ignored.',
          { requestId, phase: state.phase, atMs },
        ),
      ],
    };
  }
  return {
    state: { ...state, pending: state.pending.filter((candidate) => candidate !== entry) },
    effects: end(entry),
  };
}

/** Cancels every pending entry without writing anything. */
function cancelAll(
  state: PermissionMachineState,
  phase: 'aborted' | 'ended',
  reason: 'abort' | 'harness',
  atMs: number,
): PermissionStep {
  return {
    state: { ...state, phase, pending: [] },
    effects: state.pending.flatMap((entry) => [
      { type: 'permission.cancel', requestId: entry.requestId, reason } as const,
      resolved(entry, atMs, 'cancelled', reason),
    ]),
  };
}

/**
 * The permission machine as an `initialState` / `step` pair.
 *
 * @internal
 */
export const permissionMachine: {
  readonly initialState: (config: PermissionMachineConfig) => PermissionMachineState;
  readonly step: (state: PermissionMachineState, input: PermissionInput) => PermissionStep;
} = {
  initialState: initialPermissionState,
  step: stepPermission,
};
