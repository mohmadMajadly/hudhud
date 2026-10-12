/**
 * Gate item 4, zsh login-shell snapshot hang (ADR-0014; GH#78903, research
 * 01 §7).
 *
 * - Default runner shell (`SHELL=/bin/zsh`, the system `/etc/z*` files, an
 *   empty isolated HOME): a Bash tool turn completes.
 * - Provoked hang: the isolated HOME's `.zshenv`, `.zprofile` and `.zshrc`
 *   block. The idle watchdog must reach its `stalled` path and the stall must
 *   be named `shell-snapshot` (no snapshot file written, a shell child
 *   alive), after which the harness ladder and the sweep leave nothing
 *   behind. When the CLI instead finishes the turn on its own (a snapshot
 *   timeout of its own), that is recorded with the time it took.
 */

import path from 'node:path';

import { classifyStall, watchdogState, type WatchdogState } from '../causes.js';
import type { ItemRecorder } from '../report.js';
import { bashMarker } from '../sandbox.js';
import { runScenario, type SessionContext } from '../session.js';
import {
  isSuccess,
  pollUntil,
  sessionEvidence,
  shellSnapshotReady,
  TURN_MS,
  WATCHDOG,
} from './common.js';

const HANG_RC = 'sleep 600\n';
const HANG_LIMIT_MS = 150_000;

/** Runs item 4. */
export async function shellSnapshotItem(context: SessionContext, r: ItemRecorder): Promise<void> {
  const { host } = context;

  const normal = await runScenario(context, {}, async ({ session, sandbox }) => {
    session.initialize();
    session.user(`${bashMarker('echo hudhud-gate-4a')} gate item 4 default shell`);
    const result = await session.waitKind('result', TURN_MS);
    r.note('defaultSession', {
      ...sessionEvidence(session),
      snapshots: await host.fs.readdir(path.posix.join(sandbox.config, 'shell-snapshots')),
    });
    r.check(
      'default runner shell: the Bash tool turn completes',
      isSuccess(result) && String(result?.value['result']).includes('hudhud-gate-4a'),
      result === undefined
        ? 'no result'
        : `${String(result.at - session.spawnedAt)} ms after spawn`,
    );
  });

  const hang = await runScenario(
    context,
    {
      prepare: async (sandbox) => {
        for (const name of ['.zshenv', '.zprofile', '.zshrc']) {
          await host.fs.writeFile(path.posix.join(sandbox.home, name), HANG_RC);
        }
      },
    },
    async ({ session, sandbox }) => {
      session.initialize();
      session.user(`${bashMarker('echo hudhud-gate-4b')} gate item 4 hanging login shell`);
      let state = 'ok' as WatchdogState;
      await pollUntil(
        host,
        () =>
          state !== 'ok' || session.findKind('result') !== undefined || session.exit !== undefined,
        HANG_LIMIT_MS,
        () => {
          state = watchdogState(session.watchdogInput(), WATCHDOG);
          return Promise.resolve();
        },
      );
      const result = session.findKind('result');
      const tree =
        state === 'stalled' && session.identity !== null
          ? await context.ledger.tree(session.identity)
          : undefined;
      const cause =
        tree === undefined
          ? undefined
          : classifyStall({
              descendants: tree.descendants,
              toolRunning: session.toolRunning,
              shellSnapshotReady: await shellSnapshotReady(host, sandbox),
            });
      r.note('hangSession', {
        ...sessionEvidence(session),
        watchdog: state,
        stallCause: cause,
        tree: tree?.descendants,
      });
      if (result !== undefined) {
        r.note(
          'hangOutcome',
          'completed: the CLI finished the turn despite the hanging login shell',
        );
        r.check(
          'hanging login shell: the CLI completes the turn on its own',
          isSuccess(result),
          `${String(result.at - session.spawnedAt)} ms after spawn`,
        );
        return;
      }
      r.note('hangOutcome', `watchdog ${state}`);
      r.check(
        'hanging login shell: the idle watchdog reaches the stalled path',
        state === 'stalled',
        state,
      );
      r.check(
        'hanging login shell: the stall is named shell-snapshot',
        cause === 'shell-snapshot',
        String(cause),
      );
    },
  );
  r.note('hangShutdown', hang.shutdown);
  r.check(
    'hanging login shell: the ladder and sweep leave nothing behind',
    hang.shutdown.sweep.survivors.length === 0,
    hang.shutdown.sweep.survivors.join(', '),
  );
  r.check(
    'no egress violation',
    normal.violations + hang.violations === 0,
    `${String(normal.violations)} + ${String(hang.violations)}`,
  );
  r.check(
    'default run: nothing survives',
    normal.shutdown.sweep.survivors.length === 0,
    normal.shutdown.sweep.survivors.join(', '),
  );
}
