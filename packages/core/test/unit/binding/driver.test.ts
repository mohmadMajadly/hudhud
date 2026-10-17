// The generic session driver against the test machine and the in-memory
// transport (plan §4.2 `binding/driver`): effect order, handshake, turns,
// controls, the end of a session and the containment of a broken machine.
// Deterministic: a manual clock and drained callbacks only.

import { describe, expect, it } from 'vitest';

import { counterIds } from '../../../src/binding/clock.js';
import { openSession, SYNTHESIZED_EVENT_BYTES } from '../../../src/binding/driver.js';
import {
  AbortError,
  ControlRequestError,
  HandshakeError,
  HandshakeTimeoutError,
  InvalidOptionsError,
  ProcessExitedError,
  ProtocolError,
  SessionClosedError,
  TurnDroppedError,
} from '../../../src/binding/errors.js';
import { LoopbackTransport } from '../../../src/binding/loopback.js';
import type { HarnessMachine } from '../../../src/protocol/machine/contract.js';
import {
  collect,
  iteratorOf,
  collector,
  guardProcess,
  outcome,
  ready,
  rig,
  settle,
  state,
  text,
  nextEvent,
  types,
} from './driver-support.js';
import { TEST_CONFIG, testMachine, type TestConfig, type TestState } from './test-machine.js';

guardProcess();

const COMPAT = {
  harness: 'test',
  version: '1.0.0',
  minTested: '1.0.0',
  maxTested: '1.0.0',
  knownBroken: [],
  status: 'tested',
} as const;

describe('start and handshake', () => {
  it('feeds process.started, resolves with the session info and numbers events from 1', async () => {
    const r = rig({
      compat: COMPAT,
      containment: 'job',
      diagnostics: [{ code: 'containment.fallback', message: 'm', data: { step: 'x' } }],
    });
    expect(() => r.driver.info).toThrow(/not started/u);
    expect(r.driver.id).toBe(TEST_CONFIG.sessionId);
    const events = collector(r.session.events());
    const started = r.driver.start();
    expect(r.driver.start()).toBe(started);
    await settle();
    expect(r.ops()).toEqual([{ op: 'init' }]);
    r.say({ t: 'ready', cliPid: 77 });
    const info = await started;
    expect(info).toEqual({
      id: TEST_CONFIG.sessionId,
      mode: 'create',
      pid: 4242,
      cliPid: 77,
      version: '1.0.0',
      features: ['f1'],
      containment: 'job',
    });
    expect(Object.isFrozen(info)).toBe(true);
    expect(r.session.info).toBe(info);
    expect(r.session.id).toBe(TEST_CONFIG.sessionId);
    const disposed = r.session[Symbol.asyncDispose]();
    await settle();
    r.say({ t: 'interrupted' });
    await disposed;
    const { events: seen } = await events.result();
    expect(types(seen).slice(0, 3)).toEqual(['compat', 'diagnostic', 'session.started']);
    expect(seen.map((event) => event.seq)).toEqual(seen.map((_, index) => index));
    expect(seen[0]).toMatchObject({ seq: 0, compat: COMPAT, sessionId: TEST_CONFIG.sessionId });
    expect(r.machine.stats.inputs[0]).toBe('process.started');
  });

  it('rejects start with the handshake timeout only after the ladder ran and the process exited', async () => {
    const r = rig();
    const started = outcome(r.driver.start());
    await settle();
    r.clock.advance(TEST_CONFIG.handshakeMs);
    const result = await started;
    expect(result.error).toBeInstanceOf(HandshakeTimeoutError);
    expect(r.transport.terminations).toEqual(['watchdog']);
    expect(r.transport.exitStatus).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await r.driver.ended).toMatchObject({ outcome: 'failed' });
  });

  it('attaches the redacted stderr tail to a handshake failure', async () => {
    const r = rig({ transportOptions: { stderrTail: 'boom <redacted>' } });
    const started = outcome(r.driver.start());
    await settle();
    r.transport.exit({ code: 1, signal: null });
    const result = await started;
    expect(result.error).toBeInstanceOf(HandshakeError);
    expect((result.error as HandshakeError).details).toEqual({ stderrTail: 'boom <redacted>' });
  });

  it('openSession returns the public session or rejects after the end', async () => {
    const transport = new LoopbackTransport();
    const opened = openSession({
      machine: testMachine,
      config: TEST_CONFIG,
      transport,
      sessionId: TEST_CONFIG.sessionId,
      hostExit: null,
      ids: counterIds(),
    });
    await settle();
    transport.line(JSON.stringify({ t: 'ready' }));
    const session = await opened;
    expect(session.info.pid).toBe(4242);
    await session[Symbol.asyncDispose]();

    const failing = new LoopbackTransport();
    const refused = outcome(
      openSession({
        machine: testMachine,
        config: TEST_CONFIG,
        transport: failing,
        sessionId: TEST_CONFIG.sessionId,
        hostExit: null,
      }),
    );
    await settle();
    failing.exit({ code: 1, signal: null });
    expect((await refused).error).toBeInstanceOf(HandshakeError);
  });

  it('a session ended before any handshake effect rejects start with SESSION_CLOSED', async () => {
    const r = rig();
    const started = outcome(r.driver.start());
    await settle();
    r.say({ t: 'end-now' });
    expect((await started).error).toBeInstanceOf(SessionClosedError);
    expect(r.transport.terminations).toEqual(['abort']);
  });
});

describe('turns', () => {
  it('ask resolves with the result, error results included (K21)', async () => {
    const r = rig();
    await ready(r);
    const asked = r.session.ask('hello');
    await settle();
    const user = r.ops().at(-1);
    expect(user).toEqual({
      op: 'user',
      id: '00000000-0000-4000-8000-000000000001',
      content: 'hello',
    });
    r.say({ t: 'result', id: user?.['id'] ?? '', error: true });
    expect(await asked).toMatchObject({ isError: true, outcome: 'error' });
    expect(r.driver.pending).toMatchObject({ turns: 0, controls: 0, queue: 0, outbox: 0 });
  });

  it('a turn iterates its own events from creation and ends after turn.completed', async () => {
    const r = rig();
    await ready(r);
    const turn = r.session.send({ content: [{ type: 'text', text: 'hi' }] });
    const other = r.session.send('other');
    await settle();
    expect(r.ops().at(-2)).toMatchObject({ content: [{ type: 'text', text: 'hi' }] });
    r.say({ t: 'say', id: turn.id, text: 'a' });
    r.say({ t: 'say', id: other.id, text: 'b' });
    r.say({ t: 'result', id: turn.id });
    const events = await collect(turn);
    expect(types(events)).toEqual(['turn.queued', 'message.assistant', 'turn.completed']);
    expect(await turn.done).toMatchObject({ turnId: turn.id, outcome: 'completed' });
    r.say({ t: 'result', id: other.id });
    await other.done;
  });

  it('TURN_DROPPED fails that turn only: done rejects, the iterator rejects after its events', async () => {
    const r = rig();
    await ready(r);
    const dropped = r.session.send('a');
    const kept = r.session.send('b');
    await settle();
    r.say({ t: 'say', id: dropped.id, text: 'x' });
    r.say({ t: 'drop', id: dropped.id });
    const iterated = collector(dropped);
    expect((await outcome(dropped.done)).error).toBeInstanceOf(TurnDroppedError);
    const { events, error } = await iterated.result();
    expect(types(events)).toEqual(['turn.queued', 'message.assistant']);
    expect(error).toBeInstanceOf(TurnDroppedError);
    r.say({ t: 'result', id: kept.id });
    expect(await kept.done).toMatchObject({ turnId: kept.id });
  });

  it('send.rejected rejects the new send only; the live turn with that id is untouched', async () => {
    const ids = ['22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222'];
    const r = rig({ ids: { uuid: () => ids.shift() ?? 'not-a-uuid' } });
    await ready(r);
    const live = r.session.send('first');
    const duplicate = r.session.send('second');
    const invalid = r.session.ask('third');
    await settle();
    expect((await outcome(duplicate.done)).error).toBeInstanceOf(ProtocolError);
    expect((await outcome(invalid)).error).toBeInstanceOf(ProtocolError);
    expect(state(live.done).current()).toBe('pending');
    r.say({ t: 'result', id: live.id });
    expect(await live.done).toMatchObject({ turnId: live.id });
    expect(r.ops().filter((op) => op['op'] === 'user')).toHaveLength(1);
  });

  it('checks user input strictly and passes it through the encoder hook', async () => {
    const r = rig({
      encodeUserInput: (input) => ({ wrapped: typeof input === 'string' ? input : 'blocks' }),
    });
    await ready(r);
    expect(() => r.session.send(42 as never)).toThrow(InvalidOptionsError);
    expect(
      (await outcome(r.session.ask({ content: [{ type: 'video' }] } as never))).error,
    ).toBeInstanceOf(InvalidOptionsError);
    const turn = r.session.send('x');
    await settle();
    expect(r.ops().at(-1)).toMatchObject({ content: { wrapped: 'x' } });
    r.say({ t: 'result', id: turn.id });
    await turn.done;

    const throwing = rig({
      encodeUserInput: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- an adapter hook may throw anything
        throw 'not an error';
      },
    });
    await ready(throwing);
    const failed = await outcome(throwing.session.ask('x'));
    expect(failed.error).toBeInstanceOf(Error);
    expect((failed.error as Error).cause).toBe('not an error');
  });

  it('ask with an aborted signal interrupts, rejects at once, and the turn settles in the background', async () => {
    const r = rig();
    await ready(r);
    const controller = new AbortController();
    const asked = outcome(r.session.ask('long', { signal: controller.signal }));
    await settle();
    const id = text(r.ops().at(-1)?.['id']);
    controller.abort(new Error('user'));
    const result = await asked;
    expect(result.error).toBeInstanceOf(AbortError);
    expect((result.error as AbortError).cause).toEqual(new Error('user'));
    await settle();
    expect(r.ops().at(-1)).toEqual({ op: 'interrupt', id });
    r.say({ t: 'result', id });
    await settle();
    expect(r.driver.pending.turns).toBe(0);

    const pre = new AbortController();
    pre.abort();
    expect((await outcome(r.session.ask('never', { signal: pre.signal }))).error).toBeInstanceOf(
      AbortError,
    );
    await settle();
    expect(r.ops().filter((op) => op['content'] === 'never')).toEqual([]);
  });

  it('send with a signal works as ask: abort interrupts, done and the iterator reject at once (R6-1)', async () => {
    const r = rig();
    await ready(r);
    const controller = new AbortController();
    const turn = r.session.send('x', { signal: controller.signal });
    const iterated = collector(turn);
    await settle();
    controller.abort(new Error('user'));
    const done = await outcome(turn.done);
    expect(done.error).toBeInstanceOf(AbortError);
    expect((done.error as AbortError).cause).toEqual(new Error('user'));
    expect((await iterated.result()).error).toBeInstanceOf(AbortError);
    await settle();
    expect(r.ops().at(-1)).toEqual({ op: 'interrupt', id: turn.id });
    // The turn still settles in the background.
    r.say({ t: 'result', id: turn.id });
    await settle();
    expect(r.driver.pending.turns).toBe(0);
  });

  it('send with an already aborted signal sends nothing; done and the iterator reject (R4-6)', async () => {
    const r = rig();
    await ready(r);
    const before = r.ops().length;
    const late = r.session.send('y', { signal: AbortSignal.abort('early') });
    const done = await outcome(late.done);
    expect(done.error).toBeInstanceOf(AbortError);
    expect((done.error as AbortError).cause).toBe('early');
    expect((await outcome(iteratorOf(late).next())).error).toBeInstanceOf(AbortError);
    await settle();
    expect(r.ops().slice(before)).toEqual([]);
    expect(r.driver.pending).toMatchObject({ turns: 0, queue: 0 });
  });

  it('turn.interrupt resolves on the control answer; ask has no iterator', async () => {
    const r = rig();
    await ready(r);
    const turn = r.session.send('x');
    await turn.interrupt({ cancelQueued: true });
    await r.driver.interrupt(undefined, false);
    expect(r.ops().slice(-2)).toEqual([{ op: 'interrupt', id: turn.id }, { op: 'interrupt' }]);
    r.say({ t: 'result', id: turn.id });
    await turn.done;
  });
});

describe('controls', () => {
  it('setPermissionMode resolves, maps errors and refuses an empty mode', async () => {
    const r = rig();
    await ready(r);
    await r.session.setPermissionMode('plan');
    expect(r.ops().at(-1)).toEqual({ op: 'mode', mode: 'plan' });
    expect((await outcome(r.session.setPermissionMode('bad'))).error).toBeInstanceOf(
      ControlRequestError,
    );
    const unknown = (await outcome(r.session.setPermissionMode('unknown-code'))).error;
    expect(unknown).toBeInstanceOf(ProtocolError);
    expect((unknown as ProtocolError).details).toEqual({ unknownCode: 'FROM_THE_FUTURE' });
    expect((await outcome(r.session.setPermissionMode(''))).error).toBeInstanceOf(
      InvalidOptionsError,
    );
  });

  it('a signal rejects setPermissionMode at once; the answer is then ignored', async () => {
    const r = rig();
    await ready(r);
    const controller = new AbortController();
    const pending = outcome(r.session.setPermissionMode('wait', { signal: controller.signal }));
    await settle();
    controller.abort();
    expect((await pending).error).toBeInstanceOf(AbortError);
    r.say({ t: 'ack', c: 'c1' });
    await settle();
    expect(r.driver.pending.controls).toBe(0);
    const pre = new AbortController();
    pre.abort();
    expect(
      (await outcome(r.session.setPermissionMode('plan', { signal: pre.signal }))).error,
    ).toBeInstanceOf(AbortError);
  });

  it('controls still pending when the session ends are rejected', async () => {
    const r = rig();
    await ready(r);
    const pending = outcome(r.session.setPermissionMode('wait'));
    await settle();
    r.transport.exit({ code: 2, signal: null });
    expect((await pending).error).toBeInstanceOf(SessionClosedError);
  });
});

describe('the end of a session', () => {
  it('close drains: input ends gracefully after the last turn, the sweep is reported, then session.terminated', async () => {
    const r = rig({
      transportOptions: { afterExit: { status: 'skipped', reason: 'no-descendants' } },
    });
    await ready(r);
    const events = collector(r.session.events());
    const turn = r.session.send('x');
    const closed = state(r.session.close());
    expect(r.session.close()).toBe(r.session.closed);
    await settle();
    expect(r.transport.inputEnd).toBeNull();
    expect((await outcome(r.session.ask('late'))).error).toBeInstanceOf(SessionClosedError);
    expect((await outcome(r.session.setPermissionMode('plan'))).error).toBeInstanceOf(
      SessionClosedError,
    );
    r.say({ t: 'result', id: turn.id });
    await settle();
    expect(r.transport.inputEnd).toBe('graceful');
    expect(closed.current()).toBe('pending');
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
    expect(await r.driver.ended).toEqual({ outcome: 'closed' });
    const seen = (await events.result()).events;
    expect(types(seen).slice(-2)).toEqual(['diagnostic', 'session.terminated']);
    expect(seen.at(-2)).toMatchObject({
      code: 'termination.sweep-after-exit',
      data: { status: 'skipped', reason: 'no-descendants' },
    });
    expect(r.transport.terminations).toEqual([]);
    // After the end: calls are refused, events() replays nothing live.
    expect(() => r.session.send('x')).not.toThrow();
    expect((await outcome(r.session.ask('x'))).error).toBeInstanceOf(SessionClosedError);
    expect((await outcome(r.driver.interrupt(undefined, false))).error).toBeInstanceOf(
      SessionClosedError,
    );
    expect(types(await collect(r.session.events()))).toEqual(['session.started']);
    expect(r.driver.pending).toMatchObject({
      turns: 0,
      controls: 0,
      timers: 0,
      permissions: 0,
      subscribers: 0,
    });
  });

  it('the close deadline runs the abort ladder with intent close-timeout (K13)', async () => {
    const r = rig();
    await ready(r);
    const turn = r.session.send('forever');
    void r.session.close();
    await settle();
    r.clock.advance(TEST_CONFIG.closeMs);
    await settle();
    expect(r.transport.terminations).toEqual(['close-timeout']);
    expect(r.ops().at(-1)).toEqual({ op: 'interrupt' });
    expect(r.transport.inputEnd).toBeNull();
    r.clock.advance(TEST_CONFIG.interruptWaitMs);
    await r.session.closed;
    expect(r.transport.inputEnd).toBe('immediate');
    expect(await turn.done).toMatchObject({ outcome: 'cancelled', synthesized: true });
    expect(await r.driver.ended).toEqual({ outcome: 'aborted' });
  });

  it('close with an aborted signal turns into an abort and rejects with AbortError', async () => {
    const r = rig();
    await ready(r);
    const controller = new AbortController();
    const closing = outcome(r.session.close({ signal: controller.signal }));
    await settle();
    controller.abort();
    expect((await closing).error).toBeInstanceOf(AbortError);
    await r.session.closed;
    // The drain had already ended input; the ladder needed no interrupt.
    expect(r.transport.inputEnd).toBe('graceful');
    expect(r.transport.terminations).toEqual(['abort']);

    const other = rig();
    await ready(other);
    const pre = new AbortController();
    pre.abort();
    expect((await outcome(other.session.close({ signal: pre.signal }))).error).toBeInstanceOf(
      AbortError,
    );
    await settle();
    other.clock.advance(TEST_CONFIG.interruptWaitMs);
    await other.session.closed;
    expect(other.transport.terminations).toEqual(['abort']);
  });

  it('dispose runs the ladder; the interrupt step ends with the machine ending input', async () => {
    const r = rig();
    await ready(r);
    const turn = r.session.send('x');
    const disposed = r.session[Symbol.asyncDispose]();
    expect(r.driver.abort('abort')).toBe(r.session.closed);
    await settle();
    expect(r.transport.terminations).toEqual(['dispose']);
    expect(r.transport.inputEnd).toBeNull();
    r.say({ t: 'interrupted' });
    await disposed;
    expect(await turn.done).toMatchObject({ outcome: 'cancelled' });
    expect(await r.driver.ended).toEqual({ outcome: 'aborted' });
  });

  it('an unrequested exit fails open turns with PROCESS_EXITED and the stderr tail; later calls get that error', async () => {
    const r = rig({ transportOptions: { stderrTail: 'tail' } });
    await ready(r);
    const turn = r.session.send('x');
    await settle();
    r.transport.exit({ code: 2, signal: null });
    const failed = (await outcome(turn.done)).error;
    expect(failed).toBeInstanceOf(ProcessExitedError);
    expect((failed as ProcessExitedError).details).toMatchObject({
      stderrTail: 'tail',
      outcome: 'crashed',
    });
    await r.session.closed;
    expect((await outcome(r.session.ask('x'))).error).toBeInstanceOf(ProcessExitedError);
    expect((await outcome(r.session.setPermissionMode('plan'))).error).toBeInstanceOf(
      ProcessExitedError,
    );
  });

  it('waits at most outputDrainMs for stdout after the exit', async () => {
    const r = rig({ outputDrainMs: 500 });
    await ready(r);
    r.transport.exit({ code: 0, signal: null }, { keepOutputOpen: true });
    await settle();
    expect(r.machine.stats.inputs).not.toContain('process.exit');
    r.say({ t: 'say', text: 'late' });
    await settle();
    r.clock.advance(500);
    await r.session.closed;
    expect(r.machine.stats.inputs.slice(-2)).toEqual(['line', 'process.exit']);
  });

  it('reports the ladder as a diagnostic and feeds ladder.done', async () => {
    const report = {
      intent: 'abort',
      platform: 'posix',
      steps: [{ name: 'intent', atMs: 0, outcome: 'done' }],
      exitedAfter: 'intent',
      signalTarget: null,
      launcherDetected: false,
      sweep: null,
    } as const;
    const r = rig({
      transportOptions: {
        terminate: async (request, transport) => {
          expect(await request.interrupt()).toBe('not-applicable');
          transport.exit({ code: null, signal: 'SIGKILL' });
          return report;
        },
      },
    });
    const events = collector(r.session.events());
    void r.driver.start();
    await settle();
    await r.driver.abort('abort');
    expect(r.machine.stats.inputs).toContain('ladder.done');
    const seen = (await events.result()).events;
    expect(seen.find((event) => event.type === 'diagnostic')).toMatchObject({
      code: 'termination.ladder',
      data: report,
    });
  });

  it('a ladder that rejects is reported and the session still ends', async () => {
    const r = rig({
      transportOptions: {
        terminate: (_request, transport) => {
          transport.exit({ code: null, signal: 'SIGKILL' });
          return Promise.reject(new TypeError('ladder bug'));
        },
      },
    });
    const events = collector(r.session.events());
    void r.driver.start();
    await settle();
    await r.driver.abort('dispose');
    expect(
      (await events.result()).events.find((event) => event.type === 'diagnostic'),
    ).toMatchObject({
      code: 'termination.ladder',
      data: { error: 'TypeError' },
    });
  });
});

describe('a broken machine is contained', () => {
  it('a throwing step ends the session failed with PROTOCOL_ERROR after the ladder', async () => {
    const r = rig();
    await ready(r);
    const events = collector(r.session.events());
    const turn = r.session.send('x');
    await settle();
    r.say({ t: 'throw' });
    expect((await outcome(turn.done)).error).toBeInstanceOf(ProtocolError);
    await r.session.closed;
    expect(r.transport.terminations).toEqual(['abort']);
    expect(await r.driver.ended).toMatchObject({
      outcome: 'failed',
      error: { code: 'PROTOCOL_ERROR' },
    });
    const seen = (await events.result()).events;
    expect(seen.find((event) => event.type === 'diagnostic')).toMatchObject({
      code: 'binding.machine-error',
      data: { error: 'Error' },
    });
    expect(seen.at(-1)).toMatchObject({
      type: 'session.terminated',
      outcome: 'failed',
      signal: 'SIGKILL',
    });
    expect((await outcome(r.session.ask('y'))).error).toBeInstanceOf(ProtocolError);
  });

  it('a machine that throws during the handshake rejects start', async () => {
    const r = rig();
    const started = outcome(r.driver.start());
    await settle();
    r.say({ t: 'throw' });
    expect((await started).error).toBeInstanceOf(ProtocolError);
  });

  it('a machine that does not end after the exit is ended by the binding', async () => {
    const stubborn: HarnessMachine<TestState, TestConfig> = {
      initialState: (config) => testMachine.initialState(config),
      step: (state, input) =>
        input.type === 'process.exit' ? { state, effects: [] } : testMachine.step(state, input),
    };
    const r = rig({ machineImpl: stubborn });
    await ready(r);
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
    expect(await r.driver.ended).toMatchObject({
      outcome: 'failed',
      error: { code: 'PROTOCOL_ERROR' },
    });
    expect(r.transport.terminations).toEqual([]);
  });

  it('inputs after the machine ended are not fed; a queued send fails with the end error', async () => {
    const r = rig();
    await ready(r);
    r.say({ t: 'end-now' });
    await settle();
    r.driver.command({ type: 'cmd.close' });
    await r.session.closed;
    const steps = r.machine.stats.steps;
    r.driver.command({ type: 'cmd.close' });
    await settle();
    expect(r.machine.stats.steps).toBe(steps);
  });
});

describe('transport failures', () => {
  it('a failed write is fed once as stdin.error; the ladder then needs no interrupt', async () => {
    const r = rig();
    await ready(r);
    r.transport.failWritesWith = 'EPIPE';
    const a = r.session.send('a');
    const b = r.session.send('b');
    await settle();
    expect(r.machine.stats.inputs.filter((type) => type === 'stdin.error')).toHaveLength(1);
    await r.session[Symbol.asyncDispose]();
    await Promise.allSettled([a.done, b.done]);
    expect(r.transport.terminations).toEqual(['dispose']);
  });

  it('a write error without a code is fed as EIO', async () => {
    class NoCode extends LoopbackTransport {
      override write(): Promise<void> {
        return Promise.reject(new Error('no code'));
      }
    }
    const r = rig({ transport: new NoCode() });
    const events = collector(r.session.events());
    void r.driver.start();
    await settle();
    expect(r.machine.stats.inputs).toContain('stdin.error');
    await r.driver.abort('abort');
    expect(
      (await events.result()).events.find((event) => event.type === 'diagnostic'),
    ).toMatchObject({
      code: 'stdin.error',
      data: { code: 'EIO' },
    });
  });

  it('a failing stdout is reported and ends the output', async () => {
    const r = rig();
    await ready(r);
    const events = collector(r.session.events());
    r.transport.endOutput(new TypeError('pipe'));
    await settle();
    expect(r.machine.stats.inputs).toContain('stdout.end');
    r.transport.exit({ code: 0, signal: null });
    const seen = (await events.result()).events;
    expect(seen.find((event) => event.type === 'diagnostic')).toMatchObject({
      code: 'stdout.error',
      data: { error: 'TypeError' },
    });
  });
});

describe('events', () => {
  it('counts the line bytes for events that carry the frame, 256 for the others', async () => {
    const r = rig();
    await ready(r);
    const small = collector(r.session.events({ maxBytes: SYNTHESIZED_EVENT_BYTES }));
    const turn = r.session.send('x');
    await settle();
    r.transport.line(JSON.stringify({ t: 'say', id: turn.id, text: 'x' }), 1000);
    await settle();
    r.transport.exit({ code: 0, signal: null });
    const result = await small.result();
    expect(types(result.events)).toEqual(['session.started', 'turn.queued']);
    expect(result.error).toMatchObject({ code: 'SUBSCRIBER_OVERFLOW' });
  });

  it('numbers gap markers as the first dropped event', async () => {
    const r = rig({
      compat: COMPAT,
      events: { maxEvents: 2, overflow: 'drop-oldest-with-gap-marker' },
    });
    await ready(r);
    const iterator = r.session.events()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'compat', seq: 0 });
    expect((await iterator.next()).value).toMatchObject({ type: 'session.started', seq: 1 });
    // session.started was seq 1; the burst is seq 2..6, of which 2..4 are dropped.
    r.say({ t: 'burst', n: 5 });
    await settle();
    const first = await nextEvent(iterator);
    expect(first).toMatchObject({ type: 'gap', dropped: 3, seq: 2 });
    expect((await iterator.next()).value).toMatchObject({ type: 'message.delta', seq: 5 });
    await iterator.return?.();
    expect((await iterator.next()).done).toBe(true);
    await expect(iterator.throw?.(new Error('x'))).rejects.toThrow('x');
  });

  it('refuses invalid subscriber options with INVALID_OPTIONS', async () => {
    const r = rig();
    await ready(r);
    expect(() => r.session.events({ maxEvents: 0 })).toThrow(InvalidOptionsError);
    expect(() => r.session.send('x', { events: { overflow: 'nope' as never } })).toThrow(
      InvalidOptionsError,
    );
  });

  it('an aborted events signal ends that subscription with AbortError', async () => {
    const r = rig();
    await ready(r);
    const controller = new AbortController();
    const sub = collector(r.session.events({ signal: controller.signal }));
    controller.abort();
    expect((await sub.result()).error).toBeInstanceOf(AbortError);
    const pre = new AbortController();
    pre.abort();
    expect(
      (await collector(r.session.events({ signal: pre.signal })).result()).error,
    ).toBeInstanceOf(AbortError);
  });
});
