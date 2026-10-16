// Version drift (K4; W5 lead ruling 1, ADR-0004 §4 amendment): the session
// compares the `initialize` response's `claude_code_version` with the connect
// probe. Every drift emits `binary.version-changed`; an untested one is a
// warning only; a drifted version listed known-broken fails the handshake
// closed (the ladder runs, no turn starts) unless the application allowed
// known-broken versions.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeErrorData } from '@hudhudjs/core/protocol';

import {
  CLI_PID,
  SessionRun,
  events,
  initResponse,
  lineOf,
  makeConfig,
  ofType,
  result,
  shape,
  systemInit,
  uuid,
  writes,
  type Body,
} from './session-support.js';

const LISTED = { version: '2.1.297', reason: 'drops permission answers (test listing)' };
const VERSION_OK = '2.1.296';

function drifted(version: string, overrides: Parameters<typeof makeConfig>[0] = {}): SessionRun {
  const run = new SessionRun(
    makeConfig({ probedVersion: '2.1.296', knownBroken: [LISTED], ...overrides }),
  );
  run.feed({ type: 'process.started', pid: CLI_PID });
  run.feed({ type: 'cmd.send', turnId: uuid(1), content: 'held until the handshake' });
  run.line(initResponse({ claude_code_version: version }));
  return run;
}

describe('version drift between the connect probe and the session', () => {
  it('no check without a probed version, and none when the versions agree', () => {
    for (const config of [makeConfig(), makeConfig({ probedVersion: '2.1.296' })]) {
      const run = new SessionRun(config);
      const effects = run.start();
      expect(events(effects, 'diagnostic').map((event) => event['code'])).not.toContain(
        'binary.version-changed',
      );
      expect(ofType(effects, 'handshake.ok')).toHaveLength(1);
    }
  });

  it('an untested drift is a warning: one diagnostic, the session runs', () => {
    const run = drifted('2.1.400');
    const effects = run.effects;
    expect(events(effects, 'diagnostic')).toEqual([
      expect.objectContaining({
        code: 'binary.version-changed',
        data: { probedVersion: '2.1.296', version: '2.1.400', knownBroken: false },
      }),
    ]);
    expect(ofType(effects, 'handshake.ok')[0]?.info.version).toBe('2.1.400');
    // The held user message is flushed after the handshake.
    expect(writes(effects).map((frame) => frame['type'])).toEqual(['control_request', 'user']);
  });

  it('a missing version counts as a drift to "unknown"', () => {
    const run = new SessionRun(makeConfig({ probedVersion: '2.1.296' }));
    run.feed({ type: 'process.started', pid: CLI_PID });
    const response = initResponse();
    const body = (response['response'] as Record<string, Record<string, unknown>>)['response'];
    if (body !== undefined) delete body['claude_code_version'];
    const effects = run.line(response);
    expect(events(effects, 'diagnostic')[0]).toMatchObject({
      code: 'binary.version-changed',
      data: { version: 'unknown', knownBroken: false },
    });
    expect(ofType(effects, 'handshake.ok')).toHaveLength(1);
  });

  it('a known-broken drift fails closed: no turn, the ladder runs, the session fails', () => {
    const run = drifted(LISTED.version);
    const step = run.steps.at(-1) ?? [];
    const error = makeErrorData(
      'HARNESS_VERSION_KNOWN_BROKEN',
      `The harness now reports version ${LISTED.version}, which is listed as known broken: ${LISTED.reason}`,
      { version: LISTED.version, reason: LISTED.reason, probedVersion: '2.1.296' },
    );
    expect(shape(step)).toEqual([
      'event:diagnostic',
      'timer.clear',
      'handshake.fail',
      'turn.fail',
      'stdin.end',
      'ladder.start',
    ]);
    expect(ofType(step, 'handshake.fail')[0]?.error).toEqual(error);
    expect(ofType(step, 'turn.fail')[0]).toMatchObject({ turnId: uuid(1), error });
    expect(ofType(step, 'ladder.start')[0]?.intent).toBe('handshake-failed');
    // Only initialize was ever written: the held user message never left.
    expect(writes(run.effects).map((frame) => frame['type'])).toEqual(['control_request']);
    const end = run.feed({ type: 'process.exit', code: null, signal: 'SIGKILL' });
    expect(ofType(end, 'session.end')[0]).toEqual({
      type: 'session.end',
      outcome: 'failed',
      error,
    });
    expect(events(end, 'session.terminated')[0]).toMatchObject({
      intent: 'handshake-failed',
      outcome: 'failed',
    });
  });

  it('after a drift refusal no input ever produces a write (property)', () => {
    const inputs = fc.array(
      fc.oneof(
        fc.integer({ min: 2, max: 9 }).map((n): Body => ({
          type: 'cmd.send',
          turnId: uuid(n),
          content: 'x',
        })),
        fc.constant<Body>({
          type: 'cmd.interrupt',
          cancelQueued: true,
          correlation: 'c-1',
        }),
        fc.constant<Body>({ type: 'cmd.set-permission-mode', mode: 'plan', correlation: 'c-2' }),
        fc.constant<Body>({ type: 'cmd.close' }),
        fc.constant<Body>({ type: 'cmd.abort', intent: 'abort' }),
        fc.constant<Body>(lineOf(initResponse({ claude_code_version: VERSION_OK }))),
        fc.constant<Body>(lineOf(systemInit())),
        fc.constant<Body>(lineOf(result())),
        fc.constant<Body>({ type: 'timer', name: 'first-frame' }),
        fc.constant<Body>({ type: 'stdout.end' }),
      ),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(inputs, (bodies) => {
        const run = drifted(LISTED.version);
        const after = run.feed(...bodies);
        expect(ofType(after, 'write')).toEqual([]);
        expect(ofType(after, 'handshake.ok')).toEqual([]);
        expect(ofType(after, 'turn.settle')).toEqual([]);
      }),
    );
  });

  it('the opt-in runs a known-broken drift with the warning', () => {
    const run = drifted(LISTED.version, { allowKnownBrokenVersion: true });
    expect(events(run.effects, 'diagnostic')[0]).toMatchObject({
      code: 'binary.version-changed',
      data: { version: LISTED.version, knownBroken: true },
    });
    expect(ofType(run.effects, 'handshake.ok')).toHaveLength(1);
    expect(ofType(run.effects, 'handshake.fail')).toEqual([]);
  });

  it('caps untrusted version text in the diagnostic', () => {
    const long = `9.9.9-${'x'.repeat(300)}`;
    const run = drifted(long);
    const data = events(run.effects, 'diagnostic')[0]?.['data'] as Record<string, string>;
    expect(data['version']?.length).toBe(129);
    expect(JSON.parse(JSON.stringify(run.state))).toEqual(run.state);
  });
});
