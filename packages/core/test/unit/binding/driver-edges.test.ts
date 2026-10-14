// Edge cases of the driver: machines that break the contract are contained,
// stale timer firings are dropped, work queued behind a stalled 'block'
// subscriber is answered when the machine breaks meanwhile, and the end of a
// session waits for a 'block' subscriber unless it is aborted.

import { describe, expect, it } from 'vitest';

import { ProtocolError, SessionClosedError } from '../../../src/binding/errors.js';
import {
  collector,
  guardProcess,
  outcome,
  ready,
  rig,
  settle,
  state,
  types,
} from './driver-support.js';
import { TEST_CONFIG } from './test-machine.js';

guardProcess();

describe('contract violations of the machine are contained', () => {
  it('double settlement, a stray send.rejected and a second handshake answer change nothing', async () => {
    const r = rig();
    await ready(r, { t: 'ready', forkedFrom: 'f', apiKeySource: 'k', tokenSource: 't' });
    expect(r.session.info).toMatchObject({ forkedFrom: 'f', apiKeySource: 'k', tokenSource: 't' });
    const turn = r.session.send('x');
    await settle();
    r.say({ t: 'bogus', id: turn.id });
    expect(await turn.done).toMatchObject({ turnId: turn.id });
    expect(r.session.info.id).toBe(TEST_CONFIG.sessionId);
    expect(r.driver.pending.turns).toBe(0);
  });

  it('writes after stdin.end and a second stdin.end are ignored', async () => {
    const r = rig();
    await ready(r);
    const before = r.transport.written.length;
    r.say({ t: 'write-after-end' });
    await settle();
    expect(r.transport.written).toHaveLength(before);
    expect(r.transport.inputEnd).toBe('graceful');
  });

  it('a second session.end is ignored', async () => {
    const r = rig();
    await ready(r);
    r.say({ t: 'double-end' });
    await r.session.closed;
    expect(await r.driver.ended).toEqual({ outcome: 'unknown' });
  });

  it('a thrown value without a usable name is reported as unknown', async () => {
    const r = rig();
    await ready(r);
    const events = collector(r.session.events());
    r.say({ t: 'throw-odd' });
    await r.session.closed;
    expect(
      (await events.result()).events.find((event) => event.type === 'diagnostic'),
    ).toMatchObject({
      data: { error: 'unknown' },
    });
  });
});

describe('the default encoder', () => {
  it('passes neutral image blocks', async () => {
    const r = rig();
    await ready(r);
    const turn = r.session.send({
      content: [{ type: 'image', mediaType: 'image/webp', dataBase64: 'AA==' }],
    });
    await settle();
    expect(r.ops().at(-1)).toMatchObject({
      content: [{ type: 'image', mediaType: 'image/webp', dataBase64: 'AA==' }],
    });
    r.say({ t: 'result', id: turn.id });
    await turn.done;
  });
});

/** A rig whose session is stalled by a full 'block' subscriber. */
async function stalled(): Promise<{
  readonly r: ReturnType<typeof rig>;
  readonly blocked: AsyncIterator<unknown>;
}> {
  const r = rig();
  await ready(r);
  const blocked = r.session.events({ maxEvents: 1, overflow: 'block' })[Symbol.asyncIterator]();
  r.say({ t: 'burst', n: 3 });
  await settle();
  return { r, blocked };
}

describe('work queued behind a stalled block subscriber', () => {
  it('drops a timer firing whose timer was cleared meanwhile', async () => {
    const r = rig();
    await ready(r);
    const turn = r.session.send('x');
    void r.session.close();
    await settle();
    const blocked = r.session.events({ maxEvents: 1, overflow: 'block' })[Symbol.asyncIterator]();
    r.say({ t: 'burst', id: turn.id, n: 3 });
    await settle();
    // Queued while stalled: an abort that clears the close timer, then the close timer firing.
    r.driver.command({ type: 'cmd.abort', intent: 'abort' });
    r.clock.advance(TEST_CONFIG.closeMs);
    const inputsBefore = r.machine.stats.inputs.length;
    for (let index = 0; index < 3; index += 1) await blocked.next();
    await settle();
    const fed = r.machine.stats.inputs.slice(inputsBefore);
    expect(fed).toContain('cmd.abort');
    expect(fed).not.toContain('timer');
    expect(r.transport.terminations).toEqual(['abort']);
    await blocked.return?.();
    r.clock.advance(TEST_CONFIG.interruptWaitMs);
    await r.session.closed;
  });

  it('drops a timer firing whose timer was armed again meanwhile', async () => {
    const r = rig();
    await ready(r);
    const turn = r.session.send('x');
    void r.session.close();
    await settle();
    const blocked = r.session.events({ maxEvents: 1, overflow: 'block' })[Symbol.asyncIterator]();
    r.say({ t: 'burst', id: turn.id, n: 3 });
    await settle();
    // Raw: the session refuses controls while closing.
    r.driver.command({ type: 'cmd.set-permission-mode', mode: 'rearm-close', correlation: 'raw' });
    r.clock.advance(TEST_CONFIG.closeMs);
    for (let index = 0; index < 3; index += 1) await blocked.next();
    await settle();
    // The first firing was stale; nothing aborted yet.
    expect(r.transport.terminations).toEqual([]);
    await blocked.return?.();
    r.clock.advance(TEST_CONFIG.closeMs);
    await settle();
    expect(r.transport.terminations).toEqual(['close-timeout']);
    r.clock.advance(TEST_CONFIG.interruptWaitMs);
    await r.session.closed;
  });

  it('a send and a control queued behind an input that breaks the machine are answered with its error', async () => {
    const { r, blocked } = await stalled();
    const explode = outcome(r.session.setPermissionMode('explode'));
    const control = outcome(r.session.setPermissionMode('plan'));
    const turn = r.session.send('x');
    for (let index = 0; index < 3; index += 1) await blocked.next();
    await blocked.return?.();
    expect((await explode).error).toBeInstanceOf(ProtocolError);
    expect((await control).error).toBeInstanceOf(ProtocolError);
    expect((await outcome(turn.done)).error).toBeInstanceOf(ProtocolError);
    await r.session.closed;
  });
});

describe('the end of a session and block subscribers', () => {
  it('waits for a block subscriber that holds the last events, then closes', async () => {
    const r = rig();
    await ready(r);
    const blocked = r.session.events({ maxEvents: 1, overflow: 'block' })[Symbol.asyncIterator]();
    // The replayed pre-handshake event first (W5 lead review); the queue is empty afterwards.
    expect((await blocked.next()).value).toMatchObject({ type: 'session.started' });
    r.transport.exit({ code: 2, signal: null });
    await settle();
    const closed = state(r.session.closed);
    expect(closed.current()).toBe('pending');
    const seen: string[] = [];
    for (let next = await blocked.next(); next.done !== true; next = await blocked.next()) {
      seen.push((next.value as { type: string }).type);
    }
    await r.session.closed;
    expect(seen).toEqual(['session.terminated']);
  });

  it('the synthesized end of a broken machine waits for a full block subscriber', async () => {
    const r = rig();
    await ready(r);
    const blocked = r.session.events({ maxEvents: 1, overflow: 'block' })[Symbol.asyncIterator]();
    // The replayed pre-handshake event first (W5 lead review); the queue is empty afterwards.
    expect((await blocked.next()).value).toMatchObject({ type: 'session.started' });
    r.say({ t: 'throw' });
    await settle();
    expect(state(r.session.closed).current()).toBe('pending');
    expect((await blocked.next()).value).toMatchObject({ code: 'binding.machine-error' });
    expect((await blocked.next()).value).toMatchObject({
      type: 'session.terminated',
      outcome: 'failed',
    });
    await r.session.closed;
  });

  it('cuts a block subscriber created after the abort was requested', async () => {
    const r = rig();
    await ready(r);
    const disposed = r.session[Symbol.asyncDispose]();
    const blocked = r.session.events({ maxEvents: 1, overflow: 'block' })[Symbol.asyncIterator]();
    r.say({ t: 'burst', n: 3 });
    await settle();
    r.clock.advance(TEST_CONFIG.interruptWaitMs);
    await disposed;
    await expect(
      (async () => {
        for (;;) if ((await blocked.next()).done === true) return;
      })(),
    ).rejects.toBeInstanceOf(SessionClosedError);
  });

  it('a stdout failure after the end is not reported; diagnostics without data are published as is', async () => {
    const r = rig({
      diagnostics: [{ code: 'containment.fallback', message: 'no data' }],
      outputDrainMs: 10,
    });
    const events = collector(r.session.events());
    await ready(r);
    r.transport.exit({ code: 0, signal: null }, { keepOutputOpen: true });
    await settle();
    r.clock.advance(10);
    await r.session.closed;
    r.transport.endOutput(new Error('late'));
    await settle();
    const seen = (await events.result()).events;
    expect(seen.filter((event) => event.type === 'diagnostic')).toEqual([
      expect.objectContaining({ code: 'containment.fallback', message: 'no data' }) as unknown,
    ]);
    expect(Object.hasOwn(seen.find((event) => event.type === 'diagnostic') ?? {}, 'data')).toBe(
      false,
    );
    expect(types(seen).at(-1)).toBe('session.terminated');
  });
});
