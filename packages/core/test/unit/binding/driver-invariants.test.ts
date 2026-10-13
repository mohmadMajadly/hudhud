// The binding invariants of plan §1.6 and §5.6 (W4-T1 acceptance and
// security), each proven against the test machine and the in-memory
// transport: stdout is read continuously regardless of subscribers; ask()
// and turn.done never wait on a subscriber; only 'block' pauses input
// processing (and ask() on another session still resolves); handler
// exceptions never escape; one input at a time; cancellation is always
// possible; bounded memory; no signal handlers.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { SessionClosedError } from '../../../src/binding/errors.js';
import { HostExitHook } from '../../../src/binding/host-exit.js';
import { SessionDriver } from '../../../src/binding/driver.js';
import { LoopbackTransport } from '../../../src/binding/loopback.js';
import type { PermissionHandler } from '../../../src/binding/permission-bridge.js';
import type { PermissionErrorReason } from '../../../src/protocol/machine/contract.js';
import {
  collector,
  guardProcess,
  ready,
  rig,
  settle,
  state,
  text,
  iteratorOf,
  nextEvent,
} from './driver-support.js';
import { TEST_CONFIG, testMachine } from './test-machine.js';

guardProcess();

describe('stdout is read continuously regardless of subscribers (ADR-0007)', () => {
  it('takes every line with no subscriber and with a subscriber that never reads', async () => {
    const r = rig();
    await ready(r);
    const before = r.transport.pulls;
    for (let index = 0; index < 50; index += 1) r.say({ t: 'say', text: String(index) });
    await settle();
    expect(r.transport.pulls - before).toBe(50);
    expect(r.transport.buffered).toBe(0);

    const stuck = collector(r.session.events({ maxEvents: 3 }));
    // Never pulled: the collector above iterates, so build one that does not.
    const silent = r.session.events({ maxEvents: 3 })[Symbol.asyncIterator]();
    for (let index = 0; index < 50; index += 1) r.say({ t: 'say', text: String(index) });
    await settle();
    expect(r.transport.pulls - before).toBe(100);
    expect(r.transport.buffered).toBe(0);
    // The silent subscriber overflowed on its own ('error' is scoped to it):
    // it delivers what it kept, then rejects.
    const kept: unknown[] = [];
    const overflow = await (async () => {
      try {
        for (;;) kept.push((await silent.next()).value);
      } catch (error) {
        return error;
      }
    })();
    expect(kept).toHaveLength(3);
    expect(overflow).toMatchObject({ code: 'SUBSCRIBER_OVERFLOW' });
    r.transport.exit({ code: 0, signal: null });
    expect((await stuck.result()).error).toBeUndefined();
  });
});

describe('ask() and turn.done never wait on a subscriber', () => {
  it.each(['error', 'drop-oldest-with-gap-marker'] as const)(
    'resolves while a %s subscriber never reads',
    async (overflow) => {
      const r = rig();
      await ready(r);
      r.session.events({ maxEvents: 1, overflow });
      const asked = r.session.ask('x');
      await settle();
      const id = text(r.ops().at(-1)?.['id']);
      r.say({ t: 'burst', id, n: 20 });
      r.say({ t: 'result', id });
      expect(await asked).toMatchObject({ turnId: id });
    },
  );

  it('settles a turn even when its own events stall a block subscriber in the same step', async () => {
    const r = rig();
    await ready(r);
    const iterator = r.session.events({ maxEvents: 1, overflow: 'block' })[Symbol.asyncIterator]();
    const turn = r.session.send('x');
    await settle();
    // turn.queued filled the block queue; the result's step settles the turn
    // before its turn.completed event waits for the subscriber.
    r.say({ t: 'result', id: turn.id });
    await settle();
    expect(state(turn.done).current()).toBe('pending');
    expect((await iterator.next()).value).toMatchObject({ type: 'turn.queued' });
    expect(await turn.done).toMatchObject({ turnId: turn.id });
    await iterator.return?.();
  });
});

describe("only 'block' pauses input processing", () => {
  it("holds the next input while a 'block' subscriber is full and resumes when it reads", async () => {
    const r = rig();
    await ready(r);
    const iterator = r.session.events({ maxEvents: 1, overflow: 'block' })[Symbol.asyncIterator]();
    const turn = r.session.send('x');
    await settle();
    r.say({ t: 'say', id: turn.id, text: 'blocks' });
    r.say({ t: 'result', id: turn.id });
    r.say({ t: 'say', text: 'later' });
    await settle();
    const done = state(turn.done);
    // Bounded memory: the reader holds at most the line being processed.
    expect(r.transport.buffered).toBe(2);
    expect(done.current()).toBe('pending');
    const seen: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      seen.push(String((await nextEvent(iterator))?.type));
    }
    expect(seen).toEqual([
      'turn.queued',
      'message.assistant',
      'turn.completed',
      'message.assistant',
    ]);
    await settle();
    expect(done.current()).toBe('fulfilled');
    expect(r.transport.buffered).toBe(0);
    await iterator.return?.();
  });

  it("ask() resolves while a 'block' subscriber on another session is stalled", async () => {
    const stalled = rig();
    const other = rig();
    await ready(stalled);
    await ready(other);
    const blocked = iteratorOf(stalled.session.events({ maxEvents: 1, overflow: 'block' }));
    stalled.say({ t: 'burst', n: 5 });
    await settle();
    expect(stalled.transport.buffered).toBe(0);
    stalled.say({ t: 'say', text: 'held' });
    await settle();
    expect(stalled.transport.buffered).toBe(1);

    const asked = other.session.ask('x');
    await settle();
    other.say({ t: 'result', id: text(other.ops().at(-1)?.['id']) });
    expect(await asked).toMatchObject({ isError: false });
    // The stalled session is still stalled, then dispose cuts through.
    expect(stalled.transport.buffered).toBe(1);
    const disposed = stalled.session[Symbol.asyncDispose]();
    await expect(blocked.next()).rejects.toBeInstanceOf(SessionClosedError);
    await settle();
    stalled.clock.advance(TEST_CONFIG.interruptWaitMs);
    await disposed;
    expect(await stalled.driver.ended).toEqual({ outcome: 'aborted' });
  });

  it("dispose cuts a stalled 'block' subscriber: its iterator rejects with SESSION_CLOSED", async () => {
    const r = rig();
    await ready(r);
    const blocked = r.session.events({ maxEvents: 1, overflow: 'block' })[Symbol.asyncIterator]();
    r.say({ t: 'burst', n: 3 });
    r.say({ t: 'say', text: 'held' });
    await settle();
    const disposed = r.session[Symbol.asyncDispose]();
    await settle();
    await expect(blocked.next()).rejects.toBeInstanceOf(SessionClosedError);
    r.clock.advance(TEST_CONFIG.interruptWaitMs);
    await disposed;
    // A 'block' subscriber that stalls the very end is cut too.
    const late = rig();
    await ready(late);
    const lateBlocked = iteratorOf(late.session.events({ maxEvents: 1, overflow: 'block' }));
    const lateDisposed = late.session[Symbol.asyncDispose]();
    await settle();
    late.clock.advance(TEST_CONFIG.interruptWaitMs);
    await lateDisposed;
    await expect(lateBlocked.next()).rejects.toBeInstanceOf(SessionClosedError);
  });
});

describe('handler exceptions never escape into the driver', () => {
  const cases: [string, PermissionHandler, PermissionErrorReason][] = [
    [
      'a synchronous throw',
      () => {
        throw new TypeError('sync');
      },
      'handler-failed',
    ],
    ['a rejection', () => Promise.reject(new RangeError('async')), 'handler-failed'],
    [
      'an invalid decision',
      () => Promise.resolve({ behavior: 'maybe' } as never),
      'invalid-decision',
    ],
  ];
  it.each(cases)(
    '%s fails closed through the machine (cmd.permission-error), never an allow',
    async (_name, handler, reason) => {
      const r = rig({ onPermission: handler });
      await ready(r);
      const events = collector(r.session.events());
      r.say({ t: 'ask', rid: 'r1' });
      await settle();
      expect(r.ops().at(-1)).toEqual({ op: 'refuse', rid: 'r1', reason });
      r.transport.exit({ code: 0, signal: null });
      const seen = (await events.result()).events;
      expect(seen.find((event) => event.type === 'diagnostic')).toMatchObject({
        code: expect.stringMatching(/^permission\./u) as unknown,
      });
      expect(r.machine.stats.maxDepth).toBe(1);
    },
  );

  it('an allow is passed as a copy; the handler runs outside the step with its own signal', async () => {
    const decision = { behavior: 'allow' as const, updatedInput: { a: 1 } };
    let depthDuringHandler = -1;
    const signals: AbortSignal[] = [];
    const r = rig({
      onPermission: (request, { signal }) => {
        depthDuringHandler = r.machine.stats.depth;
        signals.push(signal);
        expect(request.requestId).toMatch(/^r/u);
        return Promise.resolve(decision);
      },
    });
    await ready(r);
    r.say({ t: 'ask', rid: 'r1' });
    r.say({ t: 'ask', rid: 'r2' });
    await settle();
    expect(depthDuringHandler).toBe(0);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(r.ops().slice(-2)).toEqual([
      { op: 'answer', rid: 'r1', decision },
      { op: 'answer', rid: 'r2', decision },
    ]);
  });

  it('a withdrawn request aborts the handler signal and drops the late answer', async () => {
    let release: (() => void) | undefined;
    let aborted = false;
    const r = rig({
      onPermission: (_request, { signal }) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise((resolve) => {
          release = () => {
            resolve({ behavior: 'allow' });
          };
        });
      },
    });
    await ready(r);
    r.say({ t: 'ask', rid: 'r1' });
    await settle();
    r.say({ t: 'withdraw', rid: 'r1' });
    await settle();
    expect(aborted).toBe(true);
    release?.();
    await settle();
    expect(r.ops().filter((op) => op['op'] === 'answer')).toEqual([]);
  });

  it('close and the end of the session abort pending asks; no handler fails closed', async () => {
    const signals: AbortSignal[] = [];
    const r = rig({
      onPermission: (_request, { signal }) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    });
    await ready(r);
    r.say({ t: 'ask', rid: 'r1' });
    await settle();
    void r.session.close();
    await settle();
    expect(signals[0]?.aborted).toBe(true);
    r.say({ t: 'ask', rid: 'r2' });
    await settle();
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
    expect(signals[1]?.aborted).toBe(true);
    expect(r.driver.pending.permissions).toBe(0);

    const none = rig();
    await ready(none);
    none.say({ t: 'ask', rid: 'r1' });
    await settle();
    expect(none.ops().at(-1)).toEqual({ op: 'refuse', rid: 'r1', reason: 'no-handler' });
  });
});

describe('one input at a time, no re-entrancy', () => {
  it('commands issued from handlers, subscribers and settlement callbacks are queued', async () => {
    const r = rig({
      onPermission: () => {
        // Synchronous calls into the session from inside a handler.
        r.session.send('from-handler');
        void r.session.setPermissionMode('plan');
        return Promise.resolve({ behavior: 'allow' });
      },
    });
    await ready(r);
    const events = r.session.events();
    const subscriber = (async () => {
      for await (const event of events) {
        if (event.type === 'permission.requested') r.session.send('from-subscriber');
        if (event.type === 'session.terminated') break;
      }
    })();
    const turn = r.session.send('first');
    void turn.done.then(() => {
      r.session.send('from-done');
    });
    await settle();
    r.say({ t: 'ask', rid: 'r1' });
    await settle();
    r.say({ t: 'result', id: turn.id });
    await settle();
    expect(
      r
        .ops()
        .filter((op) => op['op'] === 'user')
        .map((op) => text(op['content']))
        .sort(),
    ).toEqual(['first', 'from-done', 'from-handler', 'from-subscriber']);
    expect(r.machine.stats.maxDepth).toBe(1);
    r.transport.exit({ code: 0, signal: null });
    await subscriber;
  });
});

describe('cancellation is always possible', () => {
  it('dispose during the handshake, before start, and twice', async () => {
    const r = rig();
    void r.driver.start();
    await settle();
    await r.session[Symbol.asyncDispose]();
    expect(r.transport.terminations).toEqual(['dispose']);

    const unstarted = rig();
    await unstarted.driver.abort('abort');
    expect(unstarted.transport.terminations).toEqual(['abort']);
    await unstarted.session[Symbol.asyncDispose]();
  });

  it('interrupt and close before start begin the session', async () => {
    const r = rig();
    const interrupted = r.driver.interrupt(undefined, false);
    void r.session.close();
    await settle();
    r.say({ t: 'ready' });
    await settle();
    expect(r.transport.inputEnd).toBe('graceful');
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
    await interrupted;
  });
});

describe('bounded memory', () => {
  it('holds nothing after many turns', async () => {
    const r = rig();
    await ready(r);
    // A subscriber that never reads holds at most 5 events.
    const sub = iteratorOf(
      r.session.events({ maxEvents: 5, overflow: 'drop-oldest-with-gap-marker' }),
    );
    for (let index = 0; index < 200; index += 1) {
      const turn = r.session.send(String(index));
      r.say({ t: 'say', id: turn.id, text: 'x' });
      r.say({ t: 'result', id: turn.id });
      await turn.done;
    }
    await settle();
    expect(r.driver.pending).toMatchObject({
      queue: 0,
      outbox: 0,
      turns: 0,
      controls: 0,
      permissions: 0,
      timers: 0,
    });
    // One session subscriber is left; the turn subscriptions are gone.
    expect(r.driver.pending.subscribers).toBe(1);
    expect((await sub.next()).value).toMatchObject({ type: 'gap', dropped: 595 });
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
  });
});

describe('no signal handlers (K22); one exit hook', () => {
  it('installs exactly one exit listener for all sessions, ends their input on exit, removes it after', async () => {
    const listeners: (() => void)[] = [];
    const emitter = {
      once: (_event: 'exit', listener: () => void) => listeners.push(listener),
      removeListener: (_event: 'exit', listener: () => void) => {
        listeners.splice(listeners.indexOf(listener), 1);
      },
    };
    const hook = new HostExitHook(emitter);
    const a = rig({ hostExit: hook });
    const b = rig({ hostExit: hook });
    await ready(a);
    await ready(b);
    expect(listeners).toHaveLength(1);
    a.transport.exit({ code: 0, signal: null });
    await a.session.closed;
    expect(listeners).toHaveLength(1);
    listeners[0]?.();
    expect(b.transport.inputEnd).toBe('immediate');
    b.transport.exit({ code: 0, signal: null });
    await b.session.closed;
  });

  it('a session on the real host hook adds no signal listener and leaves no exit listener', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'SIGQUIT'] as const;
    const before = signals.map((name) => process.listenerCount(name));
    const exits = process.listenerCount('exit');
    const transport = new LoopbackTransport();
    const driver = new SessionDriver({
      machine: testMachine,
      config: TEST_CONFIG,
      transport,
      sessionId: TEST_CONFIG.sessionId,
    });
    void driver.start();
    await settle();
    expect(process.listenerCount('exit')).toBe(exits + 1);
    transport.exit({ code: 0, signal: null });
    await driver.closed;
    expect(signals.map((name) => process.listenerCount(name))).toEqual(before);
    expect(process.listenerCount('exit')).toBe(exits);
  });

  it('no binding source installs a process listener other than the exit hook', () => {
    const dir = path.join(import.meta.dirname, '../../../src/binding');
    for (const file of readdirSync(dir)) {
      // Code only: the doc comments name the one hook.
      const text = readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((codeLine) => !/^\s*(\*|\/\/|\/\*)/u.test(codeLine))
        .join('\n');
      expect(text, file).not.toMatch(/process\.(on|once|addListener|prependListener)\(/u);
      expect(text, file).not.toMatch(/['"]SIG(INT|TERM|HUP|BREAK|QUIT)['"]\s*,\s*\(/u);
    }
  });
});
