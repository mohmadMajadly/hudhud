// Turn machine: FIFO start, command_lifecycle correlation, background turns
// after EOF, interrupt gating (GH#98713, the `interrupt-same-write` order),
// the single `still_queued` retry, synthesized ends and the mapping of every
// observed result frame to a TurnResult (plan §1.5, §4.2; ADR-0008; K21).

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@hudhudjs/core/protocol';

import {
  INTERRUPT_RETRY_DELAY_MS,
  initialTurnState,
  turnStep,
  type TurnEffect,
  type TurnInput,
} from '../../../src/protocol/machine/turn.js';
import { classifyResult } from '../../../src/protocol/events/normalize.js';
import {
  CAPS_WITH_LIFECYCLE,
  Runner,
  SESSION_ID,
  ack,
  init,
  interrupt,
  lifecycle,
  ofType,
  result,
  send,
  sessionState,
  uuid,
} from './turn-support.js';

const T1 = uuid(1);
const T2 = uuid(2);
const T3 = uuid(3);

function settled(effects: readonly TurnEffect[], turnId: string) {
  const found = ofType(effects, 'turn.settle').find((effect) => effect.turnId === turnId);
  if (found === undefined) throw new Error(`turn ${turnId} did not settle`);
  return found.result;
}

describe('send and turn start', () => {
  it('a send queues the turn and writes the user frame with its uuid', () => {
    const run = new Runner();
    expect(run.step(send(T1))).toEqual([
      { type: 'write.user', turnId: T1, content: `prompt ${T1}` },
      { type: 'turn.queued', turnId: T1 },
    ]);
    expect(run.state.turns).toEqual([
      { turnId: T1, origin: 'application', phase: 'queued', initSeen: false },
    ]);
  });

  it('system/init starts the oldest queued turn (FIFO) when lifecycle frames are off', () => {
    const run = new Runner();
    run.step(send(T1), send(T2));
    const started = run.step(init({ model: 'claude-opus-5-5' }));
    expect(started).toEqual([
      {
        type: 'turn.started',
        turnId: T1,
        origin: 'application',
        features: [],
        model: 'claude-opus-5-5',
        raw: { type: 'system', subtype: 'init', session_id: SESSION_ID, model: 'claude-opus-5-5' },
      },
    ]);
    expect(settled(run.step(result({ user_message_uuid: T1 })), T1).outcome).toBe('completed');
    expect(ofType(run.step(init()), 'turn.started')[0]?.turnId).toBe(T2);
    expect(run.state.model).toBe('claude-opus-5-5');
  });

  it('turn.started omits the model until one was reported', () => {
    const run = new Runner();
    run.step(send(T1));
    const [started] = ofType(run.step(init()), 'turn.started');
    expect(started).not.toHaveProperty('model');
  });

  it('starts turns from command_lifecycle once msg_lifecycle_v1 was seen', () => {
    const run = new Runner();
    // Before the capability is known, lifecycle frames are ignored.
    run.step(send(T1));
    expect(run.step(lifecycle(T1))).toEqual([]);
    run.step(init({ capabilities: [...CAPS_WITH_LIFECYCLE, 42] }));
    expect(run.state.features).toEqual(CAPS_WITH_LIFECYCLE);
    expect(run.state.lifecycle).toBe(true);
    run.step(result({ user_message_uuid: T1 }));

    run.step(send(T2), send(T3));
    // Other states, unknown uuids and a missing uuid do not start anything.
    expect(run.step(lifecycle(T2, 'queued'))).toEqual([]);
    expect(run.step(lifecycle(uuid(99)))).toEqual([]);
    expect(
      run.step({ type: 'frame', frame: { type: 'command_lifecycle', state: 'started' } }),
    ).toEqual([]);
    // Out of FIFO order is fine: the uuid names the turn.
    const started = run.step(lifecycle(T3));
    expect(started).toEqual([
      {
        type: 'turn.started',
        turnId: T3,
        origin: 'application',
        features: CAPS_WITH_LIFECYCLE,
        raw: { type: 'command_lifecycle', command_uuid: T3, state: 'started' },
      },
    ]);
    // A second lifecycle start of a started turn is a no-op.
    expect(run.step(lifecycle(T3))).toEqual([]);
    // The next system/init belongs to the started turn that awaits it.
    expect(run.step(init())).toEqual([]);
    expect(run.state.turns.find((turn) => turn.turnId === T3)?.initSeen).toBe(true);
    expect(run.state.turns.find((turn) => turn.turnId === T2)?.phase).toBe('queued');
  });

  it('an init without capabilities keeps the known features', () => {
    const run = new Runner();
    run.step(send(T1), init({ capabilities: CAPS_WITH_LIFECYCLE }));
    run.step(result({ user_message_uuid: T1 }), send(T2), init());
    expect(run.state.features).toEqual(CAPS_WITH_LIFECYCLE);
  });

  it('rejects a send whose id is not a UUID or is still in use, without creating a turn', () => {
    const run = new Runner();
    run.step(send(T1));
    for (const turnId of ['bg-1', T1]) {
      expect(run.step(send(turnId))).toEqual([
        {
          type: 'send.rejected',
          turnId,
          error: {
            code: 'PROTOCOL_ERROR',
            message: 'turn id must be a fresh UUID',
            retryable: false,
          },
        },
      ]);
    }
    expect(run.state.turns).toHaveLength(1);
  });

  it('ignores frames it does not route', () => {
    const run = new Runner();
    run.step(send(T1), init());
    for (const frame of [
      { type: 'assistant', message: {} },
      { type: 'system', subtype: 'api_retry' },
      { type: 'system', subtype: 'session_state_changed', state: 'running' },
      { type: 'stream_event' },
      { subtype: 'init' },
    ] satisfies JsonObject[]) {
      expect(run.step({ type: 'frame', frame })).toEqual([]);
    }
  });
});

describe('background turns', () => {
  it('a system/init with no queued host turn starts bg-<n>, also after EOF (07 §7)', () => {
    const run = new Runner();
    run.step(send(T1), init(), result({ user_message_uuid: T1 }), sessionState('idle'));
    expect(run.step({ type: 'stdin.closed' })).toEqual([]);
    const [started] = ofType(run.step(init()), 'turn.started');
    expect(started).toMatchObject({ turnId: 'bg-1', origin: 'harness' });
    // A result without user_message_uuid settles the oldest started turn.
    expect(settled(run.step(result()), 'bg-1')).toMatchObject({
      turnId: 'bg-1',
      outcome: 'completed',
      synthesized: false,
    });
    run.step(sessionState('idle'));
    expect(ofType(run.step(init()), 'turn.started')[0]?.turnId).toBe('bg-2');
    expect(run.state.nextBg).toBe(3);
  });
});

describe('interrupt gating (GH#98713)', () => {
  it('interrupt-same-write: an interrupt before the turn system/init is held, then sent', () => {
    // 05 §7 run 36: turn 1 completes; turn 2 user frame and interrupt in one
    // breath. hudhud must not write the interrupt until turn 2's system/init.
    const run = new Runner();
    run.step(send(T1), init(), result({ user_message_uuid: T1 }), sessionState('idle'));
    const sendStep = run.step(send(T2));
    const heldStep = run.step(interrupt('c1', T2));
    expect(ofType(sendStep, 'write.interrupt')).toEqual([]);
    expect(heldStep).toEqual([]);
    expect(run.state.turns[0]?.pendingInterrupt).toEqual({
      cancelQueued: false,
      correlations: ['c1'],
    });

    const initStep = run.step(init());
    expect(initStep.map((effect) => effect.type)).toEqual(['turn.started', 'write.interrupt']);
    expect(initStep[1]).toEqual({
      type: 'write.interrupt',
      interruptId: 'int-1',
      cancelQueued: false,
      turnId: T2,
    });
    expect(run.state.turns[0]).toEqual({
      turnId: T2,
      origin: 'application',
      phase: 'interrupting',
      initSeen: true,
    });

    expect(run.step(ack('int-1'))).toEqual([
      { type: 'interrupt.settle', correlation: 'c1', ok: true },
    ]);
    const frame = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
      user_message_uuid: T2,
    } satisfies JsonObject;
    expect(settled(run.step({ type: 'frame', frame }), T2)).toEqual({
      turnId: T2,
      sessionId: SESSION_ID,
      outcome: 'cancelled',
      isError: true,
      stopReason: 'cancelled',
      terminalReason: 'aborted_streaming',
      errors: frame.errors,
      permissionDenials: [],
      synthesized: false,
      raw: frame,
    });

    // The order: the user frame and the interrupt never share a step, and the
    // interrupt is written only in the step that observed system/init.
    for (const effects of run.steps) {
      const types = effects.map((effect) => effect.type);
      expect(types.includes('write.user') && types.includes('write.interrupt')).toBe(false);
    }
  });

  it('a held interrupt follows a lifecycle start until the system/init', () => {
    const run = new Runner();
    run.step(send(T1), init({ capabilities: CAPS_WITH_LIFECYCLE }));
    run.step(result({ user_message_uuid: T1 }), send(T2), lifecycle(T2));
    expect(run.step(interrupt('c1', T2, true))).toEqual([]);
    expect(run.step(init())).toEqual([
      { type: 'write.interrupt', interruptId: 'int-1', cancelQueued: true, turnId: T2 },
    ]);
  });

  it('merges held interrupts of one turn into one write (cancel_queued OR-ed)', () => {
    const run = new Runner();
    run.step(send(T1), interrupt('c1', T1, true), interrupt('c2', T1, false));
    expect(run.state.turns[0]?.pendingInterrupt).toEqual({
      cancelQueued: true,
      correlations: ['c1', 'c2'],
    });
    expect(ofType(run.step(init()), 'write.interrupt')).toEqual([
      { type: 'write.interrupt', interruptId: 'int-1', cancelQueued: true, turnId: T1 },
    ]);
    expect(run.step(ack('int-1'))).toEqual([
      { type: 'interrupt.settle', correlation: 'c1', ok: true },
      { type: 'interrupt.settle', correlation: 'c2', ok: true },
    ]);
  });

  it('after the system/init an interrupt is written at once', () => {
    const run = new Runner();
    run.step(send(T1), init());
    expect(run.step(interrupt('c1', T1))).toEqual([
      { type: 'write.interrupt', interruptId: 'int-1', cancelQueued: false, turnId: T1 },
    ]);
  });

  it('an interrupt of a settled or unknown turn is a no-op', () => {
    const run = new Runner();
    run.step(send(T1), init(), result({ user_message_uuid: T1 }));
    for (const turnId of [T1, uuid(42)]) {
      expect(run.step(interrupt('c', turnId))).toEqual([
        { type: 'interrupt.settle', correlation: 'c', ok: true },
      ]);
    }
  });

  it('a held interrupt resolves as a no-op when its turn ends before its system/init', () => {
    const run = new Runner();
    run.step(send(T1), interrupt('c1', T1));
    expect(run.step(result({ user_message_uuid: T1 })).slice(1)).toEqual([
      { type: 'interrupt.settle', correlation: 'c1', ok: true },
    ]);
  });

  it('an error response fails the interrupt with CONTROL_REQUEST_FAILED', () => {
    const run = new Runner();
    run.step(send(T1), init(), interrupt('c1', T1));
    expect(
      run.step({ type: 'interrupt.response', interruptId: 'int-1', ok: false, error: 'boom' }),
    ).toEqual([
      {
        type: 'interrupt.settle',
        correlation: 'c1',
        ok: false,
        error: {
          code: 'CONTROL_REQUEST_FAILED',
          message: 'the harness refused the interrupt',
          retryable: true,
          details: { harnessError: 'boom' },
        },
      },
    ]);
    expect(run.state.inflight).toEqual([]);
  });

  it('ignores responses for unknown interrupt ids and a success without a body', () => {
    const run = new Runner();
    expect(run.step(ack('int-9'))).toEqual([]);
    run.step(send(T1), init(), interrupt('c1', T1));
    expect(run.step({ type: 'interrupt.response', interruptId: 'int-1', ok: true })).toEqual([
      { type: 'interrupt.settle', correlation: 'c1', ok: true },
    ]);
  });
});

describe('still_queued retry (05 §7)', () => {
  function stillQueued(): Runner {
    const run = new Runner();
    run.step(send(T1), init(), interrupt('c1', T1));
    const effects = run.step(ack('int-1', { still_queued: [T1] }));
    expect(effects).toEqual([
      {
        type: 'diagnostic',
        code: 'interrupt.still-queued-retry',
        message: 'the interrupt response still lists the turn as queued; re-sending once',
        data: { turnId: T1, interruptId: 'int-1' },
      },
      { type: 'timer.set', name: 'turn.interrupt-retry:int-1', ms: INTERRUPT_RETRY_DELAY_MS },
    ]);
    return run;
  }

  it('re-sends once after 50 ms, then reports whatever the CLI answers', () => {
    const run = stillQueued();
    // A duplicate response and a foreign timer change nothing.
    expect(run.step(ack('int-1'))).toEqual([]);
    expect(run.step({ type: 'timer', name: 'turn.interrupt-retry:int-7' })).toEqual([]);
    expect(run.step({ type: 'timer', name: 'turn.interrupt-retry:int-1' })).toEqual([
      { type: 'write.interrupt', interruptId: 'int-2', cancelQueued: false, turnId: T1 },
    ]);
    // Still queued again: no second retry.
    expect(run.step(ack('int-2', { still_queued: [T1] }))).toEqual([
      { type: 'interrupt.settle', correlation: 'c1', ok: true },
    ]);
  });

  it('a turn that ends while the retry waits clears the timer', () => {
    const run = stillQueued();
    expect(run.step(result({ user_message_uuid: T1 })).slice(1)).toEqual([
      { type: 'timer.clear', name: 'turn.interrupt-retry:int-1' },
      { type: 'interrupt.settle', correlation: 'c1', ok: true },
    ]);
    expect(run.state.inflight).toEqual([]);
  });

  it('closing stdin while the retry waits fails it', () => {
    const run = stillQueued();
    expect(run.step({ type: 'stdin.closed' })).toEqual([
      { type: 'timer.clear', name: 'turn.interrupt-retry:int-1' },
      {
        type: 'interrupt.settle',
        correlation: 'c1',
        ok: false,
        error: {
          code: 'SESSION_CLOSED',
          message: 'stdin is closed; nothing more can be written',
          retryable: false,
        },
      },
    ]);
  });

  it('a still_queued answer that arrives after stdin closed fails the interrupt, no retry', () => {
    // The shrunk counterexample of the turn-machine model check (seed
    // 1704925574): the retry was armed after stdin had closed, so its timer
    // wrote an interrupt to a closed stdin.
    const run = new Runner();
    run.step(send(T1), interrupt('c1', T1), init());
    run.step({ type: 'stdin.closed' });
    expect(run.step(ack('int-1', { still_queued: [T1] }))).toEqual([
      {
        type: 'interrupt.settle',
        correlation: 'c1',
        ok: false,
        error: {
          code: 'SESSION_CLOSED',
          message: 'stdin is closed; nothing more can be written',
          retryable: false,
        },
      },
    ]);
    expect(run.state.inflight).toEqual([]);
    expect(run.step({ type: 'timer', name: 'turn.interrupt-retry:int-1' })).toEqual([]);
  });

  it('no retry when still_queued names another turn', () => {
    const run = new Runner();
    run.step(send(T1), init(), interrupt('c1', T1));
    expect(run.step(ack('int-1', { still_queued: [T2, 7] }))).toEqual([
      { type: 'interrupt.settle', correlation: 'c1', ok: true },
    ]);
  });
});

describe('cancel_queued and session-wide interrupts', () => {
  it('turns listed in `cancelled` settle as cancelled (synthesized, raw response kept)', () => {
    const run = new Runner();
    run.step(send(T1), init(), send(T2), interrupt('c1', T1, true));
    const response = { still_queued: [], cancelled: [T2, uuid(77)] } satisfies JsonObject;
    const effects = run.step(ack('int-1', response));
    expect(effects).toEqual([
      {
        type: 'turn.settle',
        turnId: T2,
        result: {
          turnId: T2,
          sessionId: SESSION_ID,
          outcome: 'cancelled',
          isError: true,
          stopReason: 'cancelled',
          permissionDenials: [],
          synthesized: true,
          raw: response,
        },
      },
      { type: 'interrupt.settle', correlation: 'c1', ok: true },
    ]);
  });

  it('a session-wide interrupt is written at once and marks started turns interrupting', () => {
    const run = new Runner();
    run.step(send(T1), init(), send(T2));
    expect(run.step(interrupt('abort', undefined, true))).toEqual([
      { type: 'write.interrupt', interruptId: 'int-1', cancelQueued: true },
    ]);
    expect(run.state.turns.map((turn) => turn.phase)).toEqual(['interrupting', 'queued']);
    // A session-wide interrupt is never retried.
    expect(run.step(ack('int-1', { still_queued: [T1] }))).toEqual([
      { type: 'interrupt.settle', correlation: 'abort', ok: true },
    ]);
    const aborted = result({
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_tools',
    });
    expect(settled(run.step(aborted), T1).outcome).toBe('cancelled');
  });

  it('a session-wide interrupt with no turn is still written (idle interrupt is harmless)', () => {
    const run = new Runner();
    expect(run.step(interrupt('abort'))).toEqual([
      { type: 'write.interrupt', interruptId: 'int-1', cancelQueued: false },
    ]);
  });
});

describe('stdin closed (EOF)', () => {
  const closed = {
    code: 'SESSION_CLOSED',
    message: 'stdin is closed; nothing more can be written',
    retryable: false,
  };

  it('fails held interrupts, later interrupts and later sends; writes nothing', () => {
    const run = new Runner();
    run.step(send(T1), interrupt('c1', T1), send(T2), init(), send(T3), interrupt('c3', T3));
    expect(run.step({ type: 'stdin.closed' })).toEqual([
      { type: 'interrupt.settle', correlation: 'c3', ok: false, error: closed },
    ]);
    expect(run.state.turns.find((turn) => turn.turnId === T3)).not.toHaveProperty(
      'pendingInterrupt',
    );
    expect(run.step({ type: 'stdin.closed' })).toEqual([]);
    expect(run.step(interrupt('c4', T2))).toEqual([
      { type: 'interrupt.settle', correlation: 'c4', ok: false, error: closed },
    ]);
    expect(run.step(interrupt('c5'))).toEqual([
      { type: 'interrupt.settle', correlation: 'c5', ok: false, error: closed },
    ]);
    expect(run.step(send(uuid(4)))).toEqual([
      { type: 'turn.fail', turnId: uuid(4), error: closed },
    ]);
    // The in-flight interrupt of T1 is still answered.
    expect(run.step(ack('int-1'))).toEqual([
      { type: 'interrupt.settle', correlation: 'c1', ok: true },
    ]);
  });
});

describe('synthesized turn ends', () => {
  it('session_state_changed idle ends started turns without a result; queued ones stay', () => {
    const run = new Runner();
    run.step(send(T1), init(), send(T2), send(T3), init(), interrupt('c', T2));
    const idle = sessionState('idle');
    const effects = run.step(idle);
    const raw = (idle as Extract<TurnInput, { type: 'frame' }>).frame;
    expect(settled(effects, T1)).toEqual({
      turnId: T1,
      sessionId: SESSION_ID,
      outcome: 'unknown',
      isError: true,
      permissionDenials: [],
      synthesized: true,
      raw,
    });
    expect(settled(effects, T2)).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
    expect(run.state.turns.map((turn) => turn.turnId)).toEqual([T3]);
  });

  it('end settles every remaining turn and resolves every interrupt', () => {
    const run = new Runner();
    run.step(send(T1), init(), interrupt('c1', T1));
    run.step(ack('int-1', { still_queued: [T1] }));
    run.step(send(T2), interrupt('c2', T2), interrupt('c3'));
    const effects = run.step({
      type: 'end',
      disposition: { kind: 'settle', outcome: 'cancelled' },
    });
    expect(effects.map((effect) => effect.type)).toEqual([
      'turn.settle',
      'timer.clear',
      'interrupt.settle',
      'turn.settle',
      'interrupt.settle',
      'interrupt.settle',
    ]);
    expect(settled(effects, T1)).toEqual({
      turnId: T1,
      sessionId: SESSION_ID,
      outcome: 'cancelled',
      isError: true,
      stopReason: 'cancelled',
      permissionDenials: [],
      synthesized: true,
    });
    expect(run.state).toMatchObject({ ended: true, turns: [], inflight: [] });
    expect(run.state).not.toHaveProperty('endError');
  });

  it('end with outcome error settles turns as error', () => {
    const run = new Runner();
    run.step(send(T1));
    const effects = run.step({ type: 'end', disposition: { kind: 'settle', outcome: 'error' } });
    expect(settled(effects, T1)).toMatchObject({ outcome: 'error', isError: true });
    expect(settled(effects, T1)).not.toHaveProperty('stopReason');
  });

  it('end with a failure fails every turn, and later sends fail with the same error', () => {
    const error = {
      code: 'PROCESS_EXITED',
      message: 'process exited',
      retryable: true,
      details: { exitCode: 143 },
    };
    const run = new Runner();
    run.step(send(T1), init(), send(T2), interrupt('c', T2));
    expect(run.step({ type: 'end', disposition: { kind: 'fail', error } })).toEqual([
      { type: 'turn.fail', turnId: T1, error },
      { type: 'turn.fail', turnId: T2, error },
      { type: 'interrupt.settle', correlation: 'c', ok: true },
    ]);
    expect(run.state.endError).toEqual(error);
    expect(run.step(send(T3))).toEqual([{ type: 'turn.fail', turnId: T3, error }]);
  });

  it('macOS SIGINT from outside: the error result settles the turn once; the exit settles nothing', () => {
    // Research 09 (macOS gate run 1): result/error_during_execution, then exit 0.
    const error = {
      code: 'PROCESS_EXITED',
      message: 'process exited',
      retryable: true,
      details: { exitCode: 0 },
    };
    const run = new Runner();
    run.step(send(T1), init());
    const settle = run.step(
      result({
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        user_message_uuid: T1,
      }),
    );
    expect(settled(settle, T1)).toMatchObject({
      outcome: 'cancelled',
      isError: true,
      synthesized: false,
    });
    expect(run.step({ type: 'end', disposition: { kind: 'fail', error } })).toEqual([]);
    expect(run.state.turns).toEqual([]);
  });

  it('after end: frames, timers, stdin and a second end do nothing; interrupts are no-ops', () => {
    const run = new Runner();
    run.step({ type: 'end', disposition: { kind: 'settle', outcome: 'cancelled' } });
    expect(
      run.step(
        init(),
        result(),
        sessionState('idle'),
        { type: 'timer', name: 'turn.interrupt-retry:int-1' },
        { type: 'stdin.closed' },
        { type: 'end', disposition: { kind: 'settle', outcome: 'error' } },
      ),
    ).toEqual([]);
    expect(run.step(interrupt('c'))).toEqual([
      { type: 'interrupt.settle', correlation: 'c', ok: true },
    ]);
    expect(run.step(send(T1))).toEqual([
      {
        type: 'turn.fail',
        turnId: T1,
        error: {
          code: 'SESSION_CLOSED',
          message: 'stdin is closed; nothing more can be written',
          retryable: false,
        },
      },
    ]);
  });
});

describe('result correlation', () => {
  it('settles every turn named by user_message_uuid(s), queued ones included', () => {
    const run = new Runner();
    run.step(send(T1), init(), send(T2));
    const effects = run.step(result({ user_message_uuid: T1, user_message_uuids: [T1, T2, 5] }));
    expect(ofType(effects, 'turn.settle').map((effect) => effect.turnId)).toEqual([T1, T2]);
  });

  it('reports a result that matches no turn and ignores it', () => {
    const run = new Runner();
    run.step(send(T1));
    for (const [frame, uuids] of [
      [result({ user_message_uuid: uuid(9) }), [uuid(9)]],
      [result(), []],
    ] as const) {
      expect(run.step(frame)).toEqual([
        {
          type: 'diagnostic',
          code: 'turn.unmatched-result',
          message: 'a result frame matched no unsettled turn; ignored',
          data: { userMessageUuids: uuids },
        },
      ]);
    }
    expect(run.state.turns).toHaveLength(1);
  });
});

describe('result frame mapping (K21: an error result is a TurnResult)', () => {
  function mapped(frame: JsonObject, interrupted = false) {
    const run = new Runner();
    run.step(send(T1), init());
    if (interrupted) run.step(interrupt('c', T1));
    return settled(run.step({ type: 'frame', frame: { type: 'result', ...frame } }), T1);
  }

  it.each([
    [{ subtype: 'success', is_error: false }, false, 'completed', false],
    [{ subtype: 'success' }, false, 'completed', false],
    [{ subtype: 'success', is_error: true, api_error_status: 401 }, false, 'error', true],
    [{ subtype: 'error_max_turns', is_error: true }, false, 'max-turns', true],
    [{ subtype: 'error_max_budget_usd', is_error: true }, false, 'max-budget', true],
    // One mapping (classifyResult): an aborted terminal reason is cancelled,
    // with or without hudhud's own interrupt.
    [
      { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' },
      false,
      'cancelled',
      true,
    ],
    [
      { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' },
      true,
      'cancelled',
      true,
    ],
    [
      { subtype: 'error_during_execution', is_error: true, terminal_reason: 'api_error' },
      true,
      'error',
      true,
    ],
    [{ subtype: 'error_during_execution', is_error: true }, true, 'error', true],
    [{ subtype: 'error_max_structured_output_retries' }, false, 'error', true],
    [{ subtype: 'something_new', is_error: true }, false, 'error', true],
    [{ subtype: 'something_new', is_error: false }, false, 'unknown', false],
    [{}, false, 'unknown', false],
  ] satisfies [JsonObject, boolean, string, boolean][])(
    '%j (interrupted: %s) -> %s',
    (frame, interrupted, outcome, isError) => {
      expect(mapped(frame, interrupted)).toMatchObject({ outcome, isError, synthesized: false });
    },
  );

  it('max-turns maps the stop reason to max_turn_requests', () => {
    expect(
      mapped({
        subtype: 'error_max_turns',
        is_error: true,
        terminal_reason: 'max_turns',
        errors: ['Reached maximum number of turns (1)'],
        num_turns: 2,
      }),
    ).toMatchObject({
      outcome: 'max-turns',
      stopReason: 'max_turn_requests',
      terminalReason: 'max_turns',
      errors: ['Reached maximum number of turns (1)'],
    });
  });

  it('copies text, usage, cost, api status and denials defensively', () => {
    const frame = {
      subtype: 'success',
      is_error: true,
      result: 'Failed to authenticate. API Error: 401 mock 401',
      api_error_status: 401,
      terminal_reason: 'api_error',
      errors: ['one', 2, null],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: -1,
        cache_read_input_tokens: '3',
      },
      total_cost_usd: 0.25,
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {} },
        { tool_name: 'Bash' },
        'junk',
        null,
        [],
      ],
    } satisfies JsonObject;
    expect(mapped(frame)).toEqual({
      turnId: T1,
      sessionId: SESSION_ID,
      outcome: 'error',
      isError: true,
      text: 'Failed to authenticate. API Error: 401 mock 401',
      terminalReason: 'api_error',
      errors: ['one'],
      apiErrorStatus: 401,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.25 },
      permissionDenials: [{ toolName: 'Bash', toolUseId: 'toolu_1' }],
      synthesized: false,
      raw: { type: 'result', ...frame },
    });
  });

  it('omits usage when nothing valid was reported; a null api status is absent', () => {
    const value = mapped({
      subtype: 'success',
      usage: { input_tokens: 'x' },
      api_error_status: null,
    });
    expect(value).not.toHaveProperty('usage');
    expect(value).not.toHaveProperty('apiErrorStatus');
    expect(mapped({ subtype: 'success', total_cost_usd: 1 }).usage).toEqual({ costUsd: 1 });
  });

  it('takes outcome, isError and stop reason from classifyResult, also for odd frames', () => {
    for (const frame of [
      { subtype: 7 },
      { subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' },
      { subtype: 'success', stop_reason: 'end_turn', terminal_reason: 'completed' },
      { subtype: 'error_max_budget_usd', is_error: true, stop_reason: 'max_tokens' },
    ] satisfies JsonObject[]) {
      const { outcome, isError, stopReason } = classifyResult({ type: 'result', ...frame });
      const value = mapped(frame, true);
      expect(value).toMatchObject({ outcome, isError, synthesized: false });
      expect(value.stopReason).toBe(stopReason);
    }
  });

  it('keeps isError: true on a synthesized result', () => {
    const run = new Runner();
    run.step(send(T1), init());
    const idle = settled(run.step(sessionState('idle')), T1);
    expect(idle).toMatchObject({ outcome: 'unknown', isError: true, synthesized: true });
  });
});

describe('purity', () => {
  it('never mutates the input state and stays JSON', () => {
    const state0 = initialTurnState({ sessionId: SESSION_ID });
    const snapshot = JSON.stringify(state0);
    const out = turnStep(state0, send(T1));
    expect(JSON.stringify(state0)).toBe(snapshot);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    const again = turnStep(state0, send(T1));
    expect(again).toEqual(out);
  });
});
