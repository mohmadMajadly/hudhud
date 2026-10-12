// The Claude permission machine (plan §1.5, §4.2; ADR-0007, ADR-0012 §3,
// K12): every ask ends exactly once, decisions are strict, non-session
// destinations are stripped, suggestions are passed through as raw data.

import process from 'node:process';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonObject, JsonValue } from '../../../core/src/protocol/json.js';
import { validateOutboundFrame } from '../../src/protocol/generated/validators.gen.js';
import {
  CANCELLED_DENY_MESSAGE,
  CLOSING_DENY_MESSAGE,
  HANDLER_FAILED_DENY_MESSAGE,
  INVALID_DECISION_DENY_MESSAGE,
  MALFORMED_REQUEST_ERROR,
  MAX_PERMISSION_UPDATES,
  PERMISSION_DIAGNOSTIC_CODES,
  initialPermissionState,
  parseDecision,
  permissionMachine,
  stepPermission,
  stripNonSessionDestinations,
} from '../../src/protocol/machine/permission.js';
import type {
  PermissionEffect,
  PermissionInput,
  PermissionMachineState,
} from '../../src/protocol/machine/permission.js';

const seedText = process.env['FC_SEED'];
/** Property runs (plan §4.1): at least 1000; `FC_SEED` reproduces a failure. */
const runs = <T>(): fc.Parameters<T> => ({
  numRuns: 1000,
  ...(seedText === undefined ? {} : { seed: Number(seedText) }),
});

/** Feeds a value the type forbids, as an untyped caller could. */
const untyped = (value: unknown): JsonObject => value as JsonObject;
/** A non-plain object: a class instance is not JSON data. */
class NotPlain {
  readonly kind = 'not-plain';
}

/** The `can_use_tool` request observed on Windows (research 05 §6), abridged. */
const SUGGESTIONS: readonly JsonValue[] = [
  {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'echo hi *' }],
    behavior: 'allow',
    destination: 'localSettings',
  },
  { type: 'addDirectories', directories: ['<run>\\work'], destination: 'session' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];

function canUseTool(requestId: string, extra: JsonObject = {}): JsonObject {
  return {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'echo hi && touch marker.txt', description: 'mock command' },
      description: 'mock command',
      permission_suggestions: SUGGESTIONS,
      blocked_path: '<run>\\work\\marker.txt',
      tool_use_id: `toolu_${requestId}`,
      ...extra,
    },
  };
}

/** Drives the machine from a fresh state; returns the final state and every effect. */
function run(
  inputs: readonly PermissionInput[],
  config = { dangerouslyAllowConfigWrites: false },
): { state: PermissionMachineState; effects: PermissionEffect[]; perStep: PermissionEffect[][] } {
  let state = permissionMachine.initialState(config);
  const effects: PermissionEffect[] = [];
  const perStep: PermissionEffect[][] = [];
  for (const input of inputs) {
    const out = permissionMachine.step(state, input);
    state = out.state;
    effects.push(...out.effects);
    perStep.push([...out.effects]);
  }
  return { state, effects, perStep };
}

const ask = (requestId: string, atMs = 0, turnId?: string): PermissionInput => ({
  type: 'cli.can-use-tool',
  requestId,
  frame: canUseTool(requestId),
  atMs,
  ...(turnId === undefined ? {} : { turnId }),
});
const answer = (requestId: string, decision: JsonObject, atMs = 0): PermissionInput => ({
  type: 'cmd.permission',
  requestId,
  decision,
  atMs,
});

const writes = (effects: readonly PermissionEffect[]): JsonObject[] =>
  effects.flatMap((effect) => (effect.type === 'write' ? [untyped(effect.frame)] : []));
const ofType = <K extends PermissionEffect['type']>(
  effects: readonly PermissionEffect[],
  type: K,
): Extract<PermissionEffect, { type: K }>[] =>
  effects.filter(
    (effect): effect is Extract<PermissionEffect, { type: K }> => effect.type === type,
  );

function successResponse(requestId: string, response: JsonObject): JsonObject {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  };
}
function errorResponse(requestId: string, error: string): JsonObject {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } };
}
const closingDeny = (requestId: string): JsonObject =>
  successResponse(requestId, { behavior: 'deny', message: CLOSING_DENY_MESSAGE, interrupt: false });

/** Every written frame passes the strict outbound validator (ADR-0005 §7). */
function expectWireValid(effects: readonly PermissionEffect[]): void {
  for (const frame of writes(effects)) expect(validateOutboundFrame(frame).ok).toBe(true);
}

describe('ask', () => {
  it('asks the application with the request fields, the raw frame and the suggestions unchanged', () => {
    const frame = canUseTool('r1', { decision_reason_type: 'subcommandResults', title: 'Run?' });
    const { state, effects } = run([
      { type: 'cli.can-use-tool', requestId: 'r1', frame, turnId: 't1', atMs: 5 },
    ]);
    expect(effects).toEqual([
      {
        type: 'permission.ask',
        requestId: 'r1',
        request: {
          requestId: 'r1',
          turnId: 't1',
          toolName: 'Bash',
          displayName: 'Bash',
          toolUseId: 'toolu_r1',
          input: { command: 'echo hi && touch marker.txt', description: 'mock command' },
          suggestions: SUGGESTIONS,
          blockedPath: '<run>\\work\\marker.txt',
          decisionReasonType: 'subcommandResults',
          title: 'Run?',
          description: 'mock command',
          raw: frame,
        },
      },
    ]);
    const asked = ofType(effects, 'permission.ask')[0];
    // Passed through as the very same data, never copied or reshaped (D17).
    expect(asked?.request.suggestions).toBe(SUGGESTIONS);
    expect(asked?.request.raw).toBe(frame);
    expect(state.pending).toEqual([
      {
        requestId: 'r1',
        toolUseId: 'toolu_r1',
        toolName: 'Bash',
        turnId: 't1',
        state: 'asked',
        askedAtMs: 5,
      },
    ]);
  });

  it('passes suggestions of any shape through, including the Linux shape and non-objects', () => {
    const odd: JsonValue[] = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], destination: 'projectSettings' },
      'a string',
      42,
      null,
      [1, [2]],
      { destination: { nested: true } },
    ];
    const { effects } = run([
      {
        type: 'cli.can-use-tool',
        requestId: 'r1',
        frame: canUseTool('r1', { permission_suggestions: odd }),
        atMs: 0,
      },
    ]);
    expect(ofType(effects, 'permission.ask')[0]?.request.suggestions).toBe(odd);
  });

  it('asks with no suggestions when the field is absent or not an array, keeping it in raw', () => {
    for (const value of [undefined, { not: 'an array' }, 'x']) {
      const frame = canUseTool('r1', value === undefined ? {} : { permission_suggestions: value });
      const request = frame['request'] as Record<string, unknown>;
      if (value === undefined) delete request['permission_suggestions'];
      const { effects } = run([{ type: 'cli.can-use-tool', requestId: 'r1', frame, atMs: 0 }]);
      const asked = ofType(effects, 'permission.ask')[0];
      expect(asked?.request.suggestions).toEqual([]);
      expect(asked?.request.raw).toBe(frame);
    }
  });

  it('omits optional fields that are absent or not strings, and the turn id when not given', () => {
    const frame: JsonObject = {
      type: 'control_request',
      request_id: 'r1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Edit',
        tool_use_id: 'tu',
        input: {},
        display_name: 7,
        blocked_path: null,
        decision_reason_type: ['x'],
        title: {},
        description: false,
      },
    };
    const { effects, state } = run([{ type: 'cli.can-use-tool', requestId: 'r1', frame, atMs: 0 }]);
    expect(ofType(effects, 'permission.ask')[0]?.request).toEqual({
      requestId: 'r1',
      toolName: 'Edit',
      toolUseId: 'tu',
      input: {},
      suggestions: [],
      raw: frame,
    });
    expect(state.pending[0]).not.toHaveProperty('turnId');
  });

  it.each([
    ['no request', { type: 'control_request', request_id: 'r1' }],
    ['request not an object', { type: 'control_request', request_id: 'r1', request: [] }],
    [
      'another subtype',
      {
        type: 'control_request',
        request_id: 'r1',
        request: { subtype: 'hook_callback', tool_name: 'Bash', tool_use_id: 'x', input: {} },
      },
    ],
    [
      'no tool_name',
      {
        type: 'control_request',
        request: { subtype: 'can_use_tool', tool_use_id: 'x', input: {} },
      },
    ],
    [
      'no tool_use_id',
      { type: 'control_request', request: { subtype: 'can_use_tool', tool_name: 'B', input: {} } },
    ],
    [
      'input not an object',
      {
        type: 'control_request',
        request: { subtype: 'can_use_tool', tool_name: 'B', tool_use_id: 'x', input: 'rm -rf /' },
      },
    ],
  ] as const)('answers a malformed request (%s) with a control error, never asks', (_, frame) => {
    const { effects, state } = run([
      { type: 'cli.can-use-tool', requestId: 'r1', frame: untyped(frame), atMs: 0 },
    ]);
    expect(effects).toEqual([
      {
        type: 'diagnostic',
        code: 'permission.malformed-request',
        message: expect.any(String) as string,
        data: { requestId: 'r1' },
      },
      { type: 'write', frame: errorResponse('r1', MALFORMED_REQUEST_ERROR) },
    ]);
    expectWireValid(effects);
    expect(state.pending).toEqual([]);
  });

  it('reads inherited fields as absent (prototype pollution)', () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto['tool_name'] = 'Bash';
    proto['tool_use_id'] = 'polluted';
    proto['input'] = {};
    try {
      const { effects } = run([
        {
          type: 'cli.can-use-tool',
          requestId: 'r1',
          frame: { type: 'control_request', request: { subtype: 'can_use_tool' } },
          atMs: 0,
        },
      ]);
      expect(ofType(effects, 'permission.ask')).toEqual([]);
      expect(writes(effects)).toEqual([errorResponse('r1', MALFORMED_REQUEST_ERROR)]);
    } finally {
      delete proto['tool_name'];
      delete proto['tool_use_id'];
      delete proto['input'];
    }
  });

  it('ignores a duplicate in-flight request id without asking or answering twice', () => {
    const { effects, state } = run([ask('r1'), ask('r1')]);
    expect(ofType(effects, 'permission.ask')).toHaveLength(1);
    expect(writes(effects)).toEqual([]);
    expect(effects[1]).toEqual({
      type: 'diagnostic',
      code: 'permission.duplicate-request',
      message: expect.any(String) as string,
      data: { requestId: 'r1' },
    });
    expect(state.pending).toHaveLength(1);
  });

  it('accepts a reused id once the earlier request has ended', () => {
    const { effects } = run([ask('r1'), answer('r1', { behavior: 'allow' }), ask('r1')]);
    expect(ofType(effects, 'permission.ask')).toHaveLength(2);
  });
});

describe('application answers', () => {
  it('allow: writes the decision and resolves allow', () => {
    const { effects, state } = run([
      ask('r1', 100, 't1'),
      answer('r1', { behavior: 'allow' }, 350),
    ]);
    const answered = effects.slice(1);
    expect(answered).toEqual([
      { type: 'write', frame: successResponse('r1', { behavior: 'allow' }) },
      {
        type: 'permission.resolved',
        entry: {
          requestId: 'r1',
          toolUseId: 'toolu_r1',
          toolName: 'Bash',
          turnId: 't1',
          state: 'answered',
          askedAtMs: 100,
        },
        behavior: 'allow',
        by: 'application',
        waitedMs: 250,
        strippedCount: 0,
      },
    ]);
    expectWireValid(effects);
    expect(state.pending).toEqual([]);
  });

  it('allow with updatedInput and session updates: passes them unchanged', () => {
    const updatedInput = { command: 'echo hi' };
    const update = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
    const { effects } = run([
      ask('r1'),
      answer('r1', { behavior: 'allow', updatedInput, updatedPermissions: [update] }),
    ]);
    expect(writes(effects)).toEqual([
      successResponse('r1', { behavior: 'allow', updatedInput, updatedPermissions: [update] }),
    ]);
    expectWireValid(effects);
  });

  it('strips localSettings, userSettings, projectSettings and unknown destinations', () => {
    const kept = { type: 'addDirectories', directories: ['/w'], destination: 'session' };
    const updates: JsonObject[] = [
      { type: 'addRules', rules: [], behavior: 'allow', destination: 'localSettings' },
      kept,
      { type: 'addRules', rules: [], behavior: 'allow', destination: 'userSettings' },
      { type: 'addRules', rules: [], behavior: 'allow', destination: 'projectSettings' },
      { type: 'addRules', rules: [], behavior: 'allow', destination: 'policySettings' },
      { type: 'addRules', rules: [], behavior: 'allow', destination: 'cliArg' },
      { type: 'addRules', rules: [], behavior: 'allow', destination: 'Session' },
      { type: 'addRules', rules: [], behavior: 'allow' },
      { type: 'addRules', destination: ['session'] },
    ];
    const { effects } = run([
      ask('r1'),
      answer('r1', { behavior: 'allow', updatedPermissions: updates }),
    ]);
    expect(effects.slice(1)).toEqual([
      {
        type: 'diagnostic',
        code: 'permission.updates-stripped',
        message: expect.any(String) as string,
        data: { requestId: 'r1', strippedCount: 8 },
      },
      {
        type: 'write',
        frame: successResponse('r1', { behavior: 'allow', updatedPermissions: [kept] }),
      },
      expect.objectContaining({ type: 'permission.resolved', behavior: 'allow', strippedCount: 8 }),
    ]);
    expectWireValid(effects);
  });

  it('keeps an empty list when every update was stripped', () => {
    const { effects } = run([
      ask('r1'),
      answer('r1', { behavior: 'allow', updatedPermissions: [{ destination: 'userSettings' }] }),
    ]);
    expect(writes(effects)).toEqual([
      successResponse('r1', { behavior: 'allow', updatedPermissions: [] }),
    ]);
  });

  it('keeps every destination only with dangerouslyAllowConfigWrites', () => {
    const updates: JsonObject[] = [
      { destination: 'localSettings' },
      { destination: 'userSettings' },
      { destination: 'session' },
      { other: 1 },
    ];
    const { effects } = run(
      [ask('r1'), answer('r1', { behavior: 'allow', updatedPermissions: updates })],
      { dangerouslyAllowConfigWrites: true },
    );
    expect(writes(effects)).toEqual([
      successResponse('r1', { behavior: 'allow', updatedPermissions: updates }),
    ]);
    expect(ofType(effects, 'diagnostic')).toEqual([]);
  });

  it('a session destination inherited from the prototype does not count (prototype pollution)', () => {
    const viaJson = untyped(JSON.parse('{"__proto__":{"destination":"session"}}'));
    const proto = Object.prototype as Record<string, unknown>;
    proto['destination'] = 'session';
    try {
      const { effects } = run([
        ask('r1'),
        answer('r1', { behavior: 'allow', updatedPermissions: [viaJson, { type: 'x' }] }),
      ]);
      expect(writes(effects)).toEqual([
        successResponse('r1', { behavior: 'allow', updatedPermissions: [] }),
      ]);
    } finally {
      delete proto['destination'];
    }
    expect(Object.prototype).not.toHaveProperty('destination');
  });

  it('keeps a null-prototype update whose own destination is session', () => {
    const update = Object.assign(Object.create(null) as Record<string, JsonValue>, {
      destination: 'session',
    });
    const { effects } = run([
      ask('r1'),
      answer('r1', { behavior: 'allow', updatedPermissions: [update] }),
    ]);
    expect(writes(effects)).toEqual([
      successResponse('r1', { behavior: 'allow', updatedPermissions: [update] }),
    ]);
  });

  it('deny and deny+interrupt are written as given', () => {
    for (const decision of [
      { behavior: 'deny', message: 'host says no' },
      { behavior: 'deny', message: 'stop', interrupt: true },
      { behavior: 'deny', message: '', interrupt: false },
    ] as const) {
      const { effects } = run([ask('r1'), answer('r1', decision)]);
      expect(effects.slice(1)).toEqual([
        { type: 'write', frame: successResponse('r1', decision) },
        expect.objectContaining({
          type: 'permission.resolved',
          behavior: 'deny',
          by: 'application',
        }),
      ]);
      expectWireValid(effects);
    }
  });

  it('a failed handler gets a fixed non-interrupting deny; its error goes to the application only', () => {
    const secret = 'TypeError: db password rejected at /srv/app.js:12';
    const { effects } = run([
      ask('r1'),
      { type: 'cmd.permission-error', requestId: 'r1', error: secret, atMs: 0 },
    ]);
    expect(effects.slice(1)).toEqual([
      {
        type: 'diagnostic',
        code: 'permission.handler-failed',
        message: expect.any(String) as string,
        data: { requestId: 'r1', error: secret },
      },
      {
        type: 'write',
        frame: successResponse('r1', {
          behavior: 'deny',
          message: HANDLER_FAILED_DENY_MESSAGE,
          interrupt: false,
        }),
      },
      expect.objectContaining({ type: 'permission.resolved', behavior: 'deny', by: 'application' }),
    ]);
    expectWireValid(effects);
  });

  const tooMany = Array.from({ length: MAX_PERMISSION_UPDATES + 1 }, () => ({
    destination: 'session',
  }));
  it.each([
    ['not-object', []],
    ['not-object', 'allow'],
    ['not-object', null],
    ['not-object', new NotPlain()],
    ['bad-behavior', {}],
    ['bad-behavior', { behavior: 'ask' }],
    ['bad-behavior', { behavior: true }],
    ['unknown-key', { behavior: 'allow', extra: 1 }],
    ['unknown-key', { behavior: 'allow', message: 'x' }],
    ['unknown-key', { behavior: 'deny', message: 'x', updatedInput: {} }],
    ['unknown-key', JSON.parse('{"behavior":"allow","__proto__":{"x":1}}')],
    ['bad-updated-input', { behavior: 'allow', updatedInput: 'x' }],
    ['bad-updated-input', { behavior: 'allow', updatedInput: [] }],
    ['bad-updated-input', { behavior: 'allow', updatedInput: null }],
    ['bad-updated-permissions', { behavior: 'allow', updatedPermissions: {} }],
    ['bad-updated-permissions', { behavior: 'allow', updatedPermissions: [{}, 'x'] }],
    ['bad-updated-permissions', { behavior: 'allow', updatedPermissions: [null] }],
    ['bad-updated-permissions', { behavior: 'allow', updatedPermissions: [new NotPlain()] }],
    ['too-many-updates', { behavior: 'allow', updatedPermissions: tooMany }],
    ['bad-message', { behavior: 'deny' }],
    ['bad-message', { behavior: 'deny', message: 1 }],
    ['bad-interrupt', { behavior: 'deny', message: 'x', interrupt: 'yes' }],
    ['bad-interrupt', { behavior: 'deny', message: 'x', interrupt: null }],
  ] as const)(
    'refuses a decision (%s) with a fixed non-interrupting deny, never an allow',
    (reason, decision) => {
      const { effects } = run([ask('r1'), answer('r1', untyped(decision))]);
      expect(effects.slice(1)).toEqual([
        {
          type: 'diagnostic',
          code: 'permission.invalid-decision',
          message: expect.any(String) as string,
          data: { requestId: 'r1', reason },
        },
        {
          type: 'write',
          frame: successResponse('r1', {
            behavior: 'deny',
            message: INVALID_DECISION_DENY_MESSAGE,
            interrupt: false,
          }),
        },
        expect.objectContaining({
          type: 'permission.resolved',
          behavior: 'deny',
          by: 'application',
        }),
      ]);
      expectWireValid(effects);
    },
  );

  it('accepts exactly MAX_PERMISSION_UPDATES (4096) updates', () => {
    expect(MAX_PERMISSION_UPDATES).toBe(4096);
    const updates = tooMany.slice(1);
    const { effects } = run([
      ask('r1'),
      answer('r1', { behavior: 'allow', updatedPermissions: updates }),
    ]);
    expect(writes(effects)).toEqual([
      successResponse('r1', { behavior: 'allow', updatedPermissions: updates }),
    ]);
  });

  it('counts the limit before stripping', () => {
    const mixed = [...tooMany.slice(1), { destination: 'userSettings' }];
    expect(parseDecision({ behavior: 'allow', updatedPermissions: mixed }, false)).toEqual({
      ok: false,
      reason: 'too-many-updates',
    });
  });

  it('the application withdrawing a request writes a non-interrupting deny', () => {
    const { effects } = run([
      ask('r1', 10),
      { type: 'cmd.permission-abort', requestId: 'r1', atMs: 20 },
    ]);
    expect(effects.slice(1)).toEqual([
      {
        type: 'write',
        frame: successResponse('r1', {
          behavior: 'deny',
          message: CANCELLED_DENY_MESSAGE,
          interrupt: false,
        }),
      },
      expect.objectContaining({
        type: 'permission.resolved',
        behavior: 'cancelled',
        by: 'application',
        waitedMs: 10,
        entry: expect.objectContaining({ state: 'cancelled' }) as unknown,
      }),
    ]);
    expectWireValid(effects);
  });

  it('answers for unknown ids are ignored with a diagnostic, nothing written', () => {
    for (const input of [
      answer('nope', { behavior: 'allow' }, 3),
      { type: 'cmd.permission-error', requestId: 'nope', error: 'e', atMs: 3 },
      { type: 'cmd.permission-abort', requestId: 'nope', atMs: 3 },
      { type: 'cli.cancel', requestId: 'nope', atMs: 3 },
    ] as const) {
      const { effects } = run([input]);
      expect(effects).toEqual([
        {
          type: 'diagnostic',
          code: 'permission.unknown-request',
          message: expect.any(String) as string,
          data: { requestId: 'nope', phase: 'open', atMs: 3 },
        },
      ]);
    }
  });

  it('a second answer for the same request is ignored', () => {
    const { effects } = run([
      ask('r1'),
      answer('r1', { behavior: 'deny', message: 'no' }),
      answer('r1', { behavior: 'allow' }),
    ]);
    expect(writes(effects)).toHaveLength(1);
    expect(effects.at(-1)).toMatchObject({ code: 'permission.unknown-request' });
  });
});

describe('concurrent requests', () => {
  it('several requests are pending at once and are answered in any order', () => {
    const { effects, state, perStep } = run([
      ask('a', 0, 't1'),
      ask('b', 1, 't1'),
      ask('c', 2, 't2'),
      answer('b', { behavior: 'deny', message: 'no' }, 5),
      answer('c', { behavior: 'allow' }, 6),
    ]);
    expect(ofType(effects, 'permission.ask').map((e) => e.requestId)).toEqual(['a', 'b', 'c']);
    expect(writes(perStep[3] ?? [])).toEqual([
      successResponse('b', { behavior: 'deny', message: 'no' }),
    ]);
    expect(writes(perStep[4] ?? [])).toEqual([successResponse('c', { behavior: 'allow' })]);
    expect(state.pending.map((e) => e.requestId)).toEqual(['a']);
  });
});

describe('cancellation (ADR-0007, K12)', () => {
  it('a CLI cancel ends the request without writing, and fires the handler signal', () => {
    const { effects, state } = run([
      ask('r1', 0),
      { type: 'cli.cancel', requestId: 'r1', atMs: 7 },
    ]);
    expect(effects.slice(1)).toEqual([
      { type: 'permission.cancel', requestId: 'r1', reason: 'harness' },
      expect.objectContaining({
        type: 'permission.resolved',
        behavior: 'cancelled',
        by: 'harness',
        waitedMs: 7,
      }),
    ]);
    expect(writes(effects)).toEqual([]);
    expect(state.pending).toEqual([]);
  });

  it('close (drain): every pending request gets the non-interrupting deny', () => {
    const { effects, state, perStep } = run([ask('a'), ask('b'), { type: 'cmd.close', atMs: 9 }]);
    expect(perStep[2]).toEqual([
      { type: 'permission.cancel', requestId: 'a', reason: 'close' },
      { type: 'write', frame: closingDeny('a') },
      expect.objectContaining({ type: 'permission.resolved', behavior: 'cancelled', by: 'close' }),
      { type: 'permission.cancel', requestId: 'b', reason: 'close' },
      { type: 'write', frame: closingDeny('b') },
      expect.objectContaining({ type: 'permission.resolved', behavior: 'cancelled', by: 'close' }),
    ]);
    expectWireValid(effects);
    expect(state).toMatchObject({ phase: 'draining', pending: [] });
  });

  it('while draining, a new request is denied without asking the application', () => {
    const { perStep } = run([{ type: 'cmd.close', atMs: 0 }, ask('late', 4, 't9')]);
    expect(perStep[0]).toEqual([]);
    expect(perStep[1]).toEqual([
      { type: 'write', frame: closingDeny('late') },
      {
        type: 'permission.resolved',
        entry: {
          requestId: 'late',
          toolUseId: 'toolu_late',
          toolName: 'Bash',
          turnId: 't9',
          state: 'answered',
          askedAtMs: 4,
        },
        behavior: 'deny',
        by: 'close',
        waitedMs: 0,
        strippedCount: 0,
      },
    ]);
  });

  it('late handler answers after close are ignored and nothing is written', () => {
    const { perStep } = run([
      ask('r1'),
      { type: 'cmd.close', atMs: 1 },
      answer('r1', { behavior: 'allow' }, 2),
      { type: 'cmd.permission-error', requestId: 'r1', error: 'e', atMs: 2 },
      { type: 'cmd.permission-abort', requestId: 'r1', atMs: 2 },
      { type: 'cli.cancel', requestId: 'r1', atMs: 2 },
    ]);
    for (const step of perStep.slice(2)) {
      expect(step).toEqual([
        expect.objectContaining({
          type: 'diagnostic',
          code: 'permission.unknown-request',
          data: { requestId: 'r1', phase: 'draining', atMs: 2 },
        }),
      ]);
    }
  });

  it('abort: pending requests are cancelled and nothing is written', () => {
    const { effects, state, perStep } = run([ask('a'), ask('b'), { type: 'cmd.abort', atMs: 3 }]);
    expect(perStep[2]).toEqual([
      { type: 'permission.cancel', requestId: 'a', reason: 'abort' },
      expect.objectContaining({ type: 'permission.resolved', behavior: 'cancelled', by: 'abort' }),
      { type: 'permission.cancel', requestId: 'b', reason: 'abort' },
      expect.objectContaining({ type: 'permission.resolved', behavior: 'cancelled', by: 'abort' }),
    ]);
    expect(writes(effects)).toEqual([]);
    expect(state).toMatchObject({ phase: 'aborted', pending: [] });
  });

  it('after abort, new requests and late answers write nothing', () => {
    const { perStep } = run([
      ask('r1'),
      { type: 'cmd.abort', atMs: 0 },
      ask('r2'),
      answer('r1', { behavior: 'allow' }),
      { type: 'cli.cancel', requestId: 'r1', atMs: 0 },
      { type: 'cmd.close', atMs: 0 },
      { type: 'cmd.abort', atMs: 0 },
    ]);
    expect(perStep[2]).toEqual([
      {
        type: 'diagnostic',
        code: 'permission.ignored-after-abort',
        message: expect.any(String) as string,
        data: { requestId: 'r2' },
      },
    ]);
    expect(perStep[3]).toEqual([expect.objectContaining({ code: 'permission.unknown-request' })]);
    expect(perStep[4]).toEqual([expect.objectContaining({ code: 'permission.unknown-request' })]);
    expect(perStep[5]).toEqual([]);
    expect(perStep[6]).toEqual([]);
  });

  it('abort while draining moves to aborted; a second close is a no-op', () => {
    const { state, perStep } = run([
      { type: 'cmd.close', atMs: 0 },
      { type: 'cmd.close', atMs: 0 },
      { type: 'cmd.abort', atMs: 0 },
    ]);
    expect(perStep).toEqual([[], [], []]);
    expect(state.phase).toBe('aborted');
  });

  it('the CLI going away cancels pending requests; afterwards every input yields nothing', () => {
    const { perStep, state } = run([
      ask('r1'),
      { type: 'cli.gone', atMs: 1 },
      ask('r2'),
      answer('r1', { behavior: 'allow' }),
      { type: 'cmd.close', atMs: 1 },
      { type: 'cmd.abort', atMs: 1 },
      { type: 'cli.gone', atMs: 1 },
    ]);
    expect(perStep[1]).toEqual([
      { type: 'permission.cancel', requestId: 'r1', reason: 'harness' },
      expect.objectContaining({
        type: 'permission.resolved',
        behavior: 'cancelled',
        by: 'harness',
      }),
    ]);
    expect(perStep.slice(2)).toEqual([[], [], [], [], []]);
    expect(state).toEqual({ dangerouslyAllowConfigWrites: false, phase: 'ended', pending: [] });
  });

  it('waitedMs never goes negative when the injected clock steps back', () => {
    const { effects } = run([ask('r1', 50), answer('r1', { behavior: 'allow' }, 10)]);
    expect(ofType(effects, 'permission.resolved')[0]?.waitedMs).toBe(0);
  });
});

describe('machine shape', () => {
  it('lists every diagnostic code once', () => {
    expect(PERMISSION_DIAGNOSTIC_CODES).toEqual([
      'permission.malformed-request',
      'permission.duplicate-request',
      'permission.unknown-request',
      'permission.invalid-decision',
      'permission.handler-failed',
      'permission.updates-stripped',
      'permission.ignored-after-abort',
    ]);
  });

  it('initialState carries the config and starts open with nothing pending', () => {
    expect(initialPermissionState({ dangerouslyAllowConfigWrites: true })).toEqual({
      dangerouslyAllowConfigWrites: true,
      phase: 'open',
      pending: [],
    });
    expect(permissionMachine.step).toBe(stepPermission);
  });

  it('does not mutate the state it is given', () => {
    const before = run([ask('a'), ask('b')]).state;
    const snapshot = structuredClone(before);
    stepPermission(before, answer('a', { behavior: 'allow' }));
    stepPermission(before, { type: 'cmd.close', atMs: 0 });
    stepPermission(before, { type: 'cmd.abort', atMs: 0 });
    expect(before).toEqual(snapshot);
  });
});

describe('stripNonSessionDestinations', () => {
  it('returns a new array of the same objects', () => {
    const update = { destination: 'session' };
    const input = [update];
    for (const allow of [false, true]) {
      const { kept } = stripNonSessionDestinations(input, allow);
      expect(kept).not.toBe(input);
      expect(kept[0]).toBe(update);
    }
  });

  const destination = fc.oneof(
    fc.constantFrom(
      'session',
      'localSettings',
      'userSettings',
      'projectSettings',
      'policySettings',
      'cliArg',
      'SESSION',
      ' session',
      '__proto__',
    ),
    fc.string(),
    fc.jsonValue({ maxDepth: 1 }),
  );
  const update = fc
    .record(
      { destination, type: fc.string(), rules: fc.jsonValue({ maxDepth: 2 }) },
      { requiredKeys: [] },
    )
    .map(untyped);

  it('keeps exactly the updates whose own destination is "session", in order (property)', () => {
    fc.assert(
      fc.property(fc.array(update, { maxLength: 20 }), (updates) => {
        const { kept, strippedCount } = stripNonSessionDestinations(updates, false);
        const expected = updates.filter(
          (u) => Object.hasOwn(u, 'destination') && u['destination'] === 'session',
        );
        expect(kept).toEqual(expected);
        kept.forEach((u, i) => {
          expect(u).toBe(expected[i]);
        });
        expect(strippedCount).toBe(updates.length - kept.length);
      }),
      runs(),
    );
  });

  it('keeps every update unchanged under dangerouslyAllowConfigWrites (property)', () => {
    fc.assert(
      fc.property(fc.array(update, { maxLength: 20 }), (updates) => {
        const { kept, strippedCount } = stripNonSessionDestinations(updates, true);
        expect(kept).toEqual(updates);
        expect(strippedCount).toBe(0);
      }),
      runs(),
    );
  });

  it('a written allow never carries a non-session destination by default (property)', () => {
    fc.assert(
      fc.property(fc.array(update, { maxLength: 20 }), (updates) => {
        const { effects } = run([
          ask('r1'),
          answer('r1', { behavior: 'allow', updatedPermissions: updates }),
        ]);
        const [frame] = writes(effects);
        const response = (
          frame as unknown as {
            response: { response: { updatedPermissions: JsonObject[] } };
          }
        ).response.response;
        for (const u of response.updatedPermissions) expect(u['destination']).toBe('session');
        expect(validateOutboundFrame(frame).ok).toBe(true);
      }),
      runs(),
    );
  });
});

describe('every ask ends exactly once (property)', () => {
  const id = fc.constantFrom('a', 'b', 'c');
  const decision = fc.oneof(
    fc.constant<JsonObject>({ behavior: 'allow' }),
    fc.constant<JsonObject>({ behavior: 'deny', message: 'no', interrupt: true }),
    fc.constant<JsonObject>({
      behavior: 'allow',
      updatedPermissions: [{ destination: 'userSettings' }],
    }),
    fc.jsonValue({ maxDepth: 2 }).map(untyped),
  );
  const input: fc.Arbitrary<PermissionInput> = fc.oneof(
    { weight: 4, arbitrary: id.map((r) => ask(r)) },
    { weight: 3, arbitrary: fc.tuple(id, decision).map(([r, d]) => answer(r, d)) },
    {
      weight: 1,
      arbitrary: id.map(
        (r) => ({ type: 'cmd.permission-error', requestId: r, error: 'e', atMs: 0 }) as const,
      ),
    },
    {
      weight: 1,
      arbitrary: id.map((r) => ({ type: 'cmd.permission-abort', requestId: r, atMs: 0 }) as const),
    },
    {
      weight: 1,
      arbitrary: id.map((r) => ({ type: 'cli.cancel', requestId: r, atMs: 0 }) as const),
    },
    { weight: 1, arbitrary: fc.constant({ type: 'cmd.close', atMs: 0 } as const) },
    { weight: 1, arbitrary: fc.constant({ type: 'cmd.abort', atMs: 0 } as const) },
  );

  it('asks, ends, writes and the abort rule hold over random interleavings', () => {
    fc.assert(
      fc.property(fc.array(input, { maxLength: 40 }), (inputs) => {
        const all = [...inputs, { type: 'cli.gone', atMs: 0 } as const];
        const { perStep, state } = run(all);
        const open = new Set<string>();
        let aborted = false;
        all.forEach((step, i) => {
          if (step.type === 'cmd.abort') aborted = true;
          for (const effect of perStep[i] ?? []) {
            // JSON round trip of every effect (sans-IO contract).
            expect(JSON.parse(JSON.stringify(effect))).toEqual(effect);
            if (effect.type === 'permission.ask') {
              expect(open.has(effect.requestId)).toBe(false);
              open.add(effect.requestId);
            } else if (effect.type === 'permission.resolved') {
              if (open.has(effect.entry.requestId)) open.delete(effect.entry.requestId);
              else expect(effect.by).toBe('close');
            } else if (effect.type === 'diagnostic') {
              expect(PERMISSION_DIAGNOSTIC_CODES).toContain(effect.code);
            } else if (effect.type === 'write') {
              // K12: nothing is ever written once abort was requested.
              expect(aborted).toBe(false);
              expect(validateOutboundFrame(effect.frame).ok).toBe(true);
            }
          }
          // One write at most per step: each request is answered once.
          expect(writes(perStep[i] ?? []).length).toBeLessThanOrEqual(
            step.type === 'cmd.close' ? 3 : 1,
          );
        });
        expect(open.size).toBe(0);
        expect(state.pending).toEqual([]);
        expect(JSON.parse(JSON.stringify(state))).toEqual(state);
      }),
      runs(),
    );
  });
});
