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

import { readdir, readFile, readlink } from 'node:fs/promises';
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
  readlink(path: string): Promise<string>;
}

const nodeProcFs: ProcFs = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path),
  readlink: (path) => readlink(path),
};

/**
 * The error of a `/proc` that belongs to another pid namespace (code
 * `EPIDNS`, not an errno).
 *
 * @internal
 */
export class ForeignProcError extends Error {
  override readonly name = 'ForeignProcError';
  readonly code = 'EPIDNS';
}

/**
 * The Linux process table: `/proc` entries and `/proc/<pid>/stat` bytes
 * (contract on {@link LinuxProcTableCalls}).
 *
 * @remarks
 * Pids are namespace-local, but `/proc` names the processes of the pid
 * namespace that mounted it. A host in a pid namespace whose `/proc` is the
 * parent namespace's (`unshare -p -f` without `--mount-proc`, review R3-U1)
 * would read another process under its child's pid. So every call first
 * checks once that `/proc/self` names this process (`selfPid`); otherwise it
 * rejects with {@link ForeignProcError}, and the table is unavailable: no
 * identity, no snapshot, no sweep, only the host's own child is signalled
 * (the degraded path of ADR-0010). A failed check is retried on the next
 * call; a mismatch is final; without any `/proc` (`ENOENT`) there is nothing
 * to check.
 *
 * @internal
 */
export function createLinuxProcTableCalls(
  fs: ProcFs = nodeProcFs,
  selfPid: number = process.pid,
): LinuxProcTableCalls {
  let own: 'yes' | 'no' | undefined;
  const ownNamespace = async (): Promise<void> => {
    if (own === undefined) {
      let self: string;
      try {
        self = await fs.readlink(`${PROC}/self`);
      } catch (error) {
        // No `/proc` at all: nothing can be misread; the calls below fail or
        // find nothing on their own. Any other failure is not cached.
        if (errnoOf(error) === 'ENOENT') return;
        throw error;
      }
      own = self === String(selfPid) ? 'yes' : 'no';
    }
    if (own === 'no') {
      throw new ForeignProcError(
        `${PROC} belongs to another pid namespace: ${PROC}/self is not ${String(selfPid)}`,
      );
    }
  };
  return {
    source: 'linux-proc',
    async listPids() {
      await ownNamespace();
      const entries = await fs.readdir(PROC);
      return entries.filter((entry) => PID_ENTRY.test(entry)).map(Number);
    },
    async readStat(pid) {
      assertPid('pid', pid, 1);
      await ownNamespace();
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
