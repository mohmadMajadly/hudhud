/**
 * Test host of the Linux real ladder test (posix.real.test.ts). Bundled by
 * the test with esbuild and run as a detached process, so it leads its own
 * process group: if the ladder ever signalled the group of the CLI (which is
 * the host's group, ADR-0010), this process would die and the test fails.
 *
 * Tree: host -> launcher (`node`, forwards no signals) -> CLI (`node`, the
 * K1 target, reports its pid like `initialize.pid`) -> tool group
 * (`/bin/sh` leading its own group with two `sleep` processes).
 *
 * Argument: `term` (the CLI cleans its tool group on SIGTERM and exits, like
 * the real CLI) or `kill` (the CLI records SIGTERM and stays, so the ladder
 * reaches SIGKILL and the sweep). Writes JSON lines to stdout. Every signal
 * the ladder sends goes through the logging adapter below and is reported.
 * Linux only.
 */
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';
import { createInterface } from 'node:readline';

import type { LadderClock } from '../../../src/process/ladder/types.js';
import { runPosixLadder } from '../../../src/process/ladder/posix.js';
import type {
  LinuxProcTableCalls,
  PosixSignal,
  PosixSignalCalls,
  SignalOutcome,
} from '../../../src/process/os/types.js';
import { parseProcStat } from '../../../src/process/tree/proc-stat.js';
import { snapshotDescendants } from '../../../src/process/tree/snapshot.js';

const mode = process.argv[2] === 'kill' ? 'kill' : 'term';

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// The CLI: owns a tool group, reports its pid, handles SIGTERM per mode.
const CLI_CODE = `
const { spawn } = require('node:child_process');
const mode = process.argv[1];
const tool = spawn('/bin/sh', ['-c', 'sleep 600 & sleep 600 & wait'], { detached: true, stdio: 'ignore' });
process.on('SIGTERM', () => {
  process.stdout.write(JSON.stringify({ kind: 'cli-sigterm', pid: process.pid }) + '\\n');
  if (mode === 'term') {
    try { process.kill(-tool.pid, 'SIGTERM'); } catch {}
    process.exit(0);
  }
});
process.stdout.write(JSON.stringify({ kind: 'cli-ready', pid: process.pid, tool: tool.pid }) + '\\n');
setInterval(() => {}, 1 << 30);
`;

// The launcher: forwards no signals, ignores stdin EOF, exits 7 when the CLI exits.
const LAUNCHER_CODE = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(CLI_CODE)}, process.argv[1]], { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('exit', () => process.exit(7));
process.stdin.resume();
`;

async function readStat(pid: number): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(`/proc/${String(pid)}/stat`));
  } catch {
    return null;
  }
}

const processTable: LinuxProcTableCalls = {
  source: 'linux-proc',
  listPids: async () =>
    (await readdir('/proc')).filter((name) => /^[0-9]+$/.test(name)).map(Number),
  readStat,
};

function kill(kind: 'process' | 'group', id: number, signal: PosixSignal): SignalOutcome {
  let outcome: SignalOutcome = 'sent';
  try {
    process.kill(kind === 'group' ? -id : id, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') outcome = 'no-such-process';
    else if (code === 'EPERM') outcome = 'not-permitted';
    else throw error;
  }
  emit({ kind: 'signal', target: kind, id, signal, outcome });
  return outcome;
}

const signals: PosixSignalCalls = {
  signalProcess: (pid, signal) => kill('process', pid, signal),
  signalGroup: (pgid, signal) => kill('group', pgid, signal),
};

const clock: LadderClock = {
  now: () => Date.now(),
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const self = parseProcStat((await readStat(process.pid)) ?? new Uint8Array(), process.pid);
  if (self === null) throw new Error('cannot read own /proc entry');
  emit({ kind: 'host', pid: self.pid, startTime: self.startTime, pgid: self.pgid });

  const child = spawn(process.execPath, ['-e', LAUNCHER_CODE, mode], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const childPid = child.pid;
  if (childPid === undefined) throw new Error('spawn failed');
  const spawnedRecord = parseProcStat((await readStat(childPid)) ?? new Uint8Array(), childPid);
  if (spawnedRecord === null) throw new Error('cannot read the launcher /proc entry');
  const spawned = { pid: spawnedRecord.pid, startTime: spawnedRecord.startTime };
  emit({ kind: 'spawned', ...spawned });

  // Wait for the CLI to report its pid (the analogue of initialize.pid).
  // Every CLI line is relayed (cli-ready, cli-sigterm).
  const initializePid = await new Promise<number>((resolve) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      process.stdout.write(`${line}\n`);
      const event = JSON.parse(line) as { kind: string; pid: number };
      if (event.kind === 'cli-ready') resolve(event.pid);
    });
  });

  // Wait until the whole tree exists: CLI, sh and both sleeps.
  for (let attempt = 0; ; attempt += 1) {
    const tree = await snapshotDescendants(spawned, { processTable });
    if (tree.descendants.length >= 4 || attempt > 100) {
      emit({
        kind: 'tree',
        records: tree.descendants.map((record) => ({
          pid: record.pid,
          startTime: record.startTime,
          ppid: record.ppid,
          pgid: record.pgid,
        })),
      });
      break;
    }
    await delay(50);
  }

  const report = await runPosixLadder(
    {
      spawned,
      initializePid,
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
      exited,
      endStdin: () => {
        child.stdin.end();
      },
    },
    { interrupt: () => Promise.resolve('not-applicable') },
    { interruptWaitMs: 200, eofGraceMs: 500, termGraceMs: 1500, taskkillGraceMs: 0 },
    {
      intent: 'abort',
      os: { platform: 'linux', hostPid: process.pid, processTable, signals },
      clock,
    },
  );
  emit({ kind: 'report', report });
  emit({ kind: 'launcher-exit', ...(await exited) });
  emit({ kind: 'done' });
}

const guard = setTimeout(() => {
  emit({ kind: 'host-timeout' });
  process.exit(3);
}, 20_000);
main().then(
  () => {
    clearTimeout(guard);
    process.exit(0);
  },
  (error: unknown) => {
    emit({ kind: 'host-error', message: String(error) });
    process.exit(2);
  },
);
