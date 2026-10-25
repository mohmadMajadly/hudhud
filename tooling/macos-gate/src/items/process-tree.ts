/**
 * Gate item 2, process tree (ADR-0014; ADR-0010, research 05 §9-§10).
 *
 * Three runs, each with a Bash tool (`sleep`) or a slow stream from the mock:
 *
 * - SIGTERM: the `/bin/ps` table parses completely with `LC_ALL=C`,
 *   `TZ=UTC0`; the CLI's `lstart` start time is the spawn time; the Bash
 *   tool leads its own process group (as on Linux); SIGTERM to the CLI ends
 *   it and no tool process survives (by pid plus start time; a zombie is not
 *   a survivor). The raw `ps` lines of the tree are kept as evidence of the
 *   exact column format.
 * - SIGINT mid-stream: exit code 0, and the turn ends without a success
 *   result. Two shapes are accepted and recorded: no `result` frame (Linux,
 *   research 05 §9) or one error `result` before the exit (macOS gate run 1,
 *   research 09). Either way the core exit classifier must end the session
 *   with `PROCESS_EXITED` and settle the turn exactly once.
 * - SIGKILL: what survives is recorded, then the sweep of `ps.ts` (core
 *   `planSweep`, identity-verified) kills it, end to end.
 */

import { classifyExit } from '../../../../packages/core/src/protocol/machine/outcome.js';
import type { ItemRecorder } from '../report.js';
import { identityLabel, liveIdentity, psRawLines, psSnapshot } from '../ps.js';
import { bashMarker, mockMarker } from '../sandbox.js';
import { runScenario, type SessionContext } from '../session.js';
import { sessionEvidence, TURN_MS, waitForDescendant } from './common.js';

/**
 * The Bash tool's long foreground workload. From CLI 2.1.310 the Bash tool
 * refuses a foreground command whose first statement is `sleep N` with
 * N >= 25 (`Blocked: standalone sleep N`, so no process starts; macOS gate
 * run 40161690394), and it reads only the first statement, so the no-op
 * `true` keeps the same `sleep` child of the tool's shell on every version
 * of the tested window (as `foregroundSleep` in the integration tests).
 */
const TOOL_COMMAND = 'true && sleep 45';
const EXIT_MS = 10_000;
/** Allowed distance between the spawn and the `lstart` value (1 s resolution, clock skew). */
const START_TOLERANCE_MS = 5_000;
const SETTLE_MS = 2_000;

/** Runs item 2. */
export async function processTreeItem(context: SessionContext, r: ItemRecorder): Promise<void> {
  const { host, ledger } = context;

  const term = await runScenario(context, {}, async ({ session }) => {
    session.initialize();
    session.user(`${bashMarker(TOOL_COMMAND)} gate item 2 SIGTERM`);
    const seen = new Set<string>();
    const tree = await waitForDescendant(context, session, 'sleep', TURN_MS, seen);
    r.note('sigtermSession', { ...sessionEvidence(session), descendantsSeen: [...seen] });
    r.check(
      'SIGTERM run: the Bash tool runs under the CLI',
      tree !== undefined,
      tree === undefined ? `no live sleep; seen: ${[...seen].join(', ')}` : tree.match.name,
    );
    if (tree === undefined) return;
    r.note('treeBeforeSigterm', tree.descendants);
    r.note(
      'psLinesBeforeSigterm',
      await psRawLines(host, [tree.root.pid, ...tree.descendants.map((record) => record.pid)]),
    );
    r.check(
      'ps: every line parses (LC_ALL=C, TZ=UTC0, pid ppid pgid stat lstart comm)',
      tree.snapshot.rejected === 0,
      `${String(tree.snapshot.rejected)} rejected of ${String(tree.snapshot.records.length + tree.snapshot.rejected)}`,
    );
    const startMs = Number(tree.root.startTime) * 1000;
    r.check(
      'ps: the lstart start time of the CLI matches its spawn',
      Math.abs(startMs - session.spawnedAt) <= START_TOLERANCE_MS,
      `lstart ${new Date(startMs).toISOString()}, spawned ${new Date(session.spawnedAt).toISOString()}`,
    );
    r.check(
      'ps: the CLI name is its executable path, without column padding',
      tree.root.name.startsWith('/'),
      JSON.stringify(tree.root.name),
    );
    const leader = tree.descendants.find((record) => record.pid === tree.match.pgid);
    r.check(
      'process groups: the Bash tool leads its own group',
      leader !== undefined && leader.pgid === leader.pid && leader.pgid !== tree.root.pgid,
      `sleep pgid ${String(tree.match.pgid)}, CLI pgid ${String(tree.root.pgid)}, leader ${leader === undefined ? 'none' : leader.name}`,
    );
    host.signal(tree.root.pid, 'SIGTERM');
    const exit = await session.waitExit(EXIT_MS);
    r.check('SIGTERM: the CLI exits', exit !== undefined, JSON.stringify(exit));
    r.note('sigtermExit', exit);
    await host.sleep(SETTLE_MS);
    const after = await psSnapshot(host);
    ledger.observe(after);
    const survivors = tree.descendants.filter(
      (record) => liveIdentity(after.records, record) !== null,
    );
    r.check(
      'SIGTERM: the CLI cleans its tool groups (no survivor by pid + start time)',
      survivors.length === 0,
      survivors.map(identityLabel).join(', '),
    );
  });
  r.note('sigtermShutdown', term.shutdown);

  const int = await runScenario(context, {}, async ({ session }) => {
    session.initialize();
    session.user(`${mockMarker('slow', { chunks: '40', ms: '250' })} gate item 2 SIGINT`);
    const init = await session.waitKind('system/init', TURN_MS);
    await host.sleep(SETTLE_MS);
    const before = session.frames.length;
    const open = session.findKind('result') === undefined;
    r.check(
      'SIGINT run: signalled while the turn streams',
      init !== undefined && open,
      `${String(before)} frames before`,
    );
    if (session.identity !== null) host.signal(session.identity.pid, 'SIGINT');
    const exit = await session.waitExit(EXIT_MS);
    r.note('sigintSession', sessionEvidence(session));
    r.check('SIGINT mid-stream: exit code 0', exit?.code === 0, JSON.stringify(exit));
    const results = session.frames
      .slice(before)
      .filter((frame) => frame.value['type'] === 'result');
    const last = results.at(-1);
    const shape =
      last === undefined
        ? 'no-result'
        : results.length === 1 && last.value['is_error'] === true
          ? 'error-result'
          : 'other';
    r.note('sigintShape', {
      shape,
      results: results.map((frame) => ({
        subtype: frame.value['subtype'],
        is_error: frame.value['is_error'],
        terminal_reason: frame.value['terminal_reason'],
      })),
    });
    r.check(
      'SIGINT mid-stream: no result, or exactly one error result (recorded shape)',
      shape !== 'other',
      `${shape}; ${String(session.frames.length - before)} frames after the signal`,
    );
    if (exit !== undefined) {
      const classified = classifyExit({
        intent: 'none',
        exit: { code: exit.code, signal: exit.signal },
        turnActive: last === undefined,
        lastResultIsError: last?.value['is_error'] === true,
        platform: 'posix',
      });
      r.note('sigintClassification', classified);
      r.check(
        'SIGINT mid-stream: the core exit classifier ends the session with PROCESS_EXITED and settles the turn once',
        classified.outcome === 'unknown' &&
          classified.error === 'PROCESS_EXITED' &&
          classified.turnSynthesis === (last === undefined ? 'error' : 'none'),
        JSON.stringify(classified),
      );
    }
  });
  r.note('sigintShutdown', int.shutdown);

  const kill = await runScenario(context, {}, async ({ session }) => {
    session.initialize();
    session.user(`${bashMarker(TOOL_COMMAND)} gate item 2 SIGKILL`);
    const seen = new Set<string>();
    const tree = await waitForDescendant(context, session, 'sleep', TURN_MS, seen);
    r.check(
      'SIGKILL run: the Bash tool runs under the CLI',
      tree !== undefined,
      tree === undefined ? `no live sleep; seen: ${[...seen].join(', ')}` : tree.match.name,
    );
    if (tree === undefined) return;
    host.signal(tree.root.pid, 'SIGKILL');
    await session.waitExit(EXIT_MS);
    await host.sleep(SETTLE_MS);
    const after = await psSnapshot(host);
    const survivors = tree.descendants.filter(
      (record) => liveIdentity(after.records, record) !== null,
    );
    r.note('sigkillSurvivors', survivors);
    const sweep = await ledger.sweep(tree.root);
    r.note('sweep', sweep);
    r.check(
      'sweep: the survivors were signalled by verified identity',
      survivors.length === 0 || sweep.signalled.length > 0,
      sweep.signalled.join(', '),
    );
    r.check(
      'sweep: nothing of the tree survives',
      sweep.survivors.length === 0,
      sweep.survivors.join(', '),
    );
  });
  r.note('sigkillShutdown', kill.shutdown);
  for (const [name, outcome] of [
    ['SIGTERM', term],
    ['SIGINT', int],
    ['SIGKILL', kill],
  ] as const) {
    r.check(
      `${name} run: no egress violation`,
      outcome.violations === 0,
      String(outcome.violations),
    );
    r.check(
      `${name} run: nothing survives the session`,
      outcome.shutdown.sweep.survivors.length === 0,
      outcome.shutdown.sweep.survivors.join(', '),
    );
  }
}
