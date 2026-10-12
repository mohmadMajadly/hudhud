// The control-request correlator: unique ids, matched responses, late and
// unknown responses, duplicate inbound ids, cancels, timeouts through timer
// effects, unsupported subtypes answered, the never-answered set silent, and
// stdin authority (only control_response answers are written for the CLI).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeErrorData } from '../../../../core/src/protocol/errors.js';
import type { JsonObject } from '../../../../core/src/protocol/json.js';
import { validateOutboundFrame } from '../../../src/protocol/generated/validators.gen.js';
import {
  answerInbound,
  cancelControlRequest,
  closeControl,
  controlTimerFired,
  initialControlState,
  isNeverAnswered,
  receiveControlFrame,
  sendControlRequest,
  UNSUPPORTED_SUBTYPE_MESSAGE,
  type ControlConfig,
  type ControlEffect,
  type ControlState,
  type OutboundRequest,
} from '../../../src/protocol/machine/control.js';
import type { InitializeBody } from '../../../src/protocol/wire/types.js';
import { classifyInbound } from '../../../src/protocol/wire/inbound.js';
import { RESEARCH_FRAMES } from './research-frames.js';
import { fcParams } from './support.js';

const CONFIG: ControlConfig = {
  maxOutboundBytes: 32 * 1024 * 1024,
  allowRawControl: false,
  allowConfigWrites: false,
};
const RAW: ControlConfig = { ...CONFIG, allowRawControl: true };

function written(effects: readonly ControlEffect[]): JsonObject[] {
  return effects.flatMap((effect) =>
    effect.type === 'write' ? [JSON.parse(effect.line) as JsonObject] : [],
  );
}

function receive(state: ControlState, frame: JsonObject, config = CONFIG, turnId?: string) {
  return receiveControlFrame(state, config, classifyInbound(frame), turnId);
}

function response(requestId: string, body?: JsonObject): JsonObject {
  return {
    type: 'control_response',
    response:
      body === undefined
        ? { subtype: 'success', request_id: requestId }
        : { subtype: 'success', request_id: requestId, response: body },
  };
}

function canUseTool(requestId: string): JsonObject {
  return {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 't1' },
  };
}

function request(requestId: string, subtype: string): JsonObject {
  return { type: 'control_request', request_id: requestId, request: { subtype } };
}

describe('outbound requests', () => {
  it('writes each purpose with a fresh hudhud_<n> id and settles on its response', () => {
    let state = initialControlState();
    const requests: OutboundRequest[] = [
      { correlation: 'c-init', purpose: 'initialize', body: {} },
      { correlation: 'c-int', purpose: 'interrupt', cancelQueued: true },
      { correlation: 'c-mode', purpose: 'set_permission_mode', mode: 'acceptEdits' },
    ];
    const lines: JsonObject[] = [];
    for (const [index, req] of requests.entries()) {
      const step = sendControlRequest(state, CONFIG, req, 100 + index);
      state = step.state;
      lines.push(...written(step.effects));
      expect(step.effects).toHaveLength(1);
    }
    expect(lines).toEqual([
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
    ]);
    expect(state.outbound.map((entry) => [entry.requestId, entry.purpose, entry.sentAtMs])).toEqual(
      [
        ['hudhud_1', 'initialize', 100],
        ['hudhud_2', 'interrupt', 101],
        ['hudhud_3', 'set_permission_mode', 102],
      ],
    );

    // Responses may arrive out of order.
    const mode = receive(state, response('hudhud_3', {}));
    expect(mode).toMatchObject({ handled: true });
    expect(mode.effects).toEqual([
      {
        type: 'settle',
        correlation: 'c-mode',
        purpose: 'set_permission_mode',
        ok: true,
        response: {},
      },
    ]);
    // The research id init_1 is not one hudhud issued.
    const init = receive(mode.state, RESEARCH_FRAMES[0]?.frame ?? {});
    expect(init.effects).toEqual([
      {
        type: 'diagnostic',
        code: 'control.unknown-response',
        message: 'Ignored a control_response for a request hudhud never sent.',
        data: { requestId: 'init_1' },
      },
    ]);
    const ours = receive(mode.state, response('hudhud_1'));
    expect(ours.effects).toEqual([
      { type: 'settle', correlation: 'c-init', purpose: 'initialize', ok: true },
    ]);
    const failed = receive(ours.state, {
      type: 'control_response',
      response: { subtype: 'error', request_id: 'hudhud_2', error: 'x'.repeat(2000) },
    });
    expect(failed.effects).toHaveLength(1);
    const settle = failed.effects[0];
    expect(settle).toMatchObject({
      type: 'settle',
      correlation: 'c-int',
      purpose: 'interrupt',
      ok: false,
      error: {
        code: 'CONTROL_REQUEST_FAILED',
        retryable: true,
        message: 'The CLI answered the interrupt control request with an error.',
        details: { subtype: 'interrupt', requestId: 'hudhud_2' },
      },
    });
    const cliError =
      settle?.type === 'settle' && !settle.ok ? settle.error.details?.['cliError'] : '';
    expect(typeof cliError === 'string' && cliError.length).toBe(1025);
    expect(failed.state.outbound).toEqual([]);
    expect(failed.state.nextId).toBe(4);
  });

  it('never writes workspaceTrust, whatever the initialize body carries (J3)', () => {
    // @ts-expect-error -- InitializeBody has no fields in v1
    const typed: InitializeBody = { workspaceTrust: { accepted: true, directory: '/w' } };
    const smuggled = JSON.parse(
      '{"workspaceTrust":{"accepted":true,"directory":"/w"},"appendSystemPrompt":"x","__proto__":{"a":1}}',
    ) as InitializeBody;
    for (const body of [typed, smuggled]) {
      const step = sendControlRequest(
        initialControlState(),
        CONFIG,
        { correlation: 'i', purpose: 'initialize', body },
        0,
      );
      expect(step.effects).toEqual([
        {
          type: 'write',
          line: '{"type":"control_request","request_id":"hudhud_1","request":{"subtype":"initialize"}}\n',
          bytes: 86,
        },
      ]);
    }
  });

  it('reports late and unknown responses without settling twice', () => {
    let state = initialControlState();
    state = sendControlRequest(
      state,
      CONFIG,
      { correlation: 'a', purpose: 'interrupt', cancelQueued: false },
      0,
    ).state;
    const first = receive(state, response('hudhud_1'));
    expect(first.effects).toHaveLength(1);
    const duplicate = receive(first.state, response('hudhud_1'));
    expect(duplicate.effects).toEqual([
      {
        type: 'diagnostic',
        code: 'control.late-response',
        message: 'Ignored a control_response for a request that is no longer pending.',
        data: { requestId: 'hudhud_1' },
      },
    ]);
    for (const unknown of [
      'hudhud_2',
      'hudhud_0',
      'hudhud_01',
      'init_1',
      '__proto__',
      'hudhud_x',
      'y'.repeat(300),
    ]) {
      const step = receive(first.state, response(unknown));
      expect(step.effects).toHaveLength(1);
      expect(step.effects[0]).toMatchObject({
        type: 'diagnostic',
        code: 'control.unknown-response',
      });
      expect(step.state).toBe(first.state);
    }
    const long = receive(first.state, response('y'.repeat(300)));
    expect(long.effects[0]).toMatchObject({ data: { requestId: `${'y'.repeat(128)}…` } });
  });

  it('times out through timer effects and treats a later response as late', () => {
    let state = initialControlState();
    const sent = sendControlRequest(
      state,
      CONFIG,
      { correlation: 'm', purpose: 'set_permission_mode', mode: 'plan', timeoutMs: 5000 },
      10,
    );
    expect(sent.effects[1]).toEqual({
      type: 'timer.set',
      name: 'control.timeout:hudhud_1',
      ms: 5000,
    });
    state = sent.state;
    expect(controlTimerFired(state, 'first-frame')).toEqual({ state, effects: [], handled: false });
    expect(controlTimerFired(state, 'control.timeout:hudhud_9')).toEqual({
      state,
      effects: [],
      handled: true,
    });
    const fired = controlTimerFired(state, 'control.timeout:hudhud_1');
    expect(fired.handled).toBe(true);
    expect(fired.effects).toEqual([
      {
        type: 'settle',
        correlation: 'm',
        purpose: 'set_permission_mode',
        ok: false,
        error: makeErrorData(
          'CONTROL_REQUEST_FAILED',
          'The set_permission_mode control request timed out.',
          {
            cause: 'timeout',
            subtype: 'set_permission_mode',
            requestId: 'hudhud_1',
            timeoutMs: 5000,
          },
        ),
      },
    ]);
    const late = receive(fired.state, response('hudhud_1'));
    expect(late.effects[0]).toMatchObject({ code: 'control.late-response' });

    // A response before the deadline clears the timer.
    const again = sendControlRequest(
      fired.state,
      CONFIG,
      { correlation: 'n', purpose: 'interrupt', cancelQueued: true, timeoutMs: 1 },
      20,
    );
    const answered = receive(again.state, response('hudhud_2', { still_queued: [] }));
    expect(answered.effects).toEqual([
      { type: 'timer.clear', name: 'control.timeout:hudhud_2' },
      {
        type: 'settle',
        correlation: 'n',
        purpose: 'interrupt',
        ok: true,
        response: { still_queued: [] },
      },
    ]);
  });

  it('cancels locally without writing, and closes every pending request', () => {
    const aborted = makeErrorData('ABORTED', 'aborted');
    let state = initialControlState();
    state = sendControlRequest(
      state,
      RAW,
      { correlation: 'r', purpose: 'raw', subtype: 'get_settings', timeoutMs: 50 },
      0,
    ).state;
    state = sendControlRequest(
      state,
      RAW,
      { correlation: 's', purpose: 'raw', subtype: 'mcp_status' },
      0,
    ).state;
    expect(cancelControlRequest(state, 'nope', aborted)).toEqual({ state, effects: [] });
    const cancelled = cancelControlRequest(state, 'r', aborted);
    expect(cancelled.effects).toEqual([
      { type: 'timer.clear', name: 'control.timeout:hudhud_1' },
      { type: 'settle', correlation: 'r', purpose: 'raw', ok: false, error: aborted },
    ]);
    expect(written(cancelled.effects)).toEqual([]);
    expect(receive(cancelled.state, response('hudhud_1')).effects[0]).toMatchObject({
      code: 'control.late-response',
    });
    const cancelledNoTimer = cancelControlRequest(cancelled.state, 's', aborted);
    expect(cancelledNoTimer.effects).toEqual([
      { type: 'settle', correlation: 's', purpose: 'raw', ok: false, error: aborted },
    ]);

    let open = sendControlRequest(
      cancelledNoTimer.state,
      RAW,
      { correlation: 't', purpose: 'raw', subtype: 'get_usage', timeoutMs: 9 },
      0,
    ).state;
    open = receive(open, canUseTool('cli-1'), CONFIG, 'turn-1').state;
    open = receive(open, canUseTool('cli-2')).state;
    const exited = makeErrorData('PROCESS_EXITED', 'gone');
    const closed = closeControl(open, exited);
    expect(closed.effects).toEqual([
      { type: 'timer.clear', name: 'control.timeout:hudhud_3' },
      { type: 'settle', correlation: 't', purpose: 'raw', ok: false, error: exited },
      { type: 'inbound.cancel', requestId: 'cli-1', subtype: 'can_use_tool', turnId: 'turn-1' },
      { type: 'inbound.cancel', requestId: 'cli-2', subtype: 'can_use_tool' },
    ]);
    expect(closed.state).toEqual({ nextId: 4, outbound: [], inbound: [] });
    expect(written(closed.effects)).toEqual([]);
  });

  it('refuses without writing or consuming an id', () => {
    const state = sendControlRequest(
      initialControlState(),
      CONFIG,
      { correlation: 'a', purpose: 'interrupt', cancelQueued: false },
      0,
    ).state;
    const refusals: [OutboundRequest, ControlConfig, string, string | undefined][] = [
      [
        { correlation: 'a', purpose: 'interrupt', cancelQueued: true },
        CONFIG,
        'INVALID_OPTIONS',
        'control-correlation-unique',
      ],
      [
        { correlation: 'b', purpose: 'interrupt', cancelQueued: true, timeoutMs: 0 },
        CONFIG,
        'INVALID_OPTIONS',
        'control-timeout',
      ],
      [
        { correlation: 'b', purpose: 'interrupt', cancelQueued: true, timeoutMs: 1.5 },
        CONFIG,
        'INVALID_OPTIONS',
        'control-timeout',
      ],
      [
        { correlation: 'b', purpose: 'raw', subtype: 'get_settings' },
        CONFIG,
        'INVALID_OPTIONS',
        'raw-control-disabled',
      ],
      [
        {
          correlation: 'b',
          purpose: 'raw',
          subtype: 'initialize',
          body: { workspaceTrust: { accepted: true } },
        },
        RAW,
        'INVALID_OPTIONS',
        'raw-initialize',
      ],
      [
        { correlation: 'b', purpose: 'raw', subtype: 'update_settings', body: { settings: {} } },
        RAW,
        'INVALID_OPTIONS',
        'raw-config-write',
      ],
      [
        { correlation: 'b', purpose: 'set_permission_mode', mode: 'manual' as 'plan' },
        CONFIG,
        'PROTOCOL_ERROR',
        undefined,
      ],
      [
        {
          correlation: 'b',
          purpose: 'raw',
          subtype: 'get_settings',
          body: { pad: 'x'.repeat(200) },
        },
        { ...RAW, maxOutboundBytes: 100 },
        'OUTBOUND_FRAME_TOO_LARGE',
        undefined,
      ],
    ];
    for (const [req, config, code, rule] of refusals) {
      const step = sendControlRequest(state, config, req, 1);
      expect(step.state).toBe(state);
      expect(step.effects).toHaveLength(1);
      const [effect] = step.effects;
      expect(effect).toMatchObject({
        type: 'settle',
        correlation: req.correlation,
        purpose: req.purpose,
        ok: false,
        error: { code },
      });
      if (rule !== undefined) expect(effect).toMatchObject({ error: { details: { rule } } });
    }
    // update_settings with the opt-in is a raw request like any other.
    const optIn = sendControlRequest(
      state,
      { ...RAW, allowConfigWrites: true },
      { correlation: 'w', purpose: 'raw', subtype: 'update_settings', body: { settings: {} } },
      1,
    );
    expect(written(optIn.effects)).toEqual([
      {
        type: 'control_request',
        request_id: 'hudhud_2',
        request: { subtype: 'update_settings', settings: {} },
      },
    ]);
  });
});

describe('inbound requests', () => {
  it('forwards a valid can_use_tool and answers it exactly once', () => {
    const frame =
      RESEARCH_FRAMES.find((entry) => entry.name === 'can_use_tool (Windows)')?.frame ?? {};
    const got = receive(initialControlState(), frame, CONFIG, 'turn-1');
    expect(got.effects).toEqual([
      {
        type: 'inbound.request',
        requestId: '96faf3d7-4d77-4311-839f-a6ddaaec5323',
        subtype: 'can_use_tool',
        frame,
      },
    ]);
    expect(got.state.inbound).toEqual([
      {
        requestId: '96faf3d7-4d77-4311-839f-a6ddaaec5323',
        subtype: 'can_use_tool',
        turnId: 'turn-1',
        answer: 'expected',
      },
    ]);
    const id = '96faf3d7-4d77-4311-839f-a6ddaaec5323';
    const answer = answerInbound(got.state, CONFIG, id, {
      type: 'decision',
      decision: { behavior: 'allow' },
    });
    expect(answer.outcome).toBe('written');
    expect(written(answer.effects)).toEqual([
      {
        type: 'control_response',
        response: { subtype: 'success', request_id: id, response: { behavior: 'allow' } },
      },
    ]);
    expect(answer.state.inbound).toEqual([]);
    const twice = answerInbound(answer.state, CONFIG, id, { type: 'error', message: 'x' });
    expect(twice.outcome).toBe('not-pending');
    expect(twice.effects).toEqual([
      {
        type: 'diagnostic',
        code: 'control.answer-not-pending',
        message: 'Did not answer a control request that is no longer pending.',
        data: { requestId: id },
      },
    ]);
  });

  it('answers with an error frame, and keeps the entry when the answer cannot be encoded', () => {
    const state = receive(initialControlState(), canUseTool('p')).state;
    const tooBig = answerInbound(state, { ...CONFIG, maxOutboundBytes: 200 }, 'p', {
      type: 'decision',
      decision: { behavior: 'allow', updatedInput: { big: 'x'.repeat(500) } },
    });
    expect(tooBig).toMatchObject({
      outcome: 'failed',
      effects: [],
      error: { code: 'OUTBOUND_FRAME_TOO_LARGE' },
    });
    expect(tooBig.state).toBe(state);
    const error = answerInbound(tooBig.state, CONFIG, 'p', {
      type: 'error',
      message: 'host failed',
    });
    expect(written(error.effects)).toEqual([
      {
        type: 'control_response',
        response: { subtype: 'error', request_id: 'p', error: 'host failed' },
      },
    ]);
  });

  it('ignores a duplicate in-flight id and accepts it again once answered', () => {
    const first = receive(initialControlState(), canUseTool('d'));
    const duplicate = receive(first.state, canUseTool('d'));
    expect(duplicate.state).toBe(first.state);
    expect(duplicate.effects).toEqual([
      {
        type: 'diagnostic',
        code: 'control.duplicate-request',
        message: 'Ignored a duplicate in-flight control request.',
        data: { requestId: 'd', subtype: 'can_use_tool' },
      },
    ]);
    const answered = answerInbound(first.state, CONFIG, 'd', {
      type: 'error',
      message: 'no',
    }).state;
    expect(receive(answered, canUseTool('d')).effects[0]).toMatchObject({
      type: 'inbound.request',
    });
  });

  it('cancels a pending request and never writes for it', () => {
    const pending = receive(initialControlState(), canUseTool('c'), CONFIG, 'turn-7').state;
    const cancel = receive(pending, { type: 'control_cancel_request', request_id: 'c' });
    expect(cancel.effects).toEqual([
      { type: 'inbound.cancel', requestId: 'c', subtype: 'can_use_tool', turnId: 'turn-7' },
    ]);
    expect(
      answerInbound(cancel.state, CONFIG, 'c', {
        type: 'decision',
        decision: { behavior: 'allow' },
      }),
    ).toMatchObject({
      outcome: 'not-pending',
    });
    const unknown = receive(cancel.state, { type: 'control_cancel_request', request_id: 'c' });
    expect(unknown.effects).toEqual([
      {
        type: 'diagnostic',
        code: 'control.unknown-cancel',
        message: 'Ignored a cancel for a control request that is not pending.',
        data: { requestId: 'c' },
      },
    ]);
  });

  it('answers unsupported subtypes with an error, including hook_callback and mcp_message', () => {
    for (const subtype of [
      'hook_callback',
      'mcp_message',
      'elicitation',
      'oauth_token_refresh',
      'brand_new_v9',
      'x'.repeat(500),
    ]) {
      const step = receive(initialControlState(), request('u-1', subtype));
      expect(step.state).toEqual(initialControlState());
      const cut = subtype.length > 128 ? `${subtype.slice(0, 128)}…` : subtype;
      expect(step.effects[0]).toMatchObject({
        type: 'diagnostic',
        code: 'control.unsupported-request',
        data: { subtype: cut },
      });
      expect(written(step.effects)).toEqual([
        {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: 'u-1',
            error: `${UNSUPPORTED_SUBTYPE_MESSAGE}: ${cut}`,
          },
        },
      ]);
    }
  });

  it('answers a malformed can_use_tool with an error instead of leaving the CLI waiting', () => {
    const step = receive(initialControlState(), request('m', 'can_use_tool'));
    expect(step.state.inbound).toEqual([]);
    expect(step.effects[0]).toMatchObject({ code: 'control.malformed-request' });
    expect(written(step.effects)).toEqual([
      {
        type: 'control_response',
        response: { subtype: 'error', request_id: 'm', error: 'Malformed can_use_tool request' },
      },
    ]);
  });

  it('reports an answer it cannot encode', () => {
    const step = receive(initialControlState(), request('', 'hook_callback'));
    expect(written(step.effects)).toEqual([]);
    expect(step.effects[1]).toEqual({
      type: 'diagnostic',
      code: 'control.answer-failed',
      message: 'Could not encode the answer to a control request.',
      data: { requestId: '', code: 'PROTOCOL_ERROR' },
    });
  });

  it('never answers the silent set, and routes its cancel', () => {
    for (const subtype of [
      'remote_tool_call',
      'remote_plumbing_call',
      'remote_tools_probe',
      'remote_tools_reannounce',
      'request_user_dialog',
    ]) {
      expect(isNeverAnswered(subtype)).toBe(true);
      const step = receive(initialControlState(), request('s', subtype));
      expect(written(step.effects)).toEqual([]);
      expect(step.effects).toEqual([
        {
          type: 'diagnostic',
          code: 'control.unanswered-request',
          message: 'A control request that is never answered arrived.',
          data: { requestId: 's', subtype },
        },
      ]);
      expect(answerInbound(step.state, CONFIG, 's', { type: 'error', message: 'x' }).outcome).toBe(
        'not-pending',
      );
      expect(receive(step.state, request('s', subtype)).effects[0]).toMatchObject({
        code: 'control.duplicate-request',
      });
      const cancel = receive(step.state, { type: 'control_cancel_request', request_id: 's' });
      expect(cancel.effects).toEqual([{ type: 'inbound.cancel', requestId: 's', subtype }]);
      expect(cancel.state.inbound).toEqual([]);
    }
    expect(isNeverAnswered('can_use_tool')).toBe(false);
    expect(isNeverAnswered('remote')).toBe(false);
  });

  it('keeps hostile ids as data', () => {
    let state = initialControlState();
    for (const id of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      state = receive(state, canUseTool(id)).state;
    }
    expect(state.inbound.map((entry) => entry.requestId)).toEqual([
      '__proto__',
      'constructor',
      'hasOwnProperty',
      'toString',
    ]);
    expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
    const cancelled = receive(state, { type: 'control_cancel_request', request_id: '__proto__' });
    expect(cancelled.state.inbound).toHaveLength(3);
    expect(({} as Record<string, unknown>)['subtype']).toBeUndefined();
  });

  it('leaves conversation and malformed frames to the caller; consumes keep_alive', () => {
    const state = initialControlState();
    expect(receive(state, { type: 'keep_alive' })).toEqual({ state, effects: [], handled: true });
    expect(receive(state, { type: 'system', subtype: 'init' })).toEqual({
      state,
      effects: [],
      handled: false,
    });
    expect(receive(state, { type: 5 })).toEqual({ state, effects: [], handled: false });
  });

  it('handles every research frame without writing a control request', () => {
    let state = initialControlState();
    for (const { name, frame } of RESEARCH_FRAMES) {
      const step = receive(state, frame);
      for (const line of written(step.effects)) {
        expect(line['type'], name).toBe('control_response');
      }
      state = step.state;
    }
  });
});

// ---- property: random interleavings keep the tables consistent ------------------

type Op =
  | { op: 'send'; purpose: 'interrupt' | 'raw'; timeout: boolean }
  | { op: 'respond'; pick: number; ok: boolean }
  | { op: 'respond-unknown'; id: string }
  | { op: 'timer'; pick: number }
  | { op: 'abort'; pick: number }
  | { op: 'cli-request'; id: string; subtype: string }
  | { op: 'cli-cancel'; id: string }
  | { op: 'answer'; id: string }
  | { op: 'close' };

const cliId = fc.constantFrom('a', 'b', 'c', '__proto__', 'hudhud_1');
const operation: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    op: fc.constant('send' as const),
    purpose: fc.constantFrom('interrupt' as const, 'raw' as const),
    timeout: fc.boolean(),
  }),
  fc.record({ op: fc.constant('respond' as const), pick: fc.nat(20), ok: fc.boolean() }),
  fc.record({ op: fc.constant('respond-unknown' as const), id: fc.string() }),
  fc.record({ op: fc.constant('timer' as const), pick: fc.nat(20) }),
  fc.record({ op: fc.constant('abort' as const), pick: fc.nat(20) }),
  fc.record({
    op: fc.constant('cli-request' as const),
    id: cliId,
    subtype: fc.constantFrom(
      'can_use_tool',
      'hook_callback',
      'remote_tool_call',
      'request_user_dialog',
      'set_model',
    ),
  }),
  fc.record({ op: fc.constant('cli-cancel' as const), id: cliId }),
  fc.record({ op: fc.constant('answer' as const), id: cliId }),
  fc.constant({ op: 'close' as const }),
);

describe('correlator (property)', () => {
  it('settles each request once, keeps ids unique and writes only what the protocol allows', () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 60 }), (ops) => {
        let state = initialControlState();
        let clock = 0;
        let correlationSeq = 0;
        const issued = new Set<string>();
        const settled = new Set<string>();
        const sent = new Set<string>();
        const answeredSinceArrival = new Map<string, number>();
        const apply = (
          step: { state: ControlState; effects: readonly ControlEffect[] },
          fromCli: boolean,
        ): void => {
          for (const effect of step.effects) {
            if (effect.type === 'settle') {
              expect(settled.has(effect.correlation)).toBe(false);
              expect(sent.has(effect.correlation)).toBe(true);
              settled.add(effect.correlation);
            }
            if (effect.type === 'write') {
              const frame = JSON.parse(effect.line) as JsonObject;
              expect(effect.line.indexOf('\n')).toBe(effect.line.length - 1);
              if (fromCli) {
                // Stdin authority: CLI input only ever produces answers.
                expect(frame['type']).toBe('control_response');
                expect(validateOutboundFrame(frame).ok).toBe(true);
              }
              if (frame['type'] === 'control_request') {
                const id = frame['request_id'];
                expect(typeof id).toBe('string');
                if (typeof id !== 'string') continue;
                expect(issued.has(id)).toBe(false);
                issued.add(id);
              }
            }
          }
          state = step.state;
          expect(JSON.parse(JSON.stringify(state))).toEqual(state);
          expect(JSON.parse(JSON.stringify(step.effects))).toEqual(step.effects);
          const outboundIds = state.outbound.map((entry) => entry.requestId);
          expect(new Set(outboundIds).size).toBe(outboundIds.length);
          const inboundIds = state.inbound.map((entry) => entry.requestId);
          expect(new Set(inboundIds).size).toBe(inboundIds.length);
          for (const entry of state.outbound) expect(settled.has(entry.correlation)).toBe(false);
        };
        for (const op of ops) {
          clock += 1;
          const pick = (n: number) => state.outbound[n % Math.max(state.outbound.length, 1)];
          switch (op.op) {
            case 'send': {
              correlationSeq += 1;
              const correlation = `k${String(correlationSeq)}`;
              sent.add(correlation);
              const timeoutMs = op.timeout ? 10 : undefined;
              const req: OutboundRequest =
                op.purpose === 'raw'
                  ? {
                      correlation,
                      purpose: 'raw',
                      subtype: 'get_settings',
                      ...(timeoutMs === undefined ? {} : { timeoutMs }),
                    }
                  : {
                      correlation,
                      purpose: 'interrupt',
                      cancelQueued: true,
                      ...(timeoutMs === undefined ? {} : { timeoutMs }),
                    };
              apply(sendControlRequest(state, RAW, req, clock), false);
              break;
            }
            case 'respond': {
              const entry = pick(op.pick);
              const id = entry?.requestId ?? 'hudhud_999';
              const frame: JsonObject = op.ok
                ? response(id, {})
                : {
                    type: 'control_response',
                    response: { subtype: 'error', request_id: id, error: 'e' },
                  };
              apply(receive(state, frame, RAW), true);
              break;
            }
            case 'respond-unknown': {
              const before = state;
              const step = receive(state, response(op.id), RAW);
              apply(step, true);
              if (!before.outbound.some((entry) => entry.requestId === op.id)) {
                expect(step.state).toBe(before);
              }
              break;
            }
            case 'timer': {
              const entry = pick(op.pick);
              const name = entry?.timeout?.timer ?? 'control.timeout:none';
              apply(controlTimerFired(state, name), false);
              break;
            }
            case 'abort': {
              const entry = pick(op.pick);
              apply(
                cancelControlRequest(
                  state,
                  entry?.correlation ?? 'none',
                  makeErrorData('ABORTED', 'a'),
                ),
                false,
              );
              break;
            }
            case 'cli-request':
              apply(
                receive(
                  state,
                  op.subtype === 'can_use_tool' ? canUseTool(op.id) : request(op.id, op.subtype),
                  RAW,
                ),
                true,
              );
              answeredSinceArrival.set(op.id, 0);
              break;
            case 'cli-cancel':
              apply(
                receive(state, { type: 'control_cancel_request', request_id: op.id }, RAW),
                true,
              );
              break;
            case 'answer': {
              const pending = state.inbound.find((entry) => entry.requestId === op.id);
              const step = answerInbound(state, RAW, op.id, {
                type: 'decision',
                decision: { behavior: 'deny', message: 'no' },
              });
              const writes = written(step.effects);
              if (pending?.answer === 'expected') {
                expect(writes).toHaveLength(1);
                const count = (answeredSinceArrival.get(op.id) ?? 0) + 1;
                expect(count).toBe(1);
                answeredSinceArrival.set(op.id, count);
              } else {
                expect(writes).toEqual([]);
              }
              apply(step, true);
              break;
            }
            case 'close':
              apply(closeControl(state, makeErrorData('SESSION_CLOSED', 'closed')), false);
              expect(state.outbound).toEqual([]);
              expect(state.inbound).toEqual([]);
              break;
          }
        }
        // Everything sent is either settled or still pending.
        for (const correlation of sent) {
          expect(
            settled.has(correlation) ||
              state.outbound.some((entry) => entry.correlation === correlation),
          ).toBe(true);
        }
      }),
      fcParams(500),
    );
  });
});
