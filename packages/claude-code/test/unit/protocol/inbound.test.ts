// classifyInbound: every frame quoted in research 05/07 classifies without
// `malformed`; malformed agrees with the generated envelope validator on
// arbitrary JSON; only own properties are read (ADR-0012 §8).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonObject, JsonValue } from '../../../../core/src/protocol/json.js';
import { validateInboundEnvelope } from '../../../src/protocol/generated/validators.gen.js';
import { classifyInbound } from '../../../src/protocol/wire/inbound.js';
import { RESEARCH_FRAMES } from './research-frames.js';
import { fcParams } from './support.js';

describe('classifyInbound on the research frames', () => {
  it('classifies every recorded 05/07 frame without malformed', () => {
    expect(RESEARCH_FRAMES.length).toBeGreaterThan(30);
    for (const { name, frame } of RESEARCH_FRAMES) {
      const cls = classifyInbound(frame);
      expect(cls.kind, name).not.toBe('malformed');
      expect(cls.frame, name).toBe(frame);
      expect(validateInboundEnvelope(frame).ok, name).toBe(true);
    }
  });

  it('routes each control frame by its envelope', () => {
    const byName = new Map(RESEARCH_FRAMES.map((entry) => [entry.name, entry.frame]));
    const get = (name: string): JsonObject => {
      const frame = byName.get(name);
      if (frame === undefined) throw new Error(name);
      return frame;
    };
    const init = classifyInbound(get('initialize response'));
    expect(init).toMatchObject({ kind: 'control_response', requestId: 'init_1', ok: true });
    expect(init.kind === 'control_response' && init.ok && init.response?.['pid']).toBe(37148);
    expect(classifyInbound(get('can_use_tool (Windows)'))).toMatchObject({
      kind: 'control_request',
      requestId: '96faf3d7-4d77-4311-839f-a6ddaaec5323',
      subtype: 'can_use_tool',
    });
    expect(classifyInbound(get('control_cancel_request after interrupt'))).toMatchObject({
      kind: 'control_cancel_request',
      requestId: '548e5f58-…',
    });
    expect(classifyInbound(get('keep_alive')).kind).toBe('keep_alive');
    expect(classifyInbound(get('system/init (Windows)'))).toMatchObject({
      kind: 'conversation',
      type: 'system',
      subtype: 'init',
    });
    const lifecycle = classifyInbound(get('command_lifecycle started'));
    expect(lifecycle).toEqual({
      kind: 'conversation',
      type: 'command_lifecycle',
      frame: get('command_lifecycle started'),
    });
    expect(Object.hasOwn(lifecycle, 'subtype')).toBe(false);
  });
});

describe('classifyInbound on control responses', () => {
  it('reads success, error and unknown response subtypes', () => {
    expect(
      classifyInbound({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'r' },
      }),
    ).toEqual({
      kind: 'control_response',
      requestId: 'r',
      ok: true,
      frame: { type: 'control_response', response: { subtype: 'success', request_id: 'r' } },
    });
    const notObject = classifyInbound({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r', response: [1] },
    });
    expect(notObject.kind === 'control_response' && Object.hasOwn(notObject, 'response')).toBe(
      false,
    );
    expect(
      classifyInbound({
        type: 'control_response',
        response: { subtype: 'error', request_id: 'r', error: 'nope' },
      }),
    ).toMatchObject({ kind: 'control_response', ok: false, error: 'nope' });
    expect(
      classifyInbound({
        type: 'control_response',
        response: { subtype: 'error', request_id: 'r', error: 5 },
      }),
    ).toMatchObject({ kind: 'control_response', ok: false, error: '' });
    expect(
      classifyInbound({
        type: 'control_response',
        response: { subtype: 'later', request_id: 'r' },
      }),
    ).toMatchObject({
      kind: 'control_response',
      ok: false,
      error: 'unrecognized control response subtype "later"',
    });
  });
});

describe('classifyInbound on malformed envelopes', () => {
  const cases: readonly [JsonObject, string][] = [
    [{}, 'type'],
    [{ type: 7 }, 'type'],
    [{ type: 'control_request', request: { subtype: 'x' } }, 'request_id'],
    [{ type: 'control_request', request_id: 7, request: { subtype: 'x' } }, 'request_id'],
    [{ type: 'control_request', request_id: 'r' }, 'request'],
    [{ type: 'control_request', request_id: 'r', request: [] }, 'request'],
    [{ type: 'control_request', request_id: 'r', request: { subtype: 1 } }, 'request.subtype'],
    [{ type: 'control_response' }, 'response'],
    [{ type: 'control_response', response: 'x' }, 'response'],
    [{ type: 'control_response', response: { request_id: 'r' } }, 'response.subtype'],
    [{ type: 'control_response', response: { subtype: 'success' } }, 'response.request_id'],
    [{ type: 'control_cancel_request' }, 'request_id'],
    [{ type: 'control_cancel_request', request_id: null }, 'request_id'],
    [{ type: 'system', subtype: 5 }, 'subtype'],
    [{ type: 'assistant', uuid: 1 }, 'uuid'],
    [{ type: 'result', session_id: null }, 'session_id'],
  ];

  it('names the routing field', () => {
    for (const [frame, reason] of cases) {
      expect(classifyInbound(frame), JSON.stringify(frame)).toEqual({
        kind: 'malformed',
        reason,
        frame,
      });
      expect(validateInboundEnvelope(frame).ok).toBe(false);
    }
  });

  it('reads only own properties; __proto__ keys stay inert', () => {
    const viaProto = JSON.parse(
      '{"type":"control_cancel_request","__proto__":{"request_id":"r"}}',
    ) as JsonObject;
    expect(classifyInbound(viaProto)).toMatchObject({ kind: 'malformed', reason: 'request_id' });
    const nested = JSON.parse(
      '{"type":"control_request","request_id":"r","request":{"__proto__":{"subtype":"x"}}}',
    ) as JsonObject;
    expect(classifyInbound(nested)).toMatchObject({ kind: 'malformed', reason: 'request.subtype' });
    const inheritedType = Object.create({ type: 'keep_alive' }) as JsonObject;
    expect(classifyInbound(inheritedType)).toMatchObject({ kind: 'malformed', reason: 'type' });
    const protoId = JSON.parse(
      '{"type":"control_cancel_request","request_id":"__proto__"}',
    ) as JsonObject;
    expect(classifyInbound(protoId)).toMatchObject({
      kind: 'control_cancel_request',
      requestId: '__proto__',
    });
    expect(({} as Record<string, unknown>)['request_id']).toBeUndefined();
  });
});

// ---- property: total, and malformed iff the envelope validator refuses ----

const ROUTING_KEYS = [
  'type',
  'subtype',
  'request_id',
  'request',
  'response',
  'uuid',
  'session_id',
  'error',
  '__proto__',
];
const TYPES = [
  'control_request',
  'control_response',
  'control_cancel_request',
  'keep_alive',
  'system',
  'result',
  'assistant',
  'transcript_mirror',
];

const leaf: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constantFrom<JsonValue>(...TYPES, 'success', 'error', 'r', '', null, true, 0, 1.5, []),
  fc.string(),
);

const routingObject: fc.Arbitrary<JsonValue> = fc.letrec<{ node: JsonValue }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small' },
    leaf,
    fc.dictionary(fc.constantFrom(...ROUTING_KEYS), tie('node'), { maxKeys: 5 }),
  ),
})).node;

/** Objects as `JSON.parse` produces them (own `__proto__` keys included). */
const frames: fc.Arbitrary<JsonObject> = fc
  .oneof(
    fc.dictionary(fc.constantFrom(...ROUTING_KEYS), routingObject, { maxKeys: 6 }),
    fc.record(
      {
        type: fc.constantFrom<JsonValue>(...TYPES),
        request_id: leaf,
        request: routingObject,
        response: routingObject,
        subtype: leaf,
        uuid: leaf,
        session_id: leaf,
      },
      { requiredKeys: ['type'] },
    ),
    fc.jsonValue().filter((v) => typeof v === 'object' && v !== null && !Array.isArray(v)),
  )
  .map((value) => JSON.parse(JSON.stringify(value)) as JsonObject);

describe('classifyInbound (property)', () => {
  it('is total and agrees with the generated envelope validator', () => {
    fc.assert(
      fc.property(frames, (frame) => {
        const cls = classifyInbound(frame);
        expect(cls.frame).toBe(frame);
        expect(cls.kind === 'malformed').toBe(!validateInboundEnvelope(frame).ok);
      }),
      fcParams(2000),
    );
  });
});
