// Frame sequences recorded in research 05 and 07, replayed through the
// session machine with their expected effects (W3-T1 acceptance). Each
// sequence names its source section; frames come from RESEARCH_FRAMES (the
// W2 fixture file, whose entries carry `observed` / `reconstructed` /
// `protocol` provenance) or from the builders of session-support.ts (each
// labelled there). Order and timing follow the report tables; where a report
// lists frames without their exact order, the order used is the one the
// report's prose implies and is said so in the comment.
//
// Not replayed here: `permission-error-response` (the CLI's reaction to a
// host error answer; this machine never writes one for a permission, it
// denies), the TLS trap and process-tree rows (process layer, W2-T6..T8).

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@hudhudjs/core/protocol';

import { CLOSING_DENY_MESSAGE } from '../../../src/protocol/machine/permission.js';
import { RESEARCH_FRAMES, type ResearchFrame } from '../protocol/research-frames.js';
import {
  SESSION_ID,
  SPAWNED_PID,
  SessionRun,
  assistant,
  canUseTool,
  controlOk,
  events,
  lifecycle,
  makeConfig,
  ofType,
  result,
  sessionState,
  shape,
  systemInit,
  uuid,
  writes,
} from './session-support.js';

const U1 = uuid(1);
const U2 = uuid(2);

function research(name: string): ResearchFrame {
  const found = RESEARCH_FRAMES.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no research frame ${name}`);
  return found;
}

/** A research frame with some top-level or `response`/`request` fields replaced. */
function frame(name: string, patch: JsonObject = {}): JsonObject {
  return { ...research(name).frame, ...patch };
}

/** An observed `control_response` re-addressed to hudhud's own request id. */
function answerTo(name: string, requestId: string): JsonObject {
  const observed = research(name).frame;
  const response = observed['response'] as JsonObject;
  return { ...observed, response: { ...response, request_id: requestId } };
}

/** The observed initialize response of 05 §5 as the answer to `hudhud_1`. */
function observedInit(): JsonObject {
  return answerTo('initialize response', 'hudhud_1');
}

/** The observed Windows `system/init` of 05 §5 under the expected session id. */
function observedSystemInit(): JsonObject {
  return frame('system/init (Windows)', { session_id: SESSION_ID });
}

function started(run = new SessionRun()): SessionRun {
  run.feed({ type: 'process.started', pid: SPAWNED_PID });
  run.line(observedInit());
  return run;
}

function runningTurn(run = started()): SessionRun {
  run.feed({ type: 'cmd.send', turnId: U1, content: 'hello' });
  run.line(sessionState('running'), observedSystemInit());
  return run;
}

describe('05 §5 handshake', () => {
  it('initialize, response, background_tasks_changed (observed)', () => {
    const run = new SessionRun();
    const first = run.feed({ type: 'process.started', pid: SPAWNED_PID });
    expect(writes(first)).toEqual([
      { type: 'control_request', request_id: 'hudhud_1', request: { subtype: 'initialize' } },
    ]);
    const ok = run.line(observedInit());
    expect(ofType(ok, 'handshake.ok')[0]?.info).toEqual({
      id: SESSION_ID,
      mode: 'create',
      pid: SPAWNED_PID,
      cliPid: 37148,
      version: '2.1.296',
      apiKeySource: 'ANTHROPIC_API_KEY',
      tokenSource: 'none',
      features: ['ui_surface_v1'],
    });
    const tasks = run.line(research('background_tasks_changed after initialize').frame);
    expect(events(tasks).map((event) => event['type'])).toEqual(['background.tasks']);
  });

  it('a text turn: running, system/init, lifecycle, assistant, result, idle (05 §4, §5, §12)', () => {
    const run = started();
    const sent = run.feed({ type: 'cmd.send', turnId: U1, content: 'hello' });
    expect(writes(sent)[0]).toMatchObject({ type: 'user', uuid: U1 });
    const replay = run.line(
      sessionState('running'),
      observedSystemInit(),
      lifecycle(U1, 'queued'),
      lifecycle(U1, 'started'),
      research('assistant text').frame,
      result({ user_message_uuid: U1 }),
      research('session_state_changed idle').frame,
    );
    expect(events(replay).map((event) => event['type'])).toEqual([
      'session.state',
      'turn.started',
      'harness.frame',
      'harness.frame',
      'message.assistant',
      'turn.completed',
      'session.state',
    ]);
    expect(events(replay, 'turn.started')[0]).toMatchObject({
      turnId: U1,
      origin: 'application',
      model: 'claude-opus-5-5',
    });
    expect(ofType(replay, 'turn.settle')[0]?.result).toMatchObject({
      outcome: 'completed',
      isError: false,
      stopReason: 'end_turn',
    });
    // Drain: idle already reported, so close ends stdin at once (05 §8 run 39).
    expect(shape(run.feed({ type: 'cmd.close' }))).toEqual(['timer.set', 'stdin.end']);
    const end = run.advance(34).feed({ type: 'process.exit', code: 0, signal: null });
    expect(ofType(end, 'session.end')[0]).toEqual({ type: 'session.end', outcome: 'closed' });
  });
});

describe('05 §6 permissions', () => {
  it('allow: can_use_tool (observed), allow, tool_result, result/success', () => {
    const run = runningTurn();
    const ask = run.line(research('can_use_tool (Windows)').frame);
    const requestId = '96faf3d7-4d77-4311-839f-a6ddaaec5323';
    expect(ofType(ask, 'permission.ask')[0]?.request).toMatchObject({
      requestId,
      turnId: U1,
      toolName: 'Bash',
      blockedPath: '<run>\\work\\marker.txt',
    });
    const answer = run.feed({ type: 'cmd.permission', requestId, decision: { behavior: 'allow' } });
    expect(writes(answer)).toEqual([
      {
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow' } },
      },
    ]);
    const done = run.line(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_mock_0002', content: 'hi' }],
        },
      },
      result(),
    );
    expect(events(done, 'tool.result')[0]).toMatchObject({ status: 'completed' });
    expect(ofType(done, 'turn.settle')[0]?.result.outcome).toBe('completed');
  });

  it('deny: tool_result is_error, result/success with permission_denials (reconstructed)', () => {
    const run = runningTurn();
    run.line(research('can_use_tool (Linux)').frame);
    const requestId = '96faf3d7-4d77-4311-839f-a6ddaaec5324';
    const answer = run.feed({
      type: 'cmd.permission',
      requestId,
      decision: { behavior: 'deny', message: 'host says no' },
    });
    expect(writes(answer)[0]).toMatchObject({
      response: { response: { behavior: 'deny', message: 'host says no' } },
    });
    const done = run.line(
      research('tool_result after deny').frame,
      research('result/success with permission_denials').frame,
    );
    expect(events(done, 'tool.result')[0]).toMatchObject({ status: 'failed' });
    expect(ofType(done, 'turn.settle')[0]?.result).toMatchObject({
      outcome: 'completed',
      permissionDenials: [{ toolName: 'Bash', toolUseId: 'toolu_mock_0002' }],
    });
  });

  it('deny with interrupt: result/error_during_execution aborted_tools is cancelled', () => {
    const run = runningTurn();
    run.line(research('can_use_tool (Windows)').frame);
    run.feed({
      type: 'cmd.permission',
      requestId: '96faf3d7-4d77-4311-839f-a6ddaaec5323',
      decision: { behavior: 'deny', message: 'stop', interrupt: true },
    });
    const done = run.line(research('result/error_during_execution aborted_tools').frame);
    expect(ofType(done, 'turn.settle')[0]?.result).toMatchObject({
      outcome: 'cancelled',
      isError: true,
      terminalReason: 'aborted_tools',
    });
  });

  it('never answered, then interrupt: the CLI withdraws its request (observed)', () => {
    const run = runningTurn();
    const requestId = '548e5f58-…';
    run.line(canUseTool(requestId));
    const interrupt = run.feed({
      type: 'cmd.interrupt',
      turnId: U1,
      cancelQueued: false,
      correlation: 'i1',
    });
    expect(writes(interrupt)[0]).toMatchObject({ request: { subtype: 'interrupt' } });
    const withdrawn = run.line(research('control_cancel_request after interrupt').frame);
    expect(ofType(withdrawn, 'permission.cancel')).toEqual([
      { type: 'permission.cancel', requestId, reason: 'harness' },
    ]);
    expect(writes(withdrawn)).toEqual([]);
    const done = run.line(
      controlOk('hudhud_2', { still_queued: [] }),
      research('result/error_during_execution aborted_tools').frame,
    );
    expect(ofType(done, 'control.settle')[0]).toMatchObject({ correlation: 'i1', ok: true });
    expect(ofType(done, 'turn.settle')[0]?.result.outcome).toBe('cancelled');
  });

  it('never answered, then close: the non-interrupting deny lets the turn finish (K12)', () => {
    const run = runningTurn();
    run.line(canUseTool('perm-eof'));
    const close = run.feed({ type: 'cmd.close' });
    expect(writes(close)).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'perm-eof',
          response: { behavior: 'deny', message: CLOSING_DENY_MESSAGE, interrupt: false },
        },
      },
    ]);
    const done = run.line(result(), research('session_state_changed idle').frame);
    expect(shape(done)).toContain('stdin.end');
    const end = run.advance(912).feed({ type: 'process.exit', code: 0, signal: null });
    expect(ofType(end, 'session.end')[0]?.outcome).toBe('closed');
  });

  it('default mode without the prompt tool: system/permission_denied (observed)', () => {
    const run = runningTurn(started(new SessionRun(makeConfig({ permissionHandler: false }))));
    const denied = run.line(
      research('system/permission_denied (default mode, no prompt tool)').frame,
    );
    expect(events(denied, 'permission.denied')[0]).toMatchObject({
      toolName: 'Bash',
      toolUseId: 'toolu_mock_0007',
    });
  });
});

describe('05 §7 interrupt', () => {
  it('mid-stream: answer, aborted partial, interrupted text, closers, aborted_streaming', () => {
    const run = runningTurn();
    run.line({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'chunk0 ' },
      },
    });
    run
      .advance(1200)
      .feed({ type: 'cmd.interrupt', turnId: U1, cancelQueued: false, correlation: 'i' });
    const replay = run.line(
      answerTo('interrupt response, nothing queued', 'hudhud_2'),
      research('assistant aborted partial text').frame,
      research('user [Request interrupted by user]').frame,
      research('stream_event content_block_stop').frame,
      research('stream_event message_delta').frame,
      research('stream_event message_stop').frame,
      research('result/error_during_execution aborted_streaming').frame,
    );
    expect(events(replay, 'message.assistant')[0]).toMatchObject({
      aborted: true,
      text: 'chunk0 chunk1 chunk2 chu',
    });
    const settled = ofType(replay, 'turn.settle')[0]?.result;
    expect(settled).toMatchObject({ outcome: 'cancelled', terminalReason: 'aborted_streaming' });
    expect(settled?.raw).toEqual(research('result/error_during_execution aborted_streaming').frame);
  });

  it('queued message: the interrupt of turn 2 waits for its system/init (32)', () => {
    const run = runningTurn();
    run.feed({ type: 'cmd.send', turnId: U2, content: 'second' });
    const held = run.feed({
      type: 'cmd.interrupt',
      turnId: U2,
      cancelQueued: false,
      correlation: 'i2',
    });
    expect(writes(held)).toEqual([]);
    run.line(result({ user_message_uuid: U1 }));
    const init = run.line(observedSystemInit());
    expect(writes(init)).toEqual([
      {
        type: 'control_request',
        request_id: 'hudhud_2',
        request: { subtype: 'interrupt', cancel_queued: false },
      },
    ]);
  });

  it('cancel_queued: the queued message is dropped (33)', () => {
    const run = runningTurn();
    run.feed({ type: 'cmd.send', turnId: U2, content: 'second' });
    run.feed({ type: 'cmd.interrupt', turnId: U1, cancelQueued: true, correlation: 'i' });
    const answer = run.line(answerTo('interrupt response, cancel_queued', 'hudhud_2'));
    expect(ofType(answer, 'turn.settle')[0]).toMatchObject({
      turnId: U2,
      result: { outcome: 'cancelled', stopReason: 'cancelled', synthesized: true },
    });
  });

  it('GH#98713: never in the user-frame write; still_queued re-sent once after 50 ms (36, 37)', () => {
    const run = runningTurn();
    run.line(result({ user_message_uuid: U1 }));
    const same = run.feed(
      { type: 'cmd.send', turnId: U2, content: 'second' },
      { type: 'cmd.interrupt', turnId: U2, cancelQueued: false, correlation: 'i2' },
    );
    expect(writes(same).map((written) => written['type'])).toEqual(['user']);
    const init = run.advance(7).line(observedSystemInit());
    expect(writes(init)[0]).toMatchObject({ request: { subtype: 'interrupt' } });
    const answer = run.line(answerTo('interrupt response, still queued', 'hudhud_2'));
    expect(events(answer, 'diagnostic')[0]?.['code']).toBe('interrupt.still-queued-retry');
    const timer = ofType(answer, 'timer.set').find((effect) => effect.name.startsWith('turn.'));
    const resent = run.advance(50).fire(String(timer?.name));
    expect(writes(resent)[0]).toMatchObject({ request_id: 'hudhud_3' });
  });
});

describe('05 §8 stdin EOF', () => {
  it('mid-stream: close waits for the result and idle, then EOF (40)', () => {
    const run = runningTurn();
    expect(shape(run.feed({ type: 'cmd.close' }))).toEqual(['timer.set']);
    run.line(assistant('chunk0 … chunk19'));
    const done = run.advance(4094).line(result(), sessionState('idle'));
    expect(shape(done)).toContain('stdin.end');
    const end = run.feed({ type: 'process.exit', code: 0, signal: null });
    expect(ofType(end, 'session.end')[0]?.outcome).toBe('closed');
  });

  it('mid-tool: task frames, tool_result, result, idle, then EOF (41)', () => {
    const run = runningTurn();
    run.feed({ type: 'cmd.close' });
    const replay = run.line(
      research('system/task_started').frame,
      research('system/task_notification completed').frame,
      result(),
      sessionState('idle'),
    );
    expect(events(replay).map((event) => event['type'])).toEqual([
      'harness.frame',
      'harness.frame',
      'turn.completed',
      'session.state',
    ]);
    expect(shape(replay).at(-1)).toBe('stdin.end');
  });
});

describe('05 §9 errors and exits', () => {
  it('401 without retries: synthetic assistant error then is_error result; poisoned (57)', () => {
    const run = runningTurn();
    const auth = run.line(research('assistant authentication_failed').frame);
    expect(ofType(auth, 'turn.fail')[0]?.error.code).toBe('AUTHENTICATION_FAILED');
    const later = run.line(research('result/success is_error 401').frame);
    expect(ofType(later, 'turn.settle')).toEqual([]);
    const end = run.feed({ type: 'process.exit', code: 1, signal: null });
    expect(ofType(end, 'session.end')[0]).toMatchObject({
      outcome: 'failed',
      error: { code: 'AUTHENTICATION_FAILED' },
    });
  });

  it('401 with default retries: the first api_retry is the trigger and is surfaced (58)', () => {
    const run = runningTurn();
    const retry = run.line(research('system/api_retry 401').frame);
    expect(events(retry, 'api.retry')[0]).toMatchObject({
      attempt: 1,
      maxRetries: 10,
      errorStatus: 401,
    });
    expect(ofType(retry, 'ladder.start')[0]?.intent).toBe('auth-fail-fast');
  });

  it('529 overloaded: retries surfaced, error result is a result, exit 1 closes (47)', () => {
    const run = runningTurn();
    const replay = run.line(
      research('system/api_retry rate_limit').frame,
      research('result 529 overloaded').frame,
    );
    expect(ofType(replay, 'ladder.start')).toEqual([]);
    expect(ofType(replay, 'turn.settle')[0]?.result).toMatchObject({
      outcome: 'error',
      isError: true,
      apiErrorStatus: 529,
    });
    const end = run.feed({ type: 'process.exit', code: 1, signal: null });
    expect(ofType(end, 'session.end')[0]).toEqual({ type: 'session.end', outcome: 'closed' });
  });

  it('max turns: outcome max-turns (46)', () => {
    const run = runningTurn();
    const done = run.line(research('result/error_max_turns').frame);
    expect(ofType(done, 'turn.settle')[0]?.result).toMatchObject({
      outcome: 'max-turns',
      stopReason: 'max_turn_requests',
      errors: ['Reached maximum number of turns (1)'],
    });
  });

  it('Linux SIGTERM mid-stream: 143, no result; killed-externally (05 §9)', () => {
    const run = runningTurn();
    const end = run.feed({ type: 'process.exit', code: 143, signal: null });
    expect(ofType(end, 'turn.fail')[0]?.error.code).toBe('PROCESS_EXITED');
    expect(ofType(end, 'session.end')[0]?.outcome).toBe('killed-externally');
  });

  it('Linux SIGINT mid-stream: partial, interrupted text, no result, exit 0; unknown (K22)', () => {
    const run = runningTurn();
    run.line(
      research('assistant aborted partial text').frame,
      research('user [Request interrupted by user]').frame,
    );
    const end = run.feed({ type: 'process.exit', code: 0, signal: null });
    expect(ofType(end, 'turn.fail')[0]?.error.code).toBe('PROCESS_EXITED');
    expect(ofType(end, 'session.end')[0]?.outcome).toBe('unknown');
  });

  it('Windows job close: no further frames, code 0 with a turn open; unknown (05 §9)', () => {
    const run = runningTurn(started(new SessionRun(makeConfig({ platform: 'win32' }))));
    const end = run.feed({ type: 'process.exit', code: 0, signal: null });
    expect(ofType(end, 'session.end')[0]?.outcome).toBe('unknown');
  });
});

describe('05 §11 sizes and encoding', () => {
  it('a 5 MB model text passes under the default caps (75)', () => {
    const run = runningTurn();
    const text = 'x'.repeat(5_000_000);
    const done = run.line(assistant(text), result({ result: text }));
    expect(ofType(done, 'turn.settle')[0]?.result.text).toHaveLength(5_000_000);
  });

  it('UTF-8 Arabic round-trips exactly (78-80)', () => {
    const run = started();
    const sent = run.feed({ type: 'cmd.send', turnId: U1, content: 'مرحبا' });
    expect(ofType(sent, 'write')[0]?.line).toContain('مرحبا');
    run.line(observedSystemInit());
    const reply = run.line(assistant('رد: مرحبا 👋 é'));
    expect(events(reply, 'message.assistant')[0]?.['text']).toBe('رد: مرحبا 👋 é');
  });
});

describe('05 §12 session state', () => {
  it('sdk_host_only marking is carried as data (18)', () => {
    const run = runningTurn();
    const idle = run.line(research('session_state_changed idle sdk_host_only').frame);
    expect(events(idle, 'session.state')[0]).toMatchObject({
      state: 'idle',
      raw: { sdk_host_only: true },
    });
  });
});

describe('07 §1 resume and fork', () => {
  it('a11: a resume of an unknown id answers with a result before the response', () => {
    const run = new SessionRun(makeConfig({ mode: 'resume', sessionId: uuid(10) }));
    run.feed({ type: 'process.started', pid: SPAWNED_PID });
    const failed = run.line(
      research('result before any control_response (resume not found)').frame,
    );
    expect(ofType(failed, 'handshake.fail')[0]?.error).toMatchObject({
      code: 'SESSION_NOT_FOUND',
      retryable: false,
    });
    const end = run.feed({ type: 'process.exit', code: 1, signal: null });
    expect(ofType(end, 'session.end')[0]).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } });
  });

  it('a2: resume keeps the id; a5: fork runs under the hudhud-chosen id', () => {
    for (const config of [
      makeConfig({ mode: 'resume' }),
      makeConfig({ mode: 'fork', forkedFrom: uuid(20) }),
    ]) {
      const run = runningTurn(started(new SessionRun(config)));
      expect(run.state.observedSessionId).toBe(SESSION_ID);
      expect(events(run.effects, 'diagnostic').map((event) => event['code'])).not.toContain(
        'session.id-mismatch',
      );
    }
  });

  it('a4: a fork without --session-id gets a new id: reported, not fatal', () => {
    const run = started(new SessionRun(makeConfig({ mode: 'fork' })));
    run.feed({ type: 'cmd.send', turnId: U1, content: 'x' });
    const init = run.line(systemInit({ session_id: uuid(30) }));
    expect(events(init, 'diagnostic')[0]?.['code']).toBe('session.id-mismatch');
    expect(events(init, 'turn.started')).toHaveLength(1);
  });
});

describe('07 §7 background work after EOF', () => {
  it('a finished background shell starts a turn hudhud did not start (W120)', () => {
    const run = runningTurn();
    run.line(result(), sessionState('idle'));
    run.feed({ type: 'cmd.close' });
    const replay = run.line(
      research('system/task_notification completed').frame,
      observedSystemInit(),
      assistant('the shell finished'),
      result(),
      sessionState('idle'),
    );
    expect(events(replay, 'turn.started')[0]).toMatchObject({ turnId: 'bg-1', origin: 'harness' });
    expect(ofType(replay, 'turn.settle')[0]?.turnId).toBe('bg-1');
    const end = run.feed({ type: 'process.exit', code: 0, signal: null });
    expect(ofType(end, 'session.end')[0]?.outcome).toBe('closed');
  });

  it('a stopped background subagent ends with idle and exit 0 (W124)', () => {
    const run = started();
    run.feed({ type: 'cmd.close' });
    const replay = run.line(
      research('system/task_updated').frame,
      research('system/task_notification stopped').frame,
      research('background_tasks_changed after initialize').frame,
      sessionState('idle'),
    );
    expect(events(replay).map((event) => event['type'])).toEqual([
      'harness.frame',
      'harness.frame',
      'background.tasks',
      'session.state',
    ]);
    const end = run.advance(5140).feed({ type: 'process.exit', code: 0, signal: null });
    expect(ofType(end, 'session.end')[0]?.outcome).toBe('closed');
  });
});

describe('every research frame', () => {
  it('replays through a ready session without breaking it', () => {
    for (const entry of RESEARCH_FRAMES) {
      const run = runningTurn();
      const effects = run.line(entry.frame);
      for (const effect of ofType(effects, 'event')) {
        expect(effect.event.sessionId, entry.name).toBe(SESSION_ID);
      }
      expect(run.state.ended, entry.name).toBe(false);
    }
  });
});
