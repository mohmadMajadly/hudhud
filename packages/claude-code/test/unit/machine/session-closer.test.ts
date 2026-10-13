// W3-Z rulings on the session machine: a reused or invalid turn id rejects
// only the new send (ruling 7); stdin failures after the handshake and
// reused permission request ids are reported (ruling 7); the first user
// message is never written before the initialize response, in every mode,
// including the order that stalled a resumed session on macOS (ruling 10,
// research 09).

import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_REQUEST_DENY_MESSAGE,
  type ClaudeSessionConfig,
} from '../../../src/protocol/machine/session.js';
import {
  SPAWNED_PID,
  SessionRun,
  canUseTool,
  events,
  initResponse,
  makeConfig,
  ofType,
  result,
  shape,
  systemInit,
  uuid,
  writes,
} from './session-support.js';

const U1 = uuid(1);
const U2 = uuid(2);

/** A ready session with one running turn. */
function running(run = new SessionRun()): SessionRun {
  run.start();
  run.feed({ type: 'cmd.send', turnId: U1, content: 'hello' });
  run.line(systemInit());
  return run;
}

describe('a send with a refused turn id (ruling 7)', () => {
  it('rejects the new send and never touches the live turn with that id', () => {
    const run = running();
    const effects = run.feed({ type: 'cmd.send', turnId: U1, content: 'again' });
    expect(effects).toEqual([
      {
        type: 'send.rejected',
        turnId: U1,
        error: {
          code: 'PROTOCOL_ERROR',
          message: 'turn id must be a fresh UUID',
          retryable: false,
        },
      },
    ]);
    // The live turn still settles from its own result, exactly once.
    const settled = run.line(result({ user_message_uuid: U1 }));
    expect(ofType(settled, 'turn.settle').map((effect) => effect.turnId)).toEqual([U1]);
    expect(ofType(run.effects, 'turn.fail')).toEqual([]);
  });

  it('rejects a queued turn id too, and an id that is not a UUID', () => {
    const run = new SessionRun();
    run.start();
    run.feed({ type: 'cmd.send', turnId: U1, content: 'one' });
    expect(shape(run.feed({ type: 'cmd.send', turnId: U1, content: 'two' }))).toEqual([
      'send.rejected',
    ]);
    expect(shape(run.feed({ type: 'cmd.send', turnId: 'turn-1', content: 'x' }))).toEqual([
      'send.rejected',
    ]);
    expect(writes(run.effects).filter((frame) => frame['type'] === 'user')).toHaveLength(1);
  });

  it('rejects the reused id as a command while closing and after stdin broke', () => {
    const closing = running();
    closing.feed({ type: 'cmd.close' });
    expect(shape(closing.feed({ type: 'cmd.send', turnId: U1, content: 'x' }))).toEqual([
      'send.rejected',
    ]);
    // A fresh id while closing is a failed send of that new turn, as before.
    expect(
      ofType(closing.feed({ type: 'cmd.send', turnId: U2, content: 'x' }), 'turn.fail').map(
        (effect) => effect.turnId,
      ),
    ).toEqual([U2]);

    const broken = running();
    broken.feed({ type: 'stdin.error', code: 'EPIPE' });
    expect(shape(broken.feed({ type: 'cmd.send', turnId: U1, content: 'x' }))).toEqual([
      'send.rejected',
    ]);
  });

  it('accepts the id of a turn that has settled (only live ids are refused)', () => {
    const run = running();
    run.line(result({ user_message_uuid: U1 }));
    const again = run.feed({ type: 'cmd.send', turnId: U1, content: 'later' });
    expect(ofType(again, 'send.rejected')).toEqual([]);
    expect(writes(again)).toMatchObject([{ type: 'user', uuid: U1 }]);
  });
});

describe('stdin failures (ruling 7)', () => {
  it('reports a stdin failure after the handshake as diagnostic stdin.error', () => {
    const run = running();
    const effects = run.feed({ type: 'stdin.error', code: 'EPIPE' });
    expect(events(effects, 'diagnostic')).toMatchObject([
      { code: 'stdin.error', data: { code: 'EPIPE' } },
    ]);
    // Reported once: a second error on the closed stdin adds nothing.
    expect(run.feed({ type: 'stdin.error', code: 'EPIPE' })).toEqual([]);
  });

  it('fails the handshake instead during the handshake (no stdin.error diagnostic)', () => {
    const run = new SessionRun();
    run.feed({ type: 'process.started', pid: SPAWNED_PID });
    const effects = run.feed({ type: 'stdin.error', code: 'EPIPE' });
    expect(events(effects, 'diagnostic')).toEqual([]);
    expect(ofType(effects, 'handshake.fail')).toHaveLength(1);
  });
});

describe('a permission request id reused after its request ended (ruling 7)', () => {
  it('is never asked again: diagnostic and a non-interrupting deny', () => {
    const run = running();
    expect(ofType(run.line(canUseTool('req-1')), 'permission.ask')).toHaveLength(1);
    run.feed({ type: 'cmd.permission', requestId: 'req-1', decision: { behavior: 'allow' } });
    const reused = run.line(canUseTool('req-1'));
    expect(ofType(reused, 'permission.ask')).toEqual([]);
    expect(events(reused, 'permission.requested')).toEqual([]);
    expect(events(reused, 'diagnostic')).toMatchObject([
      { code: 'permission.duplicate-request-id', data: { requestId: 'req-1' } },
    ]);
    expect(writes(reused)).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-1',
          response: { behavior: 'deny', message: DUPLICATE_REQUEST_DENY_MESSAGE, interrupt: false },
        },
      },
    ]);
    // A new id is asked as usual.
    expect(ofType(run.line(canUseTool('req-2')), 'permission.ask')).toHaveLength(1);
  });

  it('writes nothing after abort (K12)', () => {
    const run = running();
    run.line(canUseTool('req-1'));
    run.feed({ type: 'cmd.permission', requestId: 'req-1', decision: { behavior: 'allow' } });
    run.feed({ type: 'cmd.abort', intent: 'abort' });
    const reused = run.line(canUseTool('req-1'));
    expect(writes(reused)).toEqual([]);
    expect(events(reused, 'diagnostic').map((event) => event['code'])).not.toContain(
      'permission.duplicate-request-id',
    );
  });
});

describe('the first user message waits for the initialize response (ruling 10)', () => {
  const modes: readonly ClaudeSessionConfig['mode'][] = ['create', 'resume', 'fork'];

  it.each(modes)('%s: a send right after process.started is held until the response', (mode) => {
    const run = new SessionRun(makeConfig({ mode }));
    const started = run.feed({ type: 'process.started', pid: SPAWNED_PID });
    expect(writes(started).map((frame) => frame['type'])).toEqual(['control_request']);
    // The macOS gate run 1 order (research 09): the user message right after
    // initialize, before its response. The machine holds it.
    const early = run.feed({ type: 'cmd.send', turnId: U1, content: 'hello' });
    expect(writes(early)).toEqual([]);
    expect(events(early, 'turn.queued')).toHaveLength(1);
    const ready = run.line(initResponse());
    const flushed = writes(ready);
    expect(flushed).toMatchObject([{ type: 'user', uuid: U1 }]);
    // Order inside the step: handshake.ok before the held write.
    const order = shape(ready);
    expect(order.indexOf('handshake.ok')).toBeLessThan(order.indexOf('write'));
  });

  it.each(modes)('%s: a send before process.started is also held until the response', (mode) => {
    const run = new SessionRun(makeConfig({ mode }));
    expect(writes(run.feed({ type: 'cmd.send', turnId: U1, content: 'hello' }))).toEqual([]);
    const started = run.feed({ type: 'process.started', pid: SPAWNED_PID });
    expect(writes(started).map((frame) => frame['type'])).toEqual(['control_request']);
    expect(writes(run.line(initResponse()))).toMatchObject([{ type: 'user', uuid: U1 }]);
  });

  it('replays the stalled macOS resume ordering without writing the user message early', () => {
    // Research 09: initialize, then the user message at once, then silence
    // until the first-frame watchdog. Here the user message is never written
    // before the response, and the watchdog fails the handshake with nothing
    // but initialize on the wire.
    const run = new SessionRun(makeConfig({ mode: 'resume' }));
    run.feed({ type: 'process.started', pid: SPAWNED_PID });
    run.feed({ type: 'cmd.send', turnId: U1, content: 'hello' });
    const fired = run.advance(60_000).fire('first-frame');
    expect(ofType(fired, 'handshake.fail')).toHaveLength(1);
    expect(writes(run.effects).map((frame) => frame['type'])).toEqual(['control_request']);
  });
});
