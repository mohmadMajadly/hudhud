// The Claude wire types and their TypeBox schema sources accept the same
// values (type level); the generated validators are strict outbound and
// lenient inbound (ADR-0005 §7), checked against frames observed with the
// pinned CLI (research 05, 07).

import type { Static } from 'typebox';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { JsonObject } from '../../../core/src/protocol/json.js';
import type { TypesEqual } from '../../../core/test/unit/type-equality.js';
import type * as inbound from '../../schema-src/wire-inbound.js';
import type * as outbound from '../../schema-src/wire-outbound.js';
import {
  validateApiRetryFrame,
  validateAssistantFrame,
  validateCanUseToolRequestFrame,
  validateCommandLifecycleFrame,
  validateControlResponseFrame,
  validateInboundEnvelope,
  validateInitializeResponse,
  validateInterruptResponse,
  validateOutboundFrame,
  validatePermissionDeniedFrame,
  validateResultFrame,
  validateSessionStateChangedFrame,
  validateSystemInitFrame,
} from '../../src/protocol/generated/validators.gen.js';
import type * as wire from '../../src/protocol/wire/types.js';

describe('wire types equal their schema sources', () => {
  it('outbound frames', () => {
    expectTypeOf<
      TypesEqual<wire.PermissionModeWire, Static<typeof outbound.PermissionModeWire>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.InitializeRequestFrame, Static<typeof outbound.InitializeRequestFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.InterruptRequestFrame, Static<typeof outbound.InterruptRequestFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<
        wire.SetPermissionModeRequestFrame,
        Static<typeof outbound.SetPermissionModeRequestFrame>
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.UserContentBlockWire, Static<typeof outbound.UserContentBlockWire>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.UserContentWire, Static<typeof outbound.UserContentWire>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.UserMessageFrame, Static<typeof outbound.UserMessageFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.PermissionDecisionWire, Static<typeof outbound.PermissionDecisionWire>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.PermissionResponseFrame, Static<typeof outbound.PermissionResponseFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.ControlErrorResponseFrame, Static<typeof outbound.ControlErrorResponseFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.OutboundFrame, Static<typeof outbound.OutboundFrame>>
    >().toEqualTypeOf<true>();
  });

  it('inbound envelope and frame views', () => {
    expectTypeOf<
      TypesEqual<wire.ControlRequestFrame, Static<typeof inbound.ControlRequestFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.ControlResponseEnvelope, Static<typeof inbound.ControlResponseEnvelope>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.ControlCancelRequestFrame, Static<typeof inbound.ControlCancelRequestFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.KeepAliveFrame, Static<typeof inbound.KeepAliveFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.ConversationEnvelope, Static<typeof inbound.ConversationEnvelope>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.InboundEnvelope, Static<typeof inbound.InboundEnvelope>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<
        wire.ControlResponseSuccessFrame,
        Static<typeof inbound.ControlResponseSuccessFrame>
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.ControlResponseErrorFrame, Static<typeof inbound.ControlResponseErrorFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.ControlResponseFrame, Static<typeof inbound.ControlResponseFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.InitializeResponse, Static<typeof inbound.InitializeResponse>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.InterruptResponse, Static<typeof inbound.InterruptResponse>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.CanUseToolRequest, Static<typeof inbound.CanUseToolRequest>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.CanUseToolRequestFrame, Static<typeof inbound.CanUseToolRequestFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.SystemFrame, Static<typeof inbound.SystemFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.SystemInitFrame, Static<typeof inbound.SystemInitFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.ApiRetryFrame, Static<typeof inbound.ApiRetryFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.SessionStateChangedFrame, Static<typeof inbound.SessionStateChangedFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.PermissionDeniedFrame, Static<typeof inbound.PermissionDeniedFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.AssistantFrame, Static<typeof inbound.AssistantFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.UserFrame, Static<typeof inbound.UserFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.StreamEventFrame, Static<typeof inbound.StreamEventFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.ResultFrame, Static<typeof inbound.ResultFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.CommandLifecycleFrame, Static<typeof inbound.CommandLifecycleFrame>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypesEqual<wire.UnknownFrame, Static<typeof inbound.UnknownFrame>>
    >().toEqualTypeOf<true>();
  });

  it('the equality check itself fails on a difference', () => {
    type Differs<A, B> = TypesEqual<A, B> extends true ? false : true;
    // One optional property more: mutual assignability would miss this.
    expectTypeOf<
      Differs<
        wire.InitializeRequestFrame['request'],
        wire.InitializeRequestFrame['request'] & { workspaceTrust?: boolean }
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<Differs<{ a?: string }, { a: string }>>().toEqualTypeOf<true>();
    expectTypeOf<
      Differs<wire.PermissionModeWire, wire.PermissionModeWire | 'manual'>
    >().toEqualTypeOf<true>();
    expectTypeOf<Differs<JsonObject, Readonly<Record<string, string>>>>().toEqualTypeOf<true>();
    // Readonly-ness of properties and arrays does not change accepted values.
    expectTypeOf<
      TypesEqual<{ readonly a: readonly string[] }, { a: string[] }>
    >().toEqualTypeOf<true>();
  });
});

// ---- outbound: strict ------------------------------------------------------------

const OUTBOUND_SAMPLES: readonly wire.OutboundFrame[] = [
  { type: 'control_request', request_id: 'hudhud_1', request: { subtype: 'initialize' } },
  {
    type: 'control_request',
    request_id: 'hudhud_2',
    request: { subtype: 'interrupt', cancel_queued: true },
  },
  {
    type: 'control_request',
    request_id: 'hudhud_3',
    request: { subtype: 'set_permission_mode', mode: 'acceptEdits' },
  },
  {
    type: 'user',
    message: { role: 'user', content: 'مرحبا' },
    parent_tool_use_id: null,
    session_id: '',
    uuid: '00000000-0000-4000-8000-000000000001',
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
    uuid: 'u-2',
  },
  {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: '96faf3d7-4d77-4311-839f-a6ddaaec5323',
      response: {
        behavior: 'allow',
        updatedInput: { command: 'echo hi' },
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      },
    },
  },
  {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'r',
      response: { behavior: 'deny', message: 'hudhud session closing', interrupt: false },
    },
  },
  {
    type: 'control_response',
    response: {
      subtype: 'error',
      request_id: 'r',
      error: 'Unsupported control request subtype: hook_callback',
    },
  },
];

/** Every object path of a value, for planting an unknown key at each level. */
function objectPaths(value: unknown, at: readonly (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectPaths(item, [...at, index]));
  }
  if (typeof value !== 'object' || value === null) return [];
  return [
    [...at],
    ...Object.entries(value).flatMap(([key, member]) => objectPaths(member, [...at, key])),
  ];
}

/** A deep copy of `value` with `extra: true` added to the object at `path`. */
function withUnknownKey(value: unknown, path: readonly (string | number)[]): unknown {
  const copy = JSON.parse(JSON.stringify(value)) as unknown;
  let target = copy as Record<string | number, unknown>;
  for (const step of path) target = target[step] as Record<string | number, unknown>;
  target['extra'] = true;
  return copy;
}

/** Objects whose content is the tool's or the application's JSON, not wire structure. */
const OPAQUE = new Set(['updatedInput', 'updatedPermissions']);

describe('outbound validator (strict)', () => {
  it('accepts every frame hudhud writes', () => {
    for (const frame of OUTBOUND_SAMPLES) {
      expect(validateOutboundFrame(frame)).toEqual({ ok: true, value: frame });
    }
  });

  it('refuses an unknown key at every level of wire structure', () => {
    let planted = 0;
    for (const frame of OUTBOUND_SAMPLES) {
      for (const path of objectPaths(frame)) {
        if (path.some((step) => typeof step === 'string' && OPAQUE.has(step))) continue;
        planted += 1;
        expect(validateOutboundFrame(withUnknownKey(frame, path)).ok, path.join('.')).toBe(false);
      }
    }
    expect(planted).toBeGreaterThan(20);
  });

  it('cannot carry initialize.workspaceTrust (ADR-0012 §2, J3)', () => {
    const frame = {
      type: 'control_request',
      request_id: 'hudhud_1',
      request: { subtype: 'initialize', workspaceTrust: { accepted: true } },
    };
    expect(validateOutboundFrame(frame)).toEqual({
      ok: false,
      issue: {
        instancePath: '/request',
        schemaPath: '#/properties/request/additionalProperties',
        keyword: 'additionalProperties',
      },
    });
  });

  it('cannot carry system prompts or a user priority (ADR-0015 provenance ruling)', () => {
    const initialize = { type: 'control_request', request_id: 'hudhud_1' };
    for (const request of [
      { subtype: 'initialize', appendSystemPrompt: 'x' },
      { subtype: 'initialize', systemPrompt: ['a'] },
    ]) {
      expect(validateOutboundFrame({ ...initialize, request }).ok).toBe(false);
    }
    const user = { type: 'user', message: { role: 'user', content: 'x' }, uuid: 'u-1' };
    expect(validateOutboundFrame(user).ok).toBe(true);
    expect(validateOutboundFrame({ ...user, priority: 'now' }).ok).toBe(false);
  });

  it('refuses wrong values', () => {
    const bad: unknown[] = [
      { type: 'control_request', request_id: '', request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: 'r', request: { subtype: 'interrupt' } },
      {
        type: 'control_request',
        request_id: 'r',
        request: { subtype: 'set_permission_mode', mode: 'manual' },
      },
      { type: 'control_request', request_id: 'r', request: { subtype: 'get_settings' } },
      { type: 'user', message: { role: 'assistant', content: 'x' }, uuid: 'u' },
      { type: 'user', message: { role: 'user', content: 'x' } },
      { type: 'user', message: { role: 'user', content: 'x' }, uuid: 'u', parent_tool_use_id: 'p' },
      {
        type: 'control_response',
        response: { subtype: 'success', request_id: 'r', response: { behavior: 'deny' } },
      },
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'r',
          response: {
            behavior: 'allow',
            updatedPermissions: Array.from({ length: 4097 }, () => ({})),
          },
        },
      },
      { type: 'keep_alive' },
      null,
      'x',
    ];
    for (const frame of bad)
      expect(validateOutboundFrame(frame).ok, JSON.stringify(frame)).toBe(false);
  });
});

// ---- inbound: lenient ------------------------------------------------------------

/** Frames as observed with CLI 2.1.296 (05 §5-§12, 07 §1), trimmed. */
const OBSERVED = {
  initResponse: {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'init_1',
      pending_permission_requests: [],
      response: {
        commands: [],
        models: [{ value: 'default', resolvedModel: 'claude-opus-5-5' }],
        account: {
          tokenSource: 'none',
          apiKeySource: 'ANTHROPIC_API_KEY',
          apiProvider: 'firstParty',
        },
        pid: 37148,
        claude_code_version: '2.1.296',
        current_permission_mode: 'default',
        session_state: 'idle',
        capabilities: ['ui_surface_v1'],
      },
    },
  },
  systemInit: {
    type: 'system',
    subtype: 'init',
    cwd: 'w',
    session_id: 'd6e7fffb-0000-4000-8000-000000000000',
    tools: ['Bash'],
    model: 'claude-opus-5-5',
    permissionMode: 'auto',
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: '2.1.296',
    capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'],
    uuid: 'x',
  },
  canUseTool: {
    type: 'control_request',
    request_id: '96faf3d7-4d77-4311-839f-a6ddaaec5323',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'echo hi && touch marker.txt', description: 'mock command' },
      description: 'mock command',
      permission_suggestions: [
        { type: 'addRules', rules: [], behavior: 'allow', destination: 'localSettings' },
      ],
      blocked_path: 'w/marker.txt',
      tool_use_id: 'toolu_mock_0002',
    },
  },
  cancel: { type: 'control_cancel_request', request_id: '548e5f58-0000' },
  interruptResponse: {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'int_1',
      response: { still_queued: [], cancelled: ['u-2'] },
    },
  },
  errorResponse: {
    type: 'control_response',
    response: { subtype: 'error', request_id: 'r', error: 'nope' },
  },
  permissionDenied: {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'toolu_mock_0007',
    message: 'needs approval',
    decision_reason_type: 'classifier',
    uuid: 'u',
    session_id: 's',
  },
  apiRetry: {
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 612.5,
    error_status: 401,
    error: 'authentication_failed',
  },
  sessionState: { type: 'system', subtype: 'session_state_changed', state: 'idle' },
  backgroundTasks: { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
  assistantAuthError: {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Failed to authenticate.' }] },
    error: 'authentication_failed',
    parent_tool_use_id: null,
    session_id: 's',
  },
  user: { type: 'user', message: { role: 'user', content: [] }, parent_tool_use_id: 'toolu_1' },
  streamEvent: { type: 'stream_event', event: { type: 'message_stop' } },
  lifecycle: { type: 'command_lifecycle', command_uuid: 'u-1', state: 'started' },
  resultAborted: {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'aborted_streaming',
    errors: ['[ede_diagnostic] result_type=user'],
    num_turns: 1,
    user_message_uuid: 'u-1',
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 't', tool_input: {} }],
    usage: { input_tokens: 1 },
    total_cost_usd: 0.01,
    session_id: 's',
  },
  resultNotFound: {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    num_turns: 0,
    session_id: '00000000-0000-4000-8000-00000000000a',
    errors: ['No conversation found with session ID: 00000000-0000-4000-8000-00000000000a'],
  },
  result401: {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 401,
    terminal_reason: 'api_error',
    result: 'Failed to authenticate. API Error: 401 mock 401',
  },
  keepAlive: { type: 'keep_alive' },
  unknown: { type: 'transcript_mirror', anything: [1, 2] },
} as const;

describe('inbound validators (lenient)', () => {
  it('accept the routing envelope of every observed frame', () => {
    for (const [name, frame] of Object.entries(OBSERVED)) {
      expect(validateInboundEnvelope(frame).ok, name).toBe(true);
    }
  });

  it('accept unknown keys at every level', () => {
    for (const frame of Object.values(OBSERVED)) {
      for (const path of objectPaths(frame)) {
        expect(validateInboundEnvelope(withUnknownKey(frame, path)).ok).toBe(true);
      }
    }
  });

  it('refuse a routing field of the wrong JSON type', () => {
    const malformed: unknown[] = [
      { type: 'control_request', request: { subtype: 'can_use_tool' } },
      { type: 'control_request', request_id: 7, request: { subtype: 'can_use_tool' } },
      { type: 'control_request', request_id: 'r', request: { subtype: 1 } },
      { type: 'control_request', request_id: 'r' },
      { type: 'control_response', response: { subtype: 'success' } },
      { type: 'control_response', response: 'x' },
      { type: 'control_cancel_request' },
      { type: 'system', subtype: 5 },
      { type: 'assistant', uuid: 1 },
      { type: 'result', session_id: null },
      { type: 7 },
      {},
      [],
      'line',
    ];
    for (const frame of malformed) {
      expect(validateInboundEnvelope(frame).ok, JSON.stringify(frame)).toBe(false);
    }
  });

  it('read only own properties of untrusted frames', () => {
    const frame = JSON.parse(
      '{"type":"control_cancel_request","__proto__":{"request_id":"r"}}',
    ) as unknown;
    expect(validateInboundEnvelope(frame).ok).toBe(false);
    const inherited = Object.create({ request_id: 'r' }) as Record<string, unknown>;
    inherited['type'] = 'control_cancel_request';
    expect(validateInboundEnvelope(inherited).ok).toBe(false);
  });

  it('type the frame views', () => {
    expect(validateControlResponseFrame(OBSERVED.initResponse).ok).toBe(true);
    expect(validateControlResponseFrame(OBSERVED.errorResponse).ok).toBe(true);
    expect(validateInitializeResponse(OBSERVED.initResponse.response.response).ok).toBe(true);
    expect(validateInterruptResponse(OBSERVED.interruptResponse.response.response).ok).toBe(true);
    expect(validateCanUseToolRequestFrame(OBSERVED.canUseTool).ok).toBe(true);
    expect(validateSystemInitFrame(OBSERVED.systemInit).ok).toBe(true);
    expect(validateApiRetryFrame(OBSERVED.apiRetry).ok).toBe(true);
    expect(validateSessionStateChangedFrame(OBSERVED.sessionState).ok).toBe(true);
    expect(validatePermissionDeniedFrame(OBSERVED.permissionDenied).ok).toBe(true);
    expect(validateAssistantFrame(OBSERVED.assistantAuthError).ok).toBe(true);
    expect(validateResultFrame(OBSERVED.resultAborted).ok).toBe(true);
    expect(validateResultFrame(OBSERVED.resultNotFound).ok).toBe(true);
    expect(validateResultFrame(OBSERVED.result401).ok).toBe(true);
    expect(validateResultFrame({ type: 'result', api_error_status: null }).ok).toBe(true);
    expect(validateCommandLifecycleFrame(OBSERVED.lifecycle).ok).toBe(true);
  });

  it('refuse a view whose typed field has the wrong type', () => {
    expect(
      validateControlResponseFrame({
        ...OBSERVED.errorResponse,
        response: { subtype: 'later', request_id: 'r' },
      }).ok,
    ).toBe(false);
    expect(validateInitializeResponse({ pid: 'x' }).ok).toBe(false);
    expect(validateInterruptResponse({ still_queued: [1] }).ok).toBe(false);
    expect(
      validateCanUseToolRequestFrame({
        ...OBSERVED.canUseTool,
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: 'x', tool_use_id: 't' },
      }).ok,
    ).toBe(false);
    expect(validateSystemInitFrame({ type: 'system', subtype: 'init', capabilities: 'x' }).ok).toBe(
      false,
    );
    expect(validateApiRetryFrame({ type: 'system', subtype: 'api_retry', attempt: 1.5 }).ok).toBe(
      false,
    );
    expect(validateSessionStateChangedFrame({ type: 'system', subtype: 'init' }).ok).toBe(false);
    expect(
      validatePermissionDeniedFrame({ type: 'system', subtype: 'permission_denied', tool_name: 1 })
        .ok,
    ).toBe(false);
    expect(validateAssistantFrame({ type: 'assistant', message: [] }).ok).toBe(false);
    expect(validateResultFrame({ type: 'result', num_turns: -1 }).ok).toBe(false);
    expect(validateCommandLifecycleFrame({ type: 'command_lifecycle', state: 1 }).ok).toBe(false);
  });
});
