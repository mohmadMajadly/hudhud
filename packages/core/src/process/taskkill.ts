/**
 * `taskkill /T /F /PID <pid>`, the tree kill of the Windows best-effort
 * ladder (ADR-0009, plan §1.7).
 *
 * @remarks
 * Guarantees of {@link createTaskkillCalls}:
 *
 * - The executable is `%SystemRoot%\System32\taskkill.exe` by absolute path,
 *   never looked up through `PATH`, the current directory or the
 *   application directory (binary planting).
 * - `SystemRoot` is taken from the environment only after validation: a
 *   drive-absolute path with backslashes only, no empty, `.` or `..`
 *   segments, no device namespace, no UNC share, no alternate data stream,
 *   no trailing dot or space, no reserved device name. Several spellings of
 *   the name (the environment is case-insensitive on Windows) must agree.
 *   When the variable is absent, `C:\Windows` is used, subject to the same
 *   checks.
 * - The realpath of the executable must equal the expected path
 *   (case-insensitively): a junction or symbolic link that redirects
 *   `SystemRoot` or `System32` elsewhere is refused, as is anything that is
 *   not a regular file.
 * - `shell: false`, `windowsHide: true`, no verbatim arguments, the current
 *   directory set to `System32`, an environment of exactly `{ SystemRoot }`,
 *   a timeout, and a bounded output buffer.
 * - The pid must be a positive safe integer that is neither 0 (System Idle
 *   Process) nor 4 (System).
 *
 * Not guaranteed: the identity of the pid. `taskkill` takes a bare pid, so
 * the caller verifies the process identity (pid plus start time) and that
 * it still holds the child handle immediately before calling, see
 * `ladder/windows.ts`. The file can also be replaced between the check and
 * the spawn; replacing `System32` requires administrator rights, which is
 * outside the threat model.
 *
 * @packageDocumentation
 */

import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';

import { pathProblem } from './cwd.js';
import type { TaskkillResult, Win32TerminateCalls } from './os/types.js';

/**
 * `SystemRoot` used when the environment does not define it.
 *
 * @public
 */
export const WIN32_DEFAULT_SYSTEM_ROOT = 'C:\\Windows';

/**
 * Upper bound on one `taskkill` run before it is killed.
 *
 * @public
 */
export const DEFAULT_TASKKILL_TIMEOUT_MS = 10_000;

/** Bound on the captured output; the output itself is ignored. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Characters Windows forbids in a path segment, plus controls. */
// eslint-disable-next-line no-control-regex -- control characters are refused on purpose
const SEGMENT = /^[^\\/:*?"<>|\u0000-\u001f]+$/;
const DRIVE_ROOT = /^[A-Za-z]:\\/;

/**
 * Why `taskkill.exe` cannot be used.
 *
 * @public
 */
export type TaskkillRefusal =
  /** `SystemRoot` is not a plain drive-absolute directory path. */
  | 'system-root-invalid'
  /** Several spellings of `SystemRoot` in the environment disagree. */
  | 'system-root-ambiguous'
  /** The executable does not exist or cannot be resolved. */
  | 'not-found'
  /** The realpath differs from the expected path (junction, symbolic link). */
  | 'redirected'
  /** Not a regular file. */
  | 'not-regular-file';

/**
 * Thrown (as a rejection of `taskkillTree`) when `taskkill.exe` is refused.
 *
 * @public
 */
export class TaskkillUnavailableError extends Error {
  override readonly name = 'TaskkillUnavailableError';
  readonly code = 'TASKKILL_UNAVAILABLE';
  readonly reason: TaskkillRefusal;

  constructor(reason: TaskkillRefusal, options?: { readonly cause?: unknown }) {
    super(`taskkill.exe is unavailable: ${reason}`, options);
    this.reason = reason;
  }
}

/**
 * Filesystem calls used to resolve `taskkill.exe`; injectable for tests.
 *
 * @public
 */
export interface TaskkillFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
}

/**
 * Options passed to {@link TaskkillExecFile}; a subset of Node's `execFile` options.
 *
 * @public
 */
export interface TaskkillExecOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly windowsVerbatimArguments: false;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeout: number;
  readonly killSignal: 'SIGKILL';
  readonly maxBuffer: number;
}

/**
 * The error Node's `execFile` passes to its callback: `code` is the exit
 * code (a number) when the process exited non-zero, or an errno string when
 * it could not run or was killed.
 *
 * @public
 */
export interface TaskkillExecError {
  readonly code?: number | string | null | undefined;
}

/**
 * Node's `child_process.execFile`, narrowed; injectable for tests.
 *
 * @public
 */
export type TaskkillExecFile = (
  file: string,
  args: readonly string[],
  options: TaskkillExecOptions,
  callback: (error: TaskkillExecError | null) => void,
) => unknown;

/**
 * Dependencies of {@link createTaskkillCalls}.
 *
 * @public
 */
export interface TaskkillDeps {
  /** The host environment, read only for `SystemRoot`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: TaskkillFs;
  readonly execFile: TaskkillExecFile;
  /** Defaults to {@link DEFAULT_TASKKILL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * The host's filesystem and `execFile`.
 *
 * @public
 */
export const nodeTaskkillDeps: Omit<TaskkillDeps, 'env'> = {
  fs: { realpath, lstat },
  execFile,
};

/**
 * The validated `SystemRoot`, or the refusal.
 *
 * @public
 */
export function systemRootFrom(
  env: Readonly<Record<string, string | undefined>>,
):
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly reason: TaskkillRefusal } {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'systemroot' && value !== undefined) values.add(value);
  }
  if (values.size > 1) return { ok: false, reason: 'system-root-ambiguous' };
  const [root = WIN32_DEFAULT_SYSTEM_ROOT] = values;
  return isPlainDrivePath(root) ? { ok: true, root } : { ok: false, reason: 'system-root-invalid' };
}

/** `X:\a\b` with plain segments only; the drive root itself is refused. */
function isPlainDrivePath(value: string): boolean {
  if (!DRIVE_ROOT.test(value) || pathProblem(value, 'win32') !== undefined) return false;
  const segments = value.slice(3).split('\\');
  return segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}

/**
 * Resolves `%SystemRoot%\System32\taskkill.exe` (see the module remarks).
 *
 * @returns the realpath to execute and the validated `SystemRoot`
 * @throws {@link TaskkillUnavailableError}
 * @public
 */
export async function resolveTaskkillPath(
  deps: Pick<TaskkillDeps, 'env' | 'fs'>,
): Promise<{ readonly path: string; readonly systemRoot: string }> {
  const root = systemRootFrom(deps.env);
  if (!root.ok) throw new TaskkillUnavailableError(root.reason);
  const expected = `${root.root}\\System32\\taskkill.exe`;
  let resolved: string;
  let isRegular: boolean;
  try {
    resolved = await deps.fs.realpath(expected);
    const stats = await deps.fs.lstat(resolved);
    isRegular = stats.isFile() && !stats.isSymbolicLink();
  } catch (error) {
    throw new TaskkillUnavailableError('not-found', { cause: error });
  }
  if (resolved.toLowerCase() !== expected.toLowerCase()) {
    throw new TaskkillUnavailableError('redirected');
  }
  if (!isRegular) throw new TaskkillUnavailableError('not-regular-file');
  return { path: resolved, systemRoot: root.root };
}

/**
 * The argv of `taskkill.exe` for a tree kill of `pid`.
 *
 * @throws RangeError when `pid` is not a positive safe integer, or is 0 or 4
 * @public
 */
export function taskkillArgv(pid: number): readonly string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === 4 || pid > 0xffff_ffff) {
    throw new RangeError(`refusing to taskkill pid ${String(pid)}`);
  }
  return ['/T', '/F', '/PID', String(pid)];
}

/**
 * The best-effort tree kill as {@link Win32TerminateCalls}. Resolves with
 * `exitCode` 0 on success, the non-zero exit code on failure (128: no such
 * process), or `null` when `taskkill` was killed by the timeout or could
 * not run. Rejects with {@link TaskkillUnavailableError} when the
 * executable is refused, and with `RangeError` for a refused pid; nothing is
 * spawned then.
 *
 * @public
 */
export function createTaskkillCalls(deps: TaskkillDeps): Win32TerminateCalls {
  return {
    async taskkillTree(pid: number): Promise<TaskkillResult> {
      const args = taskkillArgv(pid);
      const { path, systemRoot } = await resolveTaskkillPath(deps);
      const options: TaskkillExecOptions = {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
        cwd: `${systemRoot}\\System32`,
        env: { SystemRoot: systemRoot },
        timeout: deps.timeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT_BYTES,
      };
      return new Promise<TaskkillResult>((resolve) => {
        deps.execFile(path, args, options, (error) => {
          if (error === null) resolve({ exitCode: 0 });
          else resolve({ exitCode: typeof error.code === 'number' ? error.code : null });
        });
      });
    },
  };
}
