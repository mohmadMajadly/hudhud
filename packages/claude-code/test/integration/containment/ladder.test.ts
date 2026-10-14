// Termination ladders against the pinned CLI (plan §4.4 "containment and
// ladders", §4.7, §5.8 W6-T3; ADR-0008, ADR-0009, ADR-0010; K1, K13).
//
// Windows runs the best-effort ladder: the job-object addon is not built in
// this repository yet (plan §6, A1-A2), and `reporting.test.ts` asserts that
// the product reports exactly that. Linux runs the POSIX ladder.

import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import {
  allowAll,
  bashTool,
  collectEvents,
  killEach,
  ladderSteps,
  onlyDiagnostic,
  sleepsOf,
  waitForSleep,
  WINDOWS,
} from './tree.js';

const suite = integrationSuite();

/** The close deadline of these tests (K13; the default is 30 s). */
const CLOSE_DEADLINE_MS = 3000;
/** Hang guard for a tool's process to appear (the mock answers at once; a Bash tool starts in about 1 s, 05 §10). */
const TOOL_START_GUARD_MS = 30_000;

test('close: the deadline expires while a background shell holds the CLI, and the ladder ends it (K13)', async () => {
  // 07 §7 W120-W123 / L88: after EOF the CLI waits for a background Bash
  // shell for the shell's whole lifetime (697.7 s observed for `sleep
  // 700`), so only the close deadline ends this session.
  const tag = suite.workloadTag(600);
  const session = await suite.testSession({
    session: { onPermission: allowAll, closeTimeoutMs: CLOSE_DEADLINE_MS },
  });
  const { events, done } = collectEvents(session);
  const result = await session.ask(
    `${bashTool({ command: `sleep ${tag}`, run_in_background: true })} start it`,
  );
  expect(result.outcome).toBe('completed');
  const workload = await waitForSleep(tag, TOOL_START_GUARD_MS);

  const closing = Date.now();
  await session.close();
  expect(Date.now() - closing).toBeGreaterThanOrEqual(CLOSE_DEADLINE_MS);
  await done;

  expect(events.at(-1)).toMatchObject({
    type: 'session.terminated',
    intent: 'close-timeout',
    outcome: 'aborted',
  });
  const ladder = onlyDiagnostic(events, 'termination.ladder');
  expect(ladder.data).toMatchObject({ intent: 'close-timeout', launcherDetected: false });
  const steps = ladderSteps(ladder);
  // stdin was already ended by the drain, so no interrupt applies.
  expect(steps.slice(0, 2)).toEqual(['intent:done', 'interrupt:skipped:not-applicable']);
  if (WINDOWS) {
    // Best effort (ADR-0009): S1, EOF, the grace, then `taskkill /T /F`.
    expect(steps.slice(2, 5)).toEqual([
      expect.stringMatching(/^snapshot-s1:done/),
      'eof:done',
      'taskkill:done',
    ]);
    expect(ladder.data).toMatchObject({ exitedAfter: 'taskkill', signalTarget: null });
  } else {
    // POSIX (ADR-0010, K1): no launcher, so SIGTERM goes to the spawned pid;
    // the CLI kills its tool groups on SIGTERM and exits 143 (05 §9, §10).
    expect(steps).toContain('sigterm:done:spawned');
    expect(ladder.data).toMatchObject({
      exitedAfter: 'sigterm',
      signalTarget: { pid: session.info.pid },
    });
    expect(events.at(-1)).toMatchObject({ exitCode: 143 });
  }

  const survivors = await sleepsOf(tag);
  if (WINDOWS) {
    // Measured residual of best effort (W6-T3): `sleep.exe` was started
    // by MSYS2 through a forked `bash.exe` copy that exited at once, so
    // `taskkill /T` (which follows parent pids) cannot reach it.
    expect(survivors.map((row) => row.pid)).toEqual([workload.pid]);
    expect(await killEach(survivors)).toEqual(['killed']);
  } else {
    expect(survivors).toEqual([]);
  }
}, 120_000);

test('dispose during a foreground Bash tool: the interrupt ends it without force (ADR-0009, ADR-0010)', async () => {
  // 05 §7: an interrupt during a tool aborts the turn; the machine then
  // ends stdin, and an idle CLI exits on EOF in 24-47 ms (05 §8 runs
  // 39/43), so neither `taskkill` nor a signal is needed.
  const tag = suite.workloadTag(600);
  const session = await suite.testSession({ session: { onPermission: allowAll } });
  const { events, done } = collectEvents(session);
  const asked = session.ask(`${bashTool({ command: `sleep ${tag}` })} run it`);
  const workload = await waitForSleep(tag, TOOL_START_GUARD_MS);

  await session[Symbol.asyncDispose]();
  await expect(asked).resolves.toMatchObject({ outcome: 'cancelled' });
  await done;

  expect(events.at(-1)).toMatchObject({
    type: 'session.terminated',
    intent: 'dispose',
    outcome: 'aborted',
  });
  const ladder = onlyDiagnostic(events, 'termination.ladder');
  const steps = ladderSteps(ladder);
  expect(steps.slice(0, 2)).toEqual(['intent:done', 'interrupt:done:acknowledged']);
  // The CLI exits on the EOF that follows the acknowledged interrupt, while
  // the ladder takes its next step: on Windows S1 (one CIM query, 0.3-1.3 s)
  // comes before the EOF step, on POSIX the EOF step comes first.
  expect(WINDOWS ? ['interrupt', 'snapshot-s1', 'eof'] : ['interrupt', 'eof']).toContain(
    ladder.data?.['exitedAfter'],
  );
  expect(steps.some((step) => /^(taskkill|terminate-process|sigterm|sigkill)/.test(step))).toBe(
    false,
  );

  const survivors = await sleepsOf(tag);
  if (WINDOWS) {
    // The CLI ends its tool on the interrupt by the tool's process tree;
    // MSYS2's `sleep.exe` is outside that tree (see `workloadTag`).
    expect(survivors.map((row) => row.pid)).toEqual([workload.pid]);
    expect(await killEach(survivors)).toEqual(['killed']);
  } else {
    expect(survivors).toEqual([]);
  }
}, 120_000);
