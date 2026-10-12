/**
 * Property tests for the bounded queue (ADR-0007, plan §4.2): random
 * producer/consumer interleavings are injected as explicit operation lists and
 * executed deterministically (microtask draining only, no timers).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BoundedQueue } from '../../../src/binding/queue.js';
import type { OverflowPolicy } from '../../../src/binding/queue.js';
import {
  TestOverflowError,
  ev,
  fcParams,
  flush,
  gap,
  overflowError,
  replayAgainst,
  track,
} from './support.js';
import type { Ev, Tracked } from './support.js';

type Op =
  | { readonly t: 'push'; readonly bytes: number }
  | { readonly t: 'pull' }
  | { readonly t: 'flush' }
  | { readonly t: 'return' };

const opArb = (maxBytes: number, withReturn: boolean): fc.Arbitrary<Op> =>
  fc.oneof(
    {
      weight: 6,
      arbitrary: fc
        .nat(maxBytes + Math.ceil(maxBytes / 4))
        .map((bytes): Op => ({ t: 'push', bytes })),
    },
    { weight: 4, arbitrary: fc.constant<Op>({ t: 'pull' }) },
    { weight: 2, arbitrary: fc.constant<Op>({ t: 'flush' }) },
    { weight: withReturn ? 1 : 0, arbitrary: fc.constant<Op>({ t: 'return' }) },
  );

const scenarioArb = (withReturn: boolean) =>
  fc
    .record({
      maxEvents: fc.integer({ min: 1, max: 6 }),
      maxBytes: fc.integer({ min: 1, max: 40 }),
    })
    .chain((limits) =>
      fc.record({
        maxEvents: fc.constant(limits.maxEvents),
        maxBytes: fc.constant(limits.maxBytes),
        ops: fc.array(opArb(limits.maxBytes, withReturn), { maxLength: 120 }),
      }),
    );

type Outcome =
  | { readonly kind: 'value'; readonly value: Ev }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly error: unknown };

interface RunResult {
  readonly pushed: number[];
  readonly outcomes: Outcome[];
  readonly pushResults: string[];
  readonly closeCalls: number;
  readonly queue: BoundedQueue<Ev>;
}

async function run(
  overflow: OverflowPolicy,
  scenario: { maxEvents: number; maxBytes: number; ops: readonly Op[] },
): Promise<RunResult> {
  let closeCalls = 0;
  const queue = new BoundedQueue<Ev>({
    maxEvents: scenario.maxEvents,
    maxBytes: scenario.maxBytes,
    overflow,
    gapMarker: gap,
    overflowError,
    onClose: () => {
      closeCalls += 1;
    },
  });
  const iterator = queue.iterator();
  const pushed: number[] = [];
  const pushResults: string[] = [];
  const outcomes: Outcome[] = [];
  let nextId = 0;
  let blocked: Tracked<void> | undefined;

  const record = (promise: Promise<IteratorResult<Ev, undefined>>): void => {
    promise.then(
      (result) => {
        outcomes.push(
          result.done === true ? { kind: 'done' } : { kind: 'value', value: result.value },
        );
      },
      (error: unknown) => {
        outcomes.push({ kind: 'error', error });
      },
    );
  };

  const checkBounds = (): void => {
    expect(queue.size).toBeLessThanOrEqual(scenario.maxEvents);
    expect(queue.bytes).toBeLessThanOrEqual(scenario.maxBytes);
    expect(queue.bytes).toBeGreaterThanOrEqual(0);
    expect(queue.pendingPulls).toBeLessThanOrEqual(scenario.maxEvents);
  };

  for (const op of scenario.ops) {
    switch (op.t) {
      case 'push': {
        // The producer honours the 'block' contract: it waits for a pending push.
        if (blocked?.state === 'pending') break;
        const id = nextId;
        nextId += 1;
        const result = queue.push(ev(id), op.bytes);
        if (typeof result === 'string') {
          pushResults.push(result);
          if (result === 'ok' || result === 'dropped') pushed.push(id);
        } else {
          pushResults.push('blocked');
          pushed.push(id);
          blocked = track(result);
        }
        break;
      }
      case 'pull':
        if (queue.pendingPulls < scenario.maxEvents) record(iterator.next());
        break;
      case 'flush':
        await flush();
        break;
      case 'return':
        record(iterator.return?.() ?? Promise.reject(new Error('no return')));
        break;
    }
    checkBounds();
    expect(queue.blocked ? 1 : 0).toBeLessThanOrEqual(1);
  }

  // Wind down: no more events; drain everything that is left.
  await flush();
  queue.end();
  for (let guard = 0; guard < 10_000; guard += 1) {
    await flush();
    const last = outcomes.at(-1);
    if (last?.kind === 'done' && queue.pendingPulls === 0) break;
    record(iterator.next());
    checkBounds();
  }
  await flush();
  if (blocked !== undefined) expect(blocked.state).toBe('fulfilled');
  return { pushed, outcomes, pushResults, closeCalls, queue };
}

function values(outcomes: readonly Outcome[]): Ev[] {
  return outcomes.flatMap((o) => (o.kind === 'value' ? [o.value] : []));
}

function errors(outcomes: readonly Outcome[]): unknown[] {
  return outcomes.flatMap((o) => (o.kind === 'error' ? [o.error] : []));
}

describe('BoundedQueue properties', () => {
  it("'error': bounds hold, order is preserved, the overflow surfaces exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb(false), async (scenario) => {
        const { pushed, outcomes, pushResults, closeCalls, queue } = await run('error', scenario);
        const overflows = pushResults.filter((r) => r === 'overflow-error').length;
        expect(overflows).toBeLessThanOrEqual(1);
        expect(pushResults).not.toContain('dropped');
        expect(pushResults).not.toContain('blocked');
        // Nothing is accepted after the overflow.
        const at = pushResults.indexOf('overflow-error');
        if (at >= 0) expect(pushResults.slice(at + 1).every((r) => r === 'closed')).toBe(true);
        // Every accepted event is delivered, in order, without gaps.
        expect(values(outcomes)).toEqual(pushed.map(ev));
        const errs = errors(outcomes);
        expect(errs).toHaveLength(overflows);
        for (const error of errs) expect(error).toBeInstanceOf(TestOverflowError);
        // The error comes after every value, and only "done" follows it.
        if (overflows === 1) {
          const errorAt = outcomes.findIndex((o) => o.kind === 'error');
          expect(outcomes.slice(errorAt + 1).every((o) => o.kind === 'done')).toBe(true);
        }
        expect(closeCalls).toBe(1);
        expect(queue.state).toBe('closed');
      }),
      fcParams(500),
    );
  });

  it("'drop-oldest-with-gap-marker': bounds hold, order is preserved, gaps count exactly", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb(false), async (scenario) => {
        const { pushed, outcomes, pushResults, closeCalls } = await run(
          'drop-oldest-with-gap-marker',
          scenario,
        );
        expect(errors(outcomes)).toEqual([]);
        expect(pushResults.every((r) => r === 'ok' || r === 'dropped')).toBe(true);
        const delivered = values(outcomes);
        // Every pushed event is either delivered in order or reported by exactly one gap.
        expect(replayAgainst(pushed, delivered)).toBe(0);
        const reported = delivered.reduce((n, e) => n + (e.kind === 'gap' ? e.dropped : 0), 0);
        const deliveredEvents = delivered.filter((e) => e.kind === 'ev').length;
        expect(reported + deliveredEvents).toBe(pushed.length);
        expect(reported > 0).toBe(pushResults.includes('dropped'));
        expect(closeCalls).toBe(1);
      }),
      fcParams(500),
    );
  });

  it("'block': bounds hold, nothing is lost or reordered, at most one push waits", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb(false), async (scenario) => {
        const { pushed, outcomes, pushResults, closeCalls } = await run('block', scenario);
        expect(pushResults).not.toContain('dropped');
        const overflows = pushResults.filter((r) => r === 'overflow-error').length;
        expect(overflows).toBeLessThanOrEqual(1);
        // Only an event larger than the whole budget fails a 'block' queue.
        expect(values(outcomes)).toEqual(pushed.map(ev));
        expect(errors(outcomes)).toHaveLength(overflows);
        expect(closeCalls).toBe(1);
      }),
      fcParams(500),
    );
  });

  it.each<OverflowPolicy>(['error', 'drop-oldest-with-gap-marker', 'block'])(
    "'%s': return() at any point releases everything and ends every pending pull",
    async (overflow) => {
      await fc.assert(
        fc.asyncProperty(scenarioArb(true), async (scenario) => {
          const { pushed, outcomes, closeCalls, queue } = await run(overflow, scenario);
          expect(closeCalls).toBe(1);
          expect(queue.size).toBe(0);
          expect(queue.bytes).toBe(0);
          expect(queue.pendingGap).toBe(0);
          expect(queue.pendingPulls).toBe(0);
          expect(queue.blocked).toBe(false);
          // Whatever was delivered is still an in-order prefix (with exact gaps).
          expect(replayAgainst(pushed, values(outcomes))).toBeGreaterThanOrEqual(0);
          // Once done, an iterator stays done.
          const firstDone = outcomes.findIndex((o) => o.kind === 'done');
          expect(outcomes.slice(firstDone).every((o) => o.kind === 'done')).toBe(true);
        }),
        fcParams(300),
      );
    },
  );
});
