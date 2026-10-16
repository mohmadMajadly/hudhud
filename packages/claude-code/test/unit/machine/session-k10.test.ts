// K10 as decided by the lead after the auth-token-source fixture: auth
// fail-fast applies to ANTHROPIC_AUTH_TOKEN exactly as to ANTHROPIC_API_KEY
// (a static env credential that got a 401 does not succeed on retry). The
// CLI reports the token as account.tokenSource with apiKeySource "none".
// The recorded auth-token-source suite is replayed, with its exact effects,
// by the conformance runner (test/conformance, W4-T2).

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@hudhudjs/core/protocol';

import { DEFAULT_AUTH_FAIL_FAST_SOURCES } from '../../../src/protocol/machine/index.js';
import {
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
