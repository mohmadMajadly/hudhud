// Windows only: the best-effort ladder against a real `node` tree (plan
// §5.4 W2-T8). The child spawns a grandchild, which spawns a
// great-grandchild; both descendants are spawned `detached`, so they are
// outside libuv's job objects and only `taskkill /T` can reach them through
// the parent links. Cleanup kills only processes this test spawned, and only
// while their pid and start time still match (plan §4.7).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

import type { LadderClock } from '../../../src/process/ladder/types.js';
import { runWindowsLadder } from '../../../src/process/ladder/windows.js';
import type { LadderReport } from '../../../src/process/ladder/types.js';
import type { Win32CimTableCalls } from '../../../src/process/os/types.js';
import { createWin32CimTableCalls, DEFAULT_LIMITS } from '../../../src/process/os/win32.js';
import {
  createTaskkillCalls,
  DEFAULT_TASKKILL_TIMEOUT_MS,
  nodeTaskkillDeps,
  resolveSystem32PowerShell,
  resolveTaskkillPath,
  type TaskkillExecFile,
  type TaskkillExecOptions,
} from '../../../src/process/taskkill.js';
import { descendantsOf, findIdentity } from '../../../src/process/tree/descendants.js';
import { takeSnapshot } from '../../../src/process/tree/snapshot.js';
import type { ProcessIdentity } from '../../../src/process/tree/types.js';
import { hangGuard } from '../../unit/process/spawn-support.js';

const WINDOWS = process.platform === 'win32';

/**
 * The host process table: the product CIM query (os/win32.ts), which the
 * ladder uses in production. Each read is bounded by its `DEFAULT_LIMITS`;
 * the unbounded `execFile` query this test had before left the tests
 * without a product bound to size their hang guards from.
 */
function cimTable(): Win32CimTableCalls {
  return createWin32CimTableCalls({
    powershell: () => resolveSystem32PowerShell({ env: process.env, ...nodeTaskkillDeps }),
  });
}

// Hang guards (vitest.config.ts HANG_GUARD_MS, W3-Z ruling 4): each test's
// timeout is the sum of the product bounds it consumes one after another,
// plus the margin of spawn-support.ts. On the GitHub-hosted Windows runner
// these tests took 2.5 to 5 s.
/** One process table read. */
const TABLE_MS = DEFAULT_LIMITS.timeoutMs;
/** One taskkill run. */
const TASKKILL_MS = DEFAULT_TASKKILL_TIMEOUT_MS;
/** The ladder timing these tests pass (see runLadderOn). */
const INTERRUPT_WAIT_MS = 100;
const TASKKILL_GRACE_MS = 5000;
/**
 * At most this many processes under the child: the two node levels plus
 * their console hosts. spawnTree asserts it, so the sweep runs at most this
 * many taskkill calls.
 */
const MAX_DESCENDANTS = 8;
/** How long survivorsOf polls, besides the snapshot it may have started at the deadline. */
const SURVIVOR_POLL_MS = 10_000;

/**
 * Worst case of runLadderOn without a job: the interrupt wait, S1, the EOF
 * grace, the identity check, `taskkill /T` and its grace, then either the
 * TerminateProcess check and grace, or the sweep's snapshot and one taskkill
 * per descendant.
 */
function ladderBound(eofGraceMs: number): number {
  return (
    INTERRUPT_WAIT_MS +
    TABLE_MS +
    eofGraceMs +
    TABLE_MS +
    TASKKILL_MS +
    TASKKILL_GRACE_MS +
    Math.max(TABLE_MS + TASKKILL_GRACE_MS, TABLE_MS + MAX_DESCENDANTS * TASKKILL_MS)
  );
}

const realClock: LadderClock = {
  now: () => Date.now(),
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

// Each level prints `pid:<n>` for itself and forwards its descendants'
// lines, and stays alive until killed. The top level ignores stdin EOF, or
// with `exit-on-eof` exits gracefully on it (a CLI that drains and leaves its
// detached tool tree behind, 07 §2).
const LEVEL = String.raw`
const { spawn } = require('node:child_process');
const depth = Number(process.argv[1]);
process.stdin.on('error', () => {});
if (process.argv[2] === 'exit-on-eof') process.stdin.on('end', () => process.exit(0));
if (process.stdin.readable) process.stdin.resume();
process.stdout.write('pid:' + process.pid + '\n');
if (depth > 0) {
  const child = spawn(process.execPath, ['-e', process.env.HUDHUD_LEVEL, String(depth - 1)], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
    windowsHide: true,
    env: process.env,
  });
  child.stdout.pipe(process.stdout);
}
setInterval(() => {}, 1000);
`;

const spawned: ChildProcessWithoutNullStreams[] = [];
const recorded: ProcessIdentity[] = [];

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  if (recorded.length === 0) return;
  const snapshot = await takeSnapshot(cimTable());
  for (const identity of recorded.splice(0)) {
    // Only a process whose pid and start time still match is ours.
    if (findIdentity(snapshot.records, identity) !== null) {
      try {
        process.kill(identity.pid);
      } catch {
        // Exited in between.
      }
    }
  }
}, hangGuard(TABLE_MS));

/** Spawns the three-level tree and records every process under the child by identity. */
async function spawnTree(mode: 'ignore-eof' | 'exit-on-eof' = 'ignore-eof'): Promise<{
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  table: Win32CimTableCalls;
  root: ProcessIdentity;
  nodePids: number[];
  identities: ProcessIdentity[];
}> {
  const child = spawn(process.execPath, ['-e', LEVEL, '2', mode], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, HUDHUD_LEVEL: LEVEL },
  });
  spawned.push(child);
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      resolve();
    }),
  );

  const nodePids: number[] = [];
  const lines = createInterface({ input: child.stdout });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    lines.on('line', (line) => {
      const match = /^pid:(\d+)$/.exec(line);
      if (match !== null) nodePids.push(Number(match[1]));
      if (nodePids.length === 3) resolve();
    });
  });
  expect(nodePids[0]).toBe(child.pid);

  const table = cimTable();
  const before = await takeSnapshot(table);
  const rootRecord = before.records.find((r) => r.pid === child.pid);
  if (rootRecord === undefined) throw new Error('the child is missing from the snapshot');
  const root = { pid: rootRecord.pid, startTime: rootRecord.startTime };
  // The whole tree under the child (the node levels plus any console host).
  const tree = descendantsOf(before.records, root).descendants;
  const identities: ProcessIdentity[] = [
    root,
    ...tree.map((r) => ({ pid: r.pid, startTime: r.startTime })),
  ];
  recorded.push(...identities);
  expect(tree.length).toBeLessThanOrEqual(MAX_DESCENDANTS);
  expect(identities.map((id) => id.pid)).toEqual(expect.arrayContaining(nodePids));
  return { child, exited, table, root, nodePids, identities };
}

/**
 * Asserts the ladder's `identity-foreign-child` refusal was justified: a
 * fresh read still lists a process outside the tree that names a tree
 * member's pid as its parent and started before that member (a stale
 * parent pid), and the steps are those of the refusal.
 */
async function expectForeignChild(
  tree: Awaited<ReturnType<typeof spawnTree>>,
  report: LadderReport,
): Promise<void> {
  expect(summary(report).slice(0, 5), JSON.stringify(report.steps)).toEqual([
    'intent:done',
    'interrupt:skipped',
    'snapshot-s1:done',
    'eof:done',
    'taskkill:skipped',
  ]);
  const ours = new Map(tree.identities.map((identity) => [identity.pid, identity]));
  const after = await takeSnapshot(tree.table);
  const foreign = after.records.filter((record) => {
    const parent = ours.get(record.ppid);
    return (
      parent !== undefined &&
      !ours.has(record.pid) &&
      BigInt(record.startTime) < BigInt(parent.startTime)
    );
  });
  expect(foreign.length, JSON.stringify(report.steps)).toBeGreaterThan(0);
}

function summary(report: LadderReport): string[] {
  return report.steps.map((step) => `${step.name}:${step.outcome}`);
}

/**
 * The recorded identities still alive (pid and start time), polled every
 * 0.5 s until none are left or {@link SURVIVOR_POLL_MS} have passed (before,
 * ten polls: unbounded with a slow table, about 10 s with a fast one).
 */
async function survivorsOf(
  table: Win32CimTableCalls,
  identities: readonly ProcessIdentity[],
): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + SURVIVOR_POLL_MS;
  for (;;) {
    const after = await takeSnapshot(table);
    const survivors = identities.filter((id) => findIdentity(after.records, id) !== null);
    if (survivors.length === 0 || Date.now() >= deadline) return survivors;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: TaskkillExecOptions;
}

/**
 * Runs the best-effort ladder on a spawned tree with the real taskkill,
 * recording each run. `eofGraceMs` is the whole wait when the child ignores
 * EOF, and only an upper bound when it exits on EOF.
 */
async function runLadderOn(
  tree: Awaited<ReturnType<typeof spawnTree>>,
  eofGraceMs: number,
): Promise<{ report: LadderReport; execCalls: ExecCall[] }> {
  const { child, exited, table, root } = tree;
  const execCalls: ExecCall[] = [];
  const recordingExecFile: TaskkillExecFile = (file, args, options, callback) => {
    execCalls.push({ file, args, options });
    return nodeTaskkillDeps.execFile(file, args, options, callback);
  };
  const report = await runWindowsLadder(
    {
      pid: root.pid,
      identity: Promise.resolve(root),
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
      exited,
      closeStdin: () => child.stdin.end(),
      terminate: () => child.kill(),
    },
    { interrupt: () => Promise.resolve('not-applicable') },
    {
      interruptWaitMs: INTERRUPT_WAIT_MS,
      eofGraceMs,
      termGraceMs: 0,
      taskkillGraceMs: TASKKILL_GRACE_MS,
    },
    null,
    {
      intent: 'abort',
      initializePid: null,
      clock: realClock,
      os: {
        platform: 'win32',
        hostPid: process.pid,
        processTable: table,
        terminate: createTaskkillCalls({
          env: process.env,
          fs: nodeTaskkillDeps.fs,
          execFile: recordingExecFile,
        }),
      },
    },
  );
  return { report, execCalls };
}

describe.runIf(WINDOWS)('Windows best-effort ladder on a real node tree', () => {
  it(
    'control: TerminateProcess of the child alone leaves the detached descendants',
    async () => {
      const { child, exited, table, identities, nodePids } = await spawnTree();
      child.kill();
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const after = await takeSnapshot(table);
      const alive = identities
        .filter((id) => findIdentity(after.records, id) !== null)
        .map((id) => id.pid);
      // Proves the real test below needs taskkill /T; afterEach cleans these up by identity.
      expect(alive).toEqual(expect.arrayContaining(nodePids.slice(1)));
    },
    hangGuard(TABLE_MS, 1000, TABLE_MS),
  );

  it(
    'taskkill /T leaves zero survivors (child, grandchild, great-grandchild)',
    async () => {
      const tree = await spawnTree();
      // The child ignores EOF: the grace only delays the tree kill under test.
      const { report, execCalls } = await runLadderOn(tree, 1000);

      if (report.steps[4]?.detail === 'identity-foreign-child') {
        // Host-dependent, and the product is right (W6-Z, 4 of 763 runs of
        // this file): a process of the host whose dead parent's pid a tree
        // member reused (seen: OneDrive.Sync.Service.exe, started an hour
        // before the tree) names that member as its parent, so `taskkill /T`,
        // which follows parent pids without start times, would end it too.
        // The ladder refuses /T and ends the tree without it.
        await expectForeignChild(tree, report);
        expect(execCalls.some((call) => call.args.includes('/T'))).toBe(false);
        expect(await survivorsOf(tree.table, tree.identities)).toEqual([]);
        return;
      }
      // On a mismatch, name every step with its detail (why a step was skipped).
      expect(summary(report).slice(0, 5), JSON.stringify(report.steps)).toEqual([
        'intent:done',
        'interrupt:skipped',
        'snapshot-s1:done',
        'eof:done',
        'taskkill:done',
      ]);
      // Whatever the sweep finds afterwards is only ever an S1 descendant, killed without /T.
      for (const step of report.steps.slice(5)) expect(step.name).toBe('sweep');
      expect(report.exitedAfter).toBe('taskkill');

      // taskkill ran from the absolute System32 path, without a shell.
      const expected = await resolveTaskkillPath({ env: process.env, ...nodeTaskkillDeps });
      expect(execCalls[0]?.file).toBe(expected.path);
      expect(execCalls[0]?.file.toLowerCase()).toBe(
        `${expected.systemRoot}\\System32\\taskkill.exe`.toLowerCase(),
      );
      expect(execCalls[0]?.options.shell).toBe(false);
      expect(execCalls[0]?.args).toEqual(['/T', '/F', '/PID', String(tree.root.pid)]);
      for (const call of execCalls.slice(1)) expect(call.args).not.toContain('/T');

      expect(await survivorsOf(tree.table, tree.identities)).toEqual([]);
    },
    // The foreign-child branch reads the table once more.
    hangGuard(TABLE_MS, ladderBound(1000), TABLE_MS, SURVIVOR_POLL_MS + TABLE_MS),
  );

  it(
    'the sweep leaves zero survivors after a graceful exit during the EOF grace',
    async () => {
      const tree = await spawnTree('exit-on-eof');
      const { report, execCalls } = await runLadderOn(tree, 3000);

      expect(summary(report).slice(0, 4)).toEqual([
        'intent:done',
        'interrupt:skipped',
        'snapshot-s1:done',
        'eof:done',
      ]);
      expect(report.exitedAfter).toBe('eof');
      const swept = report.steps.slice(4);
      for (const step of swept) expect(step.name).toBe('sweep');
      // Both detached node descendants were alive and verified: each was killed.
      for (const pid of tree.nodePids.slice(1)) {
        expect(swept).toContainEqual(
          expect.objectContaining({ outcome: 'done', detail: `pid-${String(pid)}` }),
        );
      }
      // Leaf first: the great-grandchild before the grandchild.
      const order = swept.map((step) => step.detail);
      expect(order.indexOf(`pid-${String(tree.nodePids[2])}`)).toBeLessThan(
        order.indexOf(`pid-${String(tree.nodePids[1])}`),
      );
      expect(report.sweep?.processesSignalled).toBeGreaterThanOrEqual(2);
      // Never /T, never the host, only from the absolute System32 path.
      expect(execCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of execCalls) {
        expect(call.args).not.toContain('/T');
        expect(call.args).not.toContain(String(process.pid));
        expect(call.options.shell).toBe(false);
        expect(call.file.toLowerCase()).toMatch(/^[a-z]:\\.+\\system32\\taskkill\.exe$/);
      }

      expect(await survivorsOf(tree.table, tree.identities)).toEqual([]);
    },
    hangGuard(TABLE_MS, ladderBound(3000), SURVIVOR_POLL_MS + TABLE_MS),
  );
});
