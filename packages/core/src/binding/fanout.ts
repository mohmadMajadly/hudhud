/**
 * Event broadcast to independent bounded subscribers (ADR-0007, ADR-0003).
 *
 * @remarks
 * The producer (the session driver) publishes each event once; every live
 * subscriber whose selection matches gets it in its own {@link BoundedQueue}.
 * Subscribers are isolated from each other: an overflow, a throwing
 * predicate, an abort or a `return()` affects only that subscriber's queue,
 * and one subscriber's events are never visible to, reordered for or dropped
 * for another.
 *
 * The one deliberate exception is `'block'`: a publish that reaches a full
 * `'block'` subscriber returns a promise, and a producer that waits for it
 * delays every later event for every subscriber, including the dispatch of
 * control frames. `'block'` can stall control frames; it is opt-in and
 * documented as dangerous (ADR-0007). The events of the current publish have
 * already reached every other subscriber when the promise is returned.
 *
 * Ordering: each subscriber receives the events it selected in publish order;
 * a subscriber that joins late receives its replay entries first and then the
 * events published after it subscribed (never the event being delivered while
 * it subscribed).
 *
 * Memory: the subscriber set holds only live subscribers (a subscriber leaves
 * it synchronously when its queue stops accepting); each queue is bounded as
 * documented in `queue.ts`; at most one publish can be pending; an abort
 * listener stays on the caller's signal only until that consumer is finished
 * (it saw the end, returned or threw), so an abort can still stop the delivery
 * of events queued before an end.
 *
 * The fanout is harness-neutral and generic in the event type: the gap marker,
 * the overflow error and the abort error are built by injected factories.
 *
 * @internal
 */

import {
  BoundedQueue,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_EVENTS,
  DEFAULT_OVERFLOW,
  assertEventBytes,
  assertLimit,
  assertOverflowPolicy,
} from './queue.js';
import type { OverflowInfo, OverflowPolicy } from './queue.js';

/**
 * The part of `AbortSignal` the fanout uses. A standard `AbortSignal`
 * satisfies it.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * Per-subscriber limits and policy (§2.2 `SubscriberOptions`).
 *
 * @remarks
 * `overflow: 'block'` can stall control frames (ADR-0007).
 */
export interface SubscriberOptions {
  /** Default 10,000. */
  readonly maxEvents?: number;
  /** Default 67,108,864 (64 MiB). */
  readonly maxBytes?: number;
  /** Default `'error'`; `'block'` can stall control frames. */
  readonly overflow?: OverflowPolicy;
  /** Aborting ends the subscription; its iterator rejects once with the abort error. */
  readonly signal?: AbortSignalLike;
}

/** An event with its declared byte size. */
export interface SizedEvent<E> {
  readonly event: E;
  readonly bytes: number;
}

/** Which events a subscriber receives. */
export interface Selection<E> {
  /** Receive only events for which this returns true (turn filters). Default: all. */
  readonly match?: (event: E) => boolean;
  /**
   * End the subscription gracefully right after delivering a selected event
   * for which this returns true (for example a turn's `turn.completed`).
   */
  readonly endAfter?: (event: E) => boolean;
  /**
   * Events queued for this subscriber before any live event (compat replay,
   * K20). They are not passed through `match` and must fit the limits.
   */
  readonly replay?: readonly SizedEvent<E>[];
}

/** Factories injected by the binding that owns the event vocabulary. */
export interface FanoutDeps<E> {
  /** Builds a gap marker event for `dropped` events. */
  readonly gapMarker: (dropped: number) => E;
  /** Builds the subscriber-scoped overflow error (`SUBSCRIBER_OVERFLOW`). */
  readonly overflowError: (info: OverflowInfo) => Error;
  /** Builds the abort error (`ABORTED`) from `signal.reason`. */
  readonly abortError: (reason: unknown) => Error;
}

interface Subscriber<E> {
  readonly queue: BoundedQueue<E>;
  readonly match: ((event: E) => boolean) | undefined;
  readonly endAfter: ((event: E) => boolean) | undefined;
}

/** Wraps a non-`Error` value thrown by a predicate. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('subscriber predicate threw', { cause: value });
}

/**
 * Validates subscriber options given as untyped input and fills defaults.
 *
 * @throws RangeError or TypeError for an invalid limit or policy.
 */
export function resolveSubscriberOptions(
  options: SubscriberOptions,
): Required<Omit<SubscriberOptions, 'signal'>> {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const overflow = options.overflow ?? DEFAULT_OVERFLOW;
  assertLimit('maxEvents', maxEvents);
  assertLimit('maxBytes', maxBytes);
  assertOverflowPolicy(overflow);
  return { maxEvents, maxBytes, overflow };
}

/**
 * Broadcasts events to bounded, isolated subscribers.
 *
 * @typeParam E - the event type.
 */
export class Fanout<E> {
  readonly #deps: FanoutDeps<E>;
  readonly #subscribers = new Set<Subscriber<E>>();
  #pending: Promise<void> | undefined;
  #closed = false;

  constructor(deps: FanoutDeps<E>) {
    this.#deps = deps;
  }

  /** Live subscribers (those whose queue still accepts events). */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** Whether {@link Fanout.close} was called. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Whether a publish is waiting for a `'block'` subscriber. */
  get publishPending(): boolean {
    return this.#pending !== undefined;
  }

  /**
   * Adds a subscriber. Events published from now on that match the selection
   * are queued for it; after {@link Fanout.close} the iterator yields the
   * replay entries and is done.
   *
   * @throws RangeError or TypeError for invalid options or replay entries
   * that do not fit the limits.
   */
  subscribe(
    selection: Selection<E> = {},
    options: SubscriberOptions = {},
  ): AsyncIterableIterator<E, undefined, undefined> {
    const limits = resolveSubscriberOptions(options);
    const replay = selection.replay ?? [];
    let replayBytes = 0;
    for (const entry of replay) {
      assertEventBytes(entry.bytes);
      replayBytes += entry.bytes;
    }
    if (replay.length > limits.maxEvents || replayBytes > limits.maxBytes) {
      throw new RangeError('replay events do not fit the subscriber limits');
    }

    const signal = options.signal;
    const abort = (reason: unknown): void => {
      queue.cancel(this.#deps.abortError(reason));
    };
    let detach = (): void => {
      // Replaced below when a signal listener is registered.
    };
    const queue: BoundedQueue<E> = new BoundedQueue<E>({
      ...limits,
      gapMarker: this.#deps.gapMarker,
      overflowError: this.#deps.overflowError,
      onClose: () => {
        this.#subscribers.delete(subscriber);
      },
      // The signal stays attached until the consumer is finished, so an abort
      // also stops the delivery of events still queued after an end.
      onFinish: () => {
        detach();
      },
    });
    const subscriber: Subscriber<E> = {
      queue,
      match: selection.match,
      endAfter: selection.endAfter,
    };

    // Replay always fits (checked above), so every push returns 'ok'.
    for (const entry of replay) void queue.push(entry.event, entry.bytes);

    if (signal?.aborted === true) {
      abort(signal.reason);
    } else if (this.#closed) {
      queue.end();
    } else {
      this.#subscribers.add(subscriber);
      if (signal !== undefined) {
        const onAbort = (): void => {
          abort(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        detach = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }
    }
    return queue.iterator();
  }

  /**
   * Delivers one event to every live, matching subscriber.
   *
   * @returns `undefined` when every subscriber took the event; a promise when
   * a `'block'` subscriber is full. The producer must wait for that promise
   * before the next publish. It never rejects.
   * @throws RangeError when `bytes` is not a non-negative safe integer.
   * @throws Error after {@link Fanout.close}, or while an earlier publish is
   * still pending.
   */
  publish(event: E, bytes: number): Promise<void> | undefined {
    assertEventBytes(bytes);
    if (this.#closed) throw new Error('Fanout.publish called after close');
    if (this.#pending !== undefined) {
      throw new Error('Fanout.publish called while an earlier publish is still pending');
    }
    const waits: Promise<void>[] = [];
    // Snapshot: subscribers added during delivery do not see this event;
    // subscribers that leave during delivery are skipped below.
    for (const subscriber of [...this.#subscribers]) {
      const { queue } = subscriber;
      if (!queue.accepting) continue;
      let selected: boolean;
      let last: boolean;
      try {
        selected = subscriber.match === undefined || subscriber.match(event);
        last = selected && subscriber.endAfter?.(event) === true;
      } catch (error) {
        queue.cancel(toError(error));
        continue;
      }
      if (!selected) continue;
      const result = queue.push(event, bytes);
      if (typeof result !== 'string') waits.push(result);
      if (last) queue.end();
    }
    if (waits.length === 0) return undefined;
    const pending = Promise.all(waits).then(() => {
      this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }

  /**
   * Ends every subscription gracefully: queued events are still delivered,
   * then each iterator is done. Later publishes throw; later subscribers get
   * only their replay entries. Idempotent.
   */
  close(): void {
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) subscriber.queue.end();
  }
}
