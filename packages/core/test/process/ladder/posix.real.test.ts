import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { LadderReport } from '../../../src/process/ladder/types.js';
import { classifyExit } from '../../../src/protocol/machine/outcome.js';
import { parseProcStat } from '../../../src/process/tree/proc-stat.js';
import type { ProcessIdentity } from '../../../src/process/tree/types.js';

/**
 * Real Linux test of the POSIX ladder (W2-T7 acceptance). A detached test
 * host (its own process group) spawns a `node` launcher, which spawns a
 * `node` "CLI" that owns a `/bin/sh` group with two `sleep` processes, and
 * runs the ladder against the launcher (see posix-real-host.ts).
 *
 * Only processes this test spawned are ever signalled: the ladder signals
 * verified descendants of the launcher, and the cleanup below kills only
 * recorded identities (pid plus start time) that still match.
 */

const HOST_SOURCE = fileURLToPath(new URL('./posix-real-host.ts', import.meta.url));

/**
 * The host runs from source under Node's type stripping (the sources use
 * erasable syntax only). This resolve hook maps a missing relative `.js`
 * specifier to its `.ts` source, as TypeScript's `nodenext` resolution does.
 */
const REGISTER_HOOKS = `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\\.\\.?\\//.test(specifier) && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  },
});
`;

interface HostEvent {
  readonly kind: string;
  readonly [key: string]: unknown;
}

interface HostRun {
  readonly events: readonly HostEvent[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

let workDir = '';
let hostArgs: string[] = [];
/** Every identity this test learned of; killed in afterEach if still alive. */
const recorded: ProcessIdentity[] = [];

/** True when `identity` still names a live process (same start time, not a zombie). */
function alive(identity: ProcessIdentity): boolean {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(`/proc/${String(identity.pid)}/stat`));
  } catch {
    return false;
  }
  const record = parseProcStat(bytes, identity.pid);
  if (record?.startTime !== identity.startTime) return false;
  const state = Buffer.from(bytes)
    .toString('latin1')
    .slice(bytes.lastIndexOf(0x29) + 2, bytes.lastIndexOf(0x29) + 3);
  return state !== 'Z' && state !== 'X';
}

async function survivors(identities: readonly ProcessIdentity[]): Promise<ProcessIdentity[]> {
  // SIGKILL is asynchronous: allow up to 3 s for the kernel to finish.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const left = identities.filter(alive);
    if (left.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return identities.filter(alive);
}

function runHost(
  mode: 'term' | 'kill',
  race: 'natural' | 'launcher-first' | 'sigkill-first' = 'natural',
): Promise<HostRun> {
  const host = spawn(process.execPath, [...hostArgs, mode, race], {
    detached: true, // setsid: the host leads its own process group
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const events: HostEvent[] = [];
  createInterface({ input: host.stdout }).on('line', (line) => {
    const event = JSON.parse(line) as HostEvent;
    events.push(event);
    if (event.kind === 'host' || event.kind === 'spawned') {
      recorded.push({ pid: event['pid'] as number, startTime: event['startTime'] as string });
    }
    if (event.kind === 'tree') {
      for (const record of event['records'] as ProcessIdentity[]) {
        recorded.push({ pid: record.pid, startTime: record.startTime });
      }
    }
  });
  return new Promise((resolve) => {
    host.once('close', (code, signal) => {
      resolve({ events, code, signal });
    });
  });
}

function only(run: HostRun, kind: string): HostEvent {
  const found = run.events.filter((event) => event.kind === kind);
  expect(found, kind).toHaveLength(1);
  const [event] = found;
  if (event === undefined) throw new Error(`no ${kind} event`);
  return event;
}

interface TreeRecord extends ProcessIdentity {
  readonly ppid: number;
  readonly pgid: number;
}

function commonChecks(run: HostRun): {
  report: LadderReport;
  tree: readonly TreeRecord[];
  cliPid: number;
  toolPgid: number;
  signals: HostEvent[];
} {
  expect(run.events.find((event) => event.kind.startsWith('host-'))).toBeUndefined();
  // The host survived: its own group was never signalled.
  expect(run.signal).toBeNull();
  expect(run.code).toBe(0);
  only(run, 'done');

  const host = only(run, 'host');
  expect(host['pgid']).toBe(host['pid']); // the host leads its own group
  const spawned = only(run, 'spawned');
  const ready = only(run, 'cli-ready');
  const tree = only(run, 'tree')['records'] as TreeRecord[];
  expect(tree).toHaveLength(4); // CLI, sh, sleep, sleep
  const cliPid = ready['pid'] as number;
  const toolPgid = ready['tool'] as number;
  expect(tree.find((record) => record.pid === cliPid)?.pgid).toBe(host['pid']);
  expect(tree.filter((record) => record.pgid === toolPgid)).toHaveLength(3);

  const report = only(run, 'report')['report'] as LadderReport;
  expect(report.signalTarget?.pid).toBe(cliPid); // K1: initialize.pid behind the launcher
  expect(report.launcherDetected).toBe(true);
  const signals = run.events.filter((event) => event.kind === 'signal');
  for (const sent of signals) {
    expect(sent['id']).not.toBe(host['pid']);
    if (sent['target'] === 'group') {
      expect([host['pgid'], cliPid, spawned['pid'], 0, 1]).not.toContain(sent['id']);
    }
  }
  return { report, tree, cliPid, toolPgid, signals };
}

describe.runIf(process.platform === 'linux')('POSIX ladder on real processes (Linux)', () => {
  beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'hudhud-ladder-'));
    const register = path.join(workDir, 'register-hooks.mjs');
    writeFileSync(register, REGISTER_HOOKS);
    hostArgs = [
      // Older Node 22 lines need the flag; newer ones strip types by default.
      ...(process.features.typescript === false ? ['--experimental-strip-types'] : []),
      '--disable-warning=ExperimentalWarning',
      '--import',
      pathToFileURL(register).href,
      HOST_SOURCE,
    ];
  });

  afterEach(() => {
    // Kill only what this test spawned and what still has the recorded identity.
    for (const identity of recorded.splice(0)) {
      if (alive(identity)) process.kill(identity.pid, 'SIGKILL');
    }
  });

  afterAll(() => {
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true, maxRetries: 10 });
  });

  it('SIGTERM reaches the CLI behind the launcher (K1); the CLI cleans up; nothing survives', async () => {
    const run = await runHost('term');
    const { report, tree, cliPid, signals } = commonChecks(run);

    expect(signals.map((sent) => [sent['target'], sent['id'], sent['signal']])).toEqual([
      ['process', cliPid, 'SIGTERM'],
    ]);
    expect(only(run, 'cli-sigterm')['pid']).toBe(cliPid);
    expect(report.exitedAfter).toBe('sigterm');
    expect(report.sweep).toBeNull();
    // The launcher was never signalled: it exited by itself when the CLI did.
    expect(only(run, 'launcher-exit')).toMatchObject({ code: 7, signal: null });
    expect(await survivors(tree)).toEqual([]);
  }, 30_000);

  /**
   * The SIGKILL path (ADR-0010 step 5): SIGKILL to the K1 target, then to
   * the spawned launcher, then the sweep. The contract: both signals sent in
   * that order, the whole tree gone, and the launcher's exit classified as
   * `aborted` under the recorded `abort` intent (ADR-0008 E8: the outcome
   * comes from the intent, never the exit code). How the launcher ends is
   * its own race: SIGKILL, or its own exit 7 when it sees the CLI die
   * between the two signals (seen once on node 26). Both are legitimate.
   */
  async function sigkillPath(
    race: 'natural' | 'launcher-first' | 'sigkill-first',
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const run = await runHost('kill', race);
    const { report, tree, cliPid, toolPgid, signals } = commonChecks(run);
    const spawned = only(run, 'spawned');
    const spawnedPid = spawned['pid'];

    expect(only(run, 'cli-sigterm')['pid']).toBe(cliPid);
    expect(signals.slice(0, 3).map((sent) => [sent['target'], sent['id'], sent['signal']])).toEqual(
      [
        ['process', cliPid, 'SIGTERM'],
        ['process', cliPid, 'SIGKILL'],
        ['process', spawnedPid, 'SIGKILL'],
      ],
    );
    // Both SIGKILLs were delivered: an exited but unreaped launcher still accepts one.
    expect(signals.slice(1, 3).map((sent) => sent['outcome'])).toEqual(['sent', 'sent']);
    expect(signals).toContainEqual(
      expect.objectContaining({
        target: 'group',
        id: toolPgid,
        signal: 'SIGKILL',
        outcome: 'sent',
      }),
    );
    expect(report.steps.map((step) => step.name)).toEqual([
      'intent',
      'interrupt',
      'eof',
      'snapshot-s1',
      'sigterm',
      'snapshot-s2',
      'sigkill',
      'sigkill',
      'sweep',
    ]);
    expect(report.sweep?.groupsSignalled).toBe(1);
    // The launcher, the CLI and the tool group are all gone (verified identities).
    const launcher = { pid: spawnedPid as number, startTime: spawned['startTime'] as string };
    expect(await survivors([...tree, launcher])).toEqual([]);
    const exit = only(run, 'launcher-exit');
    const observed = {
      code: exit['code'] as number | null,
      signal: exit['signal'] as NodeJS.Signals | null,
    };
    // Either way the application sees one outcome: aborted, no error.
    expect(
      classifyExit({ intent: 'abort', exit: observed, turnActive: true, platform: 'posix' }),
    ).toEqual({ outcome: 'aborted', turnSynthesis: 'cancelled', error: 'none' });
    return observed;
  }

  it('a CLI that survives SIGTERM is SIGKILLed with the launcher; the sweep kills the tool group', async () => {
    // Whichever way the launcher ends, it is one of the two legitimate ends.
    expect([
      { code: null, signal: 'SIGKILL' },
      { code: 7, signal: null },
    ]).toContainEqual(await sigkillPath('natural'));
  }, 30_000);

  it('the same when the launcher exits by itself before its SIGKILL lands', async () => {
    expect(await sigkillPath('launcher-first')).toEqual({ code: 7, signal: null });
  }, 30_000);

  it('the same when the SIGKILL ends the launcher', async () => {
    expect(await sigkillPath('sigkill-first')).toEqual({ code: null, signal: 'SIGKILL' });
  }, 30_000);
});
