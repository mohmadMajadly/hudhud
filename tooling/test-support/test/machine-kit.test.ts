import process from 'node:process';

import fc from 'fast-check';
import type { JsonValue } from '@hudhud/core/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  KitAction,
  KitEffect,
  KitInputBody,
  KitMachine,
  ReferenceConfig,
  ReferenceState,
} from '../src/machine-kit.js';
import {
  DEFAULT_FINALE,
  assertMachineContract,
  machineActions,
  neutralInputs,
  referenceMachine,
  resolveSeed,
  runMachine,
} from '../src/machine-kit.js';

const seedText = process.env['FC_SEED'];
const seed = seedText === undefined ? {} : { seed: Number(seedText) };

const CONFIG: ReferenceConfig = {
  sessionId: 'sess-1',
  handshakeTimeoutMs: 1000,
  closeTimeoutMs: 500,
};
const configs = fc.record({
  sessionId: fc.constantFrom('sess-1', 'sess-2'),
  handshakeTimeoutMs: fc.integer({ min: 0, max: 5000 }),
  closeTimeoutMs: fc.integer({ min: 0, max: 5000 }),
});
/** Lines of the reference protocol, plus noise. */
const referenceLines = fc.oneof(
  fc.constantFrom(
    '{"type":"ready","version":"1.0"}',
    '{"type":"ready"}',
    '{"type":"result","isError":false}',
    '{"type":"result","isError":true}',
    '{"type":"ask","toolName":"Shell"}',
    '{"type":"ask"}',
    '{"type":"cancel-ask"}',
    '{"type":"other"}',
    '{"no":"type"}',
    '[1,2]',
    'not json',
  ),
  fc.string({ maxLength: 10 }),
);

const ready: KitAction = { kind: 'line', text: '{"type":"ready","version":"1.0"}' };
const result: KitAction = { kind: 'line', text: '{"type":"result","isError":false}' };
const ask: KitAction = { kind: 'line', text: '{"type":"ask","toolName":"Shell"}' };
const send: KitAction = { kind: 'send', content: 'hi' };
const input = (body: KitInputBody): KitAction => ({ kind: 'input', input: body });

type RefMachine = KitMachine<ReferenceState, ReferenceConfig>;

/** The reference machine with its effects rewritten. */
function withEffects(
  rewrite: (effects: readonly KitEffect[], next: ReferenceState) => readonly KitEffect[],
): RefMachine {
  return {
    initialState: referenceMachine.initialState,
    step: (state, body) => {
      const out = referenceMachine.step(state, body);
      return { state: out.state, effects: rewrite(out.effects, out.state) };
    },
  };
}

const fx = (type: string, fields: Readonly<Record<string, unknown>> = {}): KitEffect => ({
  ...fields,
  type,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('reference machine through the kit', () => {
  it('satisfies the contract over generated interleavings', () => {
    const logs: string[] = [];
    assertMachineContract(referenceMachine, {
      config: configs,
      lines: referenceLines,
      firstSeq: 0,
      numRuns: 1500,
      ...seed,
      log: (message) => logs.push(message),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^machine-kit: seed -?\d+/u);
  }, 30_000);

  it('satisfies the contract with extra inputs, spawn errors and a close finale', () => {
    assertMachineContract(referenceMachine, {
      config: configs,
      lines: referenceLines,
      inputs: fc.constantFrom<KitInputBody>(
        { type: 'process.spawn-error', code: 'ENOENT' },
        { type: 'process.started', pid: 7 },
      ),
      content: fc.jsonValue().map((value) => JSON.parse(JSON.stringify(value)) as JsonValue),
      maxActions: 20,
      numRuns: 300,
      ...seed,
    });
    assertMachineContract(referenceMachine, {
      config: fc.constant(CONFIG),
      actions: fc.constant([]),
      prelude: [{ type: 'process.spawn-error', code: 'ENOENT' }],
      numRuns: 1,
      ...seed,
    });
    assertMachineContract(referenceMachine, {
      config: CONFIG,
      lines: referenceLines,
      finale: [{ type: 'cmd.close' }, { type: 'process.exit', code: 0, signal: null }],
      numRuns: 300,
      ...seed,
    });
  }, 30_000);

  it('runs a full scripted session deterministically', () => {
    const actions: KitAction[] = [
      send,
      ready,
      send,
      ask,
      { kind: 'answer', target: 0, decision: { behavior: 'allow' } },
      ask,
      { kind: 'answer', target: 0, decision: { behavior: 'deny', message: 'no' } },
      ask,
      { kind: 'abort-ask', target: 0 },
      ask,
      { kind: 'line', text: '{"type":"cancel-ask"}' },
      { kind: 'interrupt', target: 0, cancelQueued: true },
      { kind: 'interrupt', target: -1, cancelQueued: false },
      { kind: 'set-mode', mode: 'plan' },
      result,
      send,
      result,
      { kind: 'advance', ms: 10 },
      input({ type: 'cmd.close' }),
      { kind: 'fire-timer', target: 0 },
    ];
    const first = runMachine(referenceMachine, CONFIG, actions, { firstSeq: 0 });
    const second = runMachine(referenceMachine, CONFIG, actions, { firstSeq: 0 });
    expect(first.violations).toEqual([]);
    expect(first.ended).toBe(true);
    expect(second).toEqual(first);
    const types = first.steps.flatMap((step) => step.effects.map((effect) => effect.type));
    expect(types).toContain('permission.ask');
    expect(types).toContain('control.settle');
    expect(types).toContain('turn.settle');
    expect(types.at(-1)).toBe('session.end');
    // The clock is stamped on every input and only moves forward.
    const stamps = first.steps.map((step) => step.input.atMs);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(first.steps[0]?.input.at).toBe('2026-01-01T00:00:00.000Z');
    expect(first.steps.at(-1)?.input.atMs).toBe(Date.UTC(2026, 0, 1) + 10 + CONFIG.closeTimeoutMs);
  });

  it('fires the handshake watchdog', () => {
    const run = runMachine(referenceMachine, CONFIG, [{ kind: 'fire-timer', target: 3 }], {
      startMs: 0,
    });
    expect(run.violations).toEqual([]);
    const types = run.steps[1]?.effects.map((effect) => effect.type);
    expect(types).toEqual(['handshake.fail', 'stdin.end', 'ladder.start']);
    expect(run.steps[1]?.input).toMatchObject({ type: 'timer', name: 'handshake', atMs: 1000 });
  });

  it('feeds the finale after the end and requires no effects', () => {
    const run = runMachine(referenceMachine, CONFIG, [
      input({ type: 'process.exit', code: 0, signal: null }),
    ]);
    expect(run.violations).toEqual([]);
    expect(run.steps.slice(2).every((step) => step.effects.length === 0)).toBe(true);
    expect(run.steps).toHaveLength(2 + DEFAULT_FINALE.length);
  });

  it('skips targeted actions without candidates', () => {
    const actions: KitAction[] = [
      { kind: 'answer', target: 3, decision: {} },
      { kind: 'abort-ask', target: 1 },
      { kind: 'interrupt', target: 2, cancelQueued: false },
    ];
    const run = runMachine(referenceMachine, CONFIG, actions, { finale: [], requireEnd: false });
    expect(run.violations).toEqual([]);
    expect(run.steps.map((step) => step.input.type)).toEqual(['process.started', 'cmd.interrupt']);
    expect(run.steps[1]?.input).not.toHaveProperty('turnId');
  });

  it('writes nothing once stdin failed, and ignores timers it did not arm', () => {
    const actions: KitAction[] = [
      send,
      ready,
      ask,
      input({ type: 'stdin.error', code: 'EPIPE' }),
      { kind: 'answer', target: 0, decision: { behavior: 'allow' } },
    ];
    const run = runMachine(referenceMachine, CONFIG, actions);
    expect(run.violations).toEqual([]);
    const answered = run.steps.find((step) => step.input.type === 'cmd.permission');
    expect(answered?.effects.map((effect) => effect.type)).toEqual(['event']);

    const state = referenceMachine.initialState(CONFIG);
    const at = '2026-01-01T00:00:00.000Z';
    expect(referenceMachine.step(state, { type: 'timer', name: 'stray', atMs: 0, at })).toEqual({
      state,
      effects: [],
    });
  });

  it('defaults to 200 runs', () => {
    let runs = 0;
    const counting: RefMachine = {
      initialState: (config) => {
        runs += 1;
        return referenceMachine.initialState(config);
      },
      step: referenceMachine.step,
    };
    assertMachineContract(counting, { config: CONFIG, maxActions: 2, ...seed });
    expect(runs).toBe(200);
  });
});

describe('the kit catches contract violations', () => {
  const violations = (
    machine: RefMachine,
    actions: readonly KitAction[] = [],
    options = {},
  ): readonly string[] => runMachine(machine, CONFIG, actions, options).violations;

  it('a session that never ends', () => {
    const machine = withEffects((effects) =>
      effects.filter((effect) => effect.type !== 'session.end'),
    );
    expect(violations(machine)).toEqual(['the session did not end after the finale']);
    expect(violations(machine, [], { requireEnd: false })).toEqual([]);
  });

  it('a turn settled twice', () => {
    const machine = withEffects((effects) =>
      effects.flatMap((effect) => (effect.type === 'turn.settle' ? [effect, effect] : [effect])),
    );
    expect(violations(machine, [send, ready, result])).toEqual(['line: turn turn-1 settled twice']);
  });

  it('a turn never settled', () => {
    const machine = withEffects((effects) =>
      effects.filter((effect) => effect.type !== 'turn.settle' && effect.type !== 'turn.fail'),
    );
    expect(violations(machine, [send])).toEqual(['process.exit: turn turn-1 never settled']);
  });

  it('a settlement of a turn nobody sent', () => {
    const machine = withEffects((effects) => [...effects, fx('turn.fail', { turnId: 'ghost' })]);
    expect(violations(machine)).toEqual([
      'process.started: turn ghost settled but never sent or started',
    ]);
  });

  it('a harness-started turn is known once its turn.started event arrives', () => {
    // Inserted right before session.end, with the next unused seq.
    const harnessTurn = (event: Readonly<Record<string, unknown>>, settle: boolean): RefMachine =>
      withEffects((effects, next) =>
        effects.flatMap((effect) =>
          effect.type === 'session.end'
            ? [
                fx('event', { event: { ...event, seq: next.seq } }),
                ...(settle ? [fx('turn.settle', { turnId: 'bg-1' })] : []),
                effect,
              ]
            : [effect],
        ),
      );
    expect(
      violations(harnessTurn({ type: 'turn.started', turnId: 'bg-1' }, true), [ready]),
    ).toEqual([]);
    expect(
      violations(harnessTurn({ type: 'turn.started', turnId: 'bg-1' }, false), [ready]),
    ).toEqual(['process.exit: turn bg-1 never settled']);
    expect(violations(harnessTurn({ type: 'turn.started' }, false), [ready])).toEqual([]);
  });

  it('effects without the fields the contract reads', () => {
    const cases: readonly [KitEffect, string][] = [
      [fx('turn.settle'), 'turn.settle without a string turnId'],
      [fx('permission.ask', { requestId: 1 }), 'permission.ask without a string requestId'],
      [fx('permission.cancel'), 'permission.cancel without a string requestId'],
      [fx('control.settle'), 'control.settle without a string correlation'],
      [fx('timer.clear'), 'timer.clear without a string name'],
      [fx('timer.set', { name: 't', ms: -1 }), 'timer.set t with an invalid ms'],
      [
        fx('timer.set', { name: 't', ms: Number.POSITIVE_INFINITY }),
        'step output is not JSON-stable',
      ],
      [fx('timer.set', { name: 't' }), 'timer.set t with an invalid ms'],
      [fx('event'), 'event effect without an event object'],
      [fx('event', { event: null }), 'event effect without an event object'],
      [fx('event', { event: { seq: 1.5 } }), 'event without an integer seq'],
      [fx('event', { event: { seq: '0' } }), 'event without an integer seq'],
    ];
    for (const [extra, message] of cases) {
      const machine = withEffects((effects) => [...effects, extra]);
      expect(violations(machine)[0]).toBe(`process.started: ${message}`);
    }
    const nameless = withEffects((effects) => [...effects, fx('timer.set', { ms: 1 })]);
    expect(violations(nameless)).toEqual(['process.started: timer.set without a string name']);
  });

  it('event seq gaps, repeats and a wrong start', () => {
    const gap = withEffects((effects) =>
      effects.map((effect) =>
        effect.type === 'event' ? fx('event', { event: { seq: 5 } }) : effect,
      ),
    );
    expect(violations(gap, [send, send])).toEqual(['cmd.send: event seq 5, expected 6']);
    expect(violations(referenceMachine, [send], { firstSeq: 1 })).toEqual([
      'cmd.send: event seq 0, expected 1',
    ]);
  });

  it('a write after stdin.end', () => {
    const machine = withEffects((effects) =>
      effects.some((effect) => effect.type === 'stdin.end')
        ? [...effects, fx('write', { line: 'x\n' })]
        : effects,
    );
    expect(violations(machine, [input({ type: 'cmd.close' })])).toEqual([
      'cmd.close: write after stdin.end',
    ]);
  });

  it('timers still armed at session.end', () => {
    const machine = withEffects((effects) =>
      effects.filter((effect) => effect.type !== 'timer.clear'),
    );
    expect(violations(machine)).toEqual(['process.exit: timer handshake armed at session.end']);
  });

  it('effects after session.end', () => {
    const machine: RefMachine = {
      initialState: referenceMachine.initialState,
      step: (state, body) =>
        state.phase === 'ended'
          ? { state, effects: [fx('write', { line: 'late\n' })] }
          : referenceMachine.step(state, body),
    };
    expect(violations(machine)).toEqual(['ladder.done: effect write after session.end']);
    const sameStep = withEffects((effects) =>
      effects.some((effect) => effect.type === 'session.end')
        ? [...effects, fx('stdin.end')]
        : effects,
    );
    expect(violations(sameStep)).toEqual(['process.exit: effect stdin.end after session.end']);
  });

  it('permission asks that end twice, never, or not at all', () => {
    const twice = withEffects((effects) =>
      effects.flatMap((effect) => (effect.type === 'permission.ask' ? [effect, effect] : [effect])),
    );
    expect(violations(twice, [send, ready, ask])).toEqual(['line: permission ref_1 asked twice']);

    const reused: RefMachine = withEffects((effects) =>
      effects.map((effect) =>
        effect.type === 'permission.ask' ? fx('permission.ask', { requestId: 'same' }) : effect,
      ),
    );
    expect(violations(reused, [send, ready, ask, { kind: 'abort-ask', target: 0 }, ask])).toEqual([
      'line: permission same asked twice',
    ]);

    const noCancel = withEffects((effects) =>
      effects.filter((effect) => effect.type !== 'permission.cancel'),
    );
    expect(violations(noCancel, [send, ready, ask])).toEqual([
      'process.exit: permission ref_1 never ended',
    ]);

    const spurious = withEffects((effects) => [
      ...effects,
      fx('permission.cancel', { requestId: 'nope' }),
    ]);
    expect(violations(spurious)).toEqual([
      'process.started: permission nope cancelled but not pending',
    ]);
  });

  it('a control settled twice', () => {
    const machine = withEffects((effects) =>
      effects.flatMap((effect) => (effect.type === 'control.settle' ? [effect, effect] : [effect])),
    );
    expect(violations(machine, [{ kind: 'set-mode', mode: 'plan' }])).toEqual([
      'cmd.set-permission-mode: control corr-1 settled twice',
    ]);
  });

  it('a step that throws, mutates, is not JSON or not deterministic', () => {
    const throws: RefMachine = {
      initialState: referenceMachine.initialState,
      step: () => {
        throw new Error('boom');
      },
    };
    expect(violations(throws)).toEqual(['process.started: step threw: Error: boom']);

    const mutates: RefMachine = {
      initialState: referenceMachine.initialState,
      step: (state, body) => {
        (state as { seq: number }).seq += 1;
        return referenceMachine.step(state, body);
      },
    };
    expect(violations(mutates)).toEqual(['process.started: step mutated its input state']);

    let calls = 0;
    const flaky = withEffects((effects) => {
      calls += 1;
      return calls % 2 === 0 ? [...effects, fx('stdout.end')] : effects;
    });
    expect(violations(flaky)).toEqual(['process.started: step is not deterministic']);

    const cases: readonly unknown[] = [
      undefined,
      Number.NaN,
      -0,
      new Date(0),
      10n,
      { nested: [1, undefined] },
      // eslint-disable-next-line no-sparse-arrays -- a hole becomes null
      [1, , 2],
      Object.assign([1], { extra: true }),
      [1, 2n],
      Object.assign([1], { toJSON: () => ({}) }),
      Object.assign([1], { toJSON: () => [1, 2] }),
      new Map([['a', 1]]),
      new (class Point {
        x = 1;
      })(),
      { [Symbol('hidden')]: 1 },
      Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }),
      { toJSON: () => 'other' },
      { toJSON: () => [] },
    ];
    for (const value of cases) {
      const machine = withEffects((effects) => [...effects, fx('note', { value })]);
      expect(violations(machine)).toEqual(['process.started: step output is not JSON-stable']);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const cycles = withEffects((effects) => [...effects, fx('note', { cyclic })]);
    expect(violations(cycles)).toEqual(['process.started: step output is not JSON-stable']);
  });

  it('an initial state that throws or is not JSON', () => {
    const throws: RefMachine = {
      ...referenceMachine,
      initialState: () => {
        throw new Error('no');
      },
    };
    expect(violations(throws)).toEqual(['initialState threw: Error: no']);
    const fn: RefMachine = {
      ...referenceMachine,
      initialState: () => (() => 1) as unknown as ReferenceState,
    };
    expect(violations(fn)).toEqual(['initialState is not JSON-stable']);
  });

  it('assertMachineContract reports the violation with a counterexample', () => {
    const machine = withEffects((effects) =>
      effects.filter((effect) => effect.type !== 'session.end'),
    );
    expect(() => {
      assertMachineContract(machine, { config: fc.constant(CONFIG), numRuns: 5, seed: 42 });
    }).toThrow(/the session did not end after the finale/u);
  });
});

describe('arbitraries and seeds', () => {
  it('generates actions within bounds, with and without lines', () => {
    fc.assert(
      fc.property(machineActions({ maxActions: 5 }), (actions) => {
        expect(actions.length).toBeLessThanOrEqual(5);
        expect(actions.some((action) => action.kind === 'line')).toBe(false);
      }),
      { numRuns: 200, ...seed },
    );
    const kinds = new Set(
      fc
        .sample(machineActions({ lines: fc.constant('x') }), { numRuns: 300, seed: 1 })
        .flat()
        .map((a) => a.kind),
    );
    expect([...kinds].sort()).toEqual(
      [
        'abort-ask',
        'advance',
        'answer',
        'fire-timer',
        'input',
        'interrupt',
        'line',
        'send',
        'set-mode',
      ].sort(),
    );
  });

  it('neutral inputs never include a harness line or a second start', () => {
    fc.assert(
      fc.property(neutralInputs(), (body) => {
        expect(['line', 'process.started', 'process.spawn-error', 'timer']).not.toContain(
          body.type,
        );
      }),
      { numRuns: 300, ...seed },
    );
  });

  it('resolves the seed: explicit, then FC_SEED, then fresh', () => {
    vi.stubEnv('FC_SEED', '77');
    expect(resolveSeed(5)).toBe(5);
    expect(resolveSeed(undefined)).toBe(77);
    vi.stubEnv('FC_SEED', 'abc');
    expect(Number.isSafeInteger(resolveSeed(undefined))).toBe(true);
    vi.stubEnv('FC_SEED', '');
    expect(Number.isSafeInteger(resolveSeed(undefined))).toBe(true);
    vi.stubEnv('FC_SEED', undefined);
    expect(Number.isSafeInteger(resolveSeed(undefined))).toBe(true);
  });
});
