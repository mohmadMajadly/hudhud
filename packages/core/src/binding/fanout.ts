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
 * documented in `queue.ts`; at most one publish can be pending; the fanout's
 * abort listener stays on the subscription's signal only until that consumer
 * is finished (it saw the end, returned or threw), so an abort can still stop
 * the delivery of events queued before an end. Producers pass a
 * {@link LinkedSignal} there, never the application's own signal: it lets go
 * of the application's signals as soon as the subscription stops accepting
 * (`Selection.onClose`), so an application signal that outlives the session
 * retains nothing of it.
 *
 * Byte accounting: an event counts its declared bytes against `maxBytes`;
 * events derived from one input can share that input's bytes
 * ({@link SharedBytes}), so a subscriber is charged the input once.
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
 * satisfies it; tests use a controllable fake.
 *
 * @beta
 */
export interface AbortSignalLike {
  /** Whether the signal aborted. */
  readonly aborted: boolean;
  /** The abort reason. */
  readonly reason: unknown;
  /** Registers the abort listener. */
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  /** Removes the abort listener. */
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * The abort signal of one subscription, linked to the application's signals
 * (ADR-0007).
 *
 * @remarks
 * It follows its parents (aborting one aborts it with that parent's reason)
 * only while the subscription accepts events: once it stopped (`unlink`, for
 * example from {@link Selection.onClose}), it lets go of them, so a
 * long-lived application signal holds no listener, and through it no queue,
 * of a subscription that ended (R4-5). A parent that aborts after that is
 * still seen: `poll()`, called before each delivery, aborts the signal then,
 * so the events still queued are not delivered after the abort. Its owner can
 * abort it directly (`abort`). The listener the fanout adds is kept until the
 * fanout removes it (the consumer finished); that removal releases the
 * signal (`onRelease`).
 *
 * @beta
 */
export class LinkedSignal implements AbortSignalLike {
  /** Whether the signal aborted. */
  aborted = false;
  /** The abort reason. */
  reason: unknown;
  readonly #parents: readonly AbortSignal[];
  readonly #listeners = new Set<() => void>();
  readonly #onRelease: () => void;
  #unlinks: (() => void)[] = [];
  #released = false;

  /**
   * @param parents - the application's signals; `undefined` entries are skipped.
   * @param onRelease - called once when the signal aborted or its last
   *   listener was removed.
   */
  constructor(
    parents: readonly (AbortSignal | undefined)[],
    onRelease: () => void = () => undefined,
  ) {
    this.#parents = parents.filter((parent): parent is AbortSignal => parent !== undefined);
    this.#onRelease = onRelease;
    const aborted = this.#parents.find((parent) => parent.aborted);
    if (aborted !== undefined) {
      this.aborted = true;
      this.reason = aborted.reason;
      return;
    }
    for (const parent of this.#parents) {
      const fromParent = (): void => {
        this.abort(parent.reason);
      };
      parent.addEventListener('abort', fromParent, { once: true });
      this.#unlinks.push(() => {
        parent.removeEventListener('abort', fromParent);
      });
    }
  }

  /** Registers the abort listener. */
  addEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners.add(listener);
  }

  /** Removes the abort listener and releases the signal. */
  removeEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners.delete(listener);
    this.#release();
  }

  /** Aborts the signal (once) and calls its listeners. */
  abort(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    this.#release();
    for (const listener of [...this.#listeners]) listener();
  }

  /** Stops following the parents; {@link LinkedSignal.poll} still sees their abort. */
  unlink(): void {
    const unlinks = this.#unlinks;
    this.#unlinks = [];
    for (const unlink of unlinks) unlink();
  }

  /** Aborts the signal when a parent aborted (after `unlink` no listener tells it). */
  poll(): void {
    if (this.aborted) return;
    const aborted = this.#parents.find((parent) => parent.aborted);
    if (aborted !== undefined) this.abort(aborted.reason);
  }

  #release(): void {
    this.unlink();
    if (this.#released) return;
    this.#released = true;
    this.#onRelease();
  }
}

/**
 * Per-subscriber limits and policy (plan §2.2, ADR-0007).
 *
 * @remarks
 * `overflow: 'block'` can stall control frames (ADR-0007).
 *
 * @public
 */
export interface SubscriberOptions {
  /** Default 10,000. */
  readonly maxEvents?: number;
  /** Default 67,108,864 (64 MiB). */
  readonly maxBytes?: number;
  /** Default `'error'`; `'block'` can stall control frames. */
  readonly overflow?: OverflowPolicy;
  /** Aborting ends the subscription; its iterator rejects once with the abort error. */
  readonly signal?: AbortSignal;
}

/**
 * {@link SubscriberOptions} as the fanout consumes them: any signal with the
 * `AbortSignal` members it uses.
 *
 * @beta
 */
export interface FanoutSubscriberOptions extends Omit<SubscriberOptions, 'signal'> {
  /** Aborting ends the subscription; its iterator rejects once with the abort error. */
  readonly signal?: AbortSignalLike;
}

/**
 * An event with its declared byte size.
 *
 * @beta
 */
export interface SizedEvent<E> {
  /** The event. */
  readonly event: E;
  /** Its declared byte size (counted against maxBytes). */
  readonly bytes: number;
}

/**
 * Which events a subscriber receives.
 *
 * @beta
 */
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
  /**
   * Called once, synchronously, when the subscription stops accepting events
   * (it ended, overflowed, was aborted, or its consumer returned), possibly
   * before its consumer took the events still queued.
   */
  readonly onClose?: () => void;
}

/**
 * Events derived from one input share its bytes (ADR-0007, R4-3): a
 * subscriber is charged the input's bytes for the first of these events it
 * takes and `siblingBytes` for each later one.
 *
 * @beta
 */
export interface SharedBytes {
  /** Identifies the input; compared by identity. */
  readonly key: object;
  /** What each later event of the same input is charged. */
  readonly siblingBytes: number;
}

/**
 * Factories injected by the binding that owns the event vocabulary.
 *
 * @beta
 */
export interface FanoutDeps<E> {
  /** Builds a gap marker event for `dropped` events; `first` is the oldest event dropped. */
  readonly gapMarker: (dropped: number, first: E) => E;
  /**
   * How many events an event stands for in a gap count (a gap marker in a
   * replay stands for the events it reports); at least 1. Default 1.
   */
  readonly count?: (event: E) => number;
  /** Builds the subscriber-scoped overflow error (`SUBSCRIBER_OVERFLOW`). */
  readonly overflowError: (info: OverflowInfo) => Error;
  /** Builds the abort error (`ABORTED`) from `signal.reason`. */
  readonly abortError: (reason: unknown) => Error;
}

interface Subscriber<E> {
  readonly queue: BoundedQueue<E>;
  readonly match: ((event: E) => boolean) | undefined;
  readonly endAfter: ((event: E) => boolean) | undefined;
  readonly maxBytes: number;
  /** The input of the last shared-bytes event this subscriber was charged for in full. */
  lastShared: object | undefined;
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
  options: FanoutSubscriberOptions,
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
 * @beta
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
    options: FanoutSubscriberOptions = {},
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
    const onClose = selection.onClose;
    const queue: BoundedQueue<E> = new BoundedQueue<E>({
      ...limits,
      gapMarker: this.#deps.gapMarker,
      ...(this.#deps.count === undefined ? {} : { count: this.#deps.count }),
      overflowError: this.#deps.overflowError,
      onClose: () => {
        this.#subscribers.delete(subscriber);
        onClose?.();
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
      maxBytes: limits.maxBytes,
      lastShared: undefined,
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
   * @param shared - the event was derived from an input other events share:
   *   a subscriber that already took an event of the same input (the last
   *   shared input it took) is charged `shared.siblingBytes` instead of
   *   `bytes`, so one input counts once per subscriber (ADR-0007).
   * @returns `undefined` when every subscriber took the event; a promise when
   * a `'block'` subscriber is full. The producer must wait for that promise
   * before the next publish. It never rejects.
   * @throws RangeError when `bytes` is not a non-negative safe integer.
   * @throws Error after {@link Fanout.close}, or while an earlier publish is
   * still pending.
   */
  publish(event: E, bytes: number, shared?: SharedBytes): Promise<void> | undefined {
    assertEventBytes(bytes);
    if (shared !== undefined) assertEventBytes(shared.siblingBytes);
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
      let charge = bytes;
      if (shared !== undefined) {
        if (subscriber.lastShared === shared.key) charge = shared.siblingBytes;
        // An input larger than the whole budget never enters the queue (it is
        // refused or dropped whole), so it is charged in full to every event.
        else if (bytes <= subscriber.maxBytes) subscriber.lastShared = shared.key;
      }
      const result = queue.push(event, charge);
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
