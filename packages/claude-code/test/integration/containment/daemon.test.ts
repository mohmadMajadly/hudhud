// A tool's daemon outlives the CLI on every way a session ends (review R3-1,
// R8-1; ADR-0010 "Sweep"; plan §5.9 review fixes).
//
// A background Bash shell starts a descendant that leaves the shell's
// process group and session (`setsid`, as `orphan.test.ts` does for the
// graceful close) and then holds the CLI with a long `sleep`. The session
// then ends by `dispose()`, by `close()` with an aborted signal, or by the
// close deadline. The CLI exits on the ladder's `SIGTERM` and ends its tool
// groups (05 §9, §10), which leaves the daemon reparented to init. Before
// the fix the POSIX ladder returned at once after that exit, without a
// sweep, and the daemon kept running; now the ladder sweeps what S1
// recorded, and the binding's snapshot before EOF covers an exit at an
// earlier step. The harness's leak check (tagged workloads, tracked
// descendants) fails the test on any survivor, and the test asserts none
// itself.
//
// Linux and macOS only: on Windows the tree has no daemon of this kind (a
// job ends everything; best effort keeps the measured W6-T3 residual, see
// `ladder.test.ts` and `orphan.test.ts`).

import { describe, expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import {
  allowAll,
  bashTool,
  collectEvents,
  ladderSteps,
  onlyDiagnostic,
  sleepsOf,
  waitForSleep,
  WINDOWS,
} from './tree.js';

const suite = integrationSuite();

/** The prefix that starts the workload in a new session and process group (as `orphan.test.ts`). */
const DETACH: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: "/usr/bin/perl -MPOSIX -e 'POSIX::setsid() or die qq(setsid: $!); exec @ARGV or die' ",
};

/** Hang guard for the background workload to appear. */
const TOOL_START_GUARD_MS = 30_000;
/** The close deadline of the close-timeout case (K13; the default is 30 s). */
const CLOSE_DEADLINE_MS = 3000;

const ENDINGS = [
  { name: 'dispose', intent: 'dispose' },
  { name: 'close with an aborted signal', intent: 'abort' },
  { name: 'the close deadline', intent: 'close-timeout' },
] as const;

describe.runIf(!WINDOWS)('a daemonized tool process', () => {
  test.each(ENDINGS)(
    '$name: nothing the tool daemonized survives',
    async ({ intent }) => {
      const tag = suite.workloadTag(600);
      const session = await suite.testSession({
        session: {
          onPermission: allowAll,
          ...(intent === 'close-timeout' ? { closeTimeoutMs: CLOSE_DEADLINE_MS } : {}),
        },
      });
      const { events, done } = collectEvents(session);
      const detach = DETACH[process.platform] ?? 'setsid ';
      const command = `${detach}sleep ${tag} >/dev/null 2>&1 & sleep 600`;
      const result = await session.ask(
        `${bashTool({ command, run_in_background: true })} start it`,
      );
      expect(result.outcome).toBe('completed');
      const workload = await waitForSleep(tag, TOOL_START_GUARD_MS);

      if (intent === 'dispose') {
        await session[Symbol.asyncDispose]();
      } else if (intent === 'abort') {
        const controller = new AbortController();
        controller.abort();
        await session.close({ signal: controller.signal }).catch(() => undefined);
      } else {
        await session.close();
      }
      await done;

      expect(events.at(-1)).toMatchObject({ type: 'session.terminated', intent });
      const ladder = onlyDiagnostic(events, 'termination.ladder');
      const report = JSON.stringify({ steps: ladderSteps(ladder), ladder: ladder.data, workload });
      // Whichever step ended the CLI, the binding swept its snapshot before
      // EOF after the exit (and the ladder swept S1 when it ended after S1).
      if (ladderSteps(ladder).some((step) => step.startsWith('snapshot-s1:done'))) {
        expect(ladderSteps(ladder).at(-1), report).toMatch(/^sweep:done/u);
      }
      expect(onlyDiagnostic(events, 'termination.sweep-after-exit').data?.['status'], report).toBe(
        'done',
      );
      expect(await sleepsOf(tag), report).toEqual([]);
    },
    120_000,
  );
});
