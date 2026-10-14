// Orphans after a graceful close: the after-exit sweep (plan §4.7, §5.8
// W6-T3; W3-Z ruling 5; ADR-0009, ADR-0010 "drain path sweep").
//
// A background shell starts a descendant that outlives the shell, then the
// shell ends by itself; the CLI waits for the shell after EOF (07 §7 W120,
// L88), runs the turn its completion triggers, and exits 0 by itself. Its
// tree outlives it (05 §10 runs 60-72 measured the Git Bash tree outliving
// the CLI on Windows; W3-T6 measured `rg` outliving it on Linux). The
// binding snapshotted the descendants when it ended stdin
// (`snapshotAtEof`) and, after the exit, kills every one still running with
// the same pid and start time (`sweepAfterExit`).

import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import {
  allowAll,
  bashTool,
  collectEvents,
  descendantsOf,
  diagnostics,
  isListed,
  killEach,
  onlyDiagnostic,
  sleepsOf,
  table,
  waitForSleep,
  WINDOWS,
} from './tree.js';

const suite = integrationSuite();

/** Hang guard for the background workload to appear. */
const TOOL_START_GUARD_MS = 30_000;

interface SweepKill {
  readonly pid: number;
  readonly source: string;
  readonly outcome: string;
}

/** The POSIX part of the sweep report (the core's `SweepResult`). */
interface PosixSweep {
  readonly processes: readonly { readonly pid: number; readonly outcome: string }[];
  readonly coveredByGroup: readonly number[];
}

test('close: the CLI exits by itself, and the after-exit sweep kills the tree it left behind', async () => {
  const tag = suite.workloadTag(600);
  const session = await suite.testSession({ session: { onPermission: allowAll } });
  const { events, done } = collectEvents(session);
  // On Linux the CLI ends the background shell's process group when the
  // shell completes (measured, W6-T3: a plain `sleep &` left nothing for
  // the sweep), so the descendant leaves the group with `setsid`, the classic
  // way a tool daemonizes. Git Bash has no process groups the CLI could end
  // that way.
  const detach = WINDOWS ? '' : 'setsid ';
  const command = `${detach}sleep ${tag} >/dev/null 2>&1 & sleep 5`;
  const result = await session.ask(`${bashTool({ command, run_in_background: true })} start it`);
  expect(result.outcome).toBe('completed');
  const workload = await waitForSleep(tag, TOOL_START_GUARD_MS);
  // The CLI's tree while the background shell runs (the EOF snapshot sees the same).
  const rows = await table.read();
  const cli = rows.find((row) => row.pid === session.info.pid);
  expect(cli).toBeDefined();
  const tree = cli === undefined ? [] : descendantsOf(rows, cli);

  await session.close();
  await done;

  // A normal drain: no ladder; the CLI exited 0 after the shell's turn.
  expect(events.at(-1)).toMatchObject({
    type: 'session.terminated',
    intent: 'close',
    outcome: 'closed',
    exitCode: 0,
  });
  expect(diagnostics(events, 'termination.ladder')).toEqual([]);
  const sweep = onlyDiagnostic(events, 'termination.sweep-after-exit');
  expect(sweep.data?.['status']).toBe('done');
  const kills = (sweep.data?.['kills'] ?? []) as unknown as readonly SweepKill[];
  // Every kill names a process of the EOF snapshot (nothing started after EOF here).
  expect(kills.every((kill) => kill.source === 'eof-snapshot')).toBe(true);
  // What the sweep killed: on Windows one `taskkill /F /PID` per process
  // (`kills`); on POSIX the ladder's sweep over the EOF snapshot (`posix`:
  // by pid, or by `kill(-pgid)` for a verified group, `coveredByGroup`).
  const posix = sweep.data?.['posix'] as unknown as PosixSweep | undefined;
  const killed = [
    ...kills.filter((kill) => kill.outcome === 'done').map((kill) => kill.pid),
    ...(posix?.processes ?? []).filter((p) => p.outcome === 'sent').map((p) => p.pid),
    ...(posix?.coveredByGroup ?? []),
  ];
  // The sweep killed at least one process that outlived the CLI ...
  const report = JSON.stringify({ sweep: sweep.data, tree, workload });
  expect(killed.length, report).toBeGreaterThan(0);
  // ... each of them a member of the CLI's tree, and none of them is left.
  for (const pid of killed) expect(tree.map((row) => row.pid)).toContain(pid);
  const after = await table.read();
  expect(tree.filter((row) => isListed(after, row))).toEqual([]);

  const survivors = await sleepsOf(tag);
  if (WINDOWS) {
    // The background shell's `conhost.exe` outlived the CLI (kept alive by
    // the console's last client) and was swept. The `sleep.exe` itself is
    // the measured best-effort residual (W6-T3): MSYS2 started it through a
    // forked `bash.exe` copy that exited at once, so it is in no
    // parent-pid tree of the CLI and no snapshot holds it.
    expect(tree.map((row) => row.pid)).not.toContain(workload.pid);
    expect(survivors.map((row) => row.pid)).toEqual([workload.pid]);
    expect(await killEach(survivors)).toEqual(['killed']);
  } else {
    // The orphaned `sleep` (reparented once its shell exited) was in the
    // EOF snapshot; it leads its own verified group (`setsid`), which the
    // sweep killed with `kill(-pgid)`.
    expect(killed).toContain(workload.pid);
    expect(survivors).toEqual([]);
  }
}, 120_000);
