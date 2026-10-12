// Frames hudhud writes to the Claude Code CLI: source of
// schemas/wire-outbound.schema.json. Strict (ADR-0005 §7): every object
// refuses unknown keys, so `initialize.workspaceTrust` cannot be sent
// (ADR-0012 §2, J3). Shapes come from observed frames (05, 07) and the MIT
// Python SDK only (ADR-0015).

import Type, { type TProperties } from 'typebox';

import { JsonObjectSchema, list, type SchemaDocument } from '../../core/schema-src/common.js';

const closed = { additionalProperties: false } as const;

/** An object that refuses unknown keys. */
function strict<Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, closed);
}

const RequestId = Type.String({ minLength: 1 });

export const PermissionModeWire = Type.Enum([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'auto',
  'bypassPermissions',
]);

export const InitializeRequestFrame = strict({
  type: Type.Literal('control_request'),
  request_id: RequestId,
  request: strict({
    subtype: Type.Literal('initialize'),
    appendSystemPrompt: Type.Optional(Type.String()),
    systemPrompt: Type.Optional(list(Type.String())),
  }),
});

export const InterruptRequestFrame = strict({
  type: Type.Literal('control_request'),
  request_id: RequestId,
  request: strict({ subtype: Type.Literal('interrupt'), cancel_queued: Type.Boolean() }),
});

export const SetPermissionModeRequestFrame = strict({
  type: Type.Literal('control_request'),
  request_id: RequestId,
  request: strict({ subtype: Type.Literal('set_permission_mode'), mode: PermissionModeWire }),
});

export const UserContentBlockWire = Type.Union([
  strict({ type: Type.Literal('text'), text: Type.String() }),
  strict({
    type: Type.Literal('image'),
    source: strict({
      type: Type.Literal('base64'),
      media_type: Type.Enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      data: Type.String(),
    }),
  }),
]);

export const UserContentWire = Type.Union([Type.String(), list(UserContentBlockWire)]);

export const UserMessageFrame = strict({
  type: Type.Literal('user'),
  message: strict({ role: Type.Literal('user'), content: UserContentWire }),
  parent_tool_use_id: Type.Optional(Type.Null()),
  session_id: Type.Optional(Type.String()),
  uuid: Type.String({ minLength: 1 }),
  priority: Type.Optional(Type.Enum(['now', 'next', 'later'])),
});

export const PermissionDecisionWire = Type.Union([
  strict({
    behavior: Type.Literal('allow'),
    updatedInput: Type.Optional(JsonObjectSchema),
    updatedPermissions: Type.Optional(list(JsonObjectSchema, { maxItems: 4096 })),
  }),
  strict({
    behavior: Type.Literal('deny'),
    message: Type.String(),
    interrupt: Type.Optional(Type.Boolean()),
  }),
]);

export const PermissionResponseFrame = strict({
  type: Type.Literal('control_response'),
  response: strict({
    subtype: Type.Literal('success'),
    request_id: RequestId,
    response: PermissionDecisionWire,
  }),
});

export const ControlErrorResponseFrame = strict({
  type: Type.Literal('control_response'),
  response: strict({
    subtype: Type.Literal('error'),
    request_id: RequestId,
    error: Type.String(),
  }),
});

export const OutboundFrame = Type.Union([
  InitializeRequestFrame,
  InterruptRequestFrame,
  SetPermissionModeRequestFrame,
  UserMessageFrame,
  PermissionResponseFrame,
  ControlErrorResponseFrame,
]);

export const wireOutboundDocument: SchemaDocument = {
  file: 'wire-outbound.schema.json',
  title: 'Claude Code wire frames written by hudhud',
  description:
    'Strict: every frame hudhud writes to the CLI stdin must match, and unknown keys are refused.',
  root: 'OutboundFrame',
  defs: {
    PermissionModeWire,
    InitializeRequestFrame,
    InterruptRequestFrame,
    SetPermissionModeRequestFrame,
    UserContentBlockWire,
    UserContentWire,
    UserMessageFrame,
    PermissionDecisionWire,
    PermissionResponseFrame,
    ControlErrorResponseFrame,
    OutboundFrame,
  },
};
