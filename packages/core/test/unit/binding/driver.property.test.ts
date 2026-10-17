// Property test of the driver (plan §4.2 `binding/driver`: microtask-order
// permutations). fast-check generates interleavings of application calls,
// harness output, permission-handler answers, clock moves and microtask
// drains of random depth; every run ends with a dispose. Checked on every
// run: no re-entrancy, every turn and control settles exactly once, every
// permission request is answered at most once and never after its
// withdrawal, the event stream is gapless, nothing is left held, and nothing
// escapes as an unhandled rejection. The seed is in the test name;
// FC_SEED reproduces a run.

import process from 'node:process';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PermissionDecision } from '../../../src/binding/permission-bridge.js';
import type { HudhudEvent } from '../../../src/protocol/events/types.js';
import { rig, text, type Rig } from './driver-support.js';
import { TEST_CONFIG } from './test-machine.js';

type Action =
  | { readonly kind: 'send'; readonly iterate: boolean }
  | { readonly kind: 'say' | 'result' | 'drop' | 'interrupt'; readonly target: number }
  | { readonly kind: 'ask' }
  | { readonly kind: 'withdraw'; readonly target: number }
  | {
      readonly kind: 'answer';
      readonly target: number;
      readonly how: 'allow' | 'deny' | 'throw' | 'invalid';
    }
  | { readonly kind: 'mode'; readonly mode: 'plan' | 'bad' | 'wait' }
  | { readonly kind: 'ack' }
  | { readonly kind: 'burst'; readonly n: number }
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'close' }
  | { readonly kind: 'crash' }
  | { readonly kind: 'flush'; readonly depth: number };

const target = fc.nat(5);
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.boolean().map((iterate): Action => ({ kind: 'send', iterate })) },
  ...(['say', 'result', 'drop', 'interrupt'] as const).map((kind) => ({
    weight: kind === 'result' ? 4 : 1,
    arbitrary: target.map((t): Action => ({ kind, target: t })),
  })),
  { weight: 2, arbitrary: fc.constant<Action>({ kind: 'ask' }) },
  { weight: 1, arbitrary: target.map((t): Action => ({ kind: 'withdraw', target: t })) },
  {
    weight: 3,
    arbitrary: fc
      .record({ target, how: fc.constantFrom('allow', 'deny', 'throw', 'invalid') })
      .map(({ target: t, how }): Action => ({ kind: 'answer', target: t, how })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('plan', 'bad', 'wait')
      .map((mode): Action => ({ kind: 'mode', mode })),
  },
  { weight: 1, arbitrary: fc.constant<Action>({ kind: 'ack' }) },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 1, max: 30 }).map((n): Action => ({ kind: 'burst', n })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(10, 1000, 30_000, 60_000)
      .map((ms): Action => ({ kind: 'advance', ms })),
  },
  { weight: 1, arbitrary: fc.constant<Action>({ kind: 'close' }) },
  { weight: 1, arbitrary: fc.constant<Action>({ kind: 'crash' }) },
  { weight: 5, arbitrary: fc.nat(6).map((depth): Action => ({ kind: 'flush', depth })) },
);

async function microtasks(depth: number): Promise<void> {
  for (let index = 0; index < depth; index += 1) await Promise.resolve();
}

interface Pending {
  readonly rid: string;
  readonly resolve: (decision: PermissionDecision) => void;
  readonly reject: (error: unknown) => void;
}

interface World {
  readonly r: Rig;
  readonly turns: { readonly id: string; settled: number }[];
  readonly pending: Pending[];
  readonly withdrawn: Set<string>;
  readonly controls: { settled: number }[];
  rid: number;
  readonly correlations: number[];
}

function build(): World {
  const pending: Pending[] = [];
  const r = rig({
    onPermission: (request) =>
      new Promise((resolve, reject) => {
        pending.push({ rid: request.requestId, resolve, reject });
      }),
  });
  return { r, turns: [], pending, withdrawn: new Set(), controls: [], rid: 0, correlations: [] };
}

function track(world: World, promise: Promise<unknown>): void {
  const record = { settled: 0 };
  world.controls.push(record);
  promise.then(
    () => {
      record.settled += 1;
    },
    () => {
      record.settled += 1;
    },
  );
}

/** The harness writes a line, unless it already exited. */
function say(world: World, frame: Parameters<Rig['say']>[0]): void {
  if (world.r.transport.exitStatus === null) world.r.say(frame);
}

function pick<T>(items: readonly T[], index: number): T | undefined {
  return items.length === 0 ? undefined : items[index % items.length];
}

async function apply(world: World, a: Action): Promise<void> {
  const { r } = world;
  switch (a.kind) {
    case 'send': {
      let id: string;
      let done: Promise<unknown>;
      try {
        if (a.iterate) {
          const turn = r.session.send('x');
          id = turn.id;
          done = turn.done;
          // Drain the turn's iterator in the background; it must end.
          void (async () => {
            try {
              for await (const event of turn) expect(event.sessionId).toBe(TEST_CONFIG.sessionId);
            } catch {
              // a failed turn rejects its iterator
            }
          })();
        } else {
          done = r.session.ask('x');
          id = `ask-${String(world.turns.length)}`;
        }
      } catch {
        return;
      }
      const record = { id, settled: 0 };
      world.turns.push(record);
      done.then(
        () => {
          record.settled += 1;
        },
        () => {
          record.settled += 1;
        },
      );
      return;
    }
    case 'say':
    case 'result':
    case 'drop': {
      const turn = pick(world.turns, a.target);
      say(world, { t: a.kind, id: turn?.id ?? 'none', text: 'x' });
      return;
    }
    case 'interrupt': {
      const turn = pick(world.turns, a.target);
      track(world, r.driver.interrupt(turn?.id, a.target % 2 === 0));
      return;
    }
    case 'ask':
      world.rid += 1;
      say(world, { t: 'ask', rid: `r${String(world.rid)}` });
      return;
    case 'withdraw': {
      if (world.rid === 0) return;
      const rid = `r${String((a.target % world.rid) + 1)}`;
      world.withdrawn.add(rid);
      say(world, { t: 'withdraw', rid });
      return;
    }
    case 'answer': {
      const entry = world.pending.splice(a.target % Math.max(world.pending.length, 1), 1)[0];
      if (entry === undefined) return;
      if (a.how === 'allow') entry.resolve({ behavior: 'allow' });
      else if (a.how === 'deny') entry.resolve({ behavior: 'deny', message: 'no' });
      else if (a.how === 'invalid') entry.resolve({ behavior: 'perhaps' } as never);
      else entry.reject(new Error('handler'));
      return;
    }
    case 'mode':
      track(world, r.session.setPermissionMode(a.mode));
      return;
    case 'ack':
      say(world, { t: 'ack', c: `c${String(r.driver.pending.controls)}` });
      return;
    case 'burst':
      say(world, { t: 'burst', n: a.n });
      return;
    case 'advance':
      r.clock.advance(a.ms);
      return;
    case 'close':
      void r.session.close();
      return;
    case 'crash':
      r.transport.exit({ code: 2, signal: null });
      return;
    case 'flush':
      await microtasks(a.depth);
      return;
  }
}

async function finish(world: World): Promise<boolean> {
  const { r } = world;
  const flag = { closed: false };
  void r.session.closed.then(() => {
    flag.closed = true;
  });
  void r.session[Symbol.asyncDispose]();
  for (let round = 0; round < 50 && !flag.closed; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    r.clock.advance(TEST_CONFIG.interruptWaitMs);
    // Answer whatever is still asked; answers after the end must be dropped.
    for (const entry of world.pending.splice(0)) entry.resolve({ behavior: 'allow' });
  }
  return flag.closed;
}

const seedText = process.env['FC_SEED'];
const seed = seedText === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(seedText);

describe('driver interleavings', () => {
  it(`keeps the binding invariants under random interleavings (seed ${String(seed)})`, async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const seen = new Set<string>();
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(action, { maxLength: 80, size: 'max' }), async (actions) => {
          const world = build();
          const events: HudhudEvent[] = [];
          const subscriber = (async () => {
            for await (const event of world.r.session.events({ maxEvents: 1_000_000 }))
              events.push(event);
          })();
          const started = world.r.driver.start().catch(() => undefined);
          await microtasks(3);
          say(world, { t: 'ready' });
          await started;
          for (const a of actions) await apply(world, a);
          expect(await finish(world)).toBe(true);
          await subscriber;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });

          // One input at a time.
          expect(world.r.machine.stats.maxDepth).toBe(1);
          // Every turn and control settled exactly once.
          for (const turn of world.turns) expect(turn.settled).toBe(1);
          for (const control of world.controls) expect(control.settled).toBe(1);
          // Each permission request answered at most once.
          const answers = world.r
            .ops()
            .filter((op) => op['op'] === 'answer')
            .map((op) => text(op['rid']));
          expect(new Set(answers).size).toBe(answers.length);
          // No application path produces the internal cmd.permission-abort
          // (W7-T5 item 2): answers, failures, withdrawals, close and dispose
          // reach the machine in other inputs.
          const inputs = world.r.machine.stats.inputs;
          expect(inputs).not.toContain('cmd.permission-abort');
          for (const type of inputs) seen.add(type);
          // A gapless stream, ending with session.terminated.
          expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
          expect(events.at(-1)?.type).toBe('session.terminated');
          // Nothing held.
          expect(world.r.driver.pending).toMatchObject({
            queue: 0,
            outbox: 0,
            timers: 0,
            turns: 0,
            controls: 0,
            permissions: 0,
            subscribers: 0,
          });
        }),
        { numRuns: 1000, seed },
      );
      expect(unhandled).toEqual([]);
      // The runs did reach every other way an ask ends.
      for (const type of ['cmd.permission', 'cmd.permission-error', 'cmd.close', 'cmd.abort'])
        expect(seen).toContain(type);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
