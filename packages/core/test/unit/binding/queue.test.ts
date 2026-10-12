import { describe, expect, it, vi } from 'vitest';

import {
  BoundedQueue,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_EVENTS,
  DEFAULT_OVERFLOW,
  OVERFLOW_POLICIES,
} from '../../../src/binding/queue.js';
import type { BoundedQueueOptions, OverflowPolicy } from '../../../src/binding/queue.js';
import { TestOverflowError, ev, flush, gap, overflowError, track } from './support.js';
import type { Ev } from './support.js';

function makeQueue(
  overflow: OverflowPolicy,
  limits: { maxEvents?: number; maxBytes?: number } = {},
  onClose?: () => void,
): BoundedQueue<Ev> {
  const options: BoundedQueueOptions<Ev> = {
    maxEvents: limits.maxEvents ?? 3,
    maxBytes: limits.maxBytes ?? 100,
    overflow,
    gapMarker: gap,
    overflowError,
    ...(onClose === undefined ? {} : { onClose }),
  };
  return new BoundedQueue<Ev>(options);
}

async function drain(queue: BoundedQueue<Ev>): Promise<Ev[]> {
  const out: Ev[] = [];
  for (;;) {
    const result = await queue.iterator().next();
    if (result.done === true) return out;
    out.push(result.value);
  }
}

describe('BoundedQueue defaults (ADR-0007)', () => {
  it('uses 10,000 events, 64 MiB and the error policy', () => {
    expect(DEFAULT_MAX_EVENTS).toBe(10_000);
    expect(DEFAULT_MAX_BYTES).toBe(67_108_864);
    expect(DEFAULT_OVERFLOW).toBe('error');
    expect(OVERFLOW_POLICIES).toEqual(['error', 'drop-oldest-with-gap-marker', 'block']);
    expect(Object.isFrozen(OVERFLOW_POLICIES)).toBe(true);
  });
});

describe('BoundedQueue validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '3' as unknown as number])(
    'refuses %s as a limit',
    (value) => {
      expect(() => makeQueue('error', { maxEvents: value })).toThrow(RangeError);
      expect(() => makeQueue('error', { maxBytes: value })).toThrow(RangeError);
    },
  );

  it('refuses an unknown overflow policy', () => {
    expect(() => makeQueue('drop' as OverflowPolicy)).toThrow(TypeError);
    expect(() => makeQueue(undefined as unknown as OverflowPolicy)).toThrow(TypeError);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, null as unknown as number])(
    'refuses %s as event bytes',
    (bytes) => {
      const queue = makeQueue('error');
      expect(() => queue.push(ev(1), bytes)).toThrow(RangeError);
      expect(queue.size).toBe(0);
    },
  );
});

describe('BoundedQueue delivery', () => {
  it('stays ending while queued events remain', async () => {
    const queue = makeQueue('error');
    void queue.push(ev(1), 1);
    queue.end();
    expect(queue.state).toBe('ending');
    expect(await drain(queue)).toEqual([ev(1)]);
    expect(queue.state).toBe('closed');
  });

  it('delivers in FIFO order and accounts count and bytes', async () => {
    const queue = makeQueue('error', { maxEvents: 5, maxBytes: 100 });
    expect(queue.push(ev(1), 10)).toBe('ok');
    expect(queue.push(ev(2), 0)).toBe('ok');
    expect(queue.push(ev(3), 30)).toBe('ok');
    expect(queue.size).toBe(3);
    expect(queue.bytes).toBe(40);
    expect(await queue.iterator().next()).toEqual({ done: false, value: ev(1) });
    expect(queue.size).toBe(2);
    expect(queue.bytes).toBe(30);
    queue.end();
    expect(await drain(queue)).toEqual([ev(2), ev(3)]);
    expect(queue.size).toBe(0);
    expect(queue.bytes).toBe(0);
  });

  it('hands an event straight to a waiting consumer, in call order', async () => {
    const queue = makeQueue('error', { maxEvents: 2 });
    const first = track(queue.iterator().next());
    const second = track(queue.iterator().next());
    expect(queue.pendingPulls).toBe(2);
    expect(queue.push(ev(1), 99)).toBe('ok');
    expect(queue.push(ev(2), 99)).toBe('ok');
    expect(queue.size).toBe(0);
    await flush();
    expect(first.value).toEqual({ done: false, value: ev(1) });
    expect(second.value).toEqual({ done: false, value: ev(2) });
  });

  it('caps concurrent next() calls at maxEvents', async () => {
    const queue = makeQueue('error', { maxEvents: 2 });
    const pulls = [queue.iterator().next(), queue.iterator().next()];
    await expect(queue.iterator().next()).rejects.toThrow(RangeError);
    expect(queue.pendingPulls).toBe(2);
    queue.end();
    expect(await Promise.all(pulls)).toEqual([
      { done: true, value: undefined },
      { done: true, value: undefined },
    ]);
  });

  it('exposes only the iterator protocol, as one frozen object', () => {
    const queue = makeQueue('error');
    const iterator = queue.iterator();
    expect(queue.iterator()).toBe(iterator);
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
    expect(Object.isFrozen(iterator)).toBe(true);
    expect(Object.keys(iterator).sort()).toEqual(['next', 'return', 'throw']);
  });
});

describe("BoundedQueue overflow 'error'", () => {
  it('fails on the count limit, drains what was queued, rejects once, then is done', async () => {
    const onClose = vi.fn();
    const queue = makeQueue('error', { maxEvents: 2, maxBytes: 100 }, onClose);
    void queue.push(ev(1), 1);
    void queue.push(ev(2), 1);
    expect(queue.push(ev(3), 1)).toBe('overflow-error');
    expect(queue.state).toBe('failed');
    expect(queue.accepting).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(queue.push(ev(4), 1)).toBe('closed');
    const it = queue.iterator();
    expect(await it.next()).toEqual({ done: false, value: ev(1) });
    expect(await it.next()).toEqual({ done: false, value: ev(2) });
    const error = await it.next().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TestOverflowError);
    expect((error as TestOverflowError).info).toEqual({
      limit: 'events',
      maxEvents: 2,
      maxBytes: 100,
      queuedEvents: 2,
      queuedBytes: 2,
      eventBytes: 1,
    });
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect(queue.state).toBe('closed');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fails on the byte limit', async () => {
    const queue = makeQueue('error', { maxEvents: 10, maxBytes: 10 });
    void queue.push(ev(1), 6);
    expect(queue.push(ev(2), 5)).toBe('overflow-error');
    expect(queue.bytes).toBe(6);
    await queue.iterator().next();
    await expect(queue.iterator().next()).rejects.toMatchObject({
      info: { limit: 'bytes', queuedEvents: 1, queuedBytes: 6, eventBytes: 5 },
    });
  });

  it('fails a waiting consumer at once on an event larger than the budget', async () => {
    const queue = makeQueue('error', { maxBytes: 10 });
    const first = track(queue.iterator().next());
    const second = track(queue.iterator().next());
    expect(queue.push(ev(1), 11)).toBe('overflow-error');
    await flush();
    expect(first.state).toBe('rejected');
    expect(first.error).toMatchObject({
      info: { limit: 'bytes', queuedEvents: 0, eventBytes: 11 },
    });
    expect(second.value).toEqual({ done: true, value: undefined });
  });
});

describe("BoundedQueue overflow 'drop-oldest-with-gap-marker'", () => {
  it('drops the oldest events and reports the exact count in one gap marker', async () => {
    const queue = makeQueue('drop-oldest-with-gap-marker', { maxEvents: 3 });
    for (const id of [1, 2, 3]) expect(queue.push(ev(id), 1)).toBe('ok');
    expect(queue.push(ev(4), 1)).toBe('dropped');
    expect(queue.push(ev(5), 1)).toBe('dropped');
    expect(queue.size).toBe(3);
    expect(queue.pendingGap).toBe(2);
    queue.end();
    expect(await drain(queue)).toEqual([gap(2), ev(3), ev(4), ev(5)]);
  });

  it('drops as many events as the byte budget needs', async () => {
    const queue = makeQueue('drop-oldest-with-gap-marker', { maxEvents: 10, maxBytes: 10 });
    void queue.push(ev(1), 3);
    void queue.push(ev(2), 3);
    void queue.push(ev(3), 3);
    expect(queue.push(ev(4), 8)).toBe('dropped');
    expect(queue.bytes).toBe(8);
    queue.end();
    expect(await drain(queue)).toEqual([gap(3), ev(4)]);
  });

  it('merges drops into an unreported gap and starts a new gap after a delivered one', async () => {
    const queue = makeQueue('drop-oldest-with-gap-marker', { maxEvents: 2 });
    const it = queue.iterator();
    for (const id of [1, 2, 3, 4]) void queue.push(ev(id), 1);
    expect(queue.pendingGap).toBe(2);
    expect(await it.next()).toEqual({ done: false, value: gap(2) });
    void queue.push(ev(5), 1);
    void queue.push(ev(6), 1);
    queue.end();
    expect(await drain(queue)).toEqual([gap(2), ev(5), ev(6)]);
  });

  it('drops an event larger than the budget itself, together with everything queued', async () => {
    const queue = makeQueue('drop-oldest-with-gap-marker', { maxBytes: 10 });
    void queue.push(ev(1), 5);
    void queue.push(ev(2), 5);
    expect(queue.push(ev(3), 11)).toBe('dropped');
    expect(queue.size).toBe(0);
    expect(queue.bytes).toBe(0);
    void queue.push(ev(4), 10);
    queue.end();
    expect(await drain(queue)).toEqual([gap(3), ev(4)]);
  });

  it('hands the gap marker of an oversized event to a waiting consumer', async () => {
    const queue = makeQueue('drop-oldest-with-gap-marker', { maxBytes: 10 });
    const pull = track(queue.iterator().next());
    const later = track(queue.iterator().next());
    expect(queue.push(ev(1), 11)).toBe('dropped');
    await flush();
    expect(pull.value).toEqual({ done: false, value: gap(1) });
    expect(queue.pendingGap).toBe(0);
    expect(later.state).toBe('pending');
    expect(queue.push(ev(2), 1)).toBe('ok');
    await flush();
    expect(later.value).toEqual({ done: false, value: ev(2) });
  });
});

describe("BoundedQueue overflow 'block'", () => {
  it('blocks the producer until the consumer makes room, then admits the event', async () => {
    const queue = makeQueue('block', { maxEvents: 1 });
    expect(queue.push(ev(1), 1)).toBe('ok');
    const result = queue.push(ev(2), 1);
    expect(result).toBeInstanceOf(Promise);
    const blocked = track(result as Promise<void>);
    expect(queue.blocked).toBe(true);
    expect(queue.size).toBe(1);
    await flush();
    expect(blocked.state).toBe('pending');
    expect(() => queue.push(ev(3), 1)).toThrow(/blocked push is still pending/);
    expect(await queue.iterator().next()).toEqual({ done: false, value: ev(1) });
    expect(queue.blocked).toBe(false);
    expect(queue.size).toBe(1);
    await flush();
    expect(blocked.state).toBe('fulfilled');
    expect(await queue.iterator().next()).toEqual({ done: false, value: ev(2) });
  });

  it('admits a blocked event only once enough bytes are free', async () => {
    const queue = makeQueue('block', { maxEvents: 10, maxBytes: 10 });
    void queue.push(ev(1), 4);
    void queue.push(ev(2), 4);
    const blocked = track(queue.push(ev(3), 8) as Promise<void>);
    await queue.iterator().next();
    await flush();
    expect(blocked.state).toBe('pending');
    expect(queue.bytes).toBe(4);
    await queue.iterator().next();
    await flush();
    expect(blocked.state).toBe('fulfilled');
    expect(queue.bytes).toBe(8);
  });

  it('fails on an event that can never fit instead of waiting forever', () => {
    const queue = makeQueue('block', { maxBytes: 10 });
    expect(queue.push(ev(1), 11)).toBe('overflow-error');
    expect(queue.state).toBe('failed');
    expect(queue.blocked).toBe(false);
  });

  it('releases the producer when the consumer returns', async () => {
    const queue = makeQueue('block', { maxEvents: 1 });
    void queue.push(ev(1), 1);
    const blocked = track(queue.push(ev(2), 1) as Promise<void>);
    await queue.iterator().return?.();
    await flush();
    expect(blocked.state).toBe('fulfilled');
    expect(queue.size).toBe(0);
    expect(queue.blocked).toBe(false);
  });

  it('releases the producer on cancel', async () => {
    const queue = makeQueue('block', { maxEvents: 1 });
    void queue.push(ev(1), 1);
    const blocked = track(queue.push(ev(2), 1) as Promise<void>);
    queue.cancel(new Error('stop'));
    await flush();
    expect(blocked.state).toBe('fulfilled');
  });

  it('still delivers a blocked event after end()', async () => {
    const queue = makeQueue('block', { maxEvents: 1 });
    void queue.push(ev(1), 1);
    const blocked = track(queue.push(ev(2), 1) as Promise<void>);
    queue.end();
    expect(await drain(queue)).toEqual([ev(1), ev(2)]);
    expect(blocked.state).toBe('fulfilled');
  });
});

describe('BoundedQueue end and cancel', () => {
  it('end() drains, finishes waiting consumers, and is idempotent', async () => {
    const onClose = vi.fn();
    const queue = makeQueue('error', {}, onClose);
    const pull = track(queue.iterator().next());
    queue.end();
    queue.end();
    await flush();
    expect(pull.value).toEqual({ done: true, value: undefined });
    expect(queue.state).toBe('closed');
    expect(queue.push(ev(1), 1)).toBe('closed');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancel() discards queued events and rejects the next pull once', async () => {
    const onClose = vi.fn();
    const queue = makeQueue('drop-oldest-with-gap-marker', { maxEvents: 1 }, onClose);
    void queue.push(ev(1), 1);
    void queue.push(ev(2), 1);
    const reason = new Error('aborted');
    queue.cancel(reason);
    expect(queue.size).toBe(0);
    expect(queue.pendingGap).toBe(0);
    expect(queue.state).toBe('failed');
    await expect(queue.iterator().next()).rejects.toBe(reason);
    expect(await queue.iterator().next()).toEqual({ done: true, value: undefined });
    queue.cancel(new Error('again'));
    queue.end();
    expect(await queue.iterator().next()).toEqual({ done: true, value: undefined });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancel() rejects the first waiting consumer and finishes the others', async () => {
    const queue = makeQueue('error');
    const first = track(queue.iterator().next());
    const second = track(queue.iterator().next());
    const reason = new Error('aborted');
    queue.cancel(reason);
    await flush();
    expect(first.error).toBe(reason);
    expect(second.value).toEqual({ done: true, value: undefined });
  });

  it('cancel() keeps a pending overflow error (the first reason stands)', async () => {
    const failed = makeQueue('error', { maxEvents: 1 });
    void failed.push(ev(1), 1);
    void failed.push(ev(2), 1);
    failed.cancel(new Error('aborted'));
    expect(failed.size).toBe(1);
    expect(await failed.iterator().next()).toEqual({ done: false, value: ev(1) });
    await expect(failed.iterator().next()).rejects.toBeInstanceOf(TestOverflowError);
  });

  it('cancel() during an end() drops what was kept', async () => {
    const reason = new Error('aborted');
    const ending = makeQueue('error');
    void ending.push(ev(1), 1);
    ending.end();
    ending.cancel(reason);
    expect(ending.size).toBe(0);
    await expect(ending.iterator().next()).rejects.toBe(reason);
  });

  it('calls onFinish once, after onClose, when the consumer is finished', async () => {
    const calls: string[] = [];
    const queue = new BoundedQueue<Ev>({
      maxEvents: 2,
      maxBytes: 10,
      overflow: 'error',
      gapMarker: gap,
      overflowError,
      onClose: () => calls.push('close'),
      onFinish: () => calls.push('finish'),
    });
    void queue.push(ev(1), 1);
    queue.end();
    expect(calls).toEqual(['close']);
    await queue.iterator().next();
    expect(calls).toEqual(['close']);
    await queue.iterator().next();
    await queue.iterator().next();
    await queue.iterator().return?.();
    expect(calls).toEqual(['close', 'finish']);
  });
});

describe('BoundedQueue iterator cleanup', () => {
  it('return() discards everything, finishes waiters and stays done', async () => {
    const onClose = vi.fn();
    const queue = makeQueue('error', {}, onClose);
    const pull = track(queue.iterator().next());
    expect(await queue.iterator().return?.()).toEqual({ done: true, value: undefined });
    await flush();
    expect(pull.value).toEqual({ done: true, value: undefined });
    expect(queue.push(ev(1), 1)).toBe('closed');
    expect(await queue.iterator().next()).toEqual({ done: true, value: undefined });
    expect(await queue.iterator().return?.()).toEqual({ done: true, value: undefined });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('return() after an overflow drops the unreported error', async () => {
    const queue = makeQueue('error', { maxEvents: 1 });
    void queue.push(ev(1), 1);
    void queue.push(ev(2), 1);
    await queue.iterator().return?.();
    expect(queue.size).toBe(0);
    expect(await queue.iterator().next()).toEqual({ done: true, value: undefined });
  });

  it('throw() closes the queue and rethrows the given value', async () => {
    const onClose = vi.fn();
    const queue = makeQueue('error', {}, onClose);
    void queue.push(ev(1), 1);
    const reason = new Error('consumer failed');
    await expect(queue.iterator().throw?.(reason)).rejects.toBe(reason);
    expect(queue.state).toBe('closed');
    expect(queue.size).toBe(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('break in for-await calls return() and closes the queue', async () => {
    const onClose = vi.fn();
    const queue = makeQueue('error', { maxEvents: 5 }, onClose);
    for (const id of [1, 2, 3]) void queue.push(ev(id), 1);
    const seen: Ev[] = [];
    for await (const item of queue.iterator()) {
      seen.push(item);
      if (seen.length === 2) break;
    }
    expect(seen).toEqual([ev(1), ev(2)]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(queue.state).toBe('closed');
    expect(queue.size).toBe(0);
  });

  it('an exception in the for-await body closes the queue', async () => {
    const queue = makeQueue('error');
    void queue.push(ev(1), 1);
    const run = async (): Promise<void> => {
      for await (const item of queue.iterator()) throw new Error(`body failed on ${item.kind}`);
    };
    await expect(run()).rejects.toThrow('body failed');
    expect(queue.state).toBe('closed');
  });
});
