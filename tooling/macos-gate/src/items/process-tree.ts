/**
 * Gate item 2, process tree (ADR-0014; ADR-0010, research 05 §9-§10).
 *
 * Three runs, each with a Bash tool (`sleep`) or a slow stream from the mock:
 *
 * - SIGTERM: the `/bin/ps` table parses completely with `LC_ALL=C`,
 *   `TZ=UTC0`; the CLI's `lstart` start time is the spawn time; the Bash
 *   tool leads its own process group (as on Linux); SIGTERM to the CLI ends
 *   it and no tool process survives (by pid plus start time).
 * - SIGINT mid-stream: exit code 0 and no `result` frame.
 * - SIGKILL: what survives is recorded, then the sweep of `ps.ts` (core
 *   `planSweep`, identity-verified) kills it, end to end.
 */

import { findIdentity } from '../../../../packages/core/src/process/tree/descendants.js';
import type { ItemRecorder } from '../report.js';
import { identityLabel, psSnapshot } from '../ps.js';
import { bashMarker, mockMarker } from '../sandbox.js';
import { runScenario, type SessionContext } from '../session.js';
import { sessionEvidence, TURN_MS, waitForDescendant } from './common.js';

const TOOL_COMMAND = 'sleep 45';
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
    const tree = await waitForDescendant(context, session, 'sleep', TURN_MS);
    r.note('sigtermSession', sessionEvidence(session));
    r.check(
      'SIGTERM run: the Bash tool runs under the CLI',
      tree !== undefined,
      'a sleep descendant',
    );
    if (tree === undefined) return;
    r.note('treeBeforeSigterm', tree.descendants);
    r.check(
      'ps: every line parses (LC_ALL=C, TZ=UTC0, pid ppid pgid lstart comm)',
      tree.snapshot.rejected === 0,
      `${String(tree.snapshot.rejected)} rejected of ${String(tree.snapshot.records.length + tree.snapshot.rejected)}`,
    );
    const startMs = Number(tree.root.startTime) * 1000;
    r.check(
      'ps: the lstart start time of the CLI matches its spawn',
      Math.abs(startMs - session.spawnedAt) <= START_TOLERANCE_MS,
      `lstart ${new Date(startMs).toISOString()}, spawned ${new Date(session.spawnedAt).toISOString()}`,
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
      (record) => findIdentity(after.records, record) !== null,
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
    r.check(
      'SIGINT mid-stream: no result frame',
      session.findKind('result', before) === undefined,
      `${String(session.frames.length - before)} frames after the signal`,
    );
  });
  r.note('sigintShutdown', int.shutdown);

  const kill = await runScenario(context, {}, async ({ session }) => {
    session.initialize();
    session.user(`${bashMarker(TOOL_COMMAND)} gate item 2 SIGKILL`);
    const tree = await waitForDescendant(context, session, 'sleep', TURN_MS);
    r.check(
      'SIGKILL run: the Bash tool runs under the CLI',
      tree !== undefined,
      'a sleep descendant',
    );
    if (tree === undefined) return;
    host.signal(tree.root.pid, 'SIGKILL');
    await session.waitExit(EXIT_MS);
    await host.sleep(SETTLE_MS);
    const after = await psSnapshot(host);
    const survivors = tree.descendants.filter(
      (record) => findIdentity(after.records, record) !== null,
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
