/**
 * Time, timers and ids of the binding layer (ADR-0006, plan §1.6).
 *
 * @remarks
 * The machines never read ambient time or randomness: the binding stamps
 * every input with its clock and generates every UUID. Everything here is
 * injected into the driver, so tests run on a {@link ManualClock} and
 * deterministic ids, never on real timers.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/**
 * The binding's clock and one-shot timers.
 *
 * @remarks
 * `nowMs` is monotonic (it never goes back); `nowIso` is the same instant as
 * an ISO-8601 timestamp. `schedule` is the only way the binding waits for
 * time: the returned function cancels the timer; calling it after the timer
 * fired, or twice, does nothing.
 *
 * @beta
 */
export interface Clock {
  /** Monotonic milliseconds (any epoch; only differences carry meaning). */
  nowMs(): number;
  /** The instant of {@link Clock.nowMs} as an ISO-8601 timestamp. */
  nowIso(): string;
  /** Calls `callback` once after `ms` milliseconds; returns the cancel function. */
  schedule(ms: number, callback: () => void): () => void;
}

/**
 * Source of the UUIDs the binding hands to a machine (turn ids, ADR-0008 §4:
 * a fresh one for every send, never reused).
 *
 * @beta
 */
export interface IdSource {
  uuid(): string;
}

/**
 * The real clock: `performance.timeOrigin + performance.now()`, so the
 * milliseconds are monotonic and still map to wall-clock ISO timestamps;
 * timers are Node timers. Timers keep the event loop alive while armed: a
 * session that waits for a deadline must not let the host exit under it.
 *
 * @beta
 */
export const systemClock: Clock = Object.freeze({
  nowMs: (): number => performance.timeOrigin + performance.now(),
  nowIso: (): string => new Date(performance.timeOrigin + performance.now()).toISOString(),
  schedule: (ms: number, callback: () => void): (() => void) => {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
});

/**
 * Random v4 UUIDs from `crypto.randomUUID` (a CSPRNG).
 *
 * @beta
 */
export const cryptoIds: IdSource = Object.freeze({ uuid: (): string => randomUUID() });

/**
 * Deterministic UUID-shaped ids `00000000-0000-4000-8000-<n as 12 hex>`, for
 * the loopback binding and tests: the same run produces the same ids.
 *
 * @beta
 */
export function counterIds(start = 1): IdSource {
  let next = start;
  return {
    uuid: (): string => {
      const id = `00000000-0000-4000-8000-${next.toString(16).padStart(12, '0')}`;
      next += 1;
      return id;
    },
  };
}

interface ManualTimer {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/**
 * Virtual time for deterministic tests and replays: time moves only when
 * {@link ManualClock.advance} or {@link ManualClock.fireNext} is called, and
 * timers fire in deadline order (ties in scheduling order). Callbacks run
 * synchronously inside those calls.
 *
 * @beta
 */
export class ManualClock implements Clock {
  #now: number;
  #order = 0;
  #timers: ManualTimer[] = [];
  /** Entries of `#timers` that were cancelled or fired since it was last compacted. */
  #dead = 0;

  /** @param startMs - the start time in milliseconds since the epoch (default 2026-01-01T00:00:00Z). */
  constructor(startMs: number = Date.UTC(2026, 0, 1)) {
    this.#now = startMs;
  }

  nowMs(): number {
    return this.#now;
  }

  nowIso(): string {
    return new Date(this.#now).toISOString();
  }

  schedule(ms: number, callback: () => void): () => void {
    const timer: ManualTimer = {
      at: this.#now + Math.max(0, ms),
      order: this.#order++,
      callback,
      cancelled: false,
    };
    this.#timers.push(timer);
    return () => {
      this.#retire(timer);
    };
  }

  /**
   * Marks a timer cancelled (or fired). The list is compacted once most of
   * it is dead, so a session that re-arms a timer on every frame without
   * advancing time keeps only its live timers (amortized O(1) per timer).
   */
  #retire(timer: ManualTimer): void {
    if (timer.cancelled) return;
    timer.cancelled = true;
    this.#dead += 1;
    if (this.#dead > 64 && this.#dead * 2 > this.#timers.length) {
      this.#timers = this.#timers.filter((other) => !other.cancelled);
      this.#dead = 0;
    }
  }

  /** Armed timers that have neither fired nor been cancelled. */
  get pending(): number {
    return this.#timers.filter((timer) => !timer.cancelled).length;
  }

  /** The deadline of the earliest armed timer, or `undefined`. */
  get nextAt(): number | undefined {
    return this.#live()[0]?.at;
  }

  /** Fires the earliest armed timer, moving time to its deadline; false when none is armed. */
  fireNext(): boolean {
    const next = this.#live()[0];
    if (next === undefined) return false;
    this.#retire(next);
    this.#now = Math.max(this.#now, next.at);
    next.callback();
    return true;
  }

  /** Moves time forward by `ms`, firing every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const target = this.#now + Math.max(0, ms);
    for (let next = this.#live()[0]; next !== undefined && next.at <= target;) {
      this.fireNext();
      next = this.#live()[0];
    }
    this.#now = target;
  }

  #live(): ManualTimer[] {
    this.#timers = this.#timers
      .filter((timer) => !timer.cancelled)
      .sort((a, b) => a.at - b.at || a.order - b.order);
    this.#dead = 0;
    return this.#timers;
  }
}
