/**
 * A scripted `HarnessProcess` for the product-host and integration-harness
 * tests: nothing is spawned; the test settles the identity read and the exit.
 */

import type {
  HarnessProcess,
  IdentityRead,
  ProcessExit,
  ProcessTableSource,
} from '@hudhud/core/process';

/** A fake process and the handles that settle it. */
export interface FakeProcess {
  readonly process: HarnessProcess;
  /** Resolves `exited` (and sets `exitStatus`). */
  exit(exit?: ProcessExit): void;
}

/** A process with the given pid whose identity read resolves with `read`. */
export function fakeProcess(
  pid: number,
  read: IdentityRead,
  identitySource: ProcessTableSource = 'linux-proc',
): FakeProcess {
  let exitStatus: ProcessExit | null = null;
  let resolveExit: (exit: ProcessExit) => void = () => undefined;
  const exited = new Promise<ProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  const process: HarnessProcess = {
    pid,
    identity: Promise.resolve(read),
    identitySource,
    write: () => Promise.resolve(),
    endStdin: () => undefined,
    stdout: {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    },
    stderrTail: () => '',
    exited,
    get exitStatus() {
      return exitStatus;
    },
    killViaHandle: () => false,
  };
  return {
    process,
    exit(exit = { code: 0, signal: null }) {
      exitStatus = exit;
      resolveExit(exit);
    },
  };
}

/** The identity read of a process found at `startTime`. */
export function identityOf(pid: number, startTime: string): IdentityRead {
  return { identity: { pid, startTime }, problem: null };
}
