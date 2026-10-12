import { describe, expect, it } from 'vitest';

import { Fanout, resolveSubscriberOptions } from '../../../src/binding/fanout.js';
import type { AbortSignalLike, Selection, SubscriberOptions } from '../../../src/binding/fanout.js';
import type { OverflowPolicy } from '../../../src/binding/queue.js';
import {
  TestAbortError,
  defined,
  TestOverflowError,
  abortError,
  ev,
  flush,
  gap,
  overflowError,
  track,
} from './support.js';
import type { Ev } from './support.js';

/** A turn-tagged test event, for turn filters. */
type TurnEv = Ev & { readonly turnId?: string; readonly last?: boolean };

const tev = (id: number, turnId?: string, last?: boolean): TurnEv => ({
  ...ev(id),
  ...(turnId === undefined ? {} : { turnId }),
  ...(last === undefined ? {} : { last }),
});

function makeFanout(): Fanout<TurnEv> {
  return new Fanout<TurnEv>({ gapMarker: gap, overflowError, abortError });
}

type Iter = AsyncIterableIterator<TurnEv, undefined, undefined>;

async function drain(iterator: Iter): Promise<TurnEv[]> {
  const out: TurnEv[] = [];
  for await (const item of iterator) out.push(item);
  return out;
}

async function settle(iterator: Iter): Promise<unknown> {
  return iterator.next().then(
    (result) => result,
    (error: unknown) => error,
  );
}

/** A controllable signal that also proves its listeners are removed. */
class FakeSignal implements AbortSignalLike {
  aborted = false;
  reason: unknown;
  readonly listeners = new Set<() => void>();
  addEventListener(_type: 'abort', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'abort', listener: () => void): void {
    this.listeners.delete(listener);
  }
  abort(reason: unknown): void {
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.listeners]) listener();
  }
}

describe('resolveSubscriberOptions', () => {
  it('fills the ADR-0007 defaults', () => {
    expect(resolveSubscriberOptions({})).toEqual({
      maxEvents: 10_000,
      maxBytes: 67_108_864,
      overflow: 'error',
    });
  });

  it('keeps given values', () => {
    expect(resolveSubscriberOptions({ maxEvents: 5, maxBytes: 7, overflow: 'block' })).toEqual({
      maxEvents: 5,
      maxBytes: 7,
      overflow: 'block',
    });
  });

  it.each<[SubscriberOptions, ErrorConstructor]>([
    [{ maxEvents: 0 }, RangeError],
    [{ maxBytes: -1 }, RangeError],
    [{ maxEvents: 1.5 }, RangeError],
    [{ overflow: 'drop-oldest' as OverflowPolicy }, TypeError],
  ])('refuses %o', (options, type) => {
    expect(() => resolveSubscriberOptions(options)).toThrow(type);
    expect(() => makeFanout().subscribe({}, options)).toThrow(type);
  });
});

describe('Fanout broadcast', () => {
  it('delivers every event to every subscriber in publish order', async () => {
    const fanout = makeFanout();
    const a = fanout.subscribe();
    const b = fanout.subscribe();
    expect(fanout.subscriberCount).toBe(2);
    for (const id of [1, 2, 3]) expect(fanout.publish(tev(id), 10)).toBeUndefined();
    fanout.close();
    expect(fanout.closed).toBe(true);
    expect((await drain(a)).map((e) => e.kind === 'ev' && e.id)).toEqual([1, 2, 3]);
    expect((await drain(b)).map((e) => e.kind === 'ev' && e.id)).toEqual([1, 2, 3]);
    expect(fanout.subscriberCount).toBe(0);
  });

  it('applies the default limits: the 10,001st unread event overflows', async () => {
    const fanout = makeFanout();
    const slow = fanout.subscribe();
    for (let id = 0; id < 10_000; id += 1) void fanout.publish(tev(id), 1);
    expect(fanout.subscriberCount).toBe(1);
    void fanout.publish(tev(10_000), 1);
    expect(fanout.subscriberCount).toBe(0);
    let delivered = 0;
    await expect(
      (async () => {
        for await (const item of slow) delivered += item.kind === 'ev' ? 1 : 0;
      })(),
    ).rejects.toBeInstanceOf(TestOverflowError);
    expect(delivered).toBe(10_000);
  });

  it('applies the default 64 MiB byte budget', async () => {
    const fanout = makeFanout();
    const sub = fanout.subscribe();
    void fanout.publish(tev(1), 67_108_864);
    expect(fanout.subscriberCount).toBe(1);
    void fanout.publish(tev(2), 1);
    expect(fanout.subscriberCount).toBe(0);
    expect(await sub.next()).toMatchObject({ done: false, value: { id: 1 } });
    expect(await settle(sub)).toMatchObject({ info: { limit: 'bytes', maxBytes: 67_108_864 } });
  });

  it('refuses invalid byte sizes before delivering anything', () => {
    const fanout = makeFanout();
    const sub = fanout.subscribe();
    expect(() => fanout.publish(tev(1), -1)).toThrow(RangeError);
    expect(() => fanout.publish(tev(1), 1.5)).toThrow(RangeError);
    fanout.close();
    return expect(sub.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('refuses publish after close; close is idempotent', () => {
    const fanout = makeFanout();
    fanout.close();
    fanout.close();
    expect(() => fanout.publish(tev(1), 1)).toThrow(/after close/);
  });
});

describe('Fanout selection (turn filters)', () => {
  it('delivers only matching events and ends after the turn completes', async () => {
    const fanout = makeFanout();
    const selection: Selection<TurnEv> = {
      match: (e) => e.turnId === 't1',
      endAfter: (e) => e.last === true,
    };
    const turn = fanout.subscribe(selection);
    const all = fanout.subscribe();
    void fanout.publish(tev(1, 't0'), 1);
    void fanout.publish(tev(2, 't1'), 1);
    void fanout.publish(tev(3), 1);
    void fanout.publish(tev(4, 't1', true), 1);
    expect(fanout.subscriberCount).toBe(1);
    void fanout.publish(tev(5, 't1'), 1);
    expect((await drain(turn)).map((e) => e.kind === 'ev' && e.id)).toEqual([2, 4]);
    fanout.close();
    expect((await drain(all)).map((e) => e.kind === 'ev' && e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('isolates a throwing predicate to its own subscriber', async () => {
    const fanout = makeFanout();
    const boom = new Error('predicate failed');
    const throwsError = fanout.subscribe({
      match: () => {
        throw boom;
      },
    });
    const throwsValue = fanout.subscribe({
      endAfter: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a predicate written in JavaScript can throw anything
        throw 'not an error';
      },
    });
    const healthy = fanout.subscribe();
    void fanout.publish(tev(1), 1);
    expect(fanout.subscriberCount).toBe(1);
    expect(await settle(throwsError)).toBe(boom);
    const wrapped = await settle(throwsValue);
    expect(wrapped).toBeInstanceOf(Error);
    expect((wrapped as Error).cause).toBe('not an error');
    void fanout.publish(tev(2), 1);
    fanout.close();
    expect((await drain(healthy)).map((e) => e.kind === 'ev' && e.id)).toEqual([1, 2]);
  });
});

describe('Fanout replay and late subscribers (K20)', () => {
  it('replays first, without filtering, then live events published after subscribing', async () => {
    const fanout = makeFanout();
    void fanout.publish(tev(1), 1);
    const late = fanout.subscribe({
      match: (e) => e.turnId === 't1',
      replay: [{ event: tev(0), bytes: 256 }],
    });
    void fanout.publish(tev(2, 't1'), 1);
    fanout.close();
    expect((await drain(late)).map((e) => e.kind === 'ev' && e.id)).toEqual([0, 2]);
  });

  it('after close, a new subscriber gets its replay and is done', async () => {
    const fanout = makeFanout();
    fanout.close();
    const sub = fanout.subscribe({ replay: [{ event: tev(0), bytes: 1 }] });
    expect(fanout.subscriberCount).toBe(0);
    expect((await drain(sub)).map((e) => e.kind === 'ev' && e.id)).toEqual([0]);
  });

  it('refuses replay that does not fit the limits or has invalid sizes', () => {
    const fanout = makeFanout();
    const two = [
      { event: tev(0), bytes: 1 },
      { event: tev(1), bytes: 1 },
    ];
    expect(() => fanout.subscribe({ replay: two }, { maxEvents: 1 })).toThrow(RangeError);
    expect(() => fanout.subscribe({ replay: two }, { maxBytes: 1 })).toThrow(RangeError);
    expect(() => fanout.subscribe({ replay: [{ event: tev(0), bytes: -1 }] })).toThrow(RangeError);
    expect(fanout.subscriberCount).toBe(0);
  });
});

describe('Fanout isolation between subscribers', () => {
  it("one subscriber's overflow fails only that subscriber, once", async () => {
    const fanout = makeFanout();
    const small = fanout.subscribe({}, { maxEvents: 2 });
    const big = fanout.subscribe({}, { maxEvents: 100 });
    for (let id = 0; id < 5; id += 1) void fanout.publish(tev(id), 1);
    expect(fanout.subscriberCount).toBe(1);
    expect((await small.next()).value).toMatchObject({ id: 0 });
    expect((await small.next()).value).toMatchObject({ id: 1 });
    expect(await settle(small)).toBeInstanceOf(TestOverflowError);
    expect(await small.next()).toEqual({ done: true, value: undefined });
    fanout.close();
    expect((await drain(big)).map((e) => e.kind === 'ev' && e.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('a dropping subscriber reports gaps while its neighbour gets everything', async () => {
    const fanout = makeFanout();
    const lossy = fanout.subscribe({}, { maxEvents: 2, overflow: 'drop-oldest-with-gap-marker' });
    const full = fanout.subscribe();
    for (let id = 0; id < 5; id += 1) void fanout.publish(tev(id), 1);
    fanout.close();
    expect(await drain(lossy)).toEqual([gap(3), tev(3), tev(4)]);
    expect(await drain(full)).toHaveLength(5);
  });
});

describe("Fanout 'block' (can stall control frames, ADR-0007)", () => {
  it('returns a pending publish only for a full block subscriber; others already have the event', async () => {
    const fanout = makeFanout();
    const blocking = fanout.subscribe({}, { maxEvents: 1, overflow: 'block' });
    const other = fanout.subscribe();
    expect(fanout.publish(tev(1), 1)).toBeUndefined();
    const pending = fanout.publish(tev(2), 1);
    expect(pending).toBeInstanceOf(Promise);
    expect(fanout.publishPending).toBe(true);
    const tracked = track(defined(pending));
    expect(() => fanout.publish(tev(3), 1)).toThrow(/still pending/);
    expect((await other.next()).value).toMatchObject({ id: 1 });
    expect((await other.next()).value).toMatchObject({ id: 2 });
    await flush();
    expect(tracked.state).toBe('pending');
    expect((await blocking.next()).value).toMatchObject({ id: 1 });
    await flush();
    expect(tracked.state).toBe('fulfilled');
    expect(fanout.publishPending).toBe(false);
    expect(fanout.publish(tev(3), 1)).toBeInstanceOf(Promise);
  });

  it('releases a pending publish when the blocking subscriber goes away', async () => {
    const fanout = makeFanout();
    const signal = new FakeSignal();
    fanout.subscribe({}, { maxEvents: 1, overflow: 'block', signal });
    void fanout.publish(tev(1), 1);
    const tracked = track(defined(fanout.publish(tev(2), 1)));
    signal.abort('stop');
    await flush();
    expect(tracked.state).toBe('fulfilled');
    expect(fanout.publishPending).toBe(false);
    expect(fanout.subscriberCount).toBe(0);
  });

  it('close() keeps a blocked event for delivery', async () => {
    const fanout = makeFanout();
    const blocking = fanout.subscribe({}, { maxEvents: 1, overflow: 'block' });
    void fanout.publish(tev(1), 1);
    const tracked = track(defined(fanout.publish(tev(2), 1)));
    fanout.close();
    expect((await drain(blocking)).map((e) => e.kind === 'ev' && e.id)).toEqual([1, 2]);
    expect(tracked.state).toBe('fulfilled');
  });
});

describe('Fanout cleanup and cancellation', () => {
  it('return(), throw() and break unsubscribe at once', async () => {
    const fanout = makeFanout();
    const a = fanout.subscribe();
    const b = fanout.subscribe();
    const c = fanout.subscribe();
    void fanout.publish(tev(1), 1);
    await a.return?.();
    expect(fanout.subscriberCount).toBe(2);
    await expect(b.throw?.(new Error('x'))).rejects.toThrow('x');
    expect(fanout.subscriberCount).toBe(1);
    for await (const item of c) {
      expect(item).toEqual(tev(1));
      break;
    }
    expect(fanout.subscriberCount).toBe(0);
    expect(fanout.publish(tev(2), 1)).toBeUndefined();
  });

  it('unsubscribing during delivery skips that subscriber; subscribing during delivery waits for the next event', async () => {
    const fanout = makeFanout();
    let joiner: Iter | undefined;
    const first = fanout.subscribe({
      match: () => {
        void victim.return?.();
        joiner ??= fanout.subscribe();
        return true;
      },
    });
    const victim = fanout.subscribe();
    void fanout.publish(tev(1), 1);
    expect(await victim.next()).toEqual({ done: true, value: undefined });
    void fanout.publish(tev(2), 1);
    fanout.close();
    expect((await drain(first)).map((e) => e.kind === 'ev' && e.id)).toEqual([1, 2]);
    expect((await drain(defined(joiner))).map((e) => e.kind === 'ev' && e.id)).toEqual([2]);
  });

  it('a pre-aborted signal yields the abort error once and never registers', async () => {
    const fanout = makeFanout();
    const signal = new FakeSignal();
    signal.abort('why');
    const sub = fanout.subscribe({ replay: [{ event: tev(0), bytes: 1 }] }, { signal });
    expect(fanout.subscriberCount).toBe(0);
    expect(signal.listeners.size).toBe(0);
    const error = await settle(sub);
    expect(error).toBeInstanceOf(TestAbortError);
    expect((error as Error).cause).toBe('why');
    expect(await sub.next()).toEqual({ done: true, value: undefined });
  });

  it('aborting a live subscriber discards its queue and rejects its pending pull', async () => {
    const fanout = makeFanout();
    const controller = new AbortController();
    const sub = fanout.subscribe({}, { signal: controller.signal });
    const pull = track(sub.next());
    controller.abort('done');
    await flush();
    expect(pull.state).toBe('rejected');
    expect((pull.error as Error).cause).toBe('done');
    expect(fanout.subscriberCount).toBe(0);
  });

  it('keeps the abort listener until the consumer is finished, then removes it', async () => {
    const fanout = makeFanout();
    const signal = new FakeSignal();
    const viaReturn = fanout.subscribe({}, { signal });
    const viaOverflow = fanout.subscribe({}, { signal, maxEvents: 1 });
    const viaEnd = fanout.subscribe({ endAfter: () => true }, { signal, maxEvents: 5 });
    expect(signal.listeners.size).toBe(3);
    await viaReturn.return?.();
    expect(signal.listeners.size).toBe(2);
    void fanout.publish(tev(1), 1);
    void fanout.publish(tev(2), 1);
    // Both stopped accepting, but neither consumer is finished yet.
    expect(fanout.subscriberCount).toBe(0);
    expect(signal.listeners.size).toBe(2);
    expect(await drain(viaEnd)).toEqual([tev(1)]);
    expect(signal.listeners.size).toBe(1);
    expect((await viaOverflow.next()).value).toEqual(tev(1));
    expect(await settle(viaOverflow)).toBeInstanceOf(TestOverflowError);
    expect(signal.listeners.size).toBe(0);
  });

  it('an abort after close stops the delivery of still-queued events', async () => {
    const fanout = makeFanout();
    const controller = new AbortController();
    const sub = fanout.subscribe({}, { signal: controller.signal });
    void fanout.publish(tev(1), 1);
    void fanout.publish(tev(2), 1);
    fanout.close();
    expect((await sub.next()).value).toEqual(tev(1));
    controller.abort('enough');
    expect(await settle(sub)).toBeInstanceOf(TestAbortError);
    expect(await sub.next()).toEqual({ done: true, value: undefined });
  });

  it('holds nothing for subscribers that left: 1,000 subscribe/return cycles leave no residue', async () => {
    const fanout = makeFanout();
    const signal = new FakeSignal();
    for (let i = 0; i < 1000; i += 1) {
      const sub = fanout.subscribe({}, { signal, maxEvents: 2 });
      void fanout.publish(tev(i), 1);
      await sub.return?.();
    }
    expect(fanout.subscriberCount).toBe(0);
    expect(signal.listeners.size).toBe(0);
  });
});
