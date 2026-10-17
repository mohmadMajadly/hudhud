import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { HudhudEvent } from '../../../../core/src/protocol/events/types.js';
import type { JsonValue } from '../../../../core/src/protocol/json.js';
import {
  type ClaudeEventData,
  type NormalizeContext,
  classifyResult,
  normalizeFrame,
} from '../../../src/protocol/events/normalize.js';
import { FRAMES } from './frames.js';

const CTX: NormalizeContext = { turnId: 't1' };

function one(frame: JsonValue, ctx: NormalizeContext = CTX): ClaudeEventData {
  const events = normalizeFrame(frame, ctx);
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error('no event');
  return event;
}

function types(frame: JsonValue, ctx: NormalizeContext = CTX): string[] {
  return normalizeFrame(frame, ctx).map((e) => e.type);
}

describe('events are assignable to the neutral union', () => {
  it('after the caller adds seq, ts and sessionId', () => {
    for (const { frame } of Object.values(FRAMES)) {
      for (const data of normalizeFrame(frame, CTX)) {
        const event: HudhudEvent = {
          ...data,
          seq: 0,
          ts: '2026-01-01T00:00:00.000Z',
          sessionId: 's',
        };
        expect(event.type).toBe(data.type);
      }
    }
  });
});

describe('system frames', () => {
  it('yields no event for system/init: the turn machine owns it', () => {
    expect(normalizeFrame(FRAMES.init.frame, CTX)).toEqual([]);
    expect(normalizeFrame(FRAMES.init.frame, {})).toEqual([]);
  });

  it('maps system/api_retry to api.retry', () => {
    expect(one(FRAMES.apiRetry.frame)).toEqual({
      type: 'api.retry',
      attempt: 1,
      maxRetries: 10,
      retryDelayMs: 600,
      errorStatus: 401,
      error: 'authentication_failed',
      raw: FRAMES.apiRetry.frame,
    });
    expect(one(FRAMES.apiRetryNullStatus.frame)).toEqual({
      type: 'api.retry',
      attempt: 2,
      raw: FRAMES.apiRetryNullStatus.frame,
    });
  });

  it('keeps an api_retry without an attempt as harness.frame', () => {
    expect(one({ type: 'system', subtype: 'api_retry' })).toMatchObject({
      type: 'harness.frame',
      subtype: 'api_retry',
    });
  });

  it('maps system/session_state_changed to session.state', () => {
    expect(one(FRAMES.sessionState.frame)).toEqual({
      type: 'session.state',
      state: 'idle',
      raw: FRAMES.sessionState.frame,
    });
    expect(one({ type: 'system', subtype: 'session_state_changed' }).type).toBe('harness.frame');
  });

  it('maps system/permission_denied to permission.denied', () => {
    expect(one(FRAMES.permissionDenied.frame)).toEqual({
      type: 'permission.denied',
      toolName: 'Bash',
      toolUseId: 'toolu_mock_0007',
      reasonType: 'rule',
      raw: FRAMES.permissionDenied.frame,
    });
    const bare = {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'x',
    };
    expect(one(bare)).toEqual({
      type: 'permission.denied',
      toolName: 'Bash',
      toolUseId: 'x',
      raw: bare,
    });
    expect(one({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' }).type).toBe(
      'harness.frame',
    );
    expect(one({ type: 'system', subtype: 'permission_denied', tool_use_id: 'x' }).type).toBe(
      'harness.frame',
    );
  });

  it('maps system/background_tasks_changed to background.tasks', () => {
    expect(one(FRAMES.backgroundTasks.frame)).toEqual({
      type: 'background.tasks',
      raw: FRAMES.backgroundTasks.frame,
    });
  });

  it.each([FRAMES.taskStarted, FRAMES.taskNotification, FRAMES.hookStarted, FRAMES.hookResponse])(
    'passes $name through as harness.frame',
    ({ frame }) => {
      expect(one(frame)).toEqual({
        type: 'harness.frame',
        frameType: 'system',
        subtype: frame.subtype,
        raw: frame,
      });
    },
  );

  it('keeps a system frame without a subtype', () => {
    expect(one({ type: 'system' })).toEqual({
      type: 'harness.frame',
      frameType: 'system',
      raw: { type: 'system' },
    });
  });
});

describe('assistant frames', () => {
  it('maps text blocks to message.assistant', () => {
    expect(one(FRAMES.assistantText.frame)).toEqual({
      type: 'message.assistant',
      turnId: 't1',
      text: 'Hello world',
      raw: FRAMES.assistantText.frame,
    });
  });

  it('accepts string content and omits the turn when unknown', () => {
    expect(one(FRAMES.assistantStringContent.frame, {})).toEqual({
      type: 'message.assistant',
      text: 'plain',
      raw: FRAMES.assistantStringContent.frame,
    });
  });

  it('maps tool_use blocks to tool.call with the tool kind', () => {
    const events = normalizeFrame(FRAMES.assistantToolUse.frame, CTX);
    expect(events.map((e) => e.type)).toEqual([
      'message.assistant',
      'tool.call',
      'tool.call',
      'tool.call',
    ]);
    expect(events[1]).toEqual({
      type: 'tool.call',
      turnId: 't1',
      toolUseId: 'toolu_mock_0002',
      toolName: 'Bash',
      kind: 'execute',
      status: 'pending',
      input: { command: 'echo hi' },
      raw: FRAMES.assistantToolUse.frame,
    });
    expect(events[2]).toMatchObject({ kind: 'other', input: null });
    expect(events[3]).toMatchObject({ kind: 'read', input: {} });
  });

  it('skips tool_use blocks without id or name but keeps the frame', () => {
    const frame = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'tool_use', id: 'x' }, 5] },
    };
    expect(normalizeFrame(frame, {})).toEqual([{ type: 'message.assistant', raw: frame }]);
  });

  it('carries aborted from the frame or the message', () => {
    expect(one(FRAMES.assistantAborted.frame)).toMatchObject({
      aborted: true,
      text: 'chunk0 chunk1 chunk2 chu',
    });
    const frame = { type: 'assistant', message: { aborted: false, content: [] } };
    expect(one(frame)).toEqual({
      type: 'message.assistant',
      turnId: 't1',
      aborted: false,
      raw: frame,
    });
  });

  it('keeps the synthetic error frame whole in raw', () => {
    expect(one(FRAMES.assistantAuthError.frame)).toMatchObject({
      type: 'message.assistant',
      text: 'Failed to authenticate. API Error: 401 mock 401',
      raw: FRAMES.assistantAuthError.frame,
    });
  });

  it('falls back to harness.frame without a message', () => {
    expect(one({ type: 'assistant', message: 'x' })).toMatchObject({
      type: 'harness.frame',
      frameType: 'assistant',
    });
  });

  it('ignores a text block without text', () => {
    const frame = { type: 'assistant', message: { content: [{ type: 'text' }] } };
    expect(one(frame)).toEqual({ type: 'message.assistant', turnId: 't1', raw: frame });
  });
});

describe('user frames', () => {
  it('maps tool_result blocks to tool.result', () => {
    expect(one(FRAMES.userToolResultOk.frame)).toEqual({
      type: 'tool.result',
      turnId: 't1',
      toolUseId: 'toolu_mock_0002',
      status: 'completed',
      raw: FRAMES.userToolResultOk.frame,
    });
    expect(one(FRAMES.userToolResultDenied.frame, {})).toEqual({
      type: 'tool.result',
      toolUseId: 'toolu_mock_0003',
      status: 'failed',
      raw: FRAMES.userToolResultDenied.frame,
    });
  });

  it('emits one tool.result per block', () => {
    const frame = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'a' },
          { type: 'tool_result', tool_use_id: 'b', is_error: false },
        ],
      },
    };
    expect(normalizeFrame(frame, CTX).map((e) => e.type)).toEqual(['tool.result', 'tool.result']);
  });

  it.each([FRAMES.userInterrupt, FRAMES.userStringContent])(
    'passes $name through as harness.frame',
    ({ frame }) => {
      expect(one(frame)).toEqual({ type: 'harness.frame', frameType: 'user', raw: frame });
    },
  );

  it('falls back without a message object', () => {
    expect(types({ type: 'user' })).toEqual(['harness.frame']);
  });
});

describe('stream_event frames', () => {
  it.each([
    [FRAMES.deltaText, 0, 'text', 'chunk0 '],
    [FRAMES.deltaThinking, 1, 'thinking', 'hm'],
    [FRAMES.deltaJson, 2, 'input_json', '{"command":'],
  ])('maps $0.name to message.delta', ({ frame }, index, deltaType, text) => {
    expect(one(frame)).toEqual({
      type: 'message.delta',
      turnId: 't1',
      index,
      deltaType,
      text,
      raw: frame,
    });
  });

  it('keeps an unknown delta kind as its wire name without text', () => {
    expect(one(FRAMES.deltaSignature.frame, {})).toEqual({
      type: 'message.delta',
      index: 1,
      deltaType: 'signature_delta',
      raw: FRAMES.deltaSignature.frame,
    });
  });

  it('omits text that is not a string', () => {
    const frame = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 3 } },
    };
    expect(one(frame)).not.toHaveProperty('text');
  });

  it.each([FRAMES.messageStart, FRAMES.messageStop])('passes $name through', ({ frame }) => {
    expect(one(frame)).toEqual({
      type: 'harness.frame',
      frameType: 'stream_event',
      subtype: frame.event.type,
      raw: frame,
    });
  });

  it('passes through a malformed delta and a missing event', () => {
    const noIndex = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta' } },
    };
    const noDelta = { type: 'stream_event', event: { type: 'content_block_delta', index: 0 } };
    const noType = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: {} },
    };
    for (const frame of [noIndex, noDelta, noType]) {
      expect(one(frame)).toMatchObject({ type: 'harness.frame', subtype: 'content_block_delta' });
    }
    expect(one({ type: 'stream_event' })).toEqual({
      type: 'harness.frame',
      frameType: 'stream_event',
      raw: { type: 'stream_event' },
    });
  });
});

describe('result frames', () => {
  it('yields only usage.update; the turn machine owns turn.completed', () => {
    expect(normalizeFrame(FRAMES.resultSuccess.frame, CTX)).toEqual([
      {
        type: 'usage.update',
        turnId: 't1',
        reported: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 3,
          costUsd: 0.0123,
        },
        // A new session's first report: the turn's tokens, the whole cost.
        estimatedDelta: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 3,
          costUsd: 0.0123,
          estimate: true,
        },
        raw: FRAMES.resultSuccess.frame,
      },
    ]);
    expect(normalizeFrame(FRAMES.resultSuccess.frame, {})[0]).not.toHaveProperty('turnId');
  });

  it('yields nothing when neither usage nor cost is reported', () => {
    for (const { frame } of [
      FRAMES.resultMaxTurns,
      FRAMES.resultAuth,
      FRAMES.resultNotFound,
      FRAMES.resultBare,
    ]) {
      expect(normalizeFrame(frame, CTX)).toEqual([]);
    }
  });

  it('ignores negative and non-numeric usage figures', () => {
    const frame = {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: -1, output_tokens: 'x', cache_read_input_tokens: 4 },
      total_cost_usd: -2,
    };
    expect(normalizeFrame(frame, CTX)[0]).toMatchObject({
      type: 'usage.update',
      reported: { cacheReadInputTokens: 4 },
    });
    expect(
      normalizeFrame({ type: 'result', usage: { input_tokens: -1 }, total_cost_usd: -1 }, CTX),
    ).toEqual([]);
  });

  it('estimates the change: the turn tokens as reported, the cost against its baseline (R4-7)', () => {
    const frame = {
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 20 },
      total_cost_usd: 0.3,
    };
    const delta = (costBaseline: number | 'unknown'): unknown =>
      (normalizeFrame(frame, { costBaseline })[0] as { estimatedDelta: unknown }).estimatedDelta;
    // 0.3 - 0.1 in floating point, rounded to nano-dollars.
    expect(delta(0.1)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.2,
      estimate: true,
    });
    // A running total that went down was reset: the new total counts.
    expect(delta(0.5)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.3,
      estimate: true,
    });
    // No baseline (the first report of a resumed or forked session): no cost delta.
    expect(delta('unknown')).toEqual({ inputTokens: 100, outputTokens: 20, estimate: true });
  });

  it('reports cost without usage', () => {
    expect(normalizeFrame({ type: 'result', total_cost_usd: 0 }, CTX)[0]).toMatchObject({
      reported: { costUsd: 0 },
    });
  });
});

describe('classifyResult', () => {
  it.each([
    [FRAMES.resultSuccess, 'completed', false, 'end_turn'],
    [FRAMES.resultMaxTurns, 'max-turns', true, 'max_turn_requests'],
    [FRAMES.resultAuth, 'error', true, undefined],
    [FRAMES.resultAbortedStreaming, 'cancelled', true, 'cancelled'],
    [FRAMES.resultBudget, 'max-budget', true, 'max_tokens'],
    [FRAMES.resultNotFound, 'error', true, undefined],
    [FRAMES.resultBare, 'unknown', false, undefined],
    [FRAMES.resultOther, 'unknown', false, undefined],
  ])('classifies $0.name', ({ frame }, outcome, isError, stopReason) => {
    const classified = classifyResult(frame);
    expect(classified).toEqual({
      outcome,
      isError,
      ...(stopReason === undefined ? {} : { stopReason }),
    });
  });

  it('maps terminal_reason max_turns without an error subtype', () => {
    expect(classifyResult({ type: 'result', terminal_reason: 'max_turns' })).toEqual({
      outcome: 'max-turns',
      isError: false,
      stopReason: 'max_turn_requests',
    });
  });
});

describe('control and unknown frames', () => {
  it('passes control_request frames through defensively (they should not arrive)', () => {
    expect(one(FRAMES.canUseTool.frame)).toEqual({
      type: 'harness.frame',
      frameType: 'control_request',
      subtype: 'can_use_tool',
      raw: FRAMES.canUseTool.frame,
    });
    expect(one(FRAMES.hookCallback.frame)).toMatchObject({ subtype: 'hook_callback' });
  });

  it.each([
    FRAMES.commandLifecycle,
    FRAMES.controlResponse,
    FRAMES.controlCancel,
    FRAMES.keepAlive,
    FRAMES.rateLimit,
  ])('passes $name through as harness.frame', ({ frame }) => {
    expect(one(frame)).toEqual({ type: 'harness.frame', frameType: frame.type, raw: frame });
  });

  it('passes frames that are not objects or have no type through', () => {
    for (const frame of [null, 3, 'text', [1], {}, { type: 7 }] as JsonValue[]) {
      expect(one(frame)).toEqual({ type: 'harness.frame', frameType: 'unknown', raw: frame });
    }
  });
});

describe('untrusted data', () => {
  it('carries text verbatim, control sequences included', () => {
    const text = '\u001b[31mred\u001b]0;title\u0007 \u0085 ‮';
    const frame = { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    expect(one(frame)).toMatchObject({ text });
  });

  it('reads only own properties', () => {
    const frame = JSON.parse(
      '{"type":"assistant","__proto__":{"aborted":true},"message":{"__proto__":{"content":"x"},"content":[]}}',
    ) as JsonValue;
    expect(one(frame)).not.toHaveProperty('aborted');
    expect(one(frame)).not.toHaveProperty('text');
    const inherited = Object.create({ type: 'assistant' }) as JsonValue;
    expect(one(inherited)).toMatchObject({ type: 'harness.frame', frameType: 'unknown' });
  });
});

describe('properties', () => {
  it('never throws, always returns events, and every event carries the frame as raw', () => {
    fc.assert(
      fc.property(fc.jsonValue() as fc.Arbitrary<JsonValue>, fc.boolean(), (frame, withTurn) => {
        const events = normalizeFrame(frame, withTurn ? CTX : {});
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) expect(event.raw).toBe(frame);
      }),
    );
  });

  it('holds for frames shaped like the known types', () => {
    const type = fc.constantFrom(
      'system',
      'assistant',
      'user',
      'stream_event',
      'result',
      'control_request',
    );
    const subtype = fc.constantFrom(
      'init',
      'api_retry',
      'session_state_changed',
      'permission_denied',
      'can_use_tool',
    );
    fc.assert(
      fc.property(
        fc.record({
          type,
          subtype,
          message: fc.jsonValue(),
          event: fc.jsonValue(),
          request: fc.jsonValue(),
          usage: fc.jsonValue(),
        }),
        (frame) => {
          const json = frame as unknown as JsonValue;
          for (const event of normalizeFrame(json, CTX)) expect(event.raw).toBe(json);
        },
      ),
    );
  });
});
