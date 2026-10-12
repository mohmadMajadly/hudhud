// Frames the Claude Code CLI writes to stdout: source of
// schemas/wire-inbound.schema.json. Lenient (ADR-0005 §7): every object
// accepts unknown keys, and only the routing envelope is required
// (`InboundEnvelope`). The frame views below type the fields the machines
// read; each is optional unless routing needs it. Shapes come from observed
// frames (05, 07) and the MIT Python SDK only (ADR-0015).

import Type, { type TProperties } from 'typebox';

import {
  JsonObjectSchema,
  JsonValueSchema,
  list,
  type SchemaDocument,
} from '../../core/schema-src/common.js';

const open = { additionalProperties: true } as const;

/** An object that accepts unknown keys. */
function lenient<Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, open);
}

const CONTROL_TYPES = [
  'control_request',
  'control_response',
  'control_cancel_request',
  'keep_alive',
];

const optionalString = Type.Optional(Type.String());
const optionalInteger = Type.Optional(Type.Integer());
const optionalStrings = Type.Optional(list(Type.String()));
const conversationIds = {
  session_id: optionalString,
  uuid: optionalString,
};
const parentToolUseId = Type.Optional(Type.Union([Type.String(), Type.Null()]));

// ---- routing envelope --------------------------------------------------------

export const ControlRequestFrame = lenient({
  type: Type.Literal('control_request'),
  request_id: Type.String(),
  request: lenient({ subtype: Type.String() }),
});

export const ControlResponseEnvelope = lenient({
  type: Type.Literal('control_response'),
  response: lenient({ subtype: Type.String(), request_id: Type.String() }),
});

export const ControlCancelRequestFrame = lenient({
  type: Type.Literal('control_cancel_request'),
  request_id: Type.String(),
});

export const KeepAliveFrame = lenient({ type: Type.Literal('keep_alive') });

export const ConversationEnvelope = lenient({
  type: Type.Unsafe<string>({ type: 'string', not: { enum: CONTROL_TYPES } }),
  subtype: optionalString,
  ...conversationIds,
});

export const InboundEnvelope = Type.Union([
  ControlRequestFrame,
  ControlResponseEnvelope,
  ControlCancelRequestFrame,
  KeepAliveFrame,
  ConversationEnvelope,
]);

// ---- control protocol views --------------------------------------------------

export const ControlResponseSuccessFrame = lenient({
  type: Type.Literal('control_response'),
  response: lenient({
    subtype: Type.Literal('success'),
    request_id: Type.String(),
    response: Type.Optional(JsonObjectSchema),
  }),
});

export const ControlResponseErrorFrame = lenient({
  type: Type.Literal('control_response'),
  response: lenient({
    subtype: Type.Literal('error'),
    request_id: Type.String(),
    error: optionalString,
  }),
});

export const ControlResponseFrame = Type.Union([
  ControlResponseSuccessFrame,
  ControlResponseErrorFrame,
]);

export const InitializeResponse = lenient({
  pid: Type.Optional(Type.Integer({ minimum: 0 })),
  claude_code_version: optionalString,
  account: Type.Optional(lenient({ apiKeySource: optionalString })),
  models: Type.Optional(list(lenient({ value: optionalString }))),
  capabilities: optionalStrings,
  current_permission_mode: optionalString,
});

export const InterruptResponse = lenient({
  still_queued: optionalStrings,
  cancelled: optionalStrings,
});

export const CanUseToolRequest = lenient({
  subtype: Type.Literal('can_use_tool'),
  tool_name: Type.String(),
  input: JsonObjectSchema,
  tool_use_id: Type.String(),
  display_name: optionalString,
  description: optionalString,
  permission_suggestions: Type.Optional(list(JsonValueSchema)),
  blocked_path: optionalString,
  decision_reason_type: optionalString,
});

export const CanUseToolRequestFrame = lenient({
  type: Type.Literal('control_request'),
  request_id: Type.String(),
  request: CanUseToolRequest,
});

// ---- conversation views -------------------------------------------------------

export const SystemFrame = lenient({
  type: Type.Literal('system'),
  subtype: Type.String(),
  ...conversationIds,
});

export const SystemInitFrame = lenient({
  type: Type.Literal('system'),
  subtype: Type.Literal('init'),
  ...conversationIds,
  permissionMode: optionalString,
  capabilities: optionalStrings,
  model: optionalString,
  claude_code_version: optionalString,
  apiKeySource: optionalString,
});

export const ApiRetryFrame = lenient({
  type: Type.Literal('system'),
  subtype: Type.Literal('api_retry'),
  ...conversationIds,
  attempt: optionalInteger,
  max_retries: optionalInteger,
  retry_delay_ms: Type.Optional(Type.Number()),
  error_status: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  error: optionalString,
});

export const SessionStateChangedFrame = lenient({
  type: Type.Literal('system'),
  subtype: Type.Literal('session_state_changed'),
  ...conversationIds,
  state: optionalString,
  sdk_host_only: Type.Optional(Type.Boolean()),
});

export const PermissionDeniedFrame = lenient({
  type: Type.Literal('system'),
  subtype: Type.Literal('permission_denied'),
  ...conversationIds,
  tool_name: optionalString,
  tool_use_id: optionalString,
  message: optionalString,
  decision_reason_type: optionalString,
});

export const AssistantFrame = lenient({
  type: Type.Literal('assistant'),
  ...conversationIds,
  parent_tool_use_id: parentToolUseId,
  message: Type.Optional(JsonObjectSchema),
  error: optionalString,
});

export const UserFrame = lenient({
  type: Type.Literal('user'),
  ...conversationIds,
  parent_tool_use_id: parentToolUseId,
  message: Type.Optional(JsonObjectSchema),
});

export const StreamEventFrame = lenient({
  type: Type.Literal('stream_event'),
  ...conversationIds,
  parent_tool_use_id: parentToolUseId,
  event: Type.Optional(JsonObjectSchema),
});

export const ResultFrame = lenient({
  type: Type.Literal('result'),
  subtype: optionalString,
  ...conversationIds,
  is_error: Type.Optional(Type.Boolean()),
  result: optionalString,
  errors: optionalStrings,
  terminal_reason: optionalString,
  api_error_status: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  user_message_uuid: optionalString,
  user_message_uuids: optionalStrings,
  usage: Type.Optional(JsonObjectSchema),
  total_cost_usd: Type.Optional(Type.Number()),
  num_turns: Type.Optional(Type.Integer({ minimum: 0 })),
  permission_denials: Type.Optional(
    list(lenient({ tool_name: optionalString, tool_use_id: optionalString })),
  ),
});

export const CommandLifecycleFrame = lenient({
  type: Type.Literal('command_lifecycle'),
  command_uuid: optionalString,
  state: optionalString,
});

export const UnknownFrame = lenient({ type: Type.String() });

export const wireInboundDocument: SchemaDocument = {
  file: 'wire-inbound.schema.json',
  title: 'Claude Code wire frames read by hudhud',
  description:
    'Lenient: every object accepts unknown keys. The root checks only the routing envelope; the named frame views type the fields hudhud reads, each optional unless routing needs it.',
  root: 'InboundEnvelope',
  defs: {
    ControlRequestFrame,
    ControlResponseEnvelope,
    ControlCancelRequestFrame,
    KeepAliveFrame,
    ConversationEnvelope,
    InboundEnvelope,
    ControlResponseSuccessFrame,
    ControlResponseErrorFrame,
    ControlResponseFrame,
    InitializeResponse,
    InterruptResponse,
    CanUseToolRequest,
    CanUseToolRequestFrame,
    SystemFrame,
    SystemInitFrame,
    ApiRetryFrame,
    SessionStateChangedFrame,
    PermissionDeniedFrame,
    AssistantFrame,
    UserFrame,
    StreamEventFrame,
    ResultFrame,
    CommandLifecycleFrame,
    UnknownFrame,
  },
};
