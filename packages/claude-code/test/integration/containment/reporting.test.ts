// What the product reports about containment, and the process hooks it
// installs (plan §2.2, §6.4, §5.8 W6-T3; K2, K22).
//
// Job-object tests (plan §6.5) need the `@hudhud/win32-job-x64` addon,
// which this repository does not build yet (A1-A2: MSVC and CMake are not
// part of the toolchain here). There is no test-skip convention for the
// addon, so no job test is written as a skip: the first test below asserts
// that the product honestly reports best-effort containment with the
// loader's reason, and it fails (on purpose) once the addon is installed,
// which is when the job tests of plan §6.5 must be added here.

import process from 'node:process';

import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { collectEvents, diagnostics, WINDOWS } from './tree.js';

const suite = integrationSuite();

test('containment is reported as best-effort, by the Harness and by each session (K2)', async () => {
  const harness = await suite.testConnect();
  expect(harness.capabilities.processContainment).toBe('best-effort');
  // The loader's own outcome (plan §6.4): no addon package on Windows,
  // not Windows elsewhere.
  expect(harness.capabilities.reasons['processContainment']).toMatch(
    WINDOWS
      ? /^job addon unavailable: package-missing \(/
      : /^job addon unavailable: not-windows \(/,
  );

  const session = await harness.sessions.create();
  const { events, done } = collectEvents(session);
  expect(session.info.containment).toBe('best-effort');
  await session.ask('[[mock:text]] hello');
  await session.close();
  await done;
  // No job was created, so no assignment could fail: `containment.fallback`
  // reports only a failed assignment (K2), never a missing addon.
  expect(diagnostics(events, 'containment.fallback')).toEqual([]);
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
