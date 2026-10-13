// Model-based property test of the turn machine over random event orders
// (plan §4.2): an independent model, fed only by inputs and effects, checks
// that no illegal transition happens, that the user frame is written before
// its turn can end, that interrupts are written only after the target's
// system/init and never in the same step as a user frame (GH#98713), that at
// most one retry happens, that timers balance, and that every turn and every
// interrupt request terminates exactly once. State and effects stay JSON.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@hudhud/core/protocol';

import {
  initialTurnState,
  turnStep,
  type TurnEffect,
  type TurnInput,
  type TurnMachineState,
} from '../../../src/protocol/machine/turn.js';
import { CAPS_WITH_LIFECYCLE, SESSION_ID, fcParams, uuid } from './turn-support.js';

/** Abstract operations; indexes are resolved against the live state. */
type Op =
  | { readonly op: 'send'; readonly reuse: number | null }
  | { readonly op: 'interrupt'; readonly target: number | null; readonly cancelQueued: boolean }
  | { readonly op: 'init'; readonly caps: boolean; readonly model: boolean }
  | { readonly op: 'lifecycle'; readonly target: number; readonly started: boolean }
  | {
      readonly op: 'result';
      readonly match: 'none' | 'one' | 'many' | 'unknown';
      readonly target: number;
      readonly subtype: string;
      readonly reason: string | null;
      readonly isError: boolean | null;
    }
  | { readonly op: 'state'; readonly idle: boolean }
  | {
      readonly op: 'response';
      readonly target: number;
      readonly ok: boolean;
      readonly stillQueuedTarget: boolean;
      readonly cancel: readonly number[];
    }
  | { readonly op: 'timer'; readonly target: number; readonly foreign: boolean }
  | { readonly op: 'stdin.closed' }
  | { readonly op: 'end'; readonly kind: 'cancelled' | 'error' | 'fail' };

const index = fc.nat({ max: 12 });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ op: fc.constant('send' as const), reuse: fc.option(index) }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('interrupt' as const),
      target: fc.option(index, { freq: 6 }),
      cancelQueued: fc.boolean(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('init' as const),
      caps: fc.boolean(),
      model: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('lifecycle' as const),
      target: index,
      started: fc.boolean(),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('result' as const),
      match: fc.constantFrom('none', 'one', 'many', 'unknown'),
      target: index,
      subtype: fc.constantFrom(
        'success',
        'error_during_execution',
        'error_max_turns',
        'error_max_budget_usd',
        'other',
      ),
      reason: fc.constantFrom('aborted_streaming', 'aborted_tools', 'completed', null),
      isError: fc.option(fc.boolean()),
    }),
  },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('state' as const), idle: fc.boolean() }) },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('response' as const),
      target: index,
      ok: fc.boolean(),
      stillQueuedTarget: fc.boolean(),
      cancel: fc.array(index, { maxLength: 2 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('timer' as const),
      target: index,
      foreign: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('stdin.closed' as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('end' as const),
      kind: fc.constantFrom('cancelled', 'error', 'fail'),
    }),
  },
);

type TurnStatus = 'queued' | 'started' | 'terminated';

/** Independent bookkeeping, fed only by inputs and effects. */
class Model {
  readonly turns = new Map<string, TurnStatus>();
  /** Every id ever offered to `send`, in order (resolves `reuse` and targets). */
  readonly ids: string[] = [];
  readonly correlations = new Map<string, 'pending' | 'settled'>();
  /** Writes per correlation group (key: correlations joined). */
  readonly writesPerGroup = new Map<string, number>();
  /** Interrupt writes awaiting a response: interruptId -> correlations. */
  readonly inflight = new Map<string, readonly string[]>();
  readonly timers = new Set<string>();
  stdinClosed = false;
  ended = false;
  nextId = 1;
  nextCorrelation = 1;
}

function pick<T>(items: readonly T[], at: number): T | undefined {
  return items.length === 0 ? undefined : items[at % items.length];
}

function resolve(op: Op, model: Model, state: TurnMachineState): TurnInput {
  switch (op.op) {
    case 'send': {
      const reused = op.reuse === null ? undefined : pick(model.ids, op.reuse);
      const turnId = reused ?? uuid(model.nextId++);
      model.ids.push(turnId);
      return { type: 'send', turnId, content: { text: turnId } };
    }
    case 'interrupt': {
      const correlation = `c${String(model.nextCorrelation++)}`;
      model.correlations.set(correlation, 'pending');
      const turnId = op.target === null ? undefined : (pick(model.ids, op.target) ?? 'missing');
      return turnId === undefined
        ? { type: 'interrupt', cancelQueued: op.cancelQueued, correlation }
        : { type: 'interrupt', turnId, cancelQueued: op.cancelQueued, correlation };
    }
    case 'init': {
      const frame: Record<string, JsonObject[string]> = { type: 'system', subtype: 'init' };
      if (op.caps) frame['capabilities'] = CAPS_WITH_LIFECYCLE;
      if (op.model) frame['model'] = 'claude-opus-5-5';
      return { type: 'frame', frame };
    }
    case 'lifecycle':
      return {
        type: 'frame',
        frame: {
          type: 'command_lifecycle',
          command_uuid: pick(model.ids, op.target) ?? 'none',
          state: op.started ? 'started' : 'queued',
        },
      };
    case 'result': {
      const frame: Record<string, JsonObject[string]> = { type: 'result', subtype: op.subtype };
      if (op.reason !== null) frame['terminal_reason'] = op.reason;
      if (op.isError !== null) frame['is_error'] = op.isError;
      const one = pick(model.ids, op.target);
      if (op.match === 'one' && one !== undefined) frame['user_message_uuid'] = one;
      if (op.match === 'many') {
        frame['user_message_uuids'] = [one ?? 'x', pick(model.ids, op.target + 1) ?? 'y'];
      }
      if (op.match === 'unknown') frame['user_message_uuid'] = uuid(999_999);
      return { type: 'frame', frame };
    }
    case 'state':
      return {
        type: 'frame',
        frame: {
          type: 'system',
          subtype: 'session_state_changed',
          state: op.idle ? 'idle' : 'running',
        },
      };
    case 'response': {
      const known = state.inflight.map((entry) => entry.interruptId);
      const interruptId = pick(known, op.target) ?? `int-${String(op.target)}`;
      if (!op.ok) return { type: 'interrupt.response', interruptId, ok: false, error: 'nope' };
      const entry = state.inflight.find((item) => item.interruptId === interruptId);
      const stillQueued = op.stillQueuedTarget && entry?.turnId !== undefined ? [entry.turnId] : [];
      const cancelled = op.cancel.map((at) => pick(model.ids, at) ?? 'none');
      return {
        type: 'interrupt.response',
        interruptId,
        ok: true,
        response: { still_queued: stillQueued, cancelled },
      };
    }
    case 'timer': {
      const name = op.foreign ? 'some.other-timer' : pick([...model.timers], op.target);
      return { type: 'timer', name: name ?? 'turn.interrupt-retry:int-0' };
    }
    case 'stdin.closed':
      return { type: 'stdin.closed' };
    case 'end':
      return {
        type: 'end',
        disposition:
          op.kind === 'fail'
            ? {
                kind: 'fail',
                error: { code: 'PROCESS_EXITED', message: 'exited', retryable: true },
              }
            : { kind: 'settle', outcome: op.kind },
      };
  }
}

/** Applies one step to the model and asserts every invariant on it. */
function check(
  model: Model,
  before: TurnMachineState,
  input: TurnInput,
  effects: readonly TurnEffect[],
  after: TurnMachineState,
): void {
  expect(JSON.parse(JSON.stringify(after))).toEqual(after);
  expect(JSON.parse(JSON.stringify(effects))).toEqual(effects);

  const types = effects.map((effect) => effect.type);
  // GH#98713: never a user frame and an interrupt in the same step.
  expect(types.includes('write.user') && types.includes('write.interrupt')).toBe(false);
  if (model.stdinClosed || model.ended) {
    expect(types).not.toContain('write.user');
    expect(types).not.toContain('write.interrupt');
  }
  if (model.ended) {
    for (const type of types) expect(['turn.fail', 'interrupt.settle']).toContain(type);
  }

  if (input.type === 'send') {
    const accepted = types.includes('write.user');
    const outcome = types.filter((type) =>
      ['write.user', 'turn.fail', 'send.rejected'].includes(type),
    );
    expect(outcome).toHaveLength(1);
    if (accepted) {
      expect(model.turns.get(input.turnId)).not.toBe('queued');
      expect(model.turns.get(input.turnId)).not.toBe('started');
    }
  }

  for (const effect of effects) {
    switch (effect.type) {
      case 'write.user':
        expect(
          model.turns.has(effect.turnId) && model.turns.get(effect.turnId) !== 'terminated',
        ).toBe(false);
        break;
      case 'turn.queued':
        model.turns.set(effect.turnId, 'queued');
        break;
      case 'turn.started': {
        const status = model.turns.get(effect.turnId);
        if (effect.origin === 'harness') {
          expect(status).toBeUndefined();
          expect(effect.turnId).toMatch(/^bg-\d+$/);
        } else {
          expect(status).toBe('queued');
        }
        model.turns.set(effect.turnId, 'started');
        break;
      }
      case 'turn.settle':
      case 'turn.fail': {
        const status = model.turns.get(effect.turnId);
        if (input.type === 'send' && input.turnId === effect.turnId) {
          // A send refused at once (stdin closed or session ended): the
          // binding's turn ends in the same step, nothing was written.
          expect(effect.type).toBe('turn.fail');
          expect(types).not.toContain('write.user');
          break;
        }
        expect(status === 'queued' || status === 'started').toBe(true);
        model.turns.set(effect.turnId, 'terminated');
        if (effect.type === 'turn.settle') {
          expect(effect.result.turnId).toBe(effect.turnId);
          expect(effect.result.sessionId).toBe(SESSION_ID);
        }
        break;
      }
      case 'send.rejected':
        break;
      case 'write.interrupt': {
        const entry = after.inflight.find((item) => item.interruptId === effect.interruptId);
        expect(entry).toBeDefined();
        const group = (entry?.correlations ?? []).join(',');
        const writes = (model.writesPerGroup.get(group) ?? 0) + 1;
        expect(writes).toBeLessThanOrEqual(2);
        model.writesPerGroup.set(group, writes);
        model.inflight.set(effect.interruptId, entry?.correlations ?? []);
        if (effect.turnId !== undefined) {
          // Written only once the target turn has seen its system/init.
          expect(model.turns.get(effect.turnId)).toBe('started');
          const turn = after.turns.find((item) => item.turnId === effect.turnId);
          expect(turn?.initSeen).toBe(true);
          expect(turn?.phase).toBe('interrupting');
          expect(
            input.type === 'frame' || input.type === 'interrupt' || input.type === 'timer',
          ).toBe(true);
        }
        break;
      }
      case 'interrupt.settle':
        expect(model.correlations.get(effect.correlation)).toBe('pending');
        model.correlations.set(effect.correlation, 'settled');
        break;
      case 'timer.set':
        expect(model.timers.has(effect.name)).toBe(false);
        model.timers.add(effect.name);
        break;
      case 'timer.clear':
        expect(model.timers.has(effect.name)).toBe(true);
        model.timers.delete(effect.name);
        break;
      case 'diagnostic':
        expect(['turn.unmatched-result', 'interrupt.still-queued-retry']).toContain(effect.code);
        break;
    }
  }

  if (input.type === 'timer' && model.timers.has(input.name)) {
    // A firing timer is consumed; a retry write follows only if it was ours.
    model.timers.delete(input.name);
  }
  if (input.type === 'stdin.closed') model.stdinClosed = true;
  if (input.type === 'end') model.ended = true;

  // The machine's table holds exactly the model's live turns, in FIFO order.
  const live = [...model.turns].filter(([, status]) => status !== 'terminated');
  expect(after.turns.map((turn) => turn.turnId).sort()).toEqual(live.map(([id]) => id).sort());
  for (const turn of after.turns) {
    expect(turn.phase === 'queued').toBe(model.turns.get(turn.turnId) === 'queued');
  }
  // Ids only grow; nothing is reused.
  expect(after.nextBg).toBeGreaterThanOrEqual(before.nextBg);
  expect(after.nextInterrupt).toBeGreaterThanOrEqual(before.nextInterrupt);
}

describe('turn machine over random event orders', () => {
  it('no illegal transition; every turn and interrupt terminates exactly once', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), fc.boolean(), (ops, failAtEnd) => {
        const model = new Model();
        let state = initialTurnState({ sessionId: SESSION_ID });
        const final: Op = { op: 'end', kind: failAtEnd ? 'fail' : 'cancelled' };
        for (const op of [...ops, final]) {
          const input = resolve(op, model, state);
          const out = turnStep(state, input);
          check(model, state, input, out.effects, out.state);
          state = out.state;
        }
        // After the end: every turn and every interrupt request terminated,
        // no timer left running, nothing in flight.
        for (const status of model.turns.values()) expect(status).toBe('terminated');
        for (const status of model.correlations.values()) expect(status).toBe('settled');
        expect(model.timers.size).toBe(0);
        expect(state.turns).toEqual([]);
        expect(state.inflight).toEqual([]);
      }),
      fcParams(1500),
    );
    // 1500 model-checked runs. Measured on Windows under the default
    // --maxWorkers with coverage: max 2.84 s over 4 runs; x2.
  }, 6_000);

  it('is deterministic: the same inputs give byte-identical outputs', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const replay = (): string => {
          const model = new Model();
          let state = initialTurnState({ sessionId: SESSION_ID });
          const out: string[] = [];
          for (const op of ops) {
            const step = turnStep(state, resolve(op, model, state));
            state = step.state;
            out.push(JSON.stringify(step));
          }
          return out.join('\n');
        };
        expect(replay()).toBe(replay());
      }),
      fcParams(300),
    );
  });
});
