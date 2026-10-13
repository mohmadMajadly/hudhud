// The incremental driver of the machine kit (KitDriver): the same per-step
// and trace checks as runMachine, one input at a time, with the bookkeeping
// methods a replay needs (the Claude conformance runner, W4-T2).

import { describe, expect, it } from 'vitest';

import type { KitMachine, ReferenceConfig, ReferenceState } from '../src/machine-kit.js';
import { KitDriver, referenceMachine } from '../src/machine-kit.js';

const CONFIG: ReferenceConfig = {
  sessionId: 'sess-1',
  handshakeTimeoutMs: 1000,
  closeTimeoutMs: 500,
};
const START = Date.UTC(2026, 9, 14);

function line(text: string) {
  return { type: 'line', text, bytes: Buffer.byteLength(text) } as const;
}

/** A driver of the reference machine with the handshake done. */
function ready(): KitDriver<ReferenceState, ReferenceConfig> {
  const driver = new KitDriver(referenceMachine, CONFIG, { firstSeq: 0, startMs: START });
  expect(driver.feed({ type: 'process.started', pid: 7 })).toBe(true);
  expect(driver.feed(line('{"type":"ready","version":"1"}'))).toBe(true);
  return driver;
}

describe('KitDriver', () => {
  it('starts at the given clock, exposes the state and moves the clock forward only', () => {
    const driver = new KitDriver(referenceMachine, CONFIG, { startMs: START });
    expect(driver.now).toBe(START);
    expect(driver.state?.phase).toBe('spawning');
    expect(driver.ended).toBe(false);
    expect(driver.stopped).toBe(false);
    driver.advance(5);
    driver.advanceTo(START + 2);
    expect(driver.now).toBe(START + 5);
    driver.advanceTo(START + 9);
    expect(driver.now).toBe(START + 9);
    // The default clock origin is the kit's.
    expect(new KitDriver(referenceMachine, CONFIG).now).toBe(Date.UTC(2026, 0, 1));
  });

  it('stamps inputs with the clock and records each step', () => {
    const driver = new KitDriver(referenceMachine, CONFIG, { startMs: START });
    driver.advance(3);
    expect(driver.feed({ type: 'process.started', pid: 7 })).toBe(true);
    expect(driver.steps).toHaveLength(1);
    expect(driver.steps[0]?.input).toMatchObject({
      type: 'process.started',
      atMs: START + 3,
      at: new Date(START + 3).toISOString(),
    });
    expect(driver.state?.phase).toBe('handshake');
    expect(driver.timers).toEqual([['handshake', START + 3 + 1000]]);
  });

  it('fires an armed timer at its deadline and nothing for an unarmed one', () => {
    const driver = new KitDriver(referenceMachine, CONFIG, { startMs: START });
    driver.feed({ type: 'process.started', pid: 7 });
    expect(driver.fireTimer('nope')).toBe(true);
    expect(driver.steps).toHaveLength(1);
    expect(driver.fireTimer('handshake')).toBe(true);
    expect(driver.now).toBe(START + 1000);
    expect(driver.timers).toEqual([]);
    expect(driver.steps.at(-1)?.effects.map((effect) => effect.type)).toEqual([
      'handshake.fail',
      'stdin.end',
      'ladder.start',
    ]);
    // A deadline already passed never moves the clock back.
    const late = new KitDriver(referenceMachine, CONFIG, { startMs: START });
    late.feed({ type: 'process.started', pid: 7 });
    late.advance(5000);
    late.fireTimer('handshake');
    expect(late.now).toBe(START + 5000);
  });

  it('tracks sends, asks and answers so the contract holds to the end', () => {
    const driver = ready();
    expect(driver.send('t1', 'hello')).toBe(true);
    expect(driver.feed(line('{"type":"ask","toolName":"Bash"}'))).toBe(true);
    expect(driver.feed(line('{"type":"ask","toolName":"Edit"}'))).toBe(true);
    expect(driver.pendingAsks).toEqual(['ref_1', 'ref_2']);
    expect(driver.answer('ref_1', { behavior: 'allow' })).toBe(true);
    expect(driver.abortAsk('ref_2')).toBe(true);
    expect(driver.pendingAsks).toEqual([]);
    // Neither is pending any more: no step, no violation.
    const steps = driver.steps.length;
    expect(driver.answer('ref_1', { behavior: 'allow' })).toBe(true);
    expect(driver.abortAsk('ref_2')).toBe(true);
    expect(driver.steps).toHaveLength(steps);
    expect(driver.feed(line('{"type":"result","isError":false}'))).toBe(true);
    expect(driver.feed({ type: 'process.exit', code: 0, signal: null })).toBe(true);
    expect(driver.ended).toBe(true);
    expect(driver.violations).toEqual([]);
  });

  it('reports a violation and stops: every later call does nothing', () => {
    const driver = ready();
    // A turn the driver never sent cannot settle: the reference settles only
    // its own turns, so fake one through a machine that settles a stranger.
    const rogue: KitMachine<ReferenceState, ReferenceConfig> = {
      initialState: referenceMachine.initialState,
      step: (state, input) =>
        input.type === 'stderr.line'
          ? { state, effects: [{ type: 'turn.settle', turnId: 'stranger', result: {} }] }
          : referenceMachine.step(state, input),
    };
    const stopped = new KitDriver(rogue, CONFIG, { startMs: START });
    expect(stopped.feed({ type: 'stderr.line', text: 'x' })).toBe(false);
    expect(stopped.stopped).toBe(true);
    expect(stopped.violations).toEqual([
      'stderr.line: turn stranger settled but never sent or started',
    ]);
    const steps = stopped.steps.length;
    expect(stopped.feed({ type: 'process.started', pid: 7 })).toBe(false);
    expect(stopped.send('t1', 'x')).toBe(false);
    expect(stopped.answer('ref_1', {})).toBe(false);
    expect(stopped.abortAsk('ref_1')).toBe(false);
    expect(stopped.fireTimer('handshake')).toBe(false);
    expect(stopped.steps).toHaveLength(steps);
    expect(driver.stopped).toBe(false);
  });

  it('reports a step that throws without recording it', () => {
    const throwing: KitMachine<ReferenceState, ReferenceConfig> = {
      initialState: referenceMachine.initialState,
      step: () => {
        throw new Error('boom');
      },
    };
    const driver = new KitDriver(throwing, CONFIG);
    expect(driver.feed({ type: 'process.started', pid: 7 })).toBe(false);
    expect(driver.violations).toEqual(['process.started: step threw: Error: boom']);
    expect(driver.steps).toEqual([]);
  });

  it('refuses to run when the initial state fails', () => {
    const broken: KitMachine<ReferenceState, ReferenceConfig> = {
      initialState: () => {
        throw new Error('no state');
      },
      step: referenceMachine.step,
    };
    const driver = new KitDriver(broken, CONFIG);
    expect(driver.state).toBeUndefined();
    expect(driver.stopped).toBe(true);
    expect(driver.violations).toEqual(['initialState threw: Error: no state']);
    expect(driver.feed({ type: 'process.started', pid: 7 })).toBe(false);
    const unstable: KitMachine<{ readonly at: Date }, null> = {
      initialState: () => ({ at: new Date(0) }),
      step: (state) => ({ state, effects: [] }),
    };
    expect(new KitDriver(unstable, null).violations).toEqual(['initialState is not JSON-stable']);
  });
});
