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
 *   directory set to `System32`, an environment of `SystemRoot` plus every
 *   other `WIN32_REQUIRED_ENV_NAMES` entry set to `''` (so libuv copies
 *   nothing from the host, `win32-env.ts`),
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
 * The resolution (`SystemRoot`, then the realpath check) is
 * {@link resolveSystem32Executable}, shared with the other System32 tool
 * hudhud runs, Windows PowerShell (the Authenticode check in
 * `verify/os-signature.ts` and the CIM process table of `os/win32.ts`, wired
 * in `spawn.ts`), so every call site applies the same checks and the same
 * `System32` working directory (review R1-3).
 *
 * @packageDocumentation
 */

import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';

import { pathProblem } from './cwd.js';
import { POWERSHELL_BELOW_SYSTEM32 } from './os/win32.js';
import { childEnv } from './win32-env.js';
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
 * Why an executable fails {@link checkExecutablePath}.
 *
 * @internal
 */
export type ExecutableRefusal = Extract<
  TaskkillRefusal,
  'not-found' | 'redirected' | 'not-regular-file'
>;

/**
 * Checks an executable named by absolute path before it is run: its realpath
 * must be `expected` itself (case-insensitively on Windows) and a regular
 * file, so a junction or link that redirects a directory on the way is
 * refused. The one check of every OS tool hudhud runs by absolute path
 * (`taskkill.exe`, PowerShell for the Authenticode check and the CIM process
 * table, `codesign`).
 *
 * @internal
 */
export async function checkExecutablePath(
  fs: TaskkillFs,
  expected: string,
  caseInsensitive: boolean,
): Promise<
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: ExecutableRefusal; readonly cause?: unknown }
> {
  let resolved: string;
  let regular: boolean;
  try {
    resolved = await fs.realpath(expected);
    const stats = await fs.lstat(resolved);
    regular = stats.isFile() && !stats.isSymbolicLink();
  } catch (error) {
    return { ok: false, reason: 'not-found', cause: error };
  }
  const same = caseInsensitive
    ? resolved.toLowerCase() === expected.toLowerCase()
    : resolved === expected;
  if (!same) return { ok: false, reason: 'redirected' };
  return regular ? { ok: true, path: resolved } : { ok: false, reason: 'not-regular-file' };
}

/**
 * Resolves `%SystemRoot%\System32\<below>` for running: `SystemRoot` through
 * {@link systemRootFrom} (validated, unambiguous), then
 * {@link checkExecutablePath}. Every System32 tool hudhud runs goes through
 * it (`taskkill.exe`, and `powershell.exe` through
 * {@link resolveSystem32PowerShell}); the caller then runs it with the
 * current directory `<SystemRoot>\System32`.
 *
 * @param below - the path below `System32`, backslash-separated
 * @returns the realpath to execute and the validated `SystemRoot`, or the
 *   refusal
 * @internal
 */
export async function resolveSystem32Executable(
  deps: Pick<TaskkillDeps, 'env' | 'fs'>,
  below: string,
): Promise<
  | { readonly ok: true; readonly path: string; readonly systemRoot: string }
  | { readonly ok: false; readonly reason: TaskkillRefusal; readonly cause?: unknown }
> {
  const root = systemRootFrom(deps.env);
  if (!root.ok) return root;
  const checked = await checkExecutablePath(deps.fs, `${root.root}\\System32\\${below}`, true);
  return checked.ok ? { ok: true, path: checked.path, systemRoot: root.root } : checked;
}

/**
 * {@link resolveSystem32Executable} for Windows PowerShell 5.1, which the
 * Authenticode check and the CIM process table run.
 *
 * @internal
 */
export function resolveSystem32PowerShell(
  deps: Pick<TaskkillDeps, 'env' | 'fs'>,
): ReturnType<typeof resolveSystem32Executable> {
  return resolveSystem32Executable(deps, POWERSHELL_BELOW_SYSTEM32);
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
  const resolved = await resolveSystem32Executable(deps, 'taskkill.exe');
  if (!resolved.ok) {
    throw new TaskkillUnavailableError(
      resolved.reason,
      resolved.cause === undefined ? undefined : { cause: resolved.cause },
    );
  }
  return { path: resolved.path, systemRoot: resolved.systemRoot };
}

/** Refuses pids that must never be passed to `taskkill`. */
function checkPid(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === 4 || pid > 0xffff_ffff) {
    throw new RangeError(`refusing to taskkill pid ${String(pid)}`);
  }
  return String(pid);
}

/**
 * The argv of `taskkill.exe`: a tree kill (`/T /F /PID <pid>`) or, with
 * `tree: false`, a kill of that one process (`/F /PID <pid>`).
 *
 * @throws RangeError when `pid` is not a positive safe integer, or is 0 or 4
 * @public
 */
export function taskkillArgv(pid: number, tree = true): readonly string[] {
  const value = checkPid(pid);
  return tree ? ['/T', '/F', '/PID', value] : ['/F', '/PID', value];
}

/**
 * The `taskkill` calls of the Windows ladder: the tree kill plus a kill of
 * one process (no `/T`), used by the sweep for identity-verified
 * descendants. The same contract as the `terminate` calls of `OsCalls`.
 *
 * @public
 */
export type TaskkillCalls = Win32TerminateCalls;

/**
 * The `taskkill` calls. Each resolves with `exitCode` 0 on success, the
 * non-zero exit code on failure (128: no such process), or `null` when
 * `taskkill` was killed by the timeout or could not run. Each rejects with
 * {@link TaskkillUnavailableError} when the executable is refused, and with
 * `RangeError` for a refused pid; nothing is spawned then.
 *
 * @public
 */
export function createTaskkillCalls(deps: TaskkillDeps): TaskkillCalls {
  const run = async (args: readonly string[]): Promise<TaskkillResult> => {
    const { path, systemRoot } = await resolveTaskkillPath(deps);
    const options: TaskkillExecOptions = {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      cwd: `${systemRoot}\\System32`,
      env: { ...childEnv({ SystemRoot: systemRoot }, 'win32') },
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
  };
  return {
    // The argv is built (and the pid checked) before anything is resolved or spawned.
    taskkillTree: async (pid) => run(taskkillArgv(pid)),
    taskkillProcess: async (pid) => run(taskkillArgv(pid, false)),
  };
}
