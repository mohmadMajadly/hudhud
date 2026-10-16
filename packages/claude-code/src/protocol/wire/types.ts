/**
 * Claude Code stream-json and control protocol frames (plan §1.5, K3).
 *
 * @remarks
 * Derived from frames observed with the pinned CLI (research 05, 07) and the
 * MIT-licensed Python Agent SDK; nothing is taken from the proprietary
 * TypeScript SDK (ADR-0015). Mirrored by `schemas/wire-outbound.schema.json`
 * (strict: hudhud authors these frames) and `schemas/wire-inbound.schema.json`
 * (lenient: the CLI adds fields on most releases, ADR-0005 §7); a type-level
 * test asserts that each type and its schema source accept the same values.
 *
 * Inbound types name only the fields the machines read. Every other field
 * stays in the raw frame. Except for the routing envelope, every typed field
 * of an inbound frame is optional and must be read defensively.
 *
 * @packageDocumentation
 */

import type { JsonObject, JsonValue } from '@hudhudjs/core/protocol';

// ---- outbound: hudhud to CLI (strict) ---------------------------------------

/**
 * Permission modes hudhud may set (K11; `manual` is not offered in v1).
 *
 * @internal
 */
export type PermissionModeWire =
  'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto' | 'bypassPermissions';

/**
 * The `initialize` request fields hudhud sends in v1: none. There is no
 * `workspaceTrust` field: it cannot be sent (ADR-0012 §2, J3). System prompts are not sent in
 * `initialize`: `appendSystemPrompt`, `systemPrompt` and the user frame
 * `priority` were removed because no observed frame (research 05, 07) and
 * not the MIT Python SDK carries them (ADR-0015 provenance; lead ruling at
 * the W1 close). System prompts go through the documented CLI flags.
 *
 * @internal
 */
export type InitializeBody = Readonly<Record<string, never>>;

/** @internal */
export interface InitializeRequestFrame {
  readonly type: 'control_request';
  readonly request_id: string;
  readonly request: { readonly subtype: 'initialize' };
}

/** @internal */
export interface InterruptRequestFrame {
  readonly type: 'control_request';
  readonly request_id: string;
  readonly request: { readonly subtype: 'interrupt'; readonly cancel_queued: boolean };
}

/** @internal */
export interface SetPermissionModeRequestFrame {
  readonly type: 'control_request';
  readonly request_id: string;
  readonly request: { readonly subtype: 'set_permission_mode'; readonly mode: PermissionModeWire };
}

/**
 * A user content block in Messages API form.
 *
 * @internal
 */
export type UserContentBlockWire =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly source: {
        readonly type: 'base64';
        readonly media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
        readonly data: string;
      };
    };

/** @internal */
export type UserContentWire = string | readonly UserContentBlockWire[];

/**
 * A user message on stdin. `uuid` is echoed in `result.user_message_uuid(s)`
 * and enables `command_lifecycle` frames (05 §5). There is no `priority`
 * field (ADR-0015; lead ruling at the W1 close: not seen in observed frames
 * or the MIT Python SDK).
 *
 * @internal
 */
export interface UserMessageFrame {
  readonly type: 'user';
  readonly message: { readonly role: 'user'; readonly content: UserContentWire };
  readonly parent_tool_use_id?: null;
  readonly session_id?: string;
  readonly uuid: string;
}

/**
 * The answer to `can_use_tool`. At most 4096 permission updates (larger
 * lists are rejected locally, plan §1.5).
 *
 * @internal
 */
export type PermissionDecisionWire =
  | {
      readonly behavior: 'allow';
      readonly updatedInput?: JsonObject;
      readonly updatedPermissions?: readonly JsonObject[];
    }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: boolean };

/** @internal */
export interface PermissionResponseFrame {
  readonly type: 'control_response';
  readonly response: {
    readonly subtype: 'success';
    readonly request_id: string;
    readonly response: PermissionDecisionWire;
  };
}

/** @internal */
export interface ControlErrorResponseFrame {
  readonly type: 'control_response';
  readonly response: {
    readonly subtype: 'error';
    readonly request_id: string;
    readonly error: string;
  };
}

/**
 * Every frame hudhud writes. Unknown keys are refused.
 *
 * @internal
 */
export type OutboundFrame =
  | InitializeRequestFrame
  | InterruptRequestFrame
  | SetPermissionModeRequestFrame
  | UserMessageFrame
  | PermissionResponseFrame
  | ControlErrorResponseFrame;

// ---- inbound: CLI to hudhud (lenient) ---------------------------------------

/** @internal */
export interface ControlRequestFrame {
  readonly type: 'control_request';
  readonly request_id: string;
  readonly request: { readonly subtype: string };
}

/** @internal */
export interface ControlResponseEnvelope {
  readonly type: 'control_response';
  readonly response: { readonly subtype: string; readonly request_id: string };
}

/** @internal */
export interface ControlCancelRequestFrame {
  readonly type: 'control_cancel_request';
  readonly request_id: string;
}

/** @internal */
export interface KeepAliveFrame {
  readonly type: 'keep_alive';
}

/**
 * Any frame that is not part of the control protocol. Its `type` is none of
 * the four control types.
 *
 * @internal
 */
export interface ConversationEnvelope {
  readonly type: string;
  readonly subtype?: string;
  readonly uuid?: string;
  readonly session_id?: string;
}

/**
 * The routing envelope every inbound frame must satisfy. A frame that fails
 * it has a routing field of the wrong JSON type.
 *
 * @internal
 */
export type InboundEnvelope =
  | ControlRequestFrame
  | ControlResponseEnvelope
  | ControlCancelRequestFrame
  | KeepAliveFrame
  | ConversationEnvelope;

/** @internal */
export interface ControlResponseSuccessFrame {
  readonly type: 'control_response';
  readonly response: {
    readonly subtype: 'success';
    readonly request_id: string;
    readonly response?: JsonObject;
  };
}

/** @internal */
export interface ControlResponseErrorFrame {
  readonly type: 'control_response';
  readonly response: {
    readonly subtype: 'error';
    readonly request_id: string;
    readonly error?: string;
  };
}

/** @internal */
export type ControlResponseFrame = ControlResponseSuccessFrame | ControlResponseErrorFrame;

/**
 * The body (`response.response`) of the `initialize` success response
 * (05 §5).
 *
 * @internal
 */
export interface InitializeResponse {
  readonly pid?: number;
  readonly claude_code_version?: string;
  readonly account?: { readonly apiKeySource?: string };
  readonly models?: readonly { readonly value?: string }[];
  readonly capabilities?: readonly string[];
  readonly current_permission_mode?: string;
}

/**
 * The body of the `interrupt` success response (05 §7).
 *
 * @internal
 */
export interface InterruptResponse {
  readonly still_queued?: readonly string[];
  readonly cancelled?: readonly string[];
}

/**
 * The `request` of a `can_use_tool` control request (05 §6).
 *
 * @internal
 */
export interface CanUseToolRequest {
  readonly subtype: 'can_use_tool';
  readonly tool_name: string;
  readonly input: JsonObject;
  readonly tool_use_id: string;
  readonly display_name?: string;
  readonly description?: string;
  /** Passed through as raw data, never applied or shape-checked (D17). */
  readonly permission_suggestions?: readonly JsonValue[];
  readonly blocked_path?: string;
  readonly decision_reason_type?: string;
}

/** @internal */
export interface CanUseToolRequestFrame {
  readonly type: 'control_request';
  readonly request_id: string;
  readonly request: CanUseToolRequest;
}

/** @internal */
export interface SystemFrame {
  readonly type: 'system';
  readonly subtype: string;
  readonly session_id?: string;
  readonly uuid?: string;
}

/**
 * `system/init`: one per turn, after the user message (05 §5).
 *
 * @internal
 */
export interface SystemInitFrame {
  readonly type: 'system';
  readonly subtype: 'init';
  readonly session_id?: string;
  readonly uuid?: string;
  readonly permissionMode?: string;
  readonly capabilities?: readonly string[];
  readonly model?: string;
  readonly claude_code_version?: string;
  readonly apiKeySource?: string;
}

/**
 * `system/api_retry` (05 §9).
 *
 * @internal
 */
export interface ApiRetryFrame {
  readonly type: 'system';
  readonly subtype: 'api_retry';
  readonly session_id?: string;
  readonly uuid?: string;
  readonly attempt?: number;
  readonly max_retries?: number;
  readonly retry_delay_ms?: number;
  readonly error_status?: number | null;
  readonly error?: string;
}

/**
 * `system/session_state_changed` (05 §12).
 *
 * @internal
 */
export interface SessionStateChangedFrame {
  readonly type: 'system';
  readonly subtype: 'session_state_changed';
  readonly session_id?: string;
  readonly uuid?: string;
  readonly state?: string;
  readonly sdk_host_only?: boolean;
}

/**
 * `system/permission_denied` (05 §6).
 *
 * @internal
 */
export interface PermissionDeniedFrame {
  readonly type: 'system';
  readonly subtype: 'permission_denied';
  readonly session_id?: string;
  readonly uuid?: string;
  readonly tool_name?: string;
  readonly tool_use_id?: string;
  readonly message?: string;
  readonly decision_reason_type?: string;
}

/** @internal */
export interface AssistantFrame {
  readonly type: 'assistant';
  readonly session_id?: string;
  readonly uuid?: string;
  readonly parent_tool_use_id?: string | null;
  readonly message?: JsonObject;
  /** For example `authentication_failed` on a synthetic error message (05 §9). */
  readonly error?: string;
}

/** @internal */
export interface UserFrame {
  readonly type: 'user';
  readonly session_id?: string;
  readonly uuid?: string;
  readonly parent_tool_use_id?: string | null;
  readonly message?: JsonObject;
}

/** @internal */
export interface StreamEventFrame {
  readonly type: 'stream_event';
  readonly session_id?: string;
  readonly uuid?: string;
  readonly parent_tool_use_id?: string | null;
  readonly event?: JsonObject;
}

/**
 * `result`: the end of a turn (05 §7, §9; 07 §1 for a failure result before
 * the `initialize` response).
 *
 * @internal
 */
export interface ResultFrame {
  readonly type: 'result';
  readonly subtype?: string;
  readonly session_id?: string;
  readonly uuid?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly errors?: readonly string[];
  readonly terminal_reason?: string;
  readonly api_error_status?: number | null;
  readonly user_message_uuid?: string;
  readonly user_message_uuids?: readonly string[];
  readonly usage?: JsonObject;
  readonly total_cost_usd?: number;
  readonly num_turns?: number;
  readonly permission_denials?: readonly {
    readonly tool_name?: string;
    readonly tool_use_id?: string;
  }[];
}

/**
 * `command_lifecycle`, sent for user messages that carry a `uuid` when the
 * CLI advertises `msg_lifecycle_v1` (05 §5).
 *
 * @internal
 */
export interface CommandLifecycleFrame {
  readonly type: 'command_lifecycle';
  readonly command_uuid?: string;
  readonly state?: string;
}

/**
 * Any other frame: kept raw and surfaced as `harness.frame`.
 *
 * @internal
 */
export interface UnknownFrame {
  readonly type: string;
}
