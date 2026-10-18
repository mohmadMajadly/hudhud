/**
 * The bounded command runner of `verify/`: the OS signature checks and the
 * version probe (ADR-0011, plan §1.7, §1.8).
 *
 * @remarks
 * Guarantees of {@link runBoundedCommand}:
 *
 * - `shell: false`, `windowsHide: true`, `windowsVerbatimArguments: false`,
 *   not detached, stdin and stderr ignored, stdout a pipe: every argv entry
 *   reaches the child as one argument, byte for byte.
 * - The environment is exactly `command.env` (through `childEnv`, so on
 *   Windows libuv copies nothing from the host); the working directory is
 *   `command.cwd`.
 * - Bounded: the child is killed through its own handle (`SIGKILL`, on
 *   Windows `TerminateProcess`) and the stdout pipe destroyed when the
 *   timeout fires, its `signal` aborts or stdout exceeds `maxStdoutBytes`, so a descendant that
 *   keeps the pipe open cannot hold the runner.
 * - Never rejects: every way the command can end is one {@link CommandOutcome}.
 *
 * @packageDocumentation
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { errnoCode, type ProcessPlatform } from '../cwd.js';
import { childEnv } from '../win32-env.js';

/**
 * One bounded command.
 *
 * @beta
 */
export interface BoundedCommand {
  /** Absolute path of the executable. */
  readonly file: string;
  readonly args: readonly string[];
  /** The child's complete environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Absolute working directory. */
  readonly cwd: string;
  /** Path semantics of `env` (Windows: `childEnv` adds the libuv names). */
  readonly platform: ProcessPlatform;
  /** Milliseconds before the child is killed. */
  readonly timeoutMs: number;
  /** Bytes of stdout kept; one more byte kills the child. */
  readonly maxStdoutBytes: number;
  /**
   * Aborting it ends the command at once as the timeout does: the child is
   * killed through its handle and the outcome is `aborted`. Already aborted:
   * nothing is spawned.
   */
  readonly signal?: AbortSignal;
}

/**
 * How a {@link BoundedCommand} ended.
 *
 * @beta
 */
export type CommandOutcome =
  | {
      readonly kind: 'exited';
      /** `null` when the child ended by a signal. */
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      /** stdout decoded as UTF-8 (invalid sequences replaced). */
      readonly stdout: string;
    }
  | { readonly kind: 'spawn-error'; readonly errno: string | undefined }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'output-too-large' }
  | { readonly kind: 'aborted' };

/**
 * `child_process.spawn` as used by {@link runBoundedCommand}; injectable for
 * tests.
 *
 * @beta
 */
export type BoundedSpawn = (
  file: string,
  args: readonly string[],
  options: {
    readonly shell: false;
    readonly windowsHide: true;
    readonly windowsVerbatimArguments: false;
    readonly detached: false;
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly stdio: readonly ['ignore', 'pipe', 'ignore'];
  },
) => ChildProcessByStdio<null, Readable, null>;

const nodeSpawn: BoundedSpawn = (file, args, options) =>
  spawn(file, [...args], { ...options, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Runs one command within its bounds (see the module remarks).
 *
 * @beta
 */
export function runBoundedCommand(
  command: BoundedCommand,
  spawnFn: BoundedSpawn = nodeSpawn,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const { signal } = command;
    if (signal?.aborted === true) {
      resolve({ kind: 'aborted' });
      return;
    }
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      child = spawnFn(command.file, command.args, {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
        detached: false,
        cwd: command.cwd,
        env: childEnv(command.env, command.platform),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      // Node validates argv and env synchronously (for example a NUL byte).
      resolve({ kind: 'spawn-error', errno: errnoCode(error) });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let stopped: 'timeout' | 'output-too-large' | 'aborted' | undefined;
    const onAbort = (): void => {
      stop('aborted');
    };
    const settle = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const stop = (reason: 'timeout' | 'output-too-large' | 'aborted'): void => {
      stopped ??= reason;
      child.kill('SIGKILL');
      child.stdout.destroy();
      settle({ kind: reason });
    };
    const timer = setTimeout(() => {
      stop('timeout');
    }, command.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped !== undefined) return;
      bytes += chunk.length;
      if (bytes > command.maxStdoutBytes) stop('output-too-large');
      else chunks.push(chunk);
    });
    // After a failed spawn the pipe may report ENOTCONN (07 §6); never unhandled.
    child.stdout.on('error', () => undefined);
    child.on('error', (error) => {
      // An error after a successful spawn (a failed kill) leaves `close` to settle.
      if (child.pid === undefined) settle({ kind: 'spawn-error', errno: errnoCode(error) });
    });
    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      settle({
        kind: 'exited',
        exitCode,
        signal,
        stdout: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
}
