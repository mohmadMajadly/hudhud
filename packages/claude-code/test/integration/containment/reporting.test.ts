// What the product reports about containment, and the process hooks it
// installs (plan §2.2, §6.4, §5.8 W6-T3; K2, K22).
//
// Containment is reported per mode (plan §6.4, §6.5; A2 lead ruling): on
// Windows x64 the staged `@hudhudjs/win32-job-x64` addon gives `'job'`, the
// shipping default; with the addon forced unavailable (`jobAddon:
// 'unavailable'`, the loader's `package-missing`) the product falls back to
// `'best-effort'` with the loader's reason. Off Windows it is best effort.

import process from 'node:process';

import { describe, expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { CONTAINMENT_MODES, collectEvents, diagnostics, WINDOWS } from './tree.js';

const suite = integrationSuite();

describe.each(CONTAINMENT_MODES)('addon $jobAddon ($containment)', ({ jobAddon, containment }) => {
  test(`containment is reported as ${containment}, by the Harness and by each session (K2)`, async () => {
    const harness = await suite.testConnect({ jobAddon });
    expect(harness.capabilities.processContainment).toBe(containment);
    if (containment === 'job') {
      expect(harness.capabilities.reasons['processContainment']).toBeUndefined();
    } else {
      // The loader's own outcome (plan §6.4): no addon package on Windows,
      // not Windows elsewhere.
      expect(harness.capabilities.reasons['processContainment']).toMatch(
        WINDOWS
          ? /^job addon unavailable: package-missing \(/
          : /^job addon unavailable: not-windows \(/,
      );
    }

    const session = await harness.sessions.create();
    const { events, done } = collectEvents(session);
    expect(session.info.containment).toBe(containment);
    await session.ask('[[mock:text]] hello');
    await session.close();
    await done;
    // Under `'job'` the assignment succeeded; under best effort no job was
    // created. Either way no assignment failed: `containment.fallback`
    // reports only a failed assignment (K2), never a missing addon.
    expect(diagnostics(events, 'containment.fallback')).toEqual([]);
  });
});

/** The signals a library could hook (Node.js names; SIGBREAK is Windows' Ctrl+Break). */
const SIGNALS: readonly NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGQUIT',
  'SIGBREAK',
  'SIGUSR1',
  'SIGUSR2',
];

function listenerCounts(): Record<string, number> {
  return Object.fromEntries(
    [...SIGNALS, 'exit', 'beforeExit', 'uncaughtException', 'unhandledRejection'].map((name) => [
      name,
      process.listenerCount(name),
    ]),
  );
}

test('the library installs no signal handler, only the host-exit hook while a session lives (K22)', async () => {
  const before = listenerCounts();
  const harness = await suite.testConnect();
  expect(listenerCounts()).toEqual(before);

  const first = await harness.sessions.create();
  const second = await harness.sessions.create();
  // Exactly one `exit` listener for all live sessions (host-exit.ts), nothing else.
  expect(listenerCounts()).toEqual({ ...before, exit: (before['exit'] ?? 0) + 1 });
  await first.ask('[[mock:text]] one');
  await first.close();
  expect(listenerCounts()).toEqual({ ...before, exit: (before['exit'] ?? 0) + 1 });
  await second.close();
  // Removed with the last session.
  expect(listenerCounts()).toEqual(before);
});
