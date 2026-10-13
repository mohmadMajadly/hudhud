// Windows only: the best-effort ladder against a real `node` tree (plan
// §5.4 W2-T8). The child spawns a grandchild, which spawns a
// great-grandchild; both descendants are spawned `detached`, so they are
// outside libuv's job objects and only `taskkill /T` can reach them through
// the parent links. Cleanup kills only processes this test spawned, and only
// while their pid and start time still match (plan §4.7).

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

import type { LadderClock } from '../../../src/process/ladder/types.js';
import { runWindowsLadder } from '../../../src/process/ladder/windows.js';
import type { LadderReport } from '../../../src/process/ladder/types.js';
import type { Win32CimTableCalls } from '../../../src/process/os/types.js';
import {
  createTaskkillCalls,
  nodeTaskkillDeps,
  resolveTaskkillPath,
  type TaskkillExecFile,
  type TaskkillExecOptions,
} from '../../../src/process/taskkill.js';
import { descendantsOf, findIdentity } from '../../../src/process/tree/descendants.js';
import { takeSnapshot } from '../../../src/process/tree/snapshot.js';
import type { ProcessIdentity } from '../../../src/process/tree/types.js';

const WINDOWS = process.platform === 'win32';

/** The contract of `Win32CimTableCalls` (os/types.ts), implemented for this test. */
function cimTable(): Win32CimTableCalls {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  const powershell = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$rows = Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [long]$_.ProcessId; pp = [long]$_.ParentProcessId; t = $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { "" }); n = $_.Name } }',
    'ConvertTo-Json -Compress -InputObject @($rows)',
  ].join('; ');
  return {
    source: 'win32-cim',
    queryProcesses: () =>
      new Promise((resolve, reject) => {
        execFile(
          powershell,
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { shell: false, windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
          (error, stdout) => {
            if (error === null) resolve(new Uint8Array(stdout));
            else reject(new Error('the CIM query failed', { cause: error }));
          },
        );
      }),
  };
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
});

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
  expect(identities.map((id) => id.pid)).toEqual(expect.arrayContaining(nodePids));
  return { child, exited, table, root, nodePids, identities };
}

function summary(report: LadderReport): string[] {
  return report.steps.map((step) => `${step.name}:${step.outcome}`);
}

/** The recorded identities still alive (pid and start time), polled until none or 5 s. */
async function survivorsOf(
  table: Win32CimTableCalls,
  identities: readonly ProcessIdentity[],
): Promise<ProcessIdentity[]> {
  let survivors = [...identities];
  for (let i = 0; i < 10 && survivors.length > 0; i += 1) {
    const after = await takeSnapshot(table);
    survivors = identities.filter((id) => findIdentity(after.records, id) !== null);
    if (survivors.length > 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return survivors;
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
    { interruptWaitMs: 100, eofGraceMs, termGraceMs: 0, taskkillGraceMs: 5000 },
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
  it('control: TerminateProcess of the child alone leaves the detached descendants', async () => {
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
  }, 60_000);

  it('taskkill /T leaves zero survivors (child, grandchild, great-grandchild)', async () => {
    const tree = await spawnTree();
    // The child ignores EOF: the grace only delays the tree kill under test.
    const { report, execCalls } = await runLadderOn(tree, 1000);

    expect(summary(report).slice(0, 5)).toEqual([
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
  }, 60_000);

  it('the sweep leaves zero survivors after a graceful exit during the EOF grace', async () => {
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
  }, 60_000);
});
