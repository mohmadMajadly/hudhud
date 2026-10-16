// Host crash: the Node.js process that runs the product dies abruptly while
// a Bash tool runs (plan §4.4 "host crash", §5.8 W6-T3, §6.5 "host crash";
// 07 §2 W94 and L72; ADR-0009, ADR-0010 residuals).
//
// The product runs in a child host (`crash-host.ts`, `support/crash-host.mjs`)
// that the test kills through its own child handle; nothing runs the ladder
// afterwards, by definition. What survives is what the product docs state:
//
// - Linux (ADR-0010 "Containment capability and residuals"; 07 §2 L72): host
//   death is stdin EOF; the CLI finishes the tool (15.3 s for `sleep 15`),
//   runs the turn, exits 0, and leaves no orphan.
// - Windows with the job addon (`'job'`, the shipping default; plan §6.5,
//   07 §2 W94 inverted): the host's job handle dies with the host, and
//   `KILL_ON_JOB_CLOSE` ends the CLI and its whole tool tree, MSYS2's
//   `sleep.exe` included. Zero survivors.
// - Windows best effort (the addon forced unavailable; ADR-0009
//   "Containment" 4; 07 §2 W94): libuv's job of the host kills the CLI
//   32-35 ms after the host died, and the Git Bash tool tree survives (W94:
//   `bash.exe`, `bash.exe`, `conhost.exe`). Measured in W6-T3: the tool's
//   `sleep.exe` survives too, outside every parent-pid tree (see
//   `workloadTag`). The test kills those survivors itself by verified
//   identity (pid plus start time), so the harness's leak check sees a
//   clean table.

import { describe, expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { startCrashHost } from './crash-host.js';
import {
  bashTool,
  CONTAINMENT_MODES,
  descendantsOf,
  isListed,
  killEach,
  readUntil,
  sleepsOf,
  stillListed,
  waitForSleep,
  WINDOWS,
} from './tree.js';

const suite = integrationSuite();

/** Hang guard for the host to connect and open its session (verifies the 250 MB binary first). */
const HOST_READY_GUARD_MS = 60_000;
/** Hang guard for the tool's process to appear after the permission was granted. */
const TOOL_START_GUARD_MS = 30_000;
/**
 * The tool of 07 §2 (`t12-host.mjs` state `tool`: Bash `sleep 15`) on Linux,
 * where its duration bounds the CLI's drain; on Windows the CLI dies with
 * the host whatever the tool does, and a longer `sleep` keeps the residual
 * observable for the whole check.
 */
const TOOL_SECONDS = WINDOWS ? 60 : 15;
/**
 * Linux: the CLI exits 15.3 s after the host died with `sleep 15` running
 * (07 §2 L72); bound with the 3x margin of the flake policy (plan §4.4).
 */
const LINUX_CLI_EXIT_BOUND_MS = 3 * 15_300;
/**
 * Windows: the CLI is gone 32-35 ms after the host died (07 §2 W93-W96,
 * libuv's job; the addon's job closes with the host's handle table at the
 * same moment); observing it takes one table read (a CIM query, at most
 * 1.3 s measured, `leaks/tracker.ts`). Bound: 3x the sum.
 */
const WINDOWS_CLI_EXIT_BOUND_MS = 3 * (35 + 1300);
/** Image names of the documented Windows residual (07 §2 W94) plus the measured `sleep.exe`. */
const WINDOWS_RESIDUAL = new Set(['bash.exe', 'conhost.exe', 'sleep.exe']);

describe.each(CONTAINMENT_MODES)('addon $jobAddon ($containment)', ({ jobAddon, containment }) => {
  const job = containment === 'job';

  test(`host crash during a Bash tool: the CLI does not survive; ${job ? 'nothing survives' : 'the tree is the documented residual'}`, async () => {
    const tag = suite.workloadTag(TOOL_SECONDS);
    const host = await startCrashHost(
      suite,
      `${bashTool({ command: `sleep ${tag}` })} run it`,
      jobAddon,
    );
    const session = await host.next('session', HOST_READY_GUARD_MS);
    expect(session.containment).toBe(containment);
    // The CLI is the spawned process itself (no launcher): its identity as the host read it.
    const root = await host.next('root', HOST_READY_GUARD_MS);
    expect(root).toMatchObject({ pid: session.pid, problem: null });
    expect(session.cliPid).toBe(session.pid);
    const cli = { pid: root.pid, startTime: root.startTime ?? '' };
    const workload = await waitForSleep(tag, TOOL_START_GUARD_MS);
    // The CLI's tool tree, as it is when the host dies.
    const rows = await readUntil(
      (current) => (isListed(current, cli) ? current : undefined),
      TOOL_START_GUARD_MS,
      'the CLI',
    );
    const tree = descendantsOf(rows, cli);
    expect(tree.length).toBeGreaterThan(0);

    const crashed = Date.now();
    const exit = await host.crash();
    expect(exit.signal).toBe('SIGKILL');

    // The CLI does not survive the host.
    await readUntil(
      (current) => (isListed(current, cli) ? undefined : true),
      WINDOWS ? WINDOWS_CLI_EXIT_BOUND_MS : LINUX_CLI_EXIT_BOUND_MS,
      'the end of the CLI',
    );
    const cliGoneMs = Date.now() - crashed;
    expect(cliGoneMs).toBeLessThanOrEqual(
      WINDOWS ? WINDOWS_CLI_EXIT_BOUND_MS : LINUX_CLI_EXIT_BOUND_MS,
    );
    // No report after the crash: the host is gone and nothing of the product ran.
    expect(
      host.reports.some((report) => report.type === 'result' || report.type === 'refused'),
    ).toBe(false);

    const survivors = await stillListed(tree);
    const sleeps = await sleepsOf(tag);
    if (WINDOWS && job) {
      // 07 §2 W94 inverted (plan §6.5): the job ended the whole tree with its owner.
      expect(survivors).toEqual([]);
      expect(sleeps).toEqual([]);
    } else if (WINDOWS) {
      expect(survivors.every((row) => WINDOWS_RESIDUAL.has(row.name.toLowerCase()))).toBe(true);
      expect(sleeps.map((row) => row.pid)).toEqual([workload.pid]);
      // Leaf first; a `conhost.exe` may end by itself once its last client is gone.
      const residual = [...survivors, ...sleeps].toReversed();
      for (const outcome of await killEach(residual)) expect(['killed', 'gone']).toContain(outcome);
      expect(await stillListed([...tree, workload])).toEqual([]);
    } else {
      // Linux: host death was stdin EOF; the CLI finished the tool, sent its
      // result to the model (the mock) and exited, leaving no orphan.
      const mock = await suite.mock();
      expect(
        mock.requests.some((request) => JSON.stringify(request.body).includes('tool_result')),
      ).toBe(true);
      expect(survivors).toEqual([]);
      expect(sleeps).toEqual([]);
    }
  }, 180_000);
});
