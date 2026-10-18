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
  /** The id of the session the event belongs to. */
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
  /** Input tokens, as the harness reported them. */
  readonly inputTokens?: number;
  /** Output tokens, as the harness reported them. */
  readonly outputTokens?: number;
  /** Tokens written to the prompt cache, as the harness reported them. */
  readonly cacheCreationInputTokens?: number;
  /** Tokens read from the prompt cache, as the harness reported them. */
  readonly cacheReadInputTokens?: number;
  /** Cost in US dollars, as the harness estimated it (a client-side estimate). */
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
  /** The turn id: a UUID hudhud generated for the turn. */
  readonly turnId: string;
  /** The id of the session the turn ran in. */
  readonly sessionId: string;
  /** How the turn ended (open). */
  readonly outcome: TurnOutcome;
  /** Whether the turn ended with an error; it is still a result, not a failure (K21). */
  readonly isError: boolean;
  /** The final text of the turn, when the harness reported one. Untrusted. */
  readonly text?: string;
  /** Why the model stopped (open). */
  readonly stopReason?: StopReason;
  /** The harness's own reason for ending the turn, as reported. */
  readonly terminalReason?: string;
  /** Error messages the harness reported for the turn. Untrusted. */
  readonly errors?: readonly string[];
  /** The HTTP status of a failed model API request, as the harness reported it. */
  readonly apiErrorStatus?: number;
  /**
   * Token and cost figures as the harness reported them, unchanged; which
   * span they cover (the turn or the session) is the harness's, and the
   * adapter's documentation says.
   */
  readonly usage?: UsageTotals;
  /** The tool calls the harness denied during the turn. */
  readonly permissionDenials: readonly { readonly toolName: string; readonly toolUseId: string }[];
  /** True when hudhud synthesized the result (no harness result arrived). */
  readonly synthesized: boolean;
  /** The harness's own result frame; absent when the result was synthesized. */
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
  | 'turn.repeated-init'
  | 'stdout.error'
  | 'termination.ladder'
  | 'termination.sweep-after-exit'
  | 'binding.machine-error'
  | 'events.pre-handshake-truncated'
  | 'security.posture'
  | 'settings-guard.allowed'
  | 'settings-guard.git-root-unresolved'
  | 'settings-guard.symlink-followed'
  | 'session.id-in-use'
  | (string & {});

/**
 * The tested version window of a harness and where a version falls in it.
 *
 * @public
 */
export interface CompatInfo {
  /** The harness, for example `claude-code`. */
  readonly harness: string;
  /** The probed version of the harness binary. */
  readonly version: string;
  /** The oldest version the adapter was tested with. */
  readonly minTested: string;
  /** The newest version the adapter was tested with. */
  readonly maxTested: string;
  /** Versions listed as known broken: refused at connect unless the adapter's opt-in is set. */
  readonly knownBroken: readonly string[];
  /** Where the version falls (open: later versions may add values). */
  readonly status: 'tested' | 'untested' | 'known-broken' | (string & {});
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
      readonly mode: 'create' | 'resume' | 'fork' | (string & {});
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
      readonly origin: 'application' | 'harness' | (string & {});
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
      readonly status: 'pending' | (string & {});
      readonly input: JsonValue;
      readonly raw: JsonValue;
    })
  | (EventBase & {
      readonly type: 'tool.result';
      readonly turnId?: string;
      readonly toolUseId: string;
      readonly status: 'completed' | 'failed' | (string & {});
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
      readonly behavior: 'allow' | 'deny' | 'cancelled' | (string & {});
      readonly by: 'application' | 'harness' | 'close' | 'abort' | (string & {});
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
      /**
       * The termination intent hudhud recorded before any signal
       * (`TerminationIntent`, `none` when hudhud did not end the process).
       * Deterministic for a given sequence of harness output and calls.
       */
      readonly intent: string;
      /**
       * How the session ended (`SessionOutcome`), classified from the intent
       * and the exit (plan §3.3). Deterministic, and what applications decide
       * on.
       */
      readonly outcome: string;
      /**
       * The raw exit code as the OS reported it. An observation, not a
       * verdict: the same session can end with different codes by race (for
       * example a launcher that exits 7 on its own SIGTERM handler versus a
       * SIGKILL that lands first). Decide on `outcome`, never on this.
       */
      readonly exitCode?: number;
      /** The raw signal as the OS reported it; an observation like `exitCode`. */
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
