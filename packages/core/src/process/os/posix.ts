/**
 * POSIX syscall adapters (plan §1.7, §4.8): the Linux `/proc` process table
 * and `kill(2)`.
 *
 * @remarks
 * No logic: every decision (which pid, which group, whether an identity
 * still matches) is made by `process/tree/`. The only checks here keep a
 * call meaning what its name says: `kill(2)` gives `0` and negative pids a
 * group meaning (`kill(0)` is the caller's own group, `kill(-1)` is every
 * process the caller may signal), so {@link PosixSignalCalls.signalProcess}
 * accepts only pids `>= 1` and {@link PosixSignalCalls.signalGroup} only
 * pgids `>= 2`; anything else throws `RangeError` before a signal is sent.
 *
 * Imports only Node built-ins and `os/types.ts` (rule `os-adapters-leaf`).
 * Coverage is scoped to POSIX hosts (`vitest.os.config.ts`).
 *
 * @packageDocumentation
 */

import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';

import type { LinuxProcTableCalls, PosixSignal, PosixSignalCalls, SignalOutcome } from './types.js';

/** The `/proc` mount read by {@link createLinuxProcTableCalls}. */
const PROC = '/proc';

/** A `/proc` entry that names a process: a decimal pid without a leading zero. */
const PID_ENTRY = /^[1-9][0-9]*$/;

/** `readStat` errors that mean "the process is gone", not a failure. */
const GONE = new Set(['ENOENT', 'ESRCH']);

/** The error code of a failed call, read without trusting its shape. */
function errnoOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/**
 * Filesystem calls used by {@link createLinuxProcTableCalls}; the host
 * filesystem by default. Tests inject failures that `/proc` cannot be made
 * to produce on demand.
 *
 * @internal
 */
export interface ProcFs {
  readdir(path: string): Promise<readonly string[]>;
  readFile(path: string): Promise<Uint8Array>;
}

const nodeProcFs: ProcFs = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path),
};

/**
 * The Linux process table: `/proc` entries and `/proc/<pid>/stat` bytes
 * (contract on {@link LinuxProcTableCalls}).
 *
 * @internal
 */
export function createLinuxProcTableCalls(fs: ProcFs = nodeProcFs): LinuxProcTableCalls {
  return {
    source: 'linux-proc',
    async listPids() {
      const entries = await fs.readdir(PROC);
      return entries.filter((entry) => PID_ENTRY.test(entry)).map(Number);
    },
    async readStat(pid) {
      assertPid('pid', pid, 1);
      try {
        return await fs.readFile(`${PROC}/${String(pid)}/stat`);
      } catch (error) {
        if (GONE.has(String(errnoOf(error)))) return null;
        throw error;
      }
    },
  };
}

/** `kill(2)` as Node exposes it (throws on failure). */
export type KillFunction = (pid: number, signal: PosixSignal) => unknown;

function assertPid(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a safe integer >= ${String(min)}, got ${String(value)}`);
  }
}

function deliver(kill: KillFunction, target: number, signal: PosixSignal): SignalOutcome {
  try {
    kill(target, signal);
    return 'sent';
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ESRCH') return 'no-such-process';
    if (code === 'EPERM') return 'not-permitted';
    throw error;
  }
}

/**
 * POSIX `kill(2)` (contract on {@link PosixSignalCalls}). `kill` defaults to
 * `process.kill`; tests inject a recorder.
 *
 * @internal
 */
export function createPosixSignalCalls(
  kill: KillFunction = (pid, signal) => process.kill(pid, signal),
): PosixSignalCalls {
  return {
    signalProcess(pid, signal) {
      assertPid('pid', pid, 1);
      return deliver(kill, pid, signal);
    },
    signalGroup(pgid, signal) {
      assertPid('pgid', pgid, 2);
      return deliver(kill, -pgid, signal);
    },
  };
}
