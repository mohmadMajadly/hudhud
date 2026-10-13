// Turn machine: a user message the harness drops (research 10 §3). Claude
// Code 2.1.296 answers a message whose uuid the session transcript already
// holds with `command_lifecycle` `completed` and never starts it; the turn
// must fail with TURN_DROPPED instead of waiting forever. Frame shapes are
// the ones recorded with the pinned CLI on Linux (research 10 §3.3, §3.6).

import { describe, expect, it } from 'vitest';

import { MAX_LIFECYCLE_STATES } from '../../../src/protocol/machine/turn.js';
import {
  CAPS_WITH_LIFECYCLE,
  Runner,
  init,
  interrupt,
  lifecycle,
  ofType,
  result,
  send,
  uuid,
} from './turn-support.js';

const T1 = uuid(1);
const T2 = uuid(2);
const T3 = uuid(3);

function dropped(turnId: string, states: readonly string[]) {
  return [
    {
      type: 'diagnostic',
      code: 'turn.dropped',
      message:
        'the harness reported the user message completed without starting it; the turn fails',
      data: { turnId, lifecycle: [...states] },
    },
    {
      type: 'turn.fail',
      turnId,
      error: {
        code: 'TURN_DROPPED',
        message: 'The harness dropped the user message without running a turn for it.',
        retryable: true,
        details: { turnId, lifecycle: [...states] },
      },
    },
  ];
}

describe('a dropped user message (TURN_DROPPED)', () => {
  it('gate run 2 shape: completed alone, before any system/init, fails the turn', () => {
    // Resume, `initialize` answered, the user message written, then only
    // `command_lifecycle` `completed` for its uuid (no queued, no started).
    const run = new Runner();
    run.step(send(T1));
    expect(run.step(lifecycle(T1, 'completed'))).toEqual(dropped(T1, ['completed']));
    expect(run.state.turns).toEqual([]);
    // A result naming it later finds no turn: it never settles twice.
    expect(ofType(run.step(result({ user_message_uuid: T1 })), 'diagnostic')).toEqual([
      expect.objectContaining({ code: 'turn.unmatched-result' }),
    ]);
  });

  it('after system/init: a duplicate sent while another turn streams fails only itself', () => {
    // Recorded (research 10 §3.6): queued:05, started:05, init, completed:03
    // while turn 05 streams, then result for 05.
    const run = new Runner();
    run.step(send(T1));
    run.step(lifecycle(T1, 'queued'), lifecycle(T1, 'started'));
    run.step(init({ capabilities: CAPS_WITH_LIFECYCLE }));
    run.step(send(T2));
    expect(run.step(lifecycle(T2, 'completed'))).toEqual(dropped(T2, ['completed']));
    expect(run.state.turns.map((turn) => [turn.turnId, turn.phase])).toEqual([[T1, 'started']]);
    const ends = run.step(result({ user_message_uuid: T1 }), lifecycle(T1, 'completed'));
    expect(ofType(ends, 'turn.settle').map((end) => end.turnId)).toEqual([T1]);
    expect(ofType(ends, 'turn.fail')).toEqual([]);
  });

  it('a normal turn: queued, started, init, result, completed settles once and never drops', () => {
    const run = new Runner();
    run.step(send(T1));
    run.step(lifecycle(T1, 'queued'), lifecycle(T1, 'started'), init());
    expect(run.state.turns[0]).toMatchObject({
      phase: 'started',
      lifecycleStates: ['queued', 'started'],
      lifecycleStarted: true,
    });
    const ends = run.step(result({ user_message_uuid: T1 }), lifecycle(T1, 'completed'));
    expect(ofType(ends, 'turn.settle')).toHaveLength(1);
    expect(ofType(ends, 'turn.fail')).toEqual([]);
  });

  it('completed before the result of a started turn is no drop; the result settles it', () => {
    const run = new Runner();
    run.step(send(T1), init({ capabilities: CAPS_WITH_LIFECYCLE }));
    run.step(send(T2), lifecycle(T2, 'queued'), lifecycle(T2, 'started'));
    expect(run.step(lifecycle(T2, 'completed'))).toEqual([]);
    expect(ofType(run.step(result({ user_message_uuid: T2 })), 'turn.settle')).toHaveLength(1);
  });

  it('merged messages report started before completed (recorded): no drop', () => {
    // Recorded: queued:02, queued:03 while turn 01 streams; then started:02,
    // started:03, init, result for [02, 03], completed:02, completed:03.
    const run = new Runner();
    run.step(send(T1), init({ capabilities: CAPS_WITH_LIFECYCLE }));
    run.step(send(T2), send(T3), lifecycle(T2, 'queued'), lifecycle(T3, 'queued'));
    run.step(result({ user_message_uuid: T1 }), lifecycle(T1, 'completed'));
    run.step(lifecycle(T2, 'started'), lifecycle(T3, 'started'), init());
    const ends = run.step(
      result({ user_message_uuids: [T2, T3] }),
      lifecycle(T2, 'completed'),
      lifecycle(T3, 'completed'),
    );
    expect(ofType(ends, 'turn.settle').map((end) => end.turnId)).toEqual([T2, T3]);
    expect(ofType(ends, 'turn.fail')).toEqual([]);
  });

  it('a started lifecycle before system/init is recorded, so a later completed is no drop', () => {
    // msg_lifecycle_v1 is announced only by system/init: the frame is
    // recorded but the turn starts with the init.
    const run = new Runner();
    run.step(send(T1), lifecycle(T1, 'started'));
    expect(run.state.turns[0]).toMatchObject({ phase: 'queued', lifecycleStarted: true });
    expect(run.step(lifecycle(T1, 'completed'))).toEqual([]);
    expect(ofType(run.step(init()), 'turn.started').map((s) => s.turnId)).toEqual([T1]);
  });

  it('records the observed states in the diagnostic and the error (queued, then completed)', () => {
    const run = new Runner();
    run.step(send(T1), lifecycle(T1, 'queued'));
    expect(run.step(lifecycle(T1, 'completed'))).toEqual(dropped(T1, ['queued', 'completed']));
  });

  it('correlates strictly by uuid: other uuids, missing fields and bg turns are untouched', () => {
    const run = new Runner();
    run.step(send(T1));
    expect(
      run.step(
        lifecycle(T2, 'completed'),
        { type: 'frame', frame: { type: 'command_lifecycle', state: 'completed' } },
        { type: 'frame', frame: { type: 'command_lifecycle', command_uuid: T1 } },
        { type: 'frame', frame: { type: 'command_lifecycle', command_uuid: 42, state: 'x' } },
      ),
    ).toEqual([]);
    expect(run.state.turns).toEqual([
      { turnId: T1, origin: 'application', phase: 'queued', initSeen: false },
    ]);
    // A harness-originated turn (bg-<n>) never fails as dropped.
    const bg = new Runner();
    bg.step(init());
    expect(bg.state.turns[0]?.turnId).toBe('bg-1');
    expect(bg.step(lifecycle('bg-1', 'completed'))).toEqual([]);
    expect(bg.state.turns.map((turn) => turn.turnId)).toEqual(['bg-1']);
  });

  it('cancelled or queued alone is recorded, not a drop (cancel_queued settles via its response)', () => {
    const run = new Runner();
    run.step(send(T1), lifecycle(T1, 'cancelled'), lifecycle(T1, 'queued'));
    expect(run.state.turns[0]).toMatchObject({
      phase: 'queued',
      lifecycleStates: ['cancelled', 'queued'],
    });
  });

  it('settles an interrupt held for the dropped turn as a no-op', () => {
    const run = new Runner();
    run.step(send(T1));
    expect(run.step(interrupt('c1', T1))).toEqual([]);
    const effects = run.step(lifecycle(T1, 'completed'));
    expect(effects.at(-1)).toEqual({ type: 'interrupt.settle', correlation: 'c1', ok: true });
    expect(ofType(effects, 'turn.fail')).toHaveLength(1);
    // The held interrupt is gone with the turn; nothing is written later.
    expect(ofType(run.step(init()), 'write.interrupt')).toEqual([]);
  });

  it('keeps a held interrupt and the lifecycle record when the interrupt is released', () => {
    const run = new Runner();
    run.step(send(T1), lifecycle(T1, 'queued'));
    run.step(interrupt('c1', T1));
    run.step(init());
    expect(run.state.turns[0]).toEqual({
      turnId: T1,
      origin: 'application',
      phase: 'interrupting',
      initSeen: true,
      lifecycleStates: ['queued'],
    });
  });

  it('bounds the recorded states', () => {
    const run = new Runner();
    run.step(send(T1));
    for (let i = 0; i < MAX_LIFECYCLE_STATES + 5; i += 1) run.step(lifecycle(T1, `s${String(i)}`));
    expect(run.state.turns[0]?.lifecycleStates).toHaveLength(MAX_LIFECYCLE_STATES);
    const effects = run.step(lifecycle(T1, 'completed'));
    expect(ofType(effects, 'turn.fail')[0]?.error.details).toMatchObject({
      lifecycle: expect.arrayContaining(['s0']) as unknown,
    });
  });
});
