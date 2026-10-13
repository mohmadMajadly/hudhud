// K10 as decided by the lead after the auth-token-source fixture: auth
// fail-fast applies to ANTHROPIC_AUTH_TOKEN exactly as to ANTHROPIC_API_KEY
// (a static env credential that got a 401 does not succeed on retry). The
// CLI reports the token as account.tokenSource with apiKeySource "none".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@hudhud/core/protocol';

import { DEFAULT_AUTH_FAIL_FAST_SOURCES } from '../../../src/protocol/machine/index.js';
import {
  SPAWNED_PID,
  SessionRun,
  events,
  initResponse,
  makeConfig,
  ofType,
  result,
  systemInit,
  uuid,
} from './session-support.js';

const U1 = uuid(1);
const TOKEN_ACCOUNT: JsonObject = { apiKeySource: 'none', tokenSource: 'ANTHROPIC_AUTH_TOKEN' };
const TRIGGER = result({ is_error: true, api_error_status: 401, terminal_reason: 'api_error' });

describe('auth fail-fast for the auth token (K10)', () => {
  it('lists both static env credentials by default', () => {
    expect(DEFAULT_AUTH_FAIL_FAST_SOURCES).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    expect(Object.isFrozen(DEFAULT_AUTH_FAIL_FAST_SOURCES)).toBe(true);
  });

  it('records the token source in the state, the session info and session.started', () => {
    const run = new SessionRun();
    const effects = run.start(initResponse({ account: TOKEN_ACCOUNT }));
    expect(run.state.tokenSource).toBe('ANTHROPIC_AUTH_TOKEN');
    expect(run.state.apiKeySource).toBe('none');
    expect(ofType(effects, 'handshake.ok')[0]?.info).toMatchObject({
      apiKeySource: 'none',
      tokenSource: 'ANTHROPIC_AUTH_TOKEN',
    });
    expect(events(effects, 'session.started')[0]).toMatchObject({
      tokenSource: 'ANTHROPIC_AUTH_TOKEN',
    });
    expect(JSON.parse(JSON.stringify(run.state))).toEqual(run.state);
    // Absent when the response names none.
    const plain = new SessionRun();
    const without = plain.start(initResponse({ account: { apiKeySource: 'ANTHROPIC_API_KEY' } }));
    expect(plain.state.tokenSource).toBeNull();
    expect(ofType(without, 'handshake.ok')[0]?.info).not.toHaveProperty('tokenSource');
  });

  it('poisons the session and names the credential that triggered', () => {
    const run = new SessionRun();
    run.start(initResponse({ account: TOKEN_ACCOUNT }));
    run.feed({ type: 'cmd.send', turnId: U1, content: 'x' });
    run.line(systemInit());
    const effects = run.line(TRIGGER);
    expect(ofType(effects, 'turn.fail')[0]?.error).toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      message: expect.stringContaining('ANTHROPIC_AUTH_TOKEN') as unknown,
      details: {
        trigger: 'result',
        credentialSource: 'ANTHROPIC_AUTH_TOKEN',
        apiKeySource: 'none',
        tokenSource: 'ANTHROPIC_AUTH_TOKEN',
      },
    });
    expect(ofType(effects, 'ladder.start')[0]?.intent).toBe('auth-fail-fast');
    expect(run.state.poisoned).toBe(true);
  });

  it('names the API key when the key is the source, and follows a narrowed list', () => {
    const key = new SessionRun();
    key.start(initResponse({ account: { apiKeySource: 'ANTHROPIC_API_KEY' } }));
    key.feed({ type: 'cmd.send', turnId: U1, content: 'x' });
    key.line(systemInit());
    expect(ofType(key.line(TRIGGER), 'turn.fail')[0]?.error.details).toMatchObject({
      credentialSource: 'ANTHROPIC_API_KEY',
      tokenSource: null,
    });
    const narrowed = new SessionRun(makeConfig({ authFailFastSources: ['ANTHROPIC_API_KEY'] }));
    narrowed.start(initResponse({ account: TOKEN_ACCOUNT }));
    narrowed.feed({ type: 'cmd.send', turnId: U1, content: 'x' });
    narrowed.line(systemInit());
    expect(ofType(narrowed.line(TRIGGER), 'ladder.start')).toEqual([]);
  });
});

/** The out frames of a recorded fixture, in order. */
function recordedFrames(platform: 'win32' | 'linux'): JsonObject[] {
  const file = fileURLToPath(
    new URL(`../../../conformance/auth-token-source/${platform}.jsonl`, import.meta.url),
  );
  return readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { dir: string; v: JsonObject })
    .filter((record) => record.dir === 'out')
    .map((record) => record.v);
}

describe('replay of the recorded auth-token-source fixture (K10)', () => {
  for (const platform of ['win32', 'linux'] as const) {
    it(`${platform}: the recorded 401 fails fast on the auth token`, () => {
      const frames = recordedFrames(platform);
      const response = frames[0] as { response: JsonObject };
      expect(response).toMatchObject({ type: 'control_response' });
      // The fixture's session id is normalized; the machine expects that one.
      const run = new SessionRun(makeConfig({ sessionId: '<uuid-1>' }));
      run.feed({ type: 'process.started', pid: SPAWNED_PID });
      // The machine's own request id replaces the recorder's.
      const answered = run.line({
        ...response,
        response: { ...response.response, request_id: 'hudhud_1' },
      });
      // The recorded initialize response names only the token source.
      expect(ofType(answered, 'handshake.ok')[0]?.info).toMatchObject({
        tokenSource: 'ANTHROPIC_AUTH_TOKEN',
      });
      run.feed({ type: 'cmd.send', turnId: U1, content: '[[mock:err status=401]] hello' });
      const rest = frames.slice(1).flatMap((frame) => run.line(frame));
      expect(ofType(rest, 'ladder.start').map((effect) => effect.intent)).toEqual([
        'auth-fail-fast',
      ]);
      expect(ofType(rest, 'turn.fail')[0]?.error).toMatchObject({
        code: 'AUTHENTICATION_FAILED',
        details: { trigger: 'assistant', credentialSource: 'ANTHROPIC_AUTH_TOKEN' },
      });
      expect(run.state.poisoned).toBe(true);
    });
  }
});
