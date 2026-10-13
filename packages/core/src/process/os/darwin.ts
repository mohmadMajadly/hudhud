/**
 * macOS syscall adapter (plan §1.7, §4.8): the process table through
 * `/bin/ps` by absolute path.
 *
 * @remarks
 * Runs exactly the command documented on {@link DarwinPsTableCalls}:
 * `/bin/ps -A -o pid=,ppid=,pgid=,stat=,lstart=,comm=`, `shell: false`, with an
 * environment of exactly `{ LC_ALL: 'C', TZ: 'UTC0' }`, stdin and stderr
 * ignored, a 30 s timeout and a 64 MiB output cap. No logic: parsing is
 * `tree/ps.ts`.
 *
 * Imports only Node built-ins and `os/types.ts` (rule `os-adapters-leaf`), so
 * the small command runner is repeated in `os/win32.ts` on purpose. Coverage
 * is scoped to macOS hosts (`vitest.os.config.ts`).
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';

import type { DarwinPsTableCalls } from './types.js';

/** Absolute path of `ps`; never looked up through `PATH`. */
export const PS_PATH = '/bin/ps';

/** The `ps` argv of the contract. */
export const PS_ARGS: readonly string[] = Object.freeze([
  '-A',
  '-o',
  'pid=,ppid=,pgid=,stat=,lstart=,comm=',
]);

/** The complete `ps` environment of the contract. */
export const PS_ENV: Readonly<Record<string, string>> = Object.freeze({ LC_ALL: 'C', TZ: 'UTC0' });

/** Limits of {@link runCommand}. */
export interface CommandLimits {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
}

/** The default limits of {@link runCommand}: the bound of one process table read. */
export const DEFAULT_LIMITS: CommandLimits = Object.freeze({
  timeoutMs: 30_000,
  maxStdoutBytes: 64 * 1024 * 1024,
});

/** A command runner: resolves with stdout on exit code 0, rejects otherwise. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<Uint8Array>;

/**
 * Runs `file` with `args` and exactly `env`: `shell: false`, `windowsHide`,
 * not detached, stdin and stderr ignored. Resolves with stdout when the
 * command exits with code 0; rejects on a spawn error, any other exit, the
 * timeout (the command is then ended through its own handle) or stdout
 * beyond the cap.
 *
 * @internal
 */
export function runCommand(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  limits: CommandLimits = DEFAULT_LIMITS,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      detached: false,
      env: { ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const fail = (error: Error): void => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      fail(new Error(`${file} timed out after ${String(limits.timeoutMs)} ms`));
    }, limits.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxStdoutBytes) {
        fail(new Error(`${file} wrote more than ${String(limits.maxStdoutBytes)} bytes`));
      } else {
        chunks.push(chunk);
      }
    });
    const onError = (error: Error): void => {
      failure ??= error;
    };
    child.on('error', onError);
    // After a failed spawn the pipe may report ENOTCONN (07 §6); never unhandled.
    child.stdout.on('error', onError);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure === undefined && code !== 0) {
        failure = new Error(`${file} exited with ${code === null ? String(signal) : String(code)}`);
      }
      if (failure === undefined) resolve(new Uint8Array(Buffer.concat(chunks)));
      else reject(failure);
    });
  });
}

/**
 * The macOS process table (contract on {@link DarwinPsTableCalls}). `run`
 * defaults to {@link runCommand}; tests inject a recorder to assert the
 * exact command.
 *
 * @internal
 */
export function createDarwinPsTableCalls(run: CommandRunner = runCommand): DarwinPsTableCalls {
  return {
    source: 'darwin-ps',
    runPs: () => run(PS_PATH, PS_ARGS, PS_ENV),
  };
}
