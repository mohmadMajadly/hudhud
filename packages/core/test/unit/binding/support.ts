/**
 * Shared helpers for the queue and fanout tests. Deterministic: no timers;
 * progress is made only by draining the microtask queue.
 */

import type { OverflowInfo } from '../../../src/binding/queue.js';

/** Test event: a numbered event or a gap marker. */
export type Ev = { readonly kind: 'ev'; readonly id: number } | GapEv;
export interface GapEv {
  readonly kind: 'gap';
  readonly dropped: number;
}

export const ev = (id: number): Ev => ({ kind: 'ev', id });
export const gap = (dropped: number): Ev => ({ kind: 'gap', dropped });

/** Typed overflow error used in place of the binding's `SubscriberOverflowError`. */
export class TestOverflowError extends Error {
  override readonly name = 'TestOverflowError';
  readonly code = 'SUBSCRIBER_OVERFLOW';
  readonly info: OverflowInfo;
  constructor(info: OverflowInfo) {
    super('subscriber overflow');
    this.info = info;
  }
}

/** Typed abort error used in place of the binding's `AbortError`. */
export class TestAbortError extends Error {
  override readonly name = 'AbortError';
  readonly code = 'ABORTED';
  constructor(reason: unknown) {
    super('aborted', { cause: reason });
  }
}

export const overflowError = (info: OverflowInfo): Error => new TestOverflowError(info);
export const abortError = (reason: unknown): Error => new TestAbortError(reason);

/** Drains pending microtasks (enough for every promise chain in these modules). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}

/** Observable settlement state of a promise. */
export interface Tracked<T> {
  readonly promise: Promise<T>;
  state: 'pending' | 'fulfilled' | 'rejected';
  value?: T;
  error?: unknown;
}

export function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { promise, state: 'pending' };
  promise.then(
    (value) => {
      tracked.state = 'fulfilled';
      tracked.value = value;
    },
    (error: unknown) => {
      tracked.state = 'rejected';
      tracked.error = error;
    },
  );
  return tracked;
}

/**
 * Checks a delivered stream against the pushed ids under drop-oldest
 * semantics: every delivered event is the next surviving id, and each gap
 * marker skips exactly the ids it reports. Returns how many pushed ids are
 * not yet accounted for (still queued or pending in an unreported gap).
 */
export function replayAgainst(pushed: readonly number[], delivered: readonly Ev[]): number {
  let index = 0;
  for (const item of delivered) {
    if (item.kind === 'gap') {
      if (item.dropped < 1) throw new Error('empty gap marker');
      index += item.dropped;
    } else {
      if (pushed[index] !== item.id) {
        throw new Error(`expected id ${String(pushed[index])}, got ${String(item.id)}`);
      }
      index += 1;
    }
    if (index > pushed.length) throw new Error('gap markers report more than was pushed');
  }
  return pushed.length - index;
}

const seedEnv = process.env['FC_SEED'];

/**
 * fast-check parameters: `numRuns`, plus `FC_SEED` from the environment to
 * reproduce a reported failure (fast-check prints the seed on failure).
 */
export function fcParams(numRuns: number): { numRuns: number; seed?: number } {
  return seedEnv === undefined ? { numRuns } : { numRuns, seed: Number(seedEnv) };
}

/** Narrows away `undefined`, failing the test when the value is missing. */
export function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('unexpectedly undefined');
  return value;
}
