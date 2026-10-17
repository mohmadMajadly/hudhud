// Subscriptions of the session driver (ADR-0007): the byte accounting of
// events derived from one line, the session-wide `events.signal`, abort
// listeners released when a subscription stops, gap numbering on filtered
// subscriptions, and `'block'` holding a drain.

import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import { SYNTHESIZED_EVENT_BYTES } from '../../../src/binding/driver.js';
import { AbortError, SubscriberOverflowError } from '../../../src/binding/errors.js';
import type { HudhudEvent } from '../../../src/protocol/events/types.js';
import type { JsonObject } from '../../../src/protocol/json.js';
import {
  collector,
  guardProcess,
  iteratorOf,
  nextEvent,
  outcome,
  ready,
  rig,
  settle,
  state,
  types,
} from './driver-support.js';
import { line } from './test-machine.js';

guardProcess();

/** The byte length the loopback transport reports for one toy line. */
function lineBytes(frame: JsonObject): number {
  return new TextEncoder().encode(line(frame)).byteLength;
}

describe('byte accounting (R4-3)', () => {
  it('charges a line once per subscriber, however many events it yields', async () => {
    const r = rig();
    await ready(r);
    const frame = { t: 'burst', n: 4, pad: 'x'.repeat(4000) };
    const bytes = lineBytes(frame);
    // Room for the line once plus its three siblings, not for the line four times.
    const maxBytes = bytes + 3 * SYNTHESIZED_EVENT_BYTES;
    const iterator = iteratorOf(r.session.events({ maxBytes }));
    // The replay (the pre-handshake `session.started`) is read first.
    expect((await nextEvent(iterator))?.type).toBe('session.started');
    r.say(frame);
    await settle();
    const deltas: HudhudEvent[] = [];
    for (let index = 0; index < 4; index += 1) {
      const event = await nextEvent(iterator);
      if (event !== undefined) deltas.push(event);
    }
    expect(types(deltas)).toEqual(Array(4).fill('message.delta'));
    await iterator.return?.();
    const disposed = r.session[Symbol.asyncDispose]();
    await settle();
    r.say({ t: 'interrupted' });
    await disposed;
  });

  it('one line overflows a subscriber only when the line alone does not fit', async () => {
    const r = rig();
    await ready(r);
    const frame = { t: 'burst', n: 3, pad: 'y'.repeat(2000) };
    const bytes = lineBytes(frame);
    const fits = collector(
      r.session.events({ maxBytes: bytes + 2 * SYNTHESIZED_EVENT_BYTES + 512 }),
    );
    const tight = collector(r.session.events({ maxBytes: bytes - 1 }));
    r.say(frame);
    await settle();
    const disposed = r.session[Symbol.asyncDispose]();
    await settle();
    r.say({ t: 'interrupted' });
    await disposed;
    const ok = await fits.result();
    expect(ok.error).toBeUndefined();
    expect(types(ok.events).filter((type) => type === 'message.delta')).toHaveLength(3);
    const failed = await tight.result();
    expect(failed.error).toBeInstanceOf(SubscriberOverflowError);
    expect((failed.error as SubscriberOverflowError).details).toMatchObject({ eventBytes: bytes });
  });

  it('the pre-handshake replay counts a line once too', async () => {
    const r = rig();
    const started = r.driver.start();
    await settle();
    const burst = { t: 'burst', n: 3, pad: 'w'.repeat(2000) };
    r.say(burst);
    r.say({ t: 'ready' });
    await started;
    const maxBytes = lineBytes(burst) + 2 * SYNTHESIZED_EVENT_BYTES + lineBytes({ t: 'ready' }) + 2;
    const iterator = iteratorOf(r.session.events({ maxBytes }));
    const replayed: HudhudEvent[] = [];
    for (let index = 0; index < 4; index += 1) {
      const event = await nextEvent(iterator);
      if (event !== undefined) replayed.push(event);
    }
    // All of it fits: no gap marker.
    expect(types(replayed)).toEqual([
      'message.delta',
      'message.delta',
      'message.delta',
      'session.started',
    ]);
    await iterator.return?.();
    const disposed = r.session[Symbol.asyncDispose]();
    await settle();
    r.say({ t: 'interrupted' });
    await disposed;
  });

  it('a turn subscriber is charged the same way', async () => {
    const r = rig();
    await ready(r);
    const pad = 'z'.repeat(3000);
    const turn = r.session.send('x', {
      events: {
        maxBytes: 4 * SYNTHESIZED_EVENT_BYTES + lineBytes({ t: 'burst', id: '', n: 3, pad }) + 64,
      },
    });
    const iterated = collector(turn);
    await settle();
    r.say({ t: 'burst', id: turn.id, n: 3, pad });
    r.say({ t: 'result', id: turn.id });
    const { events, error } = await iterated.result();
    expect(error).toBeUndefined();
    expect(types(events)).toEqual([
      'turn.queued',
      'message.delta',
      'message.delta',
      'message.delta',
      'turn.completed',
    ]);
  });
});

describe('the session-wide events.signal (R4-4, R5-2)', () => {
  it('ends events() and turn iterators with ABORTED; the call signal still works', async () => {
    const shutdown = new AbortController();
    const r = rig({ events: { signal: shutdown.signal } });
    await ready(r);
    const events = collector(r.session.events());
    const turn = r.session.send('x');
    const turnEvents = collector(turn);
    const own = new AbortController();
    const second = r.session.send('y', { signal: own.signal });
    const secondEvents = collector(second);
    await settle();
    shutdown.abort(new Error('shutdown'));
    for (const result of [
      await events.result(),
      await turnEvents.result(),
      await secondEvents.result(),
    ]) {
      expect(result.error).toBeInstanceOf(AbortError);
      expect((result.error as AbortError).cause).toEqual(new Error('shutdown'));
    }
    // The signal ends subscriptions only: both turns still run.
    expect(state(turn.done).current()).toBe('pending');
    r.say({ t: 'result', id: turn.id });
    expect(await turn.done).toMatchObject({ outcome: 'completed' });
    r.say({ t: 'result', id: second.id });
    expect(await second.done).toMatchObject({ outcome: 'completed' });
  });

  it('an already aborted session signal aborts every new subscription at once', async () => {
    const r = rig({ events: { signal: AbortSignal.abort('gone') } });
    await ready(r);
    const iterator = iteratorOf(r.session.events());
    expect((await outcome(iterator.next())).error).toBeInstanceOf(AbortError);
    const turn = r.session.send('x');
    expect((await outcome(iteratorOf(turn).next())).error).toBeInstanceOf(AbortError);
    r.say({ t: 'result', id: turn.id });
    await turn.done;
  });
});

describe('abort listeners (R4-5)', () => {
  it('a long-lived signal keeps no listener once each turn ended', async () => {
    const r = rig();
    await ready(r);
    const controller = new AbortController();
    const { signal } = controller;
    for (let index = 0; index < 5; index += 1) {
      const turn = r.session.send(`t${String(index)}`, { signal });
      await settle();
      expect(getEventListeners(signal, 'abort').length).toBeGreaterThan(0);
      r.say({ t: 'result', id: turn.id });
      await turn.done;
      await settle();
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    }
    // Subscribed, never read.
    r.session.events({ signal });
    await settle();
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);
    const disposed = r.session[Symbol.asyncDispose]();
    await settle();
    r.say({ t: 'interrupted' });
    await disposed;
    // The session ended: its subscriptions stopped and let go of the signal,
    // although events() was never read.
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('an abort after the end still stops the delivery of queued events', async () => {
    const r = rig();
    await ready(r);
    const controller = new AbortController();
    const turn = r.session.send('x', { signal: controller.signal });
    await settle();
    r.say({ t: 'say', id: turn.id, text: 'a' });
    r.say({ t: 'result', id: turn.id });
    await turn.done;
    await settle();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort('late');
    // Queued before the end, not delivered: the abort is seen at the next pull.
    expect((await outcome(iteratorOf(turn).next())).error).toBeInstanceOf(AbortError);
  });
});

describe('gap numbering (R4-U1)', () => {
  it('a turn subscriber numbers a gap as its own first dropped event', async () => {
    const r = rig();
    await ready(r);
    const a = r.session.send('a', {
      events: { maxEvents: 2, overflow: 'drop-oldest-with-gap-marker' },
    });
    const b = r.session.send('b');
    await settle();
    const iterator = iteratorOf(a);
    const queued = await nextEvent(iterator);
    expect(queued?.type).toBe('turn.queued');
    r.say({ t: 'say', id: b.id, text: 'b1' });
    r.say({ t: 'say', id: a.id, text: 'a1' });
    r.say({ t: 'say', id: a.id, text: 'a2' });
    r.say({ t: 'say', id: a.id, text: 'a3' });
    await settle();
    const gap = await nextEvent(iterator);
    const a2 = await nextEvent(iterator);
    expect(gap).toMatchObject({ type: 'gap', dropped: 1 });
    expect(a2).toMatchObject({ type: 'message.assistant', text: 'a2' });
    // a1 was dropped: the gap carries a1's seq, the one right before a2.
    expect(gap?.seq).toBe((a2?.seq ?? 0) - 1);
    r.say({ t: 'result', id: a.id });
    r.say({ t: 'result', id: b.id });
    await a.done;
    await b.done;
  });
});

describe('a dropped replay gap marker', () => {
  it('counts the events it stood for and keeps the first seq', async () => {
    const notes = [1, 2, 3].map((n) => ({ code: 'adapter.note', message: `note ${String(n)}` }));
    const r = rig({ diagnostics: notes });
    await ready(r);
    // The replay (three notes, session.started) is cut to the first note
    // plus a gap marker for the other three.
    const iterator = iteratorOf(
      r.session.events({ maxEvents: 2, overflow: 'drop-oldest-with-gap-marker' }),
    );
    // With one slot the replay is the gap marker alone.
    const alone = iteratorOf(
      r.session.events({ maxEvents: 1, overflow: 'drop-oldest-with-gap-marker' }),
    );
    // Two live events drop the first note and then the replay's gap marker
    // (with one slot: the gap marker, then the first live event).
    r.say({ t: 'say', text: 'x' });
    r.say({ t: 'say', text: 'y' });
    await settle();
    const gap = await nextEvent(iterator);
    expect(gap).toMatchObject({ type: 'gap', dropped: 4, seq: 1 });
    expect(await nextEvent(iterator)).toMatchObject({
      type: 'message.assistant',
      text: 'x',
      seq: 5,
    });
    expect(await nextEvent(alone)).toMatchObject({ type: 'gap', dropped: 5, seq: 1 });
    expect(await nextEvent(alone)).toMatchObject({ text: 'y', seq: 6 });
    await iterator.return?.();
    await alone.return?.();
    const disposed = r.session[Symbol.asyncDispose]();
    await settle();
    r.say({ t: 'interrupted' });
    await disposed;
  });
});

describe("'block' and close (R4-U2)", () => {
  it('a full unread block subscriber holds the end of a drain; abort cuts through', async () => {
    const r = rig();
    await ready(r);
    const blocked = iteratorOf(r.session.events({ maxEvents: 1, overflow: 'block' }));
    const closed = r.session.close();
    await settle();
    r.say({ t: 'idle' });
    await settle();
    r.transport.exit({ code: 0, signal: null });
    await settle();
    // The process is gone, but the drain cannot end while the subscriber
    // holds undelivered events: ending would drop them (documented hazard).
    expect(state(closed).current()).toBe('pending');
    await r.driver.abort('abort');
    await closed;
    expect((await outcome(blocked.next())).error).toBeDefined();
  });
});
