// The pre-handshake buffer of the driver (W5 lead review of W5-T1, Q1): the
// events published before the handshake settled (the adapter's diagnostics,
// session.started) reach every subscriber, after compat, in seq order,
// within the subscriber's own limits; the buffer is bounded and says so when
// it truncated.

import { describe, expect, it } from 'vitest';

import {
  PRE_HANDSHAKE_MAX_BYTES,
  PRE_HANDSHAKE_MAX_EVENTS,
  SYNTHESIZED_EVENT_BYTES,
} from '../../../src/binding/driver.js';
import type { HudhudEvent } from '../../../src/protocol/events/types.js';
import {
  collect,
  guardProcess,
  iteratorOf,
  nextEvent,
  ready,
  rig,
  settle,
  types,
} from './driver-support.js';

guardProcess();

const COMPAT = {
  harness: 'test',
  version: '1.0.0',
  minTested: '1.0.0',
  maxTested: '1.0.0',
  knownBroken: [],
  status: 'tested',
} as const;

function diagnostics(count: number): { code: string; message: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    code: 'adapter.note',
    message: `note ${String(index)}`,
  }));
}

function codeOf(event: HudhudEvent | undefined): unknown {
  return (event as { code?: unknown } | undefined)?.code;
}

describe('the pre-handshake replay', () => {
  it('a subscriber made after the start receives compat, the diagnostics and session.started, gapless', async () => {
    const r = rig({ compat: COMPAT, diagnostics: diagnostics(2) });
    await ready(r);
    const sub = iteratorOf(r.session.events());
    const seen: HudhudEvent[] = [];
    for (let index = 0; index < 4; index += 1) {
      const next = await sub.next();
      seen.push(next.value as HudhudEvent);
    }
    expect(seen.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    expect(types(seen)).toEqual(['compat', 'diagnostic', 'diagnostic', 'session.started']);
    // Live events continue the same numbering.
    const turn = r.session.send('x');
    await settle();
    expect(await nextEvent(sub)).toMatchObject({ type: 'turn.queued', seq: 4 });
    r.say({ t: 'result', id: turn.id });
    await turn.done;
    // Two subscribers each get their own replay.
    const other = iteratorOf(r.session.events());
    expect((await other.next()).value).toMatchObject({ type: 'compat' });
    expect((await other.next()).value).toMatchObject({ type: 'diagnostic', seq: 1 });
    await sub.return?.();
    await other.return?.();
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
  });

  it('a subscriber made before the start sees each event once', async () => {
    const r = rig({ diagnostics: diagnostics(1) });
    const early = r.driver.subscribe(undefined);
    await ready(r);
    r.transport.exit({ code: 0, signal: null });
    const seen = await collect(early);
    expect(types(seen).filter((type) => type === 'session.started')).toHaveLength(1);
    expect(seen.map((event) => event.seq)).toEqual(
      Array.from({ length: seen.length }, (_, index) => index + 1),
    );
  });

  it('the buffer ends with the step that settled the handshake', async () => {
    const r = rig();
    await ready(r);
    const turn = r.session.send('x');
    await settle();
    r.say({ t: 'result', id: turn.id });
    await turn.done;
    // A subscriber after the turn replays only what came before the handshake.
    const sub = iteratorOf(r.session.events());
    expect(await nextEvent(sub)).toMatchObject({ type: 'session.started' });
    r.transport.exit({ code: 0, signal: null });
    expect(types(await collect({ [Symbol.asyncIterator]: () => sub }))).toEqual([
      'session.terminated',
    ]);
  });

  it('a session that ended before its handshake still replays what it published', async () => {
    const r = rig({ diagnostics: diagnostics(1) });
    const started = r.driver.start().catch((error: unknown) => error);
    await settle();
    r.transport.exit({ code: 1, signal: null });
    await started;
    await r.session.closed;
    const seen = await collect(r.session.events());
    expect(codeOf(seen[0])).toBe('adapter.note');
    expect(types(seen).at(-1)).toBe('session.terminated');
  });

  it('is bounded: keeps the earliest, drops the newest and closes with one truncation diagnostic', async () => {
    const r = rig({ diagnostics: diagnostics(PRE_HANDSHAKE_MAX_EVENTS + 10) });
    await ready(r);
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
    const seen = await collect(r.session.events({ maxEvents: PRE_HANDSHAKE_MAX_EVENTS + 50 }));
    const replay = seen.slice(0, PRE_HANDSHAKE_MAX_EVENTS);
    expect(replay.slice(0, -1).every((event) => codeOf(event) === 'adapter.note')).toBe(true);
    expect((replay[0] as { message?: string }).message).toBe('note 0');
    // 266 diagnostics plus session.started: 255 kept, 12 dropped.
    expect(replay.at(-1)).toMatchObject({
      type: 'diagnostic',
      code: 'events.pre-handshake-truncated',
      data: { dropped: 12 },
    });
    // The replay keeps seq order.
    const seqs = replay.map((event) => event.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('counts bytes: frame events count their line', async () => {
    const big = PRE_HANDSHAKE_MAX_BYTES; // one ready line larger than the whole buffer
    const r = rig();
    const started = r.driver.start();
    await settle();
    r.transport.line(JSON.stringify({ t: 'ready' }), big);
    await started;
    await settle();
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
    const seen = await collect(r.session.events());
    expect(codeOf(seen[0])).toBe('events.pre-handshake-truncated');
    expect(seen[0]).toMatchObject({ data: { dropped: 1 } });
  });

  it("is cut to a subscriber's limits with one gap numbered as the first event left out", async () => {
    const r = rig({ compat: COMPAT, diagnostics: diagnostics(5) });
    await ready(r);
    const small = iteratorOf(r.session.events({ maxEvents: 3 }));
    expect((await small.next()).value).toMatchObject({ type: 'compat', seq: 0 });
    expect((await small.next()).value).toMatchObject({ type: 'diagnostic', seq: 1 });
    // compat, 5 diagnostics and session.started: 2 kept, 5 left out from seq 2.
    expect((await small.next()).value).toMatchObject({ type: 'gap', dropped: 5, seq: 2 });
    await small.return?.();
    const tiny = iteratorOf(r.session.events({ maxBytes: 1 }));
    expect((await tiny.next()).value).toMatchObject({ type: 'gap', dropped: 7, seq: 0 });
    await tiny.return?.();
    expect(SYNTHESIZED_EVENT_BYTES).toBe(256);
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
  });

  it("a 'block' subscriber's replay never waits on a publish; live events then follow 'block'", async () => {
    const r = rig({ diagnostics: diagnostics(3) });
    await ready(r);
    // The replay goes straight into this subscriber's queue (cut to its limit).
    const blocked = iteratorOf(r.session.events({ maxEvents: 2, overflow: 'block' }));
    expect(r.driver.pending.outbox).toBe(0);
    // Others get their full replay meanwhile.
    const other = await collectSome(r.session.events(), 4);
    expect(types(other)).toEqual(['diagnostic', 'diagnostic', 'diagnostic', 'session.started']);
    // A block subscriber with room for its replay holds nothing back.
    const roomy = iteratorOf(r.session.events({ maxEvents: 16, overflow: 'block' }));
    expect((await blocked.next()).value).toMatchObject({ type: 'diagnostic', seq: 1 });
    expect((await blocked.next()).value).toMatchObject({ type: 'gap', dropped: 3, seq: 2 });
    const turn = r.session.send('x');
    await settle();
    r.say({ t: 'result', id: turn.id });
    expect(await turn.done).toMatchObject({ turnId: turn.id });
    await blocked.return?.();
    await roomy.return?.();
    r.transport.exit({ code: 0, signal: null });
    await r.session.closed;
  });
});

async function collectSome(
  iterable: AsyncIterable<HudhudEvent>,
  count: number,
): Promise<HudhudEvent[]> {
  const out: HudhudEvent[] = [];
  for await (const event of iterable) {
    out.push(event);
    if (out.length === count) break;
  }
  return out;
}
