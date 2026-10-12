// Outbound builders match the strict schema; workspaceTrust and update_settings
// cannot be sent without the spec's opt-in (ADR-0012 §2, §3, J3).

import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { JsonObject } from '../../../../core/src/protocol/json.js';
import { validateOutboundFrame } from '../../../src/protocol/generated/validators.gen.js';
import {
  controlErrorResponse,
  encodeOutboundFrame,
  initializeRequest,
  interruptRequest,
  permissionResponse,
  rawControlRefusal,
  rawControlRequest,
  rawFrameRefusal,
  setPermissionModeRequest,
  userMessage,
  type RawControlPolicy,
} from '../../../src/protocol/wire/outbound.js';
import type {
  InitializeBody,
  PermissionDecisionWire,
  PermissionModeWire,
  UserContentWire,
} from '../../../src/protocol/wire/types.js';
import { fcParams } from './support.js';

const CAP = 32 * 1024 * 1024;

function strict(frame: JsonObject): void {
  expect(validateOutboundFrame(frame), JSON.stringify(frame)).toEqual({ ok: true, value: frame });
}

describe('builders', () => {
  it('build the exact frames and pass the strict validator', () => {
    const frames: [JsonObject, JsonObject][] = [
      [
        initializeRequest('hudhud_1'),
        { type: 'control_request', request_id: 'hudhud_1', request: { subtype: 'initialize' } },
      ],
      [
        interruptRequest('hudhud_2', true),
        {
          type: 'control_request',
          request_id: 'hudhud_2',
          request: { subtype: 'interrupt', cancel_queued: true },
        },
      ],
      [
        setPermissionModeRequest('hudhud_3', 'plan'),
        {
          type: 'control_request',
          request_id: 'hudhud_3',
          request: { subtype: 'set_permission_mode', mode: 'plan' },
        },
      ],
      [
        userMessage('u-1', 'مرحبا'),
        {
          type: 'user',
          message: { role: 'user', content: 'مرحبا' },
          parent_tool_use_id: null,
          session_id: '',
          uuid: 'u-1',
        },
      ],
      [
        controlErrorResponse('r', 'nope'),
        {
          type: 'control_response',
          response: { subtype: 'error', request_id: 'r', error: 'nope' },
        },
      ],
      [
        permissionResponse('r', { behavior: 'allow' }),
        {
          type: 'control_response',
          response: { subtype: 'success', request_id: 'r', response: { behavior: 'allow' } },
        },
      ],
      [
        permissionResponse('r', { behavior: 'deny', message: 'no' }),
        {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'r',
            response: { behavior: 'deny', message: 'no' },
          },
        },
      ],
    ];
    for (const [built, expected] of frames) {
      expect(built).toEqual(expected);
      strict(built);
    }
  });

  it('copy only the known fields of content blocks and decisions', () => {
    const blocks = [
      { type: 'text', text: 'look', extra: 1 },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA', url: 'x' },
        cache_control: {},
      },
    ] as unknown as UserContentWire;
    const user = userMessage('u-2', blocks);
    expect(user['message']).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    });
    strict(user);
    const allow = {
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      toolUseID: 't',
    } as unknown as PermissionDecisionWire;
    const allowFrame = permissionResponse('r', allow);
    expect(allowFrame).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'r',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'ls' },
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        },
      },
    });
    strict(allowFrame);
    const deny = permissionResponse('r', { behavior: 'deny', message: 'm', interrupt: true });
    expect(deny).toMatchObject({ response: { response: { interrupt: true } } });
    strict(deny);
  });

  it('initialize cannot carry workspaceTrust (type and run time, J3)', () => {
    expectTypeOf<InitializeBody['workspaceTrust']>().toEqualTypeOf<never>();
    // No body parameter: nothing exists from which workspaceTrust could be copied.
    expect(initializeRequest.length).toBe(1);
    const frame = initializeRequest('hudhud_1');
    expect(Object.keys(frame['request'] as JsonObject)).toEqual(['subtype']);
  });
});

describe('encodeOutboundFrame', () => {
  it('encodes a valid frame as one line', () => {
    const result = encodeOutboundFrame(interruptRequest('hudhud_1', false), CAP);
    expect(result).toEqual({
      ok: true,
      line: '{"type":"control_request","request_id":"hudhud_1","request":{"subtype":"interrupt","cancel_queued":false}}\n',
      bytes: 107,
    });
  });

  it('refuses a frame the strict schema refuses, including workspaceTrust', () => {
    const frame: JsonObject = {
      type: 'control_request',
      request_id: 'hudhud_1',
      request: { subtype: 'initialize', workspaceTrust: { accepted: true } },
    };
    expect(encodeOutboundFrame(frame, CAP)).toEqual({
      ok: false,
      error: {
        code: 'PROTOCOL_ERROR',
        message: 'Outbound frame does not match the strict wire schema; nothing was written.',
        retryable: false,
        details: { reason: 'schema', instancePath: '/request', keyword: 'additionalProperties' },
      },
    });
    const settings: JsonObject = {
      type: 'control_request',
      request_id: 'hudhud_1',
      request: { subtype: 'update_settings', source: 'userSettings', settings: {} },
    };
    expect(encodeOutboundFrame(settings, CAP).ok).toBe(false);
  });

  it('refuses a frame above the cap', () => {
    const result = encodeOutboundFrame(userMessage('u', 'x'.repeat(200)), 100);
    expect(!result.ok && result.error.code).toBe('OUTBOUND_FRAME_TOO_LARGE');
  });
});

const OPEN: RawControlPolicy = { allowRawControl: true, allowConfigWrites: false };

describe('raw control guard', () => {
  it('refuses everything while raw control is off', () => {
    const policy = { allowRawControl: false, allowConfigWrites: true };
    expect(rawControlRefusal('get_settings', undefined, policy)?.details).toEqual({
      rule: 'raw-control-disabled',
    });
    expect(rawFrameRefusal({ type: 'user' }, policy)?.details).toEqual({
      rule: 'raw-control-disabled',
    });
  });

  it('refuses initialize, update_settings without opt-in, bad bodies', () => {
    const rule = (subtype: string, body: JsonObject | undefined, policy = OPEN): unknown =>
      rawControlRefusal(subtype, body, policy)?.details?.['rule'];
    expect(rule('', undefined)).toBe('raw-subtype-empty');
    expect(rule('initialize', undefined)).toBe('raw-initialize');
    expect(rule('initialize', undefined, { allowRawControl: true, allowConfigWrites: true })).toBe(
      'raw-initialize',
    );
    expect(rule('update_settings', { source: 'userSettings', settings: {} })).toBe(
      'raw-config-write',
    );
    expect(
      rule('update_settings', { settings: {} }, { allowRawControl: true, allowConfigWrites: true }),
    ).toBeUndefined();
    expect(rule('get_settings', { subtype: 'update_settings' })).toBe('raw-body-subtype');
    expect(rule('get_settings', { n: Number.NaN })).toBe('raw-body-not-json');
    expect(rule('get_settings', new Map() as unknown as JsonObject)).toBe('raw-body-not-json');
    expect(rule('get_settings', undefined)).toBeUndefined();
    expect(rule('get_settings', { detail: 'full' })).toBeUndefined();
    const refusal = rawControlRefusal('update_settings', undefined, OPEN);
    expect(refusal).toMatchObject({ code: 'INVALID_OPTIONS', retryable: false });
  });

  it('builds a raw request from own keys only', () => {
    const body = JSON.parse('{"detail":"full","__proto__":{"polluted":true}}') as JsonObject;
    const frame = rawControlRequest('hudhud_9', 'get_context_usage', body);
    expect(JSON.stringify(frame)).toBe(
      '{"type":"control_request","request_id":"hudhud_9","request":{"subtype":"get_context_usage","detail":"full","__proto__":{"polluted":true}}}',
    );
    const request = frame['request'] as Record<string, unknown>;
    expect(Object.getPrototypeOf(request)).toBe(Object.prototype);
    expect(request['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(rawControlRequest('hudhud_1', 'mcp_status', undefined)).toEqual({
      type: 'control_request',
      request_id: 'hudhud_1',
      request: { subtype: 'mcp_status' },
    });
  });

  it('checks raw frames for workspaceTrust and update_settings carriers', () => {
    const rule = (frame: JsonObject, policy = OPEN): unknown =>
      rawFrameRefusal(frame, policy)?.details?.['rule'];
    const request = (sub: JsonObject): JsonObject => ({
      type: 'control_request',
      request_id: 'x',
      request: sub,
    });
    expect(rule(request({ subtype: 'initialize', workspaceTrust: { accepted: true } }))).toBe(
      'raw-initialize',
    );
    expect(rule(request({ subtype: 'update_settings', settings: {} }))).toBe('raw-config-write');
    expect(
      rule(request({ subtype: 'update_settings' }), {
        allowRawControl: true,
        allowConfigWrites: true,
      }),
    ).toBeUndefined();
    expect(rule(request({ subtype: 'get_settings' }))).toBeUndefined();
    expect(rule({ type: 'control_request', request_id: 'x' })).toBe('raw-frame-no-subtype');
    expect(rule(request({ subtype: 3 }))).toBe('raw-frame-no-subtype');
    const viaProto = JSON.parse(
      '{"type":"control_request","request":{"__proto__":{"subtype":"get_settings"}}}',
    ) as JsonObject;
    expect(rule(viaProto)).toBe('raw-frame-no-subtype');
    expect(rule({ type: 'user', message: {} })).toBeUndefined();
    expect(rule({ type: 'control_response', response: {} })).toBeUndefined();
    expect(rule({ type: 'user', bad: Number.POSITIVE_INFINITY })).toBe('raw-frame-not-json');
    expect(rule([] as unknown as JsonObject)).toBe('raw-frame-not-json');
  });
});

// ---- property: every builder output passes the strict schema and encodes to one line --

const MODES: readonly PermissionModeWire[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'auto',
  'bypassPermissions',
];
const id = fc.string({ minLength: 1 });

const content: fc.Arbitrary<UserContentWire> = fc.oneof(
  fc.string(),
  fc.array(
    fc.oneof(
      fc.record({ type: fc.constant('text' as const), text: fc.string() }),
      fc.record({
        type: fc.constant('image' as const),
        source: fc.record({
          type: fc.constant('base64' as const),
          media_type: fc.constantFrom(
            'image/png' as const,
            'image/jpeg' as const,
            'image/gif' as const,
            'image/webp' as const,
          ),
          data: fc.string(),
        }),
      }),
    ),
  ),
);

const jsonObject = fc
  .dictionary(fc.string(), fc.jsonValue({ maxDepth: 3 }))
  .map((value) => JSON.parse(JSON.stringify(value)) as JsonObject);

const decision: fc.Arbitrary<PermissionDecisionWire> = fc.oneof(
  fc.record(
    {
      behavior: fc.constant('allow' as const),
      updatedInput: jsonObject,
      updatedPermissions: fc.array(jsonObject, { maxLength: 4 }),
    },
    { requiredKeys: ['behavior'] },
  ),
  fc.record(
    { behavior: fc.constant('deny' as const), message: fc.string(), interrupt: fc.boolean() },
    { requiredKeys: ['behavior', 'message'] },
  ),
);

const built: fc.Arbitrary<JsonObject> = fc.oneof(
  id.map((requestId) => initializeRequest(requestId)),
  fc.tuple(id, fc.boolean()).map(([requestId, cancel]) => interruptRequest(requestId, cancel)),
  fc
    .tuple(id, fc.constantFrom(...MODES))
    .map(([requestId, mode]) => setPermissionModeRequest(requestId, mode)),
  fc.tuple(id, content).map(([uuid, body]) => userMessage(uuid, body)),
  fc.tuple(id, decision).map(([requestId, d]) => permissionResponse(requestId, d)),
  fc.tuple(id, fc.string()).map(([requestId, message]) => controlErrorResponse(requestId, message)),
);

describe('builders (property)', () => {
  it('always pass the strict validator and encode to exactly one LF', () => {
    fc.assert(
      fc.property(built, (frame) => {
        expect(validateOutboundFrame(frame).ok).toBe(true);
        const encoded = encodeOutboundFrame(frame, CAP);
        expect(encoded.ok).toBe(true);
        if (encoded.ok) {
          expect(encoded.line.indexOf('\n')).toBe(encoded.line.length - 1);
          expect(JSON.parse(encoded.line)).toEqual(frame);
          expect(encoded.line).not.toContain('workspaceTrust');
        }
      }),
      fcParams(1000),
    );
  });

  it('never let a raw path send initialize or update_settings without the opt-in', () => {
    const subtype = fc.oneof(
      fc.constantFrom('initialize', 'update_settings', 'get_settings', 'mcp_call'),
      fc.string(),
    );
    fc.assert(
      fc.property(subtype, jsonObject, fc.boolean(), (sub, body, rawOn) => {
        const policy = { allowRawControl: rawOn, allowConfigWrites: false };
        const refusal = rawControlRefusal(sub, body, policy);
        const frameRefusal = rawFrameRefusal(rawControlRequest('x', sub, undefined), policy);
        if (sub === 'initialize' || sub === 'update_settings' || !rawOn) {
          expect(refusal).toBeDefined();
          expect(frameRefusal).toBeDefined();
        }
      }),
      fcParams(1000),
    );
  });
});
