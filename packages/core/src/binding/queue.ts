/**
 * Bounded per-subscriber event queue (ADR-0007).
 *
 * @remarks
 * One queue backs one subscriber. It is limited in both event count and
 * bytes, and applies one of three overflow policies when a push does not fit:
 *
 * - `'error'` (default): the push is refused and the queue fails. The consumer
 *   still receives every event that was queued before the overflow, then its
 *   iterator rejects once with the overflow error, then it is done. Only this
 *   subscriber is affected.
 * - `'drop-oldest-with-gap-marker'`: the oldest queued events are dropped until
 *   the new event fits, and the consumer receives one gap marker carrying the
 *   exact number of dropped events in their place.
 * - `'block'`: the push returns a promise that settles once the event entered
 *   the queue (or the consumer went away). The producer is expected to wait.
 *   This is dangerous: a producer that waits on a slow consumer stops doing
 *   anything else, and in hudhud that producer is the session driver, so
 *   `'block'` can stall control-frame dispatch (permission requests, interrupt
 *   answers) for the whole session. It is opt-in and never the default.
 *
 * An event larger than the byte budget on its own can never fit: under
 * `'error'` and `'block'` it fails the queue with the overflow error (waiting
 * would never end), under `'drop-oldest-with-gap-marker'` it is dropped itself
 * and counted in the gap marker. The budget is therefore never exceeded, not
 * even for a moment.
 *
 * Memory bounds (no unbounded growth; unbounded subscriber queues were
 * rejected by ADR-0007):
 *
 * - queued events: at most `maxEvents`, and their declared bytes at most
 *   `maxBytes`;
 * - dropped events: one integer counter; gap markers are created only when the
 *   consumer pulls, so they never occupy queue space;
 * - blocked pushes: at most one; a second push while one is blocked is a
 *   producer contract violation and throws;
 * - pending `next()` calls: at most `maxEvents`; further concurrent calls
 *   reject with a `RangeError`;
 * - after `cancel`, `return` or `throw` nothing is retained.
 *
 * The queue never uses timers and never schedules work of its own; every
 * transition happens synchronously inside `push`, `end`, `cancel` or an
 * iterator method, and consumers are woken by resolving their promises.
 *
 * @internal
 */

/**
 * What a subscriber does when its queue is full (ADR-0007).
 *
 * @remarks
 * `'block'` can stall control frames: it makes the session driver wait for
 * this subscriber, so permission requests and interrupts are not dispatched
 * while it waits.
 */
export type OverflowPolicy = 'error' | 'drop-oldest-with-gap-marker' | 'block';

/** Default event-count limit of a subscriber queue (ADR-0007). */
export const DEFAULT_MAX_EVENTS = 10_000;

/** Default byte limit of a subscriber queue: 64 MiB (ADR-0007). */
export const DEFAULT_MAX_BYTES: number = 64 * 1024 * 1024;

/** Default overflow policy (ADR-0007). */
export const DEFAULT_OVERFLOW: OverflowPolicy = 'error';

/** Every overflow policy, for validation of untyped input. */
export const OVERFLOW_POLICIES: readonly OverflowPolicy[] = Object.freeze([
  'error',
  'drop-oldest-with-gap-marker',
  'block',
]);

/** The numbers that describe an overflow; passed to the error factory. */
export interface OverflowInfo {
  /** `'events'` when the count limit was hit, `'bytes'` when the byte limit was. */
  readonly limit: 'events' | 'bytes';
  readonly maxEvents: number;
  readonly maxBytes: number;
  /** Events queued at the moment of the overflow. */
  readonly queuedEvents: number;
  /** Bytes queued at the moment of the overflow. */
  readonly queuedBytes: number;
  /** Declared bytes of the event that did not fit. */
  readonly eventBytes: number;
}

/**
 * Result of {@link BoundedQueue.push}.
 *
 * - `'ok'`: the event was queued or handed to a waiting consumer.
 * - `'dropped'`: the event was accepted but one or more events were dropped
 *   (possibly the pushed event itself, when it exceeds the byte budget alone).
 * - `'overflow-error'`: the event was refused and the queue failed under
 *   `'error'` (or an oversized event under `'block'`); returned once, on the
 *   transition.
 * - `'closed'`: the queue no longer accepts events; the event was discarded.
 * - a promise (`'block'` only): settles when the event entered the queue or the
 *   consumer went away; it never rejects.
 */
export type PushResult = 'ok' | 'dropped' | 'overflow-error' | 'closed' | Promise<void>;

/** Construction options of a {@link BoundedQueue}. */
export interface BoundedQueueOptions<T> {
  /** Positive safe integer. */
  readonly maxEvents: number;
  /** Positive safe integer. */
  readonly maxBytes: number;
  readonly overflow: OverflowPolicy;
  /** Builds the gap marker for `dropped` events; called when the consumer pulls it. */
  readonly gapMarker: (dropped: number) => T;
  /** Builds the error the iterator rejects with on overflow. */
  readonly overflowError: (info: OverflowInfo) => Error;
  /**
   * Called exactly once, synchronously, when the queue stops accepting events
   * (end, overflow, cancel, or the consumer's `return`/`throw`).
   */
  readonly onClose?: () => void;
  /**
   * Called exactly once, synchronously, when the queue reaches `'closed'`:
   * the consumer saw the end, or returned, or threw. Always after `onClose`.
   */
  readonly onFinish?: () => void;
}

/**
 * Lifecycle of a queue: `'open'` accepts events; `'ending'` drains queued
 * events, then is done; `'failed'` drains what was kept, then rejects once;
 * `'closed'` is terminal and holds nothing.
 */
export type QueueState = 'open' | 'ending' | 'failed' | 'closed';

interface Waiter<T> {
  readonly resolve: (result: IteratorResult<T, undefined>) => void;
  readonly reject: (error: Error) => void;
}

interface Blocked<T> {
  readonly item: T;
  readonly bytes: number;
  readonly resolve: () => void;
}

interface Node<T> {
  readonly item: T;
  readonly bytes: number;
  next: Node<T> | undefined;
}

const DONE: IteratorReturnResult<undefined> = Object.freeze({ done: true, value: undefined });

/**
 * Validates a limit as a positive safe integer.
 *
 * @throws RangeError when it is not.
 */
export function assertLimit(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/**
 * Validates an overflow policy given as untyped input.
 *
 * @throws TypeError when it is not one of {@link OVERFLOW_POLICIES}.
 */
export function assertOverflowPolicy(value: unknown): asserts value is OverflowPolicy {
  if (!OVERFLOW_POLICIES.includes(value as OverflowPolicy)) {
    throw new TypeError(`overflow must be one of ${OVERFLOW_POLICIES.join(', ')}`);
  }
}

/**
 * Validates the declared byte size of one event.
 *
 * @throws RangeError when it is not a non-negative safe integer.
 */
export function assertEventBytes(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('event bytes must be a non-negative safe integer');
  }
}

/**
 * A bounded FIFO with count and byte limits, three overflow policies and gap
 * markers, consumed through one async iterator.
 *
 * @typeParam T - the event type.
 */
export class BoundedQueue<T> {
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #overflow: OverflowPolicy;
  readonly #gapMarker: (dropped: number) => T;
  readonly #overflowError: (info: OverflowInfo) => Error;
  readonly #onClose: (() => void) | undefined;
  readonly #onFinish: (() => void) | undefined;

  // Singly linked FIFO: O(1) push and shift, no compaction.
  #first: Node<T> | undefined;
  #last: Node<T> | undefined;
  #size = 0;
  #bytes = 0;

  #gap = 0;
  #state: QueueState = 'open';
  #error: Error | undefined;
  #blocked: Blocked<T> | undefined;
  readonly #waiters: Waiter<T>[] = [];
  #closeNotified = false;
  #finishNotified = false;
  readonly #iterator: AsyncIterableIterator<T, undefined, undefined>;

  /**
   * @throws RangeError or TypeError for invalid limits or policy.
   */
  constructor(options: BoundedQueueOptions<T>) {
    assertLimit('maxEvents', options.maxEvents);
    assertLimit('maxBytes', options.maxBytes);
    assertOverflowPolicy(options.overflow);
    this.#maxEvents = options.maxEvents;
    this.#maxBytes = options.maxBytes;
    this.#overflow = options.overflow;
    this.#gapMarker = options.gapMarker;
    this.#overflowError = options.overflowError;
    this.#onClose = options.onClose;
    this.#onFinish = options.onFinish;
    const iterator: AsyncIterableIterator<T, undefined, undefined> = {
      next: () => this.#next(),
      return: () => this.#return(),
      throw: (error?: unknown) => this.#throw(error),
      [Symbol.asyncIterator]: () => iterator,
    };
    this.#iterator = Object.freeze(iterator);
  }

  /** Events currently queued (gap markers excluded: they occupy no space). */
  get size(): number {
    return this.#size;
  }

  /** Declared bytes currently queued. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Dropped events not yet reported through a gap marker. */
  get pendingGap(): number {
    return this.#gap;
  }

  /** Whether a `'block'` push is waiting for space. */
  get blocked(): boolean {
    return this.#blocked !== undefined;
  }

  /** Pending `next()` calls waiting for an event. */
  get pendingPulls(): number {
    return this.#waiters.length;
  }

  /** Current lifecycle state. */
  get state(): QueueState {
    return this.#state;
  }

  /** Whether the queue still accepts events. */
  get accepting(): boolean {
    return this.#state === 'open';
  }

  /**
   * The consumer side. The same object is returned on every call; it exposes
   * only the async-iterator protocol, never the producer side.
   */
  iterator(): AsyncIterableIterator<T, undefined, undefined> {
    return this.#iterator;
  }

  /**
   * Offers one event with its declared byte size.
   *
   * @throws RangeError when `bytes` is not a non-negative safe integer.
   * @throws Error when called while an earlier `'block'` push is still waiting
   * (the producer must wait for the returned promise).
   */
  push(item: T, bytes: number): PushResult {
    assertEventBytes(bytes);
    if (this.#state !== 'open') return 'closed';
    if (this.#blocked !== undefined) {
      throw new Error('BoundedQueue.push called while a blocked push is still pending');
    }
    if (bytes > this.#maxBytes) return this.#oversized(bytes);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      // Waiters exist only while nothing is queued and no gap is pending.
      waiter.resolve({ done: false, value: item });
      return 'ok';
    }
    if (this.#fits(bytes)) {
      this.#enqueue(item, bytes);
      return 'ok';
    }
    switch (this.#overflow) {
      case 'error':
        this.#failOverflow(bytes);
        return 'overflow-error';
      case 'drop-oldest-with-gap-marker':
        // Ends before the queue is empty: an empty queue fits any event
        // within the byte budget.
        for (let node = this.#first; node !== undefined && !this.#fits(bytes); node = this.#first) {
          this.#unlink(node);
          this.#gap += 1;
        }
        this.#enqueue(item, bytes);
        return 'dropped';
      case 'block': {
        const { promise, resolve } = Promise.withResolvers<undefined>();
        this.#blocked = {
          item,
          bytes,
          resolve: () => {
            resolve(undefined);
          },
        };
        return promise;
      }
    }
  }

  /**
   * Graceful end: no more events are accepted; queued events (and a waiting
   * `'block'` push) are still delivered, then the iterator is done.
   */
  end(): void {
    if (this.#state !== 'open') return;
    this.#state = 'ending';
    this.#notifyClose();
    this.#settleWaiters();
  }

  /**
   * Abrupt end: queued events are discarded, a waiting `'block'` push is
   * released, and the iterator rejects once with `error`, then is done.
   * Applies while open or ending; once failed or closed, the first reason
   * stands and this does nothing.
   */
  cancel(error: Error): void {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    this.#discard();
    this.#state = 'failed';
    this.#error = error;
    this.#notifyClose();
    this.#settleWaiters();
  }

  #fits(bytes: number): boolean {
    return this.#size < this.#maxEvents && this.#bytes + bytes <= this.#maxBytes;
  }

  #oversized(bytes: number): PushResult {
    if (this.#overflow === 'drop-oldest-with-gap-marker') {
      this.#gap += this.#size + 1;
      this.#clearItems();
      this.#settleWaiters();
      return 'dropped';
    }
    this.#failOverflow(bytes);
    return 'overflow-error';
  }

  #failOverflow(bytes: number): void {
    const info: OverflowInfo = {
      limit: this.#size < this.#maxEvents ? 'bytes' : 'events',
      maxEvents: this.#maxEvents,
      maxBytes: this.#maxBytes,
      queuedEvents: this.#size,
      queuedBytes: this.#bytes,
      eventBytes: bytes,
    };
    this.#state = 'failed';
    this.#error = this.#overflowError(info);
    this.#notifyClose();
    this.#settleWaiters();
  }

  #enqueue(item: T, bytes: number): void {
    const node: Node<T> = { item, bytes, next: undefined };
    if (this.#last === undefined) this.#first = node;
    else this.#last.next = node;
    this.#last = node;
    this.#size += 1;
    this.#bytes += bytes;
  }

  /** Removes `node`, which must be the oldest queued node. */
  #unlink(node: Node<T>): void {
    this.#first = node.next;
    if (this.#first === undefined) this.#last = undefined;
    this.#size -= 1;
    this.#bytes -= node.bytes;
  }

  #clearItems(): void {
    this.#first = undefined;
    this.#last = undefined;
    this.#size = 0;
    this.#bytes = 0;
  }

  #discard(): void {
    this.#clearItems();
    this.#gap = 0;
    const blocked = this.#blocked;
    this.#blocked = undefined;
    blocked?.resolve();
  }

  #admitBlocked(): void {
    const blocked = this.#blocked;
    if (blocked !== undefined && this.#fits(blocked.bytes)) {
      this.#blocked = undefined;
      this.#enqueue(blocked.item, blocked.bytes);
      blocked.resolve();
    }
  }

  #notifyClose(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.#onClose?.();
  }

  #finish(): void {
    this.#state = 'closed';
    if (this.#finishNotified) return;
    this.#finishNotified = true;
    this.#onFinish?.();
  }

  /** Takes the next deliverable result, or `undefined` when the consumer must wait. */
  #take(): IteratorResult<T, undefined> | Error | undefined {
    if (this.#gap > 0) {
      const dropped = this.#gap;
      this.#gap = 0;
      return { done: false, value: this.#gapMarker(dropped) };
    }
    const node = this.#first;
    if (node !== undefined) {
      this.#unlink(node);
      this.#admitBlocked();
      return { done: false, value: node.item };
    }
    const error = this.#error;
    if (error !== undefined) {
      this.#error = undefined;
      this.#finish();
      return error;
    }
    if (this.#state === 'open') return undefined;
    this.#finish();
    return DONE;
  }

  #settleWaiters(): void {
    for (;;) {
      const waiter = this.#waiters[0];
      if (waiter === undefined) return;
      const result = this.#take();
      if (result === undefined) return;
      this.#waiters.shift();
      if (result instanceof Error) waiter.reject(result);
      else waiter.resolve(result);
    }
  }

  #next(): Promise<IteratorResult<T, undefined>> {
    if (this.#waiters.length === 0) {
      const result = this.#take();
      if (result instanceof Error) return Promise.reject(result);
      if (result !== undefined) return Promise.resolve(result);
    }
    if (this.#waiters.length >= this.#maxEvents) {
      return Promise.reject(new RangeError('too many concurrent next() calls on one subscriber'));
    }
    const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<T, undefined>>();
    this.#waiters.push({ resolve, reject });
    return promise;
  }

  #close(): void {
    this.#discard();
    this.#error = undefined;
    this.#notifyClose();
    this.#finish();
    for (const waiter of this.#waiters.splice(0)) waiter.resolve(DONE);
  }

  #return(): Promise<IteratorResult<T, undefined>> {
    this.#close();
    return Promise.resolve(DONE);
  }

  #throw(error: unknown): Promise<never> {
    this.#close();
    // Same as an async generator suspended at its start: it completes and
    // rethrows what it was given.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rethrows the caller's value unchanged, as the iterator protocol does
    return Promise.reject(error);
  }
}
