// The loopback binding (ADR-0006, plan §1.6): every config, state, input and
// step result crosses JSON, round-trip equality is asserted, and the driver
// only sees the parsed copies. Representative scripted sessions run through
// it on a manual clock with the test machine (the full Claude conformance
// replay is wired by the wave closer on top of the conformance loader).

import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../../src/binding/clock.js';
import { ProtocolError } from '../../../src/binding/errors.js';
import {
  createLoopbackDriver,
  loopbackLadder,
  loopbackMachine,
  LoopbackTransport,
  LoopbackViolation,
} from '../../../src/binding/loopback.js';
import type { HarnessMachine, MachineInput } from '../../../src/protocol/machine/contract.js';
import { collector, guardProcess, outcome, settle, types } from './driver-support.js';
import { line, TEST_CONFIG, testMachine, type TestConfig, type TestState } from './test-machine.js';

guardProcess();

const AT: Pick<MachineInput, 'atMs' | 'at'> = { atMs: 0, at: '2026-01-01T00:00:00.000Z' };

describe('loopbackMachine', () => {
  it('passes parsed copies, never the original objects', () => {
    const wrapped = loopbackMachine(testMachine);
    const state = wrapped.initialState(TEST_CONFIG);
    expect(state).toEqual(testMachine.initialState(TEST_CONFIG));
    const input: MachineInput = { ...AT, type: 'process.started', pid: 7 };
    const step = wrapped.step(state, input);
    expect(step).toEqual(testMachine.step(state, input));
    expect(wrapped.violations).toEqual([]);
  });

  it.each([
    [
      'config',
      () => wrappedOf(testMachine).initialState({ ...TEST_CONFIG, extra: new Date(0) } as never),
    ],
    [
      'input',
      () => {
        const w = wrappedOf(testMachine);
        return w.step(w.initialState(TEST_CONFIG), {
          ...AT,
          type: 'cmd.send',
          turnId: 'x',
          content: 1n as never,
        });
      },
    ],
    [
      'state',
      () => {
        const w = wrappedOf(testMachine);
        return w.step({ ...w.initialState(TEST_CONFIG), extra: undefined } as never, {
          ...AT,
          type: 'ladder.done',
        });
      },
    ],
    [
      'step',
      () => {
        const w = wrappedOf({
          initialState: (config) => testMachine.initialState(config),
          step: (state) => ({ state, effects: [{ type: 'stdin.end', extra: undefined } as never] }),
        });
        return w.step(w.initialState(TEST_CONFIG), { ...AT, type: 'ladder.done' });
      },
    ],
  ])('a %s that does not survive JSON is a violation', (what, run) => {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LoopbackViolation);
    expect(caught).toMatchObject({ what });
  });
});

function wrappedOf(
  machine: HarnessMachine<TestState, TestConfig>,
): ReturnType<typeof loopbackMachine<TestState, TestConfig>> {
  return loopbackMachine(machine);
}

describe('LoopbackTransport', () => {
  it('scripts output, writes and the exit', async () => {
    const transport = new LoopbackTransport({ pid: 9, stderrTail: 't' });
    expect(transport.pid).toBe(9);
    expect(transport.stderrTail()).toBe('t');
    transport.line('é');
    transport.push({ type: 'stderr.line', text: 'x' });
    expect(transport.buffered).toBe(2);
    const iterator = transport.output[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'line', text: 'é', bytes: 2 },
    });
    await expect(transport.output[Symbol.asyncIterator]().next()).rejects.toThrow(
      /single consumer/u,
    );
    await transport.write('a\n');
    transport.failWritesWith = 'EPIPE';
    await expect(transport.write('b\n')).rejects.toMatchObject({ code: 'EPIPE' });
    transport.endInput({ graceful: false });
    transport.endInput({ graceful: true });
    expect(transport.inputEnd).toBe('immediate');
    await expect(transport.write('c\n')).rejects.toMatchObject({ code: 'ENDED' });
    expect(transport.written).toEqual(['a\n']);
    expect(await transport.afterExit()).toBeNull();
    expect(transport.exitStatus).toBeNull();
    transport.exit({ code: 3, signal: null });
    transport.exit({ code: 4, signal: null });
    expect(await transport.exited).toEqual({ code: 3, signal: null });
    expect(() => {
      transport.line('late');
    }).toThrow(/already ended/u);
    transport.endOutput();
    expect((await iterator.next()).value).toEqual({ type: 'stderr.line', text: 'x' });
    expect((await iterator.next()).done).toBe(true);
  });

  it('a failed output rejects the reader; the graceful sweep report is returned', async () => {
    const report = { status: 'skipped', reason: 'root-alive' } as const;
    const transport = new LoopbackTransport({ afterExit: report });
    const reading = transport.output[Symbol.asyncIterator]().next();
    transport.endOutput(new Error('pipe'));
    await expect(reading).rejects.toThrow('pipe');
    transport.endInput({ graceful: true });
    expect(await transport.afterExit()).toBe(report);
  });

  it('the default ladder interrupts, ends input and exits as killed', async () => {
    const transport = new LoopbackTransport();
    const steps: string[] = [];
    const ladder = transport.terminate({
      intent: 'abort',
      initializePid: null,
      interrupt: () => {
        steps.push('interrupt');
        return Promise.resolve('acknowledged');
      },
    });
    expect(
      transport.terminate({
        intent: 'dispose',
        initializePid: null,
        interrupt: () => Promise.resolve('timeout'),
      }),
    ).toBe(ladder);
    expect(await ladder).toBeNull();
    expect(steps).toEqual(['interrupt']);
    expect(transport.terminations).toEqual(['abort']);
    expect(transport.inputEnd).toBe('immediate');
    expect(transport.exitStatus).toEqual({ code: null, signal: 'SIGKILL' });
    expect(loopbackLadder).toBeTypeOf('function');
  });
});

describe('scripted sessions through the loopback binding', () => {
  it('handshake, a turn with a permission, then a graceful close with the sweep report', async () => {
    const lb = createLoopbackDriver(testMachine, TEST_CONFIG, {
      onPermission: () => Promise.resolve({ behavior: 'allow' }),
      afterExit: { status: 'skipped', reason: 'no-descendants' },
      compat: {
        harness: 'test',
        version: '1.0.0',
        minTested: '1.0.0',
        maxTested: '1.0.0',
        knownBroken: [],
        status: 'tested',
      },
      containment: 'job',
    });
    expect(lb.clock).toBeInstanceOf(ManualClock);
    const events = collector(lb.session.events());
    const started = lb.driver.start();
    await settle();
    lb.transport.line(line({ t: 'ready' }));
    expect((await started).containment).toBe('job');
    const asked = lb.session.ask('hello');
    await settle();
    const turnId = '00000000-0000-4000-8000-000000000001';
    lb.transport.line(line({ t: 'ask', rid: 'r1' }));
    await settle();
    lb.transport.line(line({ t: 'say', id: turnId, text: 'done' }));
    lb.transport.line(line({ t: 'result', id: turnId }));
    expect(await asked).toMatchObject({ turnId, outcome: 'completed' });
    void lb.session.close();
    await settle();
    expect(lb.transport.inputEnd).toBe('graceful');
    lb.transport.exit({ code: 0, signal: null });
    await lb.session.closed;
    expect(lb.transport.written.map((text) => JSON.parse(text) as unknown)).toEqual([
      { op: 'init' },
      { op: 'user', id: turnId, content: 'hello' },
      { op: 'answer', rid: 'r1', decision: { behavior: 'allow' } },
    ]);
    expect(types((await events.result()).events)).toEqual([
      'compat',
      'session.started',
      'turn.queued',
      'permission.requested',
      'permission.resolved',
      'message.assistant',
      'turn.completed',
      'diagnostic',
      'session.terminated',
    ]);
    expect(lb.machine.violations).toEqual([]);
  });

  it('abort: the interrupt step, the ladder, a cancelled turn', async () => {
    const lb = createLoopbackDriver(testMachine, TEST_CONFIG, { sessionId: TEST_CONFIG.sessionId });
    const started = lb.driver.start();
    await settle();
    lb.transport.line(line({ t: 'ready' }));
    await started;
    const turn = lb.session.send('long');
    await settle();
    const disposed = lb.session[Symbol.asyncDispose]();
    await settle();
    (lb.clock as ManualClock).advance(TEST_CONFIG.interruptWaitMs);
    await disposed;
    expect(await turn.done).toMatchObject({ outcome: 'cancelled', synthesized: true });
    expect(lb.transport.terminations).toEqual(['dispose']);
  });

  it('a machine output that does not survive JSON ends the session with PROTOCOL_ERROR', async () => {
    const leaky: HarnessMachine<TestState, TestConfig> = {
      initialState: (config) => testMachine.initialState(config),
      step: (state, input) => {
        const step = testMachine.step(state, input);
        return input.type === 'line'
          ? {
              state: step.state,
              effects: [...step.effects, { type: 'timer.set', name: 'x', ms: Number.NaN }],
            }
          : step;
      },
    };
    const lb = createLoopbackDriver(leaky, TEST_CONFIG);
    const started = outcome(lb.driver.start());
    await settle();
    lb.transport.line(line({ t: 'ready' }));
    expect((await started).error).toBeInstanceOf(ProtocolError);
    await lb.session.closed;
    expect(lb.machine.violations.map((violation) => violation.what)).toEqual(['step']);
    expect(await lb.driver.ended).toMatchObject({ outcome: 'failed' });
  });
});
