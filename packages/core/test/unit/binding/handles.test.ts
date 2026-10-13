// The public handles (plan §2.2): input checks, AbortSignal semantics over
// a fake driver core, and the harness base that disposes its sessions.

import { describe, expect, it } from 'vitest';

import {
  AbortError,
  HarnessDisposedError,
  InvalidOptionsError,
} from '../../../src/binding/errors.js';
import {
  createSession,
  HarnessBase,
  normalizeUserInput,
  type Session,
  type SessionCore,
  type TurnCore,
} from '../../../src/binding/handles.js';
import type { TurnResult } from '../../../src/protocol/events/types.js';
import { outcome, settle, state } from './driver-support.js';

describe('normalizeUserInput', () => {
  it('accepts text and neutral blocks and returns a copy', () => {
    expect(normalizeUserInput('hi')).toBe('hi');
    const input = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', mediaType: 'image/png', dataBase64: 'AA==' },
      ],
    } as const;
    const copy = normalizeUserInput(input);
    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
  });

  it.each([
    [42, 'user-input'],
    [null, 'user-input'],
    [[], 'user-input'],
    [{}, 'user-input'],
    [{ content: 'x' }, 'user-input'],
    [{ content: [], extra: 1 }, 'user-input'],
    [{ content: [1] }, 'content-block'],
    [{ content: [[]] }, 'content-block'],
    [{ content: [{ type: 'text' }] }, 'content-block'],
    [{ content: [{ type: 'text', text: 'a', more: 1 }] }, 'content-block'],
    [{ content: [{ type: 'image', mediaType: 'image/bmp', dataBase64: 'x' }] }, 'content-block'],
    [{ content: [{ type: 'image', mediaType: 'image/png' }] }, 'content-block'],
    [{ content: [{ type: 'image', mediaType: 1, dataBase64: 'x' }] }, 'content-block'],
    [{ content: [{ type: 'audio' }] }, 'content-block'],
  ])('refuses %j (%s)', (input, rule) => {
    let caught: unknown;
    try {
      normalizeUserInput(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidOptionsError);
    expect((caught as InvalidOptionsError).details).toEqual({ path: 'input', rule });
  });
});

const RESULT: TurnResult = {
  turnId: 't1',
  sessionId: 's',
  outcome: 'completed',
  isError: false,
  permissionDenials: [],
  synthesized: false,
};

/** A fake core: records calls; promises are controlled by the test. */
function fakeCore(): SessionCore & {
  readonly calls: string[];
  resolveDone: (result: TurnResult) => void;
  rejectDone: (error: Error) => void;
} {
  const calls: string[] = [];
  const done = Promise.withResolvers<TurnResult>();
  const closed = Promise.withResolvers<undefined>();
  const core = {
    calls,
    resolveDone: done.resolve,
    rejectDone: done.reject,
    id: 's',
    info: {
      id: 's',
      mode: 'create',
      pid: 1,
      version: '1',
      features: [],
      containment: 'best-effort',
    } as const,
    closed: closed.promise.then(() => undefined),
    sendTurn: (_input: unknown, options: { readonly iterate: boolean }): TurnCore => {
      calls.push(`send:${String(options.iterate)}`);
      return { id: 't1', done: done.promise, events: undefined };
    },
    interrupt: (turnId: string | undefined, cancelQueued: boolean) => {
      calls.push(`interrupt:${String(turnId)}:${String(cancelQueued)}`);
      return Promise.reject(new Error('moot'));
    },
    setPermissionMode: (mode: string) => {
      calls.push(`mode:${mode}`);
      return new Promise<void>(() => undefined);
    },
    subscribe: () => {
      calls.push('subscribe');
      return (async function* () {
        // empty
      })() as AsyncIterableIterator<never, undefined, undefined>;
    },
    close: () => {
      calls.push('close');
      return new Promise<void>(() => undefined);
    },
    abort: (intent: 'abort' | 'dispose') => {
      calls.push(`abort:${intent}`);
      closed.resolve(undefined);
      return Promise.resolve();
    },
  };
  return core;
}

describe('Session over a core', () => {
  it('exposes the core facts and forwards events()', () => {
    const core = fakeCore();
    const session = createSession(core);
    expect(session.id).toBe('s');
    expect(session.info.pid).toBe(1);
    expect(session.closed).toBe(core.closed);
    session.events();
    expect(core.calls).toEqual(['subscribe']);
  });

  it('ask settles with done when no signal is given; send without a signal adds no listener', async () => {
    const core = fakeCore();
    const session = createSession(core);
    const asked = session.ask('x');
    const turn = session.send('y');
    core.resolveDone(RESULT);
    expect(await asked).toBe(RESULT);
    expect(await turn.done).toBe(RESULT);
    expect(() => turn[Symbol.asyncIterator]()).toThrow(/no event iterator/u);
    await expect(turn.interrupt()).rejects.toThrow('moot');
    expect(core.calls).toContain('interrupt:t1:false');
  });

  it('ask forwards a rejected done and removes its signal listener when settled', async () => {
    const core = fakeCore();
    const session = createSession(core);
    const controller = new AbortController();
    const asked = outcome(session.ask('x', { signal: controller.signal }));
    core.rejectDone(new Error('session failed'));
    expect((await asked).error).toEqual(new Error('session failed'));
    controller.abort();
    await settle();
    expect(core.calls.filter((call) => call.startsWith('interrupt'))).toEqual([]);
  });

  it('ask resolves through the signal wrapper and removes the listener', async () => {
    const core = fakeCore();
    const session = createSession(core);
    const controller = new AbortController();
    const asked = session.ask('x', { signal: controller.signal });
    core.resolveDone(RESULT);
    expect(await asked).toBe(RESULT);
    controller.abort();
    await settle();
    expect(core.calls.filter((call) => call.startsWith('interrupt'))).toEqual([]);
  });

  it('send with a signal removes its listener once done settles either way', async () => {
    for (const settleWith of ['resolve', 'reject'] as const) {
      const core = fakeCore();
      const session = createSession(core);
      const controller = new AbortController();
      const turn = session.send('x', { signal: controller.signal });
      if (settleWith === 'resolve') core.resolveDone(RESULT);
      else core.rejectDone(new Error('x'));
      await outcome(turn.done);
      controller.abort();
      await settle();
      expect(core.calls.filter((call) => call.startsWith('interrupt'))).toEqual([]);
    }
  });

  it('setPermissionMode and close honour their signals', async () => {
    const core = fakeCore();
    const session = createSession(core);
    const controller = new AbortController();
    const mode = state(session.setPermissionMode('plan', { signal: controller.signal }));
    const closing = outcome(session.close({ signal: controller.signal }));
    expect(state(session.setPermissionMode('x')).current()).toBe('pending');
    controller.abort();
    expect((await closing).error).toBeInstanceOf(AbortError);
    await settle();
    expect(mode.current()).toBe('rejected');
    expect(core.calls).toContain('abort:abort');
  });

  it('a failed interrupt after an abort is swallowed (ask and send)', async () => {
    const core = fakeCore();
    const session = createSession(core);
    const askSignal = new AbortController();
    const asked = outcome(session.ask('x', { signal: askSignal.signal }));
    askSignal.abort();
    expect((await asked).error).toBeInstanceOf(AbortError);
    const sendSignal = new AbortController();
    session.send('y', { signal: sendSignal.signal });
    sendSignal.abort();
    await settle();
    expect(core.calls.filter((call) => call.startsWith('interrupt'))).toHaveLength(2);
  });

  it('dispose aborts with intent dispose', async () => {
    const core = fakeCore();
    await createSession(core)[Symbol.asyncDispose]();
    expect(core.calls).toEqual(['abort:dispose']);
  });
});

function fakeSession(): Session & { disposed: number; finish: () => void } {
  const closed = Promise.withResolvers<undefined>();
  const session = {
    disposed: 0,
    finish: () => {
      closed.resolve(undefined);
    },
    closed: closed.promise.then(() => undefined),
    [Symbol.asyncDispose]: () => {
      session.disposed += 1;
      return Promise.reject(new Error('dispose failed'));
    },
  };
  return session as unknown as Session & { disposed: number; finish: () => void };
}

const FACTS = {
  capabilities: {
    multiTurn: 'supported',
    resume: 'supported',
    fork: 'supported',
    interrupt: 'supported',
    permissionsInBand: 'supported',
    workspaceTrust: { none: 'supported', context: 'unsupported', full: 'supported' },
    processContainment: 'best-effort',
    reasons: {},
  },
  binary: {
    path: '/bin/h',
    version: '1',
    source: 'option',
    verification: { status: 'verified', method: 'sha256-manifest', mode: 'advisory' },
  },
  compat: {
    harness: 'h',
    version: '1',
    minTested: '1',
    maxTested: '1',
    knownBroken: [],
    status: 'tested',
  },
  securityPosture: { entries: [] },
} as const;

describe('HarnessBase', () => {
  it('tracks live sessions, disposes them once, then refuses and disposes late ones', async () => {
    const harness = new HarnessBase(FACTS);
    expect(harness.binary.path).toBe('/bin/h');
    expect(harness.capabilities.processContainment).toBe('best-effort');
    expect(harness.compat.status).toBe('tested');
    expect(harness.securityPosture.entries).toEqual([]);
    const ended = fakeSession();
    const live = fakeSession();
    harness.track(ended);
    harness.track(live);
    ended.finish();
    await settle();
    expect(harness.sessionCount).toBe(1);
    harness.assertOpen();
    const disposed = harness[Symbol.asyncDispose]();
    expect(harness[Symbol.asyncDispose]()).toBe(disposed);
    await disposed;
    expect(live.disposed).toBe(1);
    expect(harness.disposed).toBe(true);
    expect(() => {
      harness.assertOpen();
    }).toThrow(HarnessDisposedError);
    const late = fakeSession();
    harness.track(late);
    await settle();
    expect(late.disposed).toBe(1);
  });
});
