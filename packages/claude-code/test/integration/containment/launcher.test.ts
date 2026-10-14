// The K1 signal target with a launcher in front of the CLI (plan §1.7
// "Process identity and signal target", §4.4, §5.8 W6-T3; ADR-0010; 07 §4).
//
// 07 §4 W109/L84: through a launcher shaped like the npm package's fallback
// `cli-wrapper.cjs` (`t14-launcher.cjs`: `spawnSync(binary, argv, { stdio:
// 'inherit' })`), the spawned pid is the launcher's and `initialize.pid` is
// the CLI's (a child of the launcher), and the launcher re-raises nothing to
// its child. K1: SIGTERM goes to `initialize.pid` only when snapshot S1 shows
// it as a descendant of the spawned pid; otherwise to the spawned pid.
// Containment and the sweep stay rooted at the spawned pid.
//
// POSIX only: the signal target is a POSIX rule (Windows ends the tree by
// `taskkill /T` from the spawned pid), and a launcher on Windows would have
// to be a native executable (the harness's `test-launcher.ts` refuses
// `win32`). The case without a launcher is in `ladder.test.ts` (the K1
// target is then the spawned pid, which is `initialize.pid`).
//
// Not reproducible here: a start-time mismatch of the signal target between
// S1 and S2 (the CLI's pid reused by another process within one ladder)
// needs pid reuse; the core's unit tests cover that branch with a fake
// process table (`packages/core/test/process/ladder/posix.test.ts`,
// `signal-target:identity-changed`). The real-process case of the same S2
// re-verification, a signal target that exited, is the lingering-launcher
// test below.

import { describe, expect, test } from 'vitest';

import type { Session } from '@hudhud/core';

import { integrationSuite } from '../support/harness.js';
import {
  allowAll,
  bashTool,
  collectEvents,
  diagnostics,
  ladderSteps,
  onlyDiagnostic,
  sleepsOf,
  waitForSleep,
  WINDOWS,
  workloadOfTest,
} from './tree.js';
import type { DiagnosticEvent } from './tree.js';
import type { HudhudEvent } from '@hudhud/core';

const suite = integrationSuite();

/** Hang guard for the tool's process to appear. */
const TOOL_START_GUARD_MS = 30_000;
/** A lingering launcher ends itself after this (it is always ended earlier by the ladder). */
const LINGER_MS = 60_000;
/**
 * The close deadline of the tests that keep the CLI running past EOF (K13).
 * They end the session by `close()`, not by dispose: the interrupt of the
 * dispose ladder ends the background shell on Linux (measured, W6-T3), and
 * the CLI then exits on EOF before S1; a close only ends stdin, so the
 * background shell holds the CLI (07 §7 L88) until the deadline runs the
 * ladder.
 */
const CLOSE_DEADLINE_MS = 3000;

/** Opens a session through the test's launcher and checks the launcher was detected (07 §4). */
async function launcherSession(launcher: {
  readonly lingerMs?: number;
  readonly ignoreSigterm?: boolean;
}): Promise<{ session: Session; events: HudhudEvent[]; done: Promise<void> }> {
  await suite.setup({ launcher });
  const harness = await suite.testConnect();
  const session = await harness.sessions.create({
    onPermission: allowAll,
    closeTimeoutMs: CLOSE_DEADLINE_MS,
  });
  const collected = collectEvents(session);
  expect(session.info.cliPid).toBeDefined();
  expect(session.info.cliPid).not.toBe(session.info.pid);
  return { session, ...collected };
}

/** A background shell that holds the CLI after EOF (07 §7 W120/L88); returns the `sleep` it runs. */
async function holdTheCli(
  session: Session,
): Promise<{ readonly tag: string; readonly pid: number }> {
  const tag = workloadOfTest(600);
  const result = await session.ask(
    `${bashTool({ command: `sleep ${tag}`, run_in_background: true })} start it`,
  );
  expect(result.outcome).toBe('completed');
  return { tag, pid: (await waitForSleep(tag, TOOL_START_GUARD_MS)).pid };
}

function launcherDetected(events: readonly HudhudEvent[]): DiagnosticEvent[] {
  return diagnostics(events, 'binary.launcher-detected');
}

describe.runIf(!WINDOWS)('K1 signal target through a launcher (POSIX)', () => {
  test('launcher present: SIGTERM goes to initialize.pid, the CLI in S1 below the launcher', async () => {
    const { session, events, done } = await launcherSession({});
    const held = await holdTheCli(session);
    await session.close();
    await done;

    expect(launcherDetected(events)).toHaveLength(1);
    const ladder = onlyDiagnostic(events, 'termination.ladder');
    expect(ladder.data).toMatchObject({
      intent: 'close-timeout',
      launcherDetected: true,
      signalTarget: { pid: session.info.cliPid },
      exitedAfter: 'sigterm',
    });
    expect(ladderSteps(ladder)).toContain('sigterm:done:initialize-pid');
    // The CLI killed its tool groups on SIGTERM (05 §10); the launcher
    // returned from spawnSync and exited.
    expect(await sleepsOf(held.tag)).toEqual([]);
  }, 120_000);

  test('lingering launcher: S2 re-verifies the signal target (exited), then SIGKILL of the spawned pid and the sweep', async () => {
    const { session, events, done } = await launcherSession({ lingerMs: LINGER_MS });
    const held = await holdTheCli(session);
    await session.close();
    await done;

    const ladder = onlyDiagnostic(events, 'termination.ladder');
    expect(ladder.data).toMatchObject({
      intent: 'close-timeout',
      launcherDetected: true,
      signalTarget: { pid: session.info.cliPid },
      exitedAfter: 'sweep',
    });
    const steps = ladderSteps(ladder);
    expect(steps).toContain('sigterm:done:initialize-pid');
    // The CLI exited on SIGTERM; the launcher lingered past termGraceMs.
    expect(steps).toContain('sigkill:skipped:signal-target:exited');
    expect(steps).toContain('sigkill:done:spawned');
    expect(steps.at(-1)).toBe('sweep:done');
    expect(await sleepsOf(held.tag)).toEqual([]);
  }, 120_000);

  test('initialize.pid not in S1: the CLI already exited, so SIGTERM goes to the spawned launcher', async () => {
    const { session, events, done } = await launcherSession({ lingerMs: LINGER_MS });
    await session.ask('[[mock:text]] hello');
    // Idle: the CLI exits on the EOF after the interrupt (24-47 ms, 05 §8
    // runs 39/43); the launcher lingers, so S1 has no initialize.pid.
    await session[Symbol.asyncDispose]();
    await done;

    const ladder = onlyDiagnostic(events, 'termination.ladder');
    expect(ladder.data).toMatchObject({
      launcherDetected: true,
      signalTarget: { pid: session.info.pid },
      exitedAfter: 'sigterm',
    });
    expect(ladderSteps(ladder)).toContain('sigterm:done:spawned');
  }, 120_000);

  test('initialize.pid not in S1 and the launcher ignores SIGTERM: SIGKILL of the spawned pid and the sweep', async () => {
    const { session, events, done } = await launcherSession({
      lingerMs: LINGER_MS,
      ignoreSigterm: true,
    });
    await session.ask('[[mock:text]] hello');
    await session[Symbol.asyncDispose]();
    await done;

    const ladder = onlyDiagnostic(events, 'termination.ladder');
    expect(ladder.data).toMatchObject({
      launcherDetected: true,
      signalTarget: { pid: session.info.pid },
      exitedAfter: 'sweep',
    });
    const steps = ladderSteps(ladder);
    expect(steps).toContain('sigterm:done:spawned');
    expect(steps).toContain('sigkill:done:spawned');
    expect(steps.some((step) => step.includes('signal-target'))).toBe(false);
    expect(steps.at(-1)).toBe('sweep:done');
  }, 120_000);
});
