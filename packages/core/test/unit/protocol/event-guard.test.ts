// isEventType and HudhudEventOf (W7-Z): narrowing the open event union by
// `type`. The expectTypeOf assertions do nothing at run time; `pnpm build`
// compiles the test files, so a narrowing that stops working is a compile
// error there.

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as root from '../../../src/index.js';
import { isEventType, type HudhudEventOf } from '../../../src/protocol/events/guard.js';
import type { EventBase, HudhudEvent, ToolKind } from '../../../src/protocol/events/types.js';
import * as protocol from '../../../src/protocol/index.js';
import type { JsonValue } from '../../../src/protocol/json.js';

const base = { seq: 1, ts: '2026-10-17T00:00:00.000Z', sessionId: 's' };

const toolCall: HudhudEvent = {
  ...base,
  type: 'tool.call',
  toolUseId: 't1',
  toolName: 'Bash',
  kind: 'execute',
  status: 'pending',
  input: {},
  raw: {},
};
const delta: HudhudEvent = {
  ...base,
  type: 'message.delta',
  index: 0,
  deltaType: 'text',
  text: 'hi',
  raw: {},
};
const later: HudhudEvent = { ...base, type: 'review.started', raw: { any: 1 } };

describe('isEventType', () => {
  it('is true exactly for events of the given type', () => {
    expect(isEventType(toolCall, 'tool.call')).toBe(true);
    expect(isEventType(toolCall, 'tool.result')).toBe(false);
    expect(isEventType(delta, 'message.delta')).toBe(true);
    expect(isEventType(later, 'review.started')).toBe(true);
    expect(isEventType(later, 'tool.call')).toBe(false);
  });

  it('narrows a known type to its arm', () => {
    const event: HudhudEvent = toolCall;
    if (!isEventType(event, 'tool.call')) throw new Error('not a tool call');
    expectTypeOf(event.toolName).toEqualTypeOf<string>();
    expectTypeOf(event.kind).toEqualTypeOf<ToolKind>();
    expectTypeOf(event.status).toEqualTypeOf<'pending'>();
    expect(event.toolName).toBe('Bash');
  });

  it('narrows a type a later version adds to the open arm with that type', () => {
    const event: HudhudEvent = later;
    if (!isEventType(event, 'review.started')) throw new Error('not review.started');
    expectTypeOf(event.type).toEqualTypeOf<'review.started'>();
    expectTypeOf(event.raw).toEqualTypeOf<JsonValue | undefined>();
    expect(event.raw).toEqual({ any: 1 });
  });

  it('is what the root and the protocol entry export', () => {
    expect(root.isEventType).toBe(isEventType);
    expect(protocol.isEventType).toBe(isEventType);
  });
});

describe('HudhudEventOf', () => {
  it('is the matching arm, never the open arm, for a known type', () => {
    type Call = HudhudEventOf<'tool.call'>;
    expectTypeOf<Call['type']>().toEqualTypeOf<'tool.call'>();
    expectTypeOf<Call>().toHaveProperty('toolUseId');
    expectTypeOf<HudhudEventOf<'gap'>>().toEqualTypeOf<
      EventBase & { readonly type: 'gap'; readonly dropped: number; readonly raw?: JsonValue }
    >();
  });

  it('is the open arm with that type for an unknown type', () => {
    expectTypeOf<HudhudEventOf<'review.started'>>().toEqualTypeOf<
      EventBase & { readonly type: 'review.started'; readonly raw?: JsonValue }
    >();
  });

  it('distributes over a union of types', () => {
    expectTypeOf<HudhudEventOf<'gap' | 'review.started'>>().toEqualTypeOf<
      | (EventBase & { readonly type: 'gap'; readonly dropped: number; readonly raw?: JsonValue })
      | (EventBase & { readonly type: 'review.started'; readonly raw?: JsonValue })
    >();
    expectTypeOf<HudhudEventOf<'tool.call' | 'tool.result'>['type']>().toEqualTypeOf<
      'tool.call' | 'tool.result'
    >();
  });

  it('shows that comparing type alone does not narrow (why the guard exists)', () => {
    const event: HudhudEvent = toolCall;
    if (event.type === 'tool.call') {
      // The open arm admits 'tool.call' too, so `toolName` is not known here.
      expectTypeOf(event).not.toHaveProperty('toolName');
    }
    expect(event.type).toBe('tool.call');
  });
});
