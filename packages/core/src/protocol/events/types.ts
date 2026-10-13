/**
 * The harness-neutral event vocabulary (plan §2.2, ADR-0003, ADR-0005 §6).
 *
 * @remarks
 * Mirrored by `schemas/events.schema.json`; a type-level test asserts that
 * each type and its schema source accept the same values. Enums marked open
 * accept unknown values on read, and the event union has an open arm for
 * event types added later. Every event built from a harness frame carries
 * that frame as `raw`.
 *
 * @packageDocumentation
 */

import type { JsonObject, JsonValue } from '../json.js';

/**
 * Fields shared by every event of a session stream.
 *
 * @public
 */
export interface EventBase {
  /** Strictly increasing by 1 within a session stream, starting at 0. */
  readonly seq: number;
  /** ISO-8601 timestamp. */
  readonly ts: string;
  readonly sessionId: string;
}

/**
 * Tool kind (ACP-aligned, open).
 *
 * @public
 */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other'
  | (string & {});

/**
 * Why a turn stopped (ACP-aligned, open).
 *
 * @public
 */
export type StopReason =
  'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | (string & {});

/**
 * Token and cost totals as reported by the harness.
 *
 * @public
 */
export interface UsageTotals {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly costUsd?: number;
}

/**
 * How a turn ended (open).
 *
 * @public
 */
export type TurnOutcome =
  'completed' | 'error' | 'cancelled' | 'max-turns' | 'max-budget' | 'unknown' | (string & {});

/**
 * The result of one turn. An error result is a result, not a failure (K21).
 *
 * @public
 */
export interface TurnResult {
  readonly turnId: string;
  readonly sessionId: string;
  readonly outcome: TurnOutcome;
  readonly isError: boolean;
  readonly text?: string;
  readonly stopReason?: StopReason;
  readonly terminalReason?: string;
  readonly errors?: readonly string[];
  readonly apiErrorStatus?: number;
  readonly usage?: UsageTotals;
  readonly permissionDenials: readonly { readonly toolName: string; readonly toolUseId: string }[];
  /** True when hudhud synthesized the result (no harness result arrived). */
  readonly synthesized: boolean;
  readonly raw?: JsonValue;
}

/**
 * Diagnostic codes (open).
 *
 * @public
 */
export type DiagnosticCode =
  | 'env.dropped'
  | 'env.added'
  | 'env.removed'
  | 'binary.launcher-detected'
  | 'binary.version-changed'
  | 'binary.unverified'
  | 'project.permissions-ignored'
  | 'containment.fallback'
  | 'containment.addon-unavailable'
  | 'stdout.non-json-line'
  | 'frame.skipped-oversized'
  | 'interrupt.still-queued-retry'
  | 'session.id-mismatch'
  | 'control.unknown-response'
  | 'control.late-response'
  | 'control.duplicate-request'
  | 'control.unknown-cancel'
  | 'control.unsupported-request'
  | 'control.unanswered-request'
  | 'control.malformed-request'
  | 'control.answer-not-pending'
  | 'control.answer-failed'
  | 'permission.malformed-request'
  | 'permission.duplicate-request'
  | 'permission.unknown-request'
  | 'permission.invalid-decision'
  | 'permission.handler-failed'
  | 'permission.updates-stripped'
  | 'permission.ignored-after-abort'
  | 'permission.duplicate-request-id'
  | 'stdin.error'
  | 'turn.unmatched-result'
  | 'turn.dropped'
  | (string & {});

/**
 * The tested version window of a harness and where a version falls in it.
 *
 * @public
 */
export interface CompatInfo {
  readonly harness: string;
  readonly version: string;
  readonly minTested: string;
  readonly maxTested: string;
  readonly knownBroken: readonly string[];
  readonly status: 'tested' | 'untested' | 'known-broken';
}

/**
 * Every event of a session stream. The last arm is open: event types added
 * later arrive with their `type` and `raw`.
 *
 * @public
 */
export type HudhudEvent =
  | (EventBase & { readonly type: 'compat'; readonly compat: CompatInfo; readonly raw?: JsonValue })
  | (EventBase & {
      readonly type: 'session.started';
      readonly mode: 'create' | 'resume' | 'fork';
      readonly pid: number;
      readonly cliPid?: number;
      readonly version: string;
      readonly apiKeySource?: string;
      readonly tokenSource?: string;
      readonly permissionMode?: string;
      readonly raw: JsonValue;
    })
  | (EventBase & { readonly type: 'turn.queued'; readonly turnId: string })
  | (EventBase & {
      readonly type: 'turn.started';
      readonly turnId: string;
      readonly origin: 'application' | 'harness';
      readonly features: readonly string[];
      readonly model?: string;
      readonly raw: JsonValue;
    })
  | (EventBase & {
      readonly type: 'message.assistant';
      readonly turnId?: string;
      readonly text?: string;
      readonly aborted?: boolean;
      readonly raw: JsonValue;
    })
  | (EventBase & {
      readonly type: 'message.delta';
      readonly turnId?: string;
      readonly index: number;
      readonly deltaType: 'text' | 'thinking' | 'input_json' | (string & {});
      readonly text?: string;
      readonly raw: JsonValue;
    })
  | (EventBase & {
      readonly type: 'tool.call';
      readonly turnId?: string;
      readonly toolUseId: string;
      readonly toolName: string;
      readonly kind: ToolKind;
      readonly status: 'pending';
      readonly input: JsonValue;
      readonly raw: JsonValue;
    })
  | (EventBase & {
      readonly type: 'tool.result';
      readonly turnId?: string;
      readonly toolUseId: string;
      readonly status: 'completed' | 'failed';
      readonly raw: JsonValue;
    })
  | (EventBase & {
      readonly type: 'permission.requested';
      readonly requestId: string;
      readonly turnId?: string;
      readonly toolName: string;
      readonly toolUseId: string;
      readonly raw: JsonValue;
    })
  | (EventBase & {
      readonly type: 'permission.resolved';
      readonly requestId: string;
      readonly behavior: 'allow' | 'deny' | 'cancelled';
      readonly by: 'application' | 'harness' | 'close' | 'abort';
      readonly raw?: JsonValue;
    })
  | (EventBase & {
      readonly type: 'permission.denied';
      readonly toolName: string;
      readonly toolUseId: string;
      readonly reasonType?: string;
      readonly raw: JsonValue;
    })
  | (EventBase & {
      readonly type: 'api.retry';
      readonly attempt: number;
      readonly maxRetries?: number;
      readonly retryDelayMs?: number;
      readonly errorStatus?: number;
      readonly error?: string;
      readonly raw: JsonValue;
    })
  | (EventBase & {
      readonly type: 'usage.update';
      readonly turnId?: string;
      readonly reported: UsageTotals;
      readonly estimatedDelta: UsageTotals & { readonly estimate: true };
      readonly raw?: JsonValue;
    })
  | (EventBase & {
      readonly type: 'turn.completed';
      readonly turnId: string;
      readonly result: TurnResult;
      readonly raw?: JsonValue;
    })
  | (EventBase & {
      readonly type: 'session.state';
      readonly state: 'idle' | 'running' | 'requires_action' | (string & {});
      readonly raw: JsonValue;
    })
  | (EventBase & { readonly type: 'background.tasks'; readonly raw: JsonValue })
  | (EventBase & {
      readonly type: 'stalled';
      readonly silentForMs: number;
      readonly turnId?: string;
      readonly pendingPermissions: number;
      readonly raw?: JsonValue;
    })
  | (EventBase & {
      readonly type: 'diagnostic';
      readonly code: DiagnosticCode;
      readonly message: string;
      readonly data?: JsonObject;
      readonly raw?: JsonValue;
    })
  | (EventBase & { readonly type: 'gap'; readonly dropped: number; readonly raw?: JsonValue })
  | (EventBase & {
      readonly type: 'session.terminated';
      readonly intent: string;
      readonly outcome: string;
      readonly exitCode?: number;
      readonly signal?: string;
      readonly raw?: JsonValue;
    })
  | (EventBase & {
      readonly type: 'harness.frame';
      readonly frameType: string;
      readonly subtype?: string;
      readonly raw: JsonValue;
    })
  | (EventBase & { readonly type: string & {}; readonly raw?: JsonValue });
