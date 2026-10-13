// The composed session machine with a dropped user message (research 10 §3,
// lead decision after macOS gate run 2): the turn fails TURN_DROPPED in every
// mode, before or after system/init, every other turn is untouched and the
// session stays usable. The frames replay what the pinned CLI 2.1.296 wrote
// on Linux and macOS for a resumed session whose user message reused a uuid
// of the transcript: the initialize response, then `command_lifecycle`
// `completed` for that uuid, then nothing until EOF.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@hudhud/core/protocol';

import type { ClaudeSessionConfig } from '../../../src/protocol/machine/session.js';
import {
  SPAWNED_PID,
  SessionRun,
  events,
  lifecycle,
  makeConfig,
  ofType,
  result,
  systemInit,
  uuid,
  writes,
} from './session-support.js';

const U1 = uuid(1);
const U2 = uuid(2);
const modes: readonly ClaudeSessionConfig['mode'][] = ['create', 'resume', 'fork'];

const DROPPED = {
  code: 'TURN_DROPPED',
  message: 'The harness dropped the user message without running a turn for it.',
  retryable: true,
  details: { turnId: U1, lifecycle: ['completed'] },
};

describe('a user message the harness drops (TURN_DROPPED)', () => {
  it.each(modes)('%s: completed before any system/init fails the turn at once', (mode) => {
    const run = new SessionRun(makeConfig({ mode }));
    run.start();
    expect(writes(run.feed({ type: 'cmd.send', turnId: U1, content: 'hello' }))).toMatchObject([
      { type: 'user', uuid: U1 },
    ]);
    const effects = run.line(lifecycle(U1, 'completed'));
    expect(ofType(effects, 'turn.fail')).toEqual([
      { type: 'turn.fail', turnId: U1, error: DROPPED },
    ]);
    expect(events(effects, 'diagnostic')).toEqual([
      expect.objectContaining({
        code: 'turn.dropped',
        data: { turnId: U1, lifecycle: ['completed'] },
      }),
    ]);
    // The session stays usable: a fresh uuid runs normally.
    run.feed({ type: 'cmd.send', turnId: U2, content: 'again' });
    run.line(systemInit());
    const settled = run.line(result({ user_message_uuid: U2 }));
    expect(ofType(settled, 'turn.settle').map((effect) => effect.turnId)).toEqual([U2]);
    expect(ofType(run.effects, 'session.end')).toEqual([]);
  });

  it.each(modes)('%s: after system/init, only the dropped turn fails', (mode) => {
    const run = new SessionRun(makeConfig({ mode }));
    run.start();
    run.feed({ type: 'cmd.send', turnId: U2, content: 'first' });
    run.line(systemInit());
    run.feed({ type: 'cmd.send', turnId: U1, content: 'dup' });
    const effects = run.line(lifecycle(U1, 'completed'));
    expect(ofType(effects, 'turn.fail')).toEqual([
      { type: 'turn.fail', turnId: U1, error: DROPPED },
    ]);
    const settled = run.line(result({ user_message_uuid: U2 }), lifecycle(U2, 'completed'));
    expect(ofType(settled, 'turn.settle').map((effect) => effect.turnId)).toEqual([U2]);
    expect(ofType(settled, 'turn.fail')).toEqual([]);
  });

  it('replays gate run 2 end to end: dropped, then EOF and exit settle nothing twice', () => {
    const run = new SessionRun(makeConfig({ mode: 'resume' }));
    run.start();
    run.feed({ type: 'cmd.send', turnId: U1, content: 'gate item 6 resume' });
    run.line(lifecycle(U1, 'completed'));
    run.feed({ type: 'cmd.close' });
    run.feed({ type: 'stdout.end' }, { type: 'process.exit', code: 0, signal: null });
    const ends = [...ofType(run.effects, 'turn.fail'), ...ofType(run.effects, 'turn.settle')];
    expect(ends.map((effect) => effect.turnId)).toEqual([U1]);
  });

  it('a result for the turn before its completed frame settles it; no drop follows', () => {
    const run = new SessionRun(makeConfig({ mode: 'resume' }));
    run.start();
    run.feed({ type: 'cmd.send', turnId: U1, content: 'hello' });
    run.line(lifecycle(U1, 'queued'), lifecycle(U1, 'started'), systemInit());
    const effects = run.line(result({ user_message_uuid: U1 }), lifecycle(U1, 'completed'));
    expect(ofType(effects, 'turn.settle').map((effect) => effect.turnId)).toEqual([U1]);
    expect(ofType(effects, 'turn.fail')).toEqual([]);
    expect(events(effects, 'diagnostic')).toEqual([]);
  });
});

/** The records of the recorded resume-duplicate-uuid fixture (Linux, research 10 §3). */
function recorded(file: string): { dir: string; v: JsonObject }[] {
  const path = fileURLToPath(
    new URL(`../../../conformance/resume-duplicate-uuid/${file}`, import.meta.url),
  );
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { dir: string; v: JsonObject });
}

describe('replay of the recorded resume-duplicate-uuid fixture (linux)', () => {
  it('records the drop: initialize response, completed for the re-sent uuid, nothing else', () => {
    const main = recorded('linux.jsonl');
    const sent = main.find((record) => record.dir === 'in' && record.v['type'] === 'user');
    const out = main.filter((record) => record.dir === 'out').map((record) => record.v);
    expect(out.map((frame) => frame['type'])).toEqual(['control_response', 'command_lifecycle']);
    expect(out[1]).toMatchObject({ command_uuid: sent?.v['uuid'], state: 'completed' });
    expect(main.at(-1)).toMatchObject({ dir: 'exit', v: { code: 0, signal: null } });
    // The setup case ran a full turn with lifecycle frames.
    const setup = recorded('linux.setup.jsonl')
      .filter((record) => record.dir === 'out')
      .filter((record) => record.v['type'] === 'command_lifecycle')
      .map((record) => record.v['state']);
    expect(setup).toEqual(['queued', 'started', 'completed']);
  });

  it('fails the resumed turn TURN_DROPPED when its frames are fed to the machine', () => {
    const main = recorded('linux.jsonl');
    const sent = main.find((record) => record.dir === 'in' && record.v['type'] === 'user');
    const recordedUuid = sent?.v['uuid'];
    const [response, ...rest] = main
      .filter((record) => record.dir === 'out')
      .map((record) => record.v);
    // Normalized ids: the session id is the fixture's, the re-sent uuid is
    // mapped onto the machine's turn id, the request id onto the machine's.
    const run = new SessionRun(makeConfig({ mode: 'resume', sessionId: '<uuid-1>' }));
    run.feed({ type: 'process.started', pid: SPAWNED_PID });
    const reply = response as { response: JsonObject };
    expect(
      ofType(
        run.line({ ...reply, response: { ...reply.response, request_id: 'hudhud_1' } }),
        'handshake.ok',
      ),
    ).toHaveLength(1);
    run.feed({ type: 'cmd.send', turnId: U1, content: '[[mock:echo]] BRAVO' });
    const effects = rest.flatMap((frame) =>
      run.line(frame['command_uuid'] === recordedUuid ? { ...frame, command_uuid: U1 } : frame),
    );
    expect(ofType(effects, 'turn.fail')).toEqual([
      { type: 'turn.fail', turnId: U1, error: DROPPED },
    ]);
  });
});
