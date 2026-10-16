/**
 * Claude stream-json frame to neutral event normalization (plan §1.5, §2.2;
 * ADR-0003, ADR-0016; ACP vocabulary, 06 §H12).
 *
 * @remarks
 * Sans-IO and total: `normalizeFrame` is a pure function of its arguments and
 * never throws, whatever the frame holds. Every event carries the whole frame
 * as `raw`. Text from the harness is carried as data; display sanitization is
 * the consumer's job (ADR-0012 §8). Untrusted objects are read with own-property
 * accessors only and are never spread. A frame that maps to no neutral event,
 * or whose fields are too malformed to build one, becomes a `harness.frame`
 * event, so no frame is dropped silently.
 *
 * Event identity (`seq`, `ts`, `sessionId`) is assigned by the caller; the
 * output omits those fields.
 *
 * @packageDocumentation
 */

import type {
  EventBase,
  HudhudEvent,
  JsonObject,
  JsonValue,
  StopReason,
  TurnOutcome,
  UsageTotals,
} from '@hudhudjs/core/protocol';
import {
  isJsonObject,
  ownArray,
  ownBoolean,
  ownNumber,
  ownObject,
  ownString,
} from '@hudhudjs/core/protocol';

import { claudeToolKind } from './tool-kind.js';

type EventOf<T extends string> = Extract<HudhudEvent, { readonly type: T }>;
type WithoutBase<E> = E extends unknown ? Omit<E, keyof EventBase> : never;

/**
 * A neutral event before the caller assigns `seq`, `ts` and `sessionId`.
 *
 * @internal
 */
export type ClaudeEventData = WithoutBase<
  | EventOf<'message.assistant'>
  | EventOf<'message.delta'>
  | EventOf<'tool.call'>
  | EventOf<'tool.result'>
  | EventOf<'permission.denied'>
  | EventOf<'api.retry'>
  | EventOf<'usage.update'>
  | EventOf<'session.state'>
  | EventOf<'background.tasks'>
  | EventOf<'harness.frame'>
>;

/**
 * What the caller knows that a frame does not say.
 *
 * @internal
 */
export interface NormalizeContext {
  /**
   * The turn the frame belongs to, as assigned by the turn machine; turn
   * scoped events omit `turnId` when it is absent.
   */
  readonly turnId?: string;
}

/**
 * Normalizes one inbound Claude frame into zero-loss neutral events.
 *
 * @remarks
 * Mapping: `system/api_retry` to
 * `api.retry`; `system/session_state_changed` to `session.state`;
 * `system/permission_denied` to `permission.denied`;
 * `system/background_tasks_changed` to `background.tasks`; `assistant` to
 * `message.assistant` plus one `tool.call` per `tool_use` block; `user` with
 * `tool_result` blocks to one `tool.result` each; `stream_event`
 * `content_block_delta` to `message.delta`. Everything else is `harness.frame`,
 * except two frames the turn machine owns: `system/init` yields no event, and
 * `result` yields only `usage.update` (when usage or cost is reported); the turn
 * machine builds `turn.started` and `turn.completed` (see {@link classifyResult}).
 *
 * @internal
 */
export function normalizeFrame(frame: JsonValue, ctx: NormalizeContext): ClaudeEventData[] {
  if (!isJsonObject(frame)) return [harnessFrame(frame, 'unknown')];
  const type = ownString(frame, 'type');
  // Owned by the turn machine, which reads these frames itself.
  if (type === 'result') return result(frame, ctx);
  if (type === 'system' && ownString(frame, 'subtype') === 'init') return [];
  const events = type === undefined ? [] : byType(type, frame, ctx);
  return events.length > 0 ? events : [harnessFrame(frame, type ?? 'unknown', subtypeOf(frame))];
}

function byType(type: string, frame: JsonObject, ctx: NormalizeContext): ClaudeEventData[] {
  switch (type) {
    case 'system':
      return system(frame);
    case 'assistant':
      return assistant(frame, ctx);
    case 'user':
      return user(frame, ctx);
    case 'stream_event':
      return streamEvent(frame, ctx);
    default:
      return [];
  }
}

/** The subtype a `harness.frame` reports: the frame's, or the request's. */
function subtypeOf(frame: JsonObject): string | undefined {
  const own = ownString(frame, 'subtype');
  if (own !== undefined) return own;
  const request = ownObject(frame, 'request');
  if (request !== undefined) return ownString(request, 'subtype');
  const event = ownObject(frame, 'event');
  return event === undefined ? undefined : ownString(event, 'type');
}

function harnessFrame(frame: JsonValue, frameType: string, subtype?: string): ClaudeEventData {
  return {
    type: 'harness.frame',
    frameType,
    ...(subtype === undefined ? {} : { subtype }),
    raw: frame,
  };
}

function turnField(ctx: NormalizeContext): { readonly turnId?: string } {
  return ctx.turnId === undefined ? {} : { turnId: ctx.turnId };
}

// ---- system ----------------------------------------------------------------

function system(frame: JsonObject): ClaudeEventData[] {
  switch (ownString(frame, 'subtype')) {
    case 'api_retry': {
      const attempt = ownNumber(frame, 'attempt');
      if (attempt === undefined) return [];
      const maxRetries = ownNumber(frame, 'max_retries');
      const retryDelayMs = ownNumber(frame, 'retry_delay_ms');
      const errorStatus = ownNumber(frame, 'error_status');
      const error = ownString(frame, 'error');
      return [
        {
          type: 'api.retry',
          attempt,
          ...(maxRetries === undefined ? {} : { maxRetries }),
          ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
          ...(errorStatus === undefined ? {} : { errorStatus }),
          ...(error === undefined ? {} : { error }),
          raw: frame,
        },
      ];
    }
    case 'session_state_changed': {
      const state = ownString(frame, 'state');
      return state === undefined ? [] : [{ type: 'session.state', state, raw: frame }];
    }
    case 'permission_denied': {
      const toolName = ownString(frame, 'tool_name');
      const toolUseId = ownString(frame, 'tool_use_id');
      if (toolName === undefined || toolUseId === undefined) return [];
      const reasonType = ownString(frame, 'decision_reason_type');
      return [
        {
          type: 'permission.denied',
          toolName,
          toolUseId,
          ...(reasonType === undefined ? {} : { reasonType }),
          raw: frame,
        },
      ];
    }
    case 'background_tasks_changed':
      return [{ type: 'background.tasks', raw: frame }];
    case undefined:
    default:
      return [];
  }
}

// ---- assistant and user ----------------------------------------------------

/** Own `message.content` blocks that are objects; a string content has none. */
function contentBlocks(message: JsonObject): JsonObject[] {
  return (ownArray(message, 'content') ?? []).filter(isJsonObject);
}

function assistant(frame: JsonObject, ctx: NormalizeContext): ClaudeEventData[] {
  const message = ownObject(frame, 'message');
  if (message === undefined) return [];
  const content = ownString(message, 'content');
  const texts: string[] = content === undefined ? [] : [content];
  const calls: ClaudeEventData[] = [];
  for (const block of contentBlocks(message)) {
    const blockType = ownString(block, 'type');
    const text = ownString(block, 'text');
    if (blockType === 'text' && text !== undefined) texts.push(text);
    const toolUseId = ownString(block, 'id');
    const toolName = ownString(block, 'name');
    const input = Object.hasOwn(block, 'input') ? block['input'] : undefined;
    if (blockType === 'tool_use' && toolUseId !== undefined && toolName !== undefined) {
      calls.push({
        type: 'tool.call',
        ...turnField(ctx),
        toolUseId,
        toolName,
        kind: claudeToolKind(toolName),
        status: 'pending',
        input: input === undefined ? {} : input,
        raw: frame,
      });
    }
  }
  const aborted = ownBoolean(frame, 'aborted') ?? ownBoolean(message, 'aborted');
  return [
    {
      type: 'message.assistant',
      ...turnField(ctx),
      ...(texts.length === 0 ? {} : { text: texts.join('') }),
      ...(aborted === undefined ? {} : { aborted }),
      raw: frame,
    },
    ...calls,
  ];
}

function user(frame: JsonObject, ctx: NormalizeContext): ClaudeEventData[] {
  const message = ownObject(frame, 'message');
  if (message === undefined) return [];
  const results: ClaudeEventData[] = [];
  for (const block of contentBlocks(message)) {
    const toolUseId = ownString(block, 'tool_use_id');
    if (ownString(block, 'type') !== 'tool_result' || toolUseId === undefined) continue;
    results.push({
      type: 'tool.result',
      ...turnField(ctx),
      toolUseId,
      status: ownBoolean(block, 'is_error') === true ? 'failed' : 'completed',
      raw: frame,
    });
  }
  return results;
}

// ---- stream_event ----------------------------------------------------------

const DELTA_TYPES: ReadonlyMap<string, { readonly deltaType: string; readonly field: string }> =
  new Map([
    ['text_delta', { deltaType: 'text', field: 'text' }],
    ['thinking_delta', { deltaType: 'thinking', field: 'thinking' }],
    ['input_json_delta', { deltaType: 'input_json', field: 'partial_json' }],
  ]);

function streamEvent(frame: JsonObject, ctx: NormalizeContext): ClaudeEventData[] {
  const event = ownObject(frame, 'event');
  if (event === undefined || ownString(event, 'type') !== 'content_block_delta') return [];
  const index = ownNumber(event, 'index');
  const delta = ownObject(event, 'delta');
  const wireType = delta === undefined ? undefined : ownString(delta, 'type');
  if (index === undefined || delta === undefined || wireType === undefined) return [];
  const known = DELTA_TYPES.get(wireType);
  const text = known === undefined ? undefined : ownString(delta, known.field);
  return [
    {
      type: 'message.delta',
      ...turnField(ctx),
      index,
      deltaType: known?.deltaType ?? wireType,
      ...(text === undefined ? {} : { text }),
      raw: frame,
    },
  ];
}

// ---- result ----------------------------------------------------------------

const USAGE_FIELDS: readonly (readonly [string, keyof UsageTotals])[] = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
];

/** Reported totals, or `undefined` when the frame reports neither usage nor cost. */
function usageTotals(frame: JsonObject): UsageTotals | undefined {
  const usage = ownObject(frame, 'usage');
  const entries: [keyof UsageTotals, number][] = [];
  for (const [wireName, name] of USAGE_FIELDS) {
    const value = usage === undefined ? undefined : ownNumber(usage, wireName);
    if (value !== undefined && value >= 0) entries.push([name, value]);
  }
  const cost = ownNumber(frame, 'total_cost_usd');
  if (cost !== undefined && cost >= 0) entries.push(['costUsd', cost]);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * How a `result` frame ended a turn.
 *
 * @internal
 */
export interface ResultClassification {
  readonly outcome: TurnOutcome;
  readonly isError: boolean;
  readonly stopReason?: StopReason;
}

/**
 * Classifies a `result` frame (pure; the turn machine reuses it).
 *
 * @remarks
 * `isError` is `is_error === true` or an `error*` subtype. Outcome:
 * `terminal_reason` `aborted*` is `cancelled`; `error_max_turns` or
 * `max_turns` is `max-turns`; `error_max_budget_usd` is `max-budget`; any
 * other error is `error`; `success` is `completed`; anything else is
 * `unknown`. The stop reason is the frame's own `stop_reason` (open string),
 * else derived from `terminal_reason`: `completed` is `end_turn`, `max_turns`
 * is `max_turn_requests`, `aborted*` is `cancelled`.
 *
 * @internal
 */
export function classifyResult(frame: JsonObject): ResultClassification {
  const subtype = ownString(frame, 'subtype');
  const terminalReason = ownString(frame, 'terminal_reason');
  const isError = ownBoolean(frame, 'is_error') === true || subtype?.startsWith('error') === true;
  const aborted = terminalReason?.startsWith('aborted') === true;
  const stopReason = ownString(frame, 'stop_reason') ?? derivedStopReason(terminalReason, aborted);
  return {
    outcome: outcomeOf(subtype, terminalReason, isError, aborted),
    isError,
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}

function outcomeOf(
  subtype: string | undefined,
  terminalReason: string | undefined,
  isError: boolean,
  aborted: boolean,
): TurnOutcome {
  if (aborted) return 'cancelled';
  if (subtype === 'error_max_turns' || terminalReason === 'max_turns') return 'max-turns';
  if (subtype === 'error_max_budget_usd') return 'max-budget';
  if (isError) return 'error';
  return subtype === 'success' ? 'completed' : 'unknown';
}

function derivedStopReason(
  terminalReason: string | undefined,
  aborted: boolean,
): StopReason | undefined {
  if (terminalReason === 'completed') return 'end_turn';
  if (terminalReason === 'max_turns') return 'max_turn_requests';
  return aborted ? 'cancelled' : undefined;
}

/** The turn machine owns `turn.completed`; a result only yields usage. */
function result(frame: JsonObject, ctx: NormalizeContext): ClaudeEventData[] {
  const reported = usageTotals(frame);
  if (reported === undefined) return [];
  return [
    {
      type: 'usage.update',
      ...turnField(ctx),
      reported,
      estimatedDelta: { estimate: true },
      raw: frame,
    },
  ];
}

// ---- control frames --------------------------------------------------------
//
// The session machine routes control frames to the control and permission
// machines and never passes them here. One that arrives anyway ("should not
// happen") falls through to `harness.frame`; `permission.requested` belongs to
// the permission machine.
