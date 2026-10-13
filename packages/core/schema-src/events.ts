// Neutral event vocabulary (plan §2.2): source of schemas/events.schema.json.
// The handwritten public types live in src/protocol/events/types.ts; a
// type-level test asserts that both accept the same values.

import Type, { type TProperties } from 'typebox';

import {
  Count,
  JsonObjectSchema,
  JsonValueSchema,
  list,
  openEnum,
  type SchemaDocument,
} from './common.js';

export const ToolKind = openEnum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
] as const);

export const StopReason = openEnum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const);

export const TurnOutcome = openEnum([
  'completed',
  'error',
  'cancelled',
  'max-turns',
  'max-budget',
  'unknown',
] as const);

export const DiagnosticCode = openEnum([
  'env.dropped',
  'env.added',
  'env.removed',
  'binary.launcher-detected',
  'binary.version-changed',
  'binary.unverified',
  'project.permissions-ignored',
  'containment.fallback',
  'containment.addon-unavailable',
  'stdout.non-json-line',
  'frame.skipped-oversized',
  'interrupt.still-queued-retry',
  'session.id-mismatch',
  'control.unknown-response',
  'control.late-response',
  'control.duplicate-request',
  'control.unknown-cancel',
  'control.unsupported-request',
  'control.unanswered-request',
  'control.malformed-request',
  'control.answer-not-pending',
  'control.answer-failed',
  'permission.malformed-request',
  'permission.duplicate-request',
  'permission.unknown-request',
  'permission.invalid-decision',
  'permission.handler-failed',
  'permission.updates-stripped',
  'permission.ignored-after-abort',
  'permission.duplicate-request-id',
  'stdin.error',
  'turn.unmatched-result',
  'turn.dropped',
  'stdout.error',
  'termination.ladder',
  'termination.sweep-after-exit',
  'binding.machine-error',
] as const);

const usageProperties = {
  inputTokens: Type.Optional(Count),
  outputTokens: Type.Optional(Count),
  cacheCreationInputTokens: Type.Optional(Count),
  cacheReadInputTokens: Type.Optional(Count),
  costUsd: Type.Optional(Type.Number({ minimum: 0 })),
};

export const UsageTotals = Type.Object(usageProperties);

export const TurnResult = Type.Object({
  turnId: Type.String(),
  sessionId: Type.String(),
  outcome: TurnOutcome,
  isError: Type.Boolean(),
  text: Type.Optional(Type.String()),
  stopReason: Type.Optional(StopReason),
  terminalReason: Type.Optional(Type.String()),
  errors: Type.Optional(list(Type.String())),
  apiErrorStatus: Type.Optional(Type.Integer()),
  usage: Type.Optional(UsageTotals),
  permissionDenials: list(Type.Object({ toolName: Type.String(), toolUseId: Type.String() })),
  synthesized: Type.Boolean(),
  raw: Type.Optional(JsonValueSchema),
});

export const CompatInfo = Type.Object({
  harness: Type.String(),
  version: Type.String(),
  minTested: Type.String(),
  maxTested: Type.String(),
  knownBroken: list(Type.String()),
  status: Type.Enum(['tested', 'untested', 'known-broken']),
});

/** An event arm: the shared base fields, a literal `type`, then the arm's fields. */
function event<const Name extends string, Properties extends TProperties>(
  type: Name,
  properties: Properties,
) {
  return Type.Object({
    seq: Count,
    ts: Type.String(),
    sessionId: Type.String(),
    type: Type.Literal(type),
    ...properties,
  });
}

const raw = JsonValueSchema;
const optionalRaw = Type.Optional(JsonValueSchema);
const turnId = Type.String();
const optionalTurnId = Type.Optional(Type.String());

export const CompatEvent = event('compat', { compat: CompatInfo, raw: optionalRaw });
export const SessionStartedEvent = event('session.started', {
  mode: Type.Enum(['create', 'resume', 'fork']),
  pid: Count,
  cliPid: Type.Optional(Count),
  version: Type.String(),
  apiKeySource: Type.Optional(Type.String()),
  tokenSource: Type.Optional(Type.String()),
  permissionMode: Type.Optional(Type.String()),
  raw,
});
export const TurnQueuedEvent = event('turn.queued', { turnId });
export const TurnStartedEvent = event('turn.started', {
  turnId,
  origin: Type.Enum(['application', 'harness']),
  features: list(Type.String()),
  model: Type.Optional(Type.String()),
  raw,
});
export const MessageAssistantEvent = event('message.assistant', {
  turnId: optionalTurnId,
  text: Type.Optional(Type.String()),
  aborted: Type.Optional(Type.Boolean()),
  raw,
});
export const MessageDeltaEvent = event('message.delta', {
  turnId: optionalTurnId,
  index: Count,
  deltaType: openEnum(['text', 'thinking', 'input_json'] as const),
  text: Type.Optional(Type.String()),
  raw,
});
export const ToolCallEvent = event('tool.call', {
  turnId: optionalTurnId,
  toolUseId: Type.String(),
  toolName: Type.String(),
  kind: ToolKind,
  status: Type.Literal('pending'),
  input: JsonValueSchema,
  raw,
});
export const ToolResultEvent = event('tool.result', {
  turnId: optionalTurnId,
  toolUseId: Type.String(),
  status: Type.Enum(['completed', 'failed']),
  raw,
});
export const PermissionRequestedEvent = event('permission.requested', {
  requestId: Type.String(),
  turnId: optionalTurnId,
  toolName: Type.String(),
  toolUseId: Type.String(),
  raw,
});
export const PermissionResolvedEvent = event('permission.resolved', {
  requestId: Type.String(),
  behavior: Type.Enum(['allow', 'deny', 'cancelled']),
  by: Type.Enum(['application', 'harness', 'close', 'abort']),
  raw: optionalRaw,
});
export const PermissionDeniedEvent = event('permission.denied', {
  toolName: Type.String(),
  toolUseId: Type.String(),
  reasonType: Type.Optional(Type.String()),
  raw,
});
export const ApiRetryEvent = event('api.retry', {
  attempt: Count,
  maxRetries: Type.Optional(Count),
  retryDelayMs: Type.Optional(Type.Number({ minimum: 0 })),
  errorStatus: Type.Optional(Type.Integer()),
  error: Type.Optional(Type.String()),
  raw,
});
export const UsageUpdateEvent = event('usage.update', {
  turnId: optionalTurnId,
  reported: UsageTotals,
  estimatedDelta: Type.Object({ ...usageProperties, estimate: Type.Literal(true) }),
  raw: optionalRaw,
});
export const TurnCompletedEvent = event('turn.completed', {
  turnId,
  result: TurnResult,
  raw: optionalRaw,
});
export const SessionStateEvent = event('session.state', {
  state: openEnum(['idle', 'running', 'requires_action'] as const),
  raw,
});
export const BackgroundTasksEvent = event('background.tasks', { raw });
export const StalledEvent = event('stalled', {
  silentForMs: Count,
  turnId: optionalTurnId,
  pendingPermissions: Count,
  raw: optionalRaw,
});
export const DiagnosticEvent = event('diagnostic', {
  code: DiagnosticCode,
  message: Type.String(),
  data: Type.Optional(JsonObjectSchema),
  raw: optionalRaw,
});
export const GapEvent = event('gap', { dropped: Count, raw: optionalRaw });
export const SessionTerminatedEvent = event('session.terminated', {
  intent: Type.String({
    description:
      'The termination intent hudhud recorded before any signal (none when hudhud did not end the process). Deterministic.',
  }),
  outcome: Type.String({
    description:
      'How the session ended, classified from the intent and the exit. Deterministic: decide on this.',
  }),
  exitCode: Type.Optional(
    Type.Integer({
      description:
        'The raw exit code as the OS reported it: an observation that can differ by race, never a verdict. Decide on outcome.',
    }),
  ),
  signal: Type.Optional(
    Type.String({
      description: 'The raw signal as the OS reported it: an observation like exitCode.',
    }),
  ),
  raw: optionalRaw,
});
export const HarnessFrameEvent = event('harness.frame', {
  frameType: Type.String(),
  subtype: Type.Optional(Type.String()),
  raw,
});

/** Every known event arm; validates the events hudhud itself produces. */
export const KnownHudhudEvent = Type.Union([
  CompatEvent,
  SessionStartedEvent,
  TurnQueuedEvent,
  TurnStartedEvent,
  MessageAssistantEvent,
  MessageDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  PermissionRequestedEvent,
  PermissionResolvedEvent,
  PermissionDeniedEvent,
  ApiRetryEvent,
  UsageUpdateEvent,
  TurnCompletedEvent,
  SessionStateEvent,
  BackgroundTasksEvent,
  StalledEvent,
  DiagnosticEvent,
  GapEvent,
  SessionTerminatedEvent,
  HarnessFrameEvent,
]);

/** The open arm: an event type added later still has the base fields. */
export const OpenHudhudEvent = Type.Object({
  seq: Count,
  ts: Type.String(),
  sessionId: Type.String(),
  type: Type.String(),
  raw: optionalRaw,
});

/** Every event a reader must accept. */
export const HudhudEvent = Type.Union([KnownHudhudEvent, OpenHudhudEvent]);

export const eventsDocument: SchemaDocument = {
  file: 'events.schema.json',
  title: 'hudhud events',
  description:
    'Harness-neutral session events. Enums with a plain string arm are open: unknown values are accepted on read. Unknown event types match OpenHudhudEvent.',
  root: 'HudhudEvent',
  defs: {
    ToolKind,
    StopReason,
    TurnOutcome,
    DiagnosticCode,
    UsageTotals,
    TurnResult,
    CompatInfo,
    CompatEvent,
    SessionStartedEvent,
    TurnQueuedEvent,
    TurnStartedEvent,
    MessageAssistantEvent,
    MessageDeltaEvent,
    ToolCallEvent,
    ToolResultEvent,
    PermissionRequestedEvent,
    PermissionResolvedEvent,
    PermissionDeniedEvent,
    ApiRetryEvent,
    UsageUpdateEvent,
    TurnCompletedEvent,
    SessionStateEvent,
    BackgroundTasksEvent,
    StalledEvent,
    DiagnosticEvent,
    GapEvent,
    SessionTerminatedEvent,
    HarnessFrameEvent,
    KnownHudhudEvent,
    OpenHudhudEvent,
    HudhudEvent,
  },
};
