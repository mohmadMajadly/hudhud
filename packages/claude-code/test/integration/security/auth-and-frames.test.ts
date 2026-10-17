// Auth fail-fast and the inbound frame cap against the pinned CLI (W6-T4;
// plan §2.4 `onAuthFailure`, `onOversizedFrame`, `maxFrameBytes`, §3.1,
// §3.3; ADR-0012 §6, ADR-0011 §7; K10).
//
// Auth evidence: 05 §9 runs 57-59: a 401 is sticky, and with the default
// retries the CLI emits `system/api_retry` (`error: authentication_failed`)
// ten times over 170-184 s; the first retry follows the first 401 after
// 0.6 s. hudhud fails fast on the first trigger for the static credentials
// `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (K10; the token's source
// string was observed in the W3-Z fixture). Timing bound: 3x the 0.6 s first
// retry delay, so the failure must land before the CLI's second attempt
// could even start; the run otherwise takes about three minutes.
//
// Frame evidence: 05 §11 run 75: a 5 MB model text arrives as stdout lines
// of 5,001,567 bytes, unsplit; the `assistant` and `result` frames each carry
// the whole text.

import {
  AuthenticationFailedError,
  isHudhudError,
  OversizedFrameError,
  type TurnResult,
} from '@hudhudjs/core';
import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { recordTiming } from '../support/timing.js';
import { collect, diagnostics, requestsWith } from './support.js';

const suite = integrationSuite();

/**
 * 3 x the 0.6 s first retry delay of 05 §9 run 58: the failure must land
 * before the CLI's second attempt could start. It also holds the flake
 * margin: measured on CI (W7-T1, 15 samples per credential and run) at
 * most 179.9 ms on GitHub ubuntu-24.04 (timing runs 38980331321 and
 * 38984419523) and 419.7 ms on windows-2025 (run 38984419523), so 3x the
 * largest measurement (1260 ms) is below it.
 */
const FAIL_FAST_BOUND_MS = 1800;

for (const credential of ['api-key', 'fake-auth-token'] as const) {
  const source = credential === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
  test(`401 with ${source}: fail-fast poisons the session at the first trigger (05 §9 run 58, K10)`, async () => {
    await suite.setup({ sandbox: { credential } });
    const sandbox = await suite.sandbox();
    const harness = await suite.testConnect();
    const session = await harness.sessions.create();
    expect(credential === 'api-key' ? session.info.apiKeySource : session.info.tokenSource).toBe(
      source,
    );
    const collected = collect(session);
    const started = performance.now();
    // `errn`: 401 for the first request only, so a retry would succeed; the
    // failure proves hudhud did not wait for one.
    const error: unknown = await session.ask('[[mock:errn status=401 n=1 key=auth]] auth').then(
      (result: TurnResult) => result,
      (caught: unknown) => caught,
    );
    const elapsed = performance.now() - started;
    recordTiming(`auth-fail-fast.${credential}`, elapsed);
    await session.closed;
    await collected.done;

    expect(error).toBeInstanceOf(AuthenticationFailedError);
    expect(isHudhudError(error) ? error.code : undefined).toBe('AUTHENTICATION_FAILED');
    expect((error as AuthenticationFailedError).details).toMatchObject({
      trigger: 'api_retry',
      credentialSource: source,
    });
    expect(elapsed).toBeLessThan(FAIL_FAST_BOUND_MS);
    // hudhud decided at the CLI's first retry notice, not after its retry
    // ladder; the turn's requests carried the credential redacted.
    expect(collected.events.filter((event) => event.type === 'api.retry')).toEqual([
      expect.objectContaining({ attempt: 1, errorStatus: 401, error: 'authentication_failed' }),
    ]);
    const mock = await suite.mock();
    const header = credential === 'api-key' ? 'x-api-key' : 'authorization';
    const turns = requestsWith(mock, 'key=auth');
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) expect(turn.headers[header]).toBe('<redacted>');
    expect(collected.events.at(-1)).toMatchObject({
      type: 'session.terminated',
      intent: 'auth-fail-fast',
      outcome: 'failed',
    });
    // The session ended poisoned: later calls reject with the ending error
    // (plan §3.2).
    const again: unknown = await session.ask('[[mock:text]] again').then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(isHudhudError(again) ? again.code : again).toBe('AUTHENTICATION_FAILED');
    // No credential value in the error or any event.
    const value = String(sandbox.env[source]);
    const text = `${(error as Error).message} ${JSON.stringify((error as AuthenticationFailedError).details)} ${JSON.stringify(collected.events)}`;
    expect(text.includes(value)).toBe(false);
  });
}

test('a 5 MB model text passes the default 64 MiB cap unsplit (05 §11 run 75)', async () => {
  const harness = await suite.testConnect();
  const session = await harness.sessions.create();
  const result = await session.ask('[[mock:big bytes=5000000]] big');
  await session.close();
  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  expect(result.text?.length).toBe(5_000_000);
  expect(result.text?.startsWith('BIG:')).toBe(true);
  expect(result.text?.endsWith(':END')).toBe(true);
});

test("a frame above maxFrameBytes fails the session under 'fail' (default)", async () => {
  const harness = await suite.testConnect();
  const session = await harness.sessions.create({ maxFrameBytes: 1_048_576 });
  const collected = collect(session);
  await expect(session.ask('[[mock:big bytes=2000000]] over')).rejects.toBeInstanceOf(
    OversizedFrameError,
  );
  await session.closed;
  await collected.done;
  expect(collected.events.at(-1)).toMatchObject({
    type: 'session.terminated',
    intent: 'oversized-frame',
    outcome: 'failed',
  });
});

test("frames above maxFrameBytes are skipped and reported under 'skip'", async () => {
  const harness = await suite.testConnect();
  const session = await harness.sessions.create({
    maxFrameBytes: 1_048_576,
    onOversizedFrame: 'skip',
  });
  const collected = collect(session);
  const result = await session.ask('[[mock:big bytes=2000000]] skip');
  // The `result` frame itself was skipped: the end comes from the CLI's
  // idle state (05 §12 run 17), synthesized.
  expect(result).toMatchObject({ synthesized: true, isError: true });
  const after = await session.ask('[[mock:text]] after');
  expect(after).toMatchObject({ outcome: 'completed', isError: false });
  await session.close();
  await collected.done;
  const skipped = diagnostics(collected.events, 'frame.skipped-oversized');
  // The `assistant` and the `result` frame each carry the whole text.
  expect(skipped.length).toBeGreaterThanOrEqual(2);
  for (const data of skipped) expect(Number(data['bytes'])).toBeGreaterThan(1_048_576);
});
