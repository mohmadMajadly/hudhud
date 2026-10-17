// The egress trap with nonessential traffic deliberately on and off (W6-T4;
// plan §4.5; ADR-0012 §5, ADR-0013 §2).
//
// Evidence: 05 §2 run 89 (`q10-egress-nonessential-on`): without
// `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` the CLI sends its turn to the
// mock and about 11 `CONNECT api.anthropic.com:443` within 20 s straight
// past `ANTHROPIC_BASE_URL`; with the variable (every other run of 05 and
// 07 §3.2 W101/L76) zero. The trap is the mock as `HTTPS_PROXY`: it records
// each attempt and refuses it with 403, never forwarding anything.
//
// Timing: in the W6-T4 measurements the first attempts were recorded before
// the first turn had finished (four within 0.2 s of it, seven after 15 s);
// both tests watch the same window, the first turn plus OBSERVE_MS, more
// than 3x the 0.2 s it took the first attempts to appear. Re-measured
// (W7-T1): the first attempt was recorded at most 3.9 ms after the turn
// ended on CI (timing runs 38980331321 and 38984419523, 15 samples each:
// GitHub ubuntu-24.04 at most 3.9 ms, windows-2025 at most 2.8 ms).
// The window is not shortened to 3x that: for the "off" test it is how long
// silence is observed, and longer is stronger.

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { recordTiming } from '../support/timing.js';
import { requestsWith } from './support.js';

const suite = integrationSuite();

const OBSERVE_MS = 3000;

test('nonessential traffic on: the trap records and refuses every attempt (05 §2 run 89)', async () => {
  // The one test whose sandbox leaves the switch out (plan §4.5).
  await suite.setup({ sandbox: { nonessentialTraffic: 'allowed' } });
  const mock = await suite.mock();
  const harness = await suite.testConnect();
  const session = await harness.sessions.create({ nonessentialTraffic: 'harness-default' });
  const result = await session.ask('[[mock:text]] egress-on');
  const turnEnded = performance.now();
  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  // The same window as below; when the first attempt appears inside it, its
  // delay after the turn is a K15 timing sample (W7-T1).
  while (mock.violations.length === 0 && performance.now() - turnEnded < OBSERVE_MS) {
    await delay(10);
  }
  if (mock.violations.length > 0) {
    recordTiming('egress.first-attempt-after-turn', performance.now() - turnEnded);
  }
  await delay(Math.max(0, OBSERVE_MS - (performance.now() - turnEnded)));
  // Closed (the CLI has exited) before the record is read: nothing can add
  // to it afterwards.
  await session.close();

  const attempts = mock.violations;
  expect(attempts.length).toBeGreaterThan(0);
  for (const attempt of attempts) {
    expect(attempt).toMatchObject({
      kind: 'connect',
      method: 'CONNECT',
      target: 'api.anthropic.com:443',
    });
  }
  // The model traffic itself still went to the mock only.
  expect(requestsWith(mock, 'egress-on')).toHaveLength(1);
  // The violations were expected here and are asserted above; the test
  // clears them so the harness's zero-violation check covers whatever else
  // the test did (nothing after the close).
  mock.reset();
});

test('nonessential traffic off (the default): zero attempts in the same window', async () => {
  const mock = await suite.mock();
  const harness = await suite.testConnect();
  const session = await harness.sessions.create();
  const result = await session.ask('[[mock:text]] egress-off');
  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  await delay(OBSERVE_MS);
  await session.close();
  expect(mock.violations).toEqual([]);
  expect(requestsWith(mock, 'egress-off')).toHaveLength(1);
});
