/**
 * Differential property test for the fanout (ADR-0007): each subscriber of a
 * shared fanout must behave exactly like an independent bounded queue fed
 * with the same events and the same consumer actions. That is the isolation
 * guarantee: no subscriber starves, reorders, drops or fails events for
 * another. Interleavings of publishes, pulls, returns and aborts are injected
 * as operation lists and run deterministically (no timers).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Fanout } from '../../../src/binding/fanout.js';
import type { AbortSignalLike } from '../../../src/binding/fanout.js';
import { BoundedQueue } from '../../../src/binding/queue.js';
import type { OverflowPolicy } from '../../../src/binding/queue.js';
import { abortError, defined, ev, fcParams, flush, gap, overflowError, track } from './support.js';
import type { Ev, Tracked } from './support.js';

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
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.listeners]) listener();
  }
}

interface SubSpec {
  readonly overflow: OverflowPolicy;
  readonly maxEvents: number;
  readonly maxBytes: number;
}

type Op =
  | { readonly t: 'publish'; readonly bytes: number }
  | { readonly t: 'pull'; readonly i: number }
  | { readonly t: 'flush' }
  | { readonly t: 'return'; readonly i: number }
  | { readonly t: 'abort'; readonly i: number };

const subSpecArb: fc.Arbitrary<SubSpec> = fc.record({
  overflow: fc.constantFrom<OverflowPolicy>('error', 'drop-oldest-with-gap-marker', 'block'),
  maxEvents: fc.integer({ min: 1, max: 5 }),
  maxBytes: fc.integer({ min: 1, max: 30 }),
});

const scenarioArb = fc.array(subSpecArb, { minLength: 1, maxLength: 4 }).chain((subs) => {
  const index = fc.nat(subs.length - 1);
  const op: fc.Arbitrary<Op> = fc.oneof(
    { weight: 8, arbitrary: fc.nat(36).map((bytes): Op => ({ t: 'publish', bytes })) },
    { weight: 6, arbitrary: index.map((i): Op => ({ t: 'pull', i })) },
    { weight: 2, arbitrary: fc.constant<Op>({ t: 'flush' }) },
    { weight: 1, arbitrary: index.map((i): Op => ({ t: 'return', i })) },
    { weight: 1, arbitrary: index.map((i): Op => ({ t: 'abort', i })) },
  );
  return fc.record({ subs: fc.constant(subs), ops: fc.array(op, { maxLength: 150 }) });
});

type Outcome =
  | { readonly kind: 'value'; readonly value: Ev }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly name: string; readonly detail: unknown };

function recorder(into: Outcome[]) {
  return (promise: Promise<IteratorResult<Ev, undefined>>): void => {
    promise.then(
      (result) => {
        into.push(result.done === true ? { kind: 'done' } : { kind: 'value', value: result.value });
      },
      (error: unknown) => {
        const e = error as Error & { info?: unknown };
        into.push({ kind: 'error', name: e.name, detail: e.info ?? e.cause });
      },
    );
  };
}

interface Lane {
  readonly spec: SubSpec;
  readonly signal: FakeSignal;
  readonly shared: AsyncIterableIterator<Ev, undefined, undefined>;
  readonly alone: BoundedQueue<Ev>;
  readonly sharedOut: Outcome[];
  readonly aloneOut: Outcome[];
  pulls: number;
}

describe('Fanout properties', () => {
  it('every subscriber behaves exactly like its own independent bounded queue', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ subs, ops }) => {
        const fanout = new Fanout<Ev>({ gapMarker: gap, overflowError, abortError });
        const lanes = subs.map((spec): Lane => {
          const signal = new FakeSignal();
          return {
            spec,
            signal,
            shared: fanout.subscribe({}, { ...spec, signal }),
            alone: new BoundedQueue<Ev>({ ...spec, gapMarker: gap, overflowError }),
            sharedOut: [],
            aloneOut: [],
            pulls: 0,
          };
        });
        let pending: Tracked<void> | undefined;
        let nextId = 0;

        for (const op of ops) {
          switch (op.t) {
            case 'publish': {
              // The producer honours the contract: it waits for a pending publish.
              if (pending?.state === 'pending') break;
              const id = nextId;
              nextId += 1;
              const result = fanout.publish(ev(id), op.bytes);
              for (const lane of lanes) void lane.alone.push(ev(id), op.bytes);
              pending = result === undefined ? undefined : track(result);
              break;
            }
            case 'pull': {
              const lane = defined(lanes[op.i]);
              // Stay under the concurrent-pull cap on both sides alike.
              if (lane.pulls >= lane.spec.maxEvents) break;
              lane.pulls += 1;
              const done = (): void => {
                lane.pulls -= 1;
              };
              const sharedNext = lane.shared.next();
              recorder(lane.sharedOut)(sharedNext);
              recorder(lane.aloneOut)(lane.alone.iterator().next());
              sharedNext.then(done, done);
              break;
            }
            case 'flush':
              await flush();
              break;
            case 'return': {
              const lane = defined(lanes[op.i]);
              await lane.shared.return?.();
              await lane.alone.iterator().return?.();
              break;
            }
            case 'abort': {
              const lane = defined(lanes[op.i]);
              const reason = `abort-${String(op.i)}`;
              lane.signal.abort(reason);
              lane.alone.cancel(abortError(reason));
              break;
            }
          }
          expect(fanout.subscriberCount).toBe(lanes.filter((l) => l.alone.accepting).length);
        }

        await flush();
        fanout.close();
        for (const lane of lanes) {
          lane.alone.end();
          for (let guard = 0; guard < 1000; guard += 1) {
            await flush();
            recorder(lane.sharedOut)(lane.shared.next());
            recorder(lane.aloneOut)(lane.alone.iterator().next());
            await flush();
            if (lane.aloneOut.at(-1)?.kind === 'done') break;
          }
        }
        await flush();
        for (const lane of lanes) {
          expect(lane.sharedOut).toEqual(lane.aloneOut);
          expect(lane.signal.listeners.size).toBe(0);
        }
        if (pending !== undefined) expect(pending.state).toBe('fulfilled');
        expect(fanout.subscriberCount).toBe(0);
        expect(fanout.publishPending).toBe(false);
      }),
      fcParams(300),
    );
  });
});
