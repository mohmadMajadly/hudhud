/**
 * Executable path validation before spawn (ADR-0011 §2, §5, plan §1.7).
 *
 * @remarks
 * Guarantees of {@link resolveExecutable}:
 *
 * - Only an absolute path is accepted, so the OS never searches the current
 *   directory, the application directory or `PATH` for it (binary planting).
 *   On win32 drive-relative (`C:x`), root-relative (`\x`) and device-namespace
 *   (`\\?\`, `\\.\`) spellings are refused.
 * - The returned `path` is the `realpath` (symlinks, junctions, `subst` and 8.3
 *   short names resolved; ADR-0011 "resolve launcher symlinks"), names a
 *   regular file, and on POSIX is executable by this process (`access X_OK`;
 *   on win32 the same call only re-checks existence).
 * - BatBadBut (CVE-2024-27980): a segment ending in `.bat` or `.cmd`, in the
 *   requested or the resolved path, is refused; on win32 the comparison is
 *   case-insensitive, and the final segment of both paths must end in `.exe`
 *   (case-insensitive), which also refuses `.com`, `.ps1`, `.lnk`, `.pif`,
 *   `.scr` and extensionless files: only native PE images are launched. Windows
 *   spellings that hide an extension are refused, not normalized: an alternate
 *   data stream (`claude.bat::$DATA`), a trailing dot or space (`claude.bat.`),
 *   a reserved device name. An 8.3 alias keeps the extension (`CLAUDE~1.BAT`)
 *   and is checked as written and again as resolved.
 * - On POSIX a script with a `#!` line is accepted (application-supplied
 *   launchers are supported, ADR-0011 J9); no shell is ever involved because
 *   spawn uses `shell: false`.
 *
 * Not guaranteed (TOCTOU): the file can be replaced between this check and
 * the spawn, or by an auto-update between sessions. `size`, `mtimeNs` and
 * `ctimeNs` let the caller key a verification cache and detect a change; binding the
 * spawned image to a digest is the job of `verify/` (ADR-0011, K8).
 *
 * @packageDocumentation
 */

import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';

import { errnoCode, hostPlatform, pathProblem } from './cwd.js';
import type { ExecutableIdentity, PathProblem, ProcessPlatform } from './cwd.js';

/**
 * A validated executable.
 *
 * @public
 */
export interface ResolvedExecutable {
  /** The path as the caller passed it. */
  readonly requested: string;
  /** The realpath; this is the path to spawn and to verify. */
  readonly path: string;
  /** File size in bytes at the time of the check. */
  readonly size: number;
  /** Modification time in whole milliseconds at the time of the check. */
  readonly mtimeMs: number;
  /** Modification time in nanoseconds (decimal) at the time of the check. */
  readonly mtimeNs: string;
  /** Status change time (`ctime`) in nanoseconds (decimal) at the time of the check. */
  readonly ctimeNs: string;
}

/**
 * Why an executable path is refused.
 *
 * @public
 */
export type ExecutableRefusal =
  PathProblem | 'batch-file' | 'not-exe' | 'not-regular-file' | 'not-executable' | 'unresolvable';

/**
 * Thrown by {@link resolveExecutable}. The adapter maps `code` to the public
 * `BinaryNotFoundError` / `BinaryRefusedError` (plan §3.1).
 *
 * @public
 */
export class ExecutableResolutionError extends Error {
  override readonly name = 'ExecutableResolutionError';
  readonly code: 'BINARY_NOT_FOUND' | 'BINARY_REFUSED';
  /** `not-found` with `BINARY_NOT_FOUND`; the refusal otherwise. */
  readonly reason: ExecutableRefusal | 'not-found';
  /** The path as the caller passed it. */
  readonly path: string;
  /** The realpath, when it was resolved. */
  readonly resolved: string | undefined;

  constructor(
    reason: ExecutableRefusal | 'not-found',
    requested: string,
    resolved?: string,
    options?: { readonly cause?: unknown },
  ) {
    const shown = JSON.stringify(requested);
    super(
      reason === 'not-found'
        ? `executable ${shown} does not exist`
        : `executable ${shown}${resolved === undefined ? '' : ` (resolved ${JSON.stringify(resolved)})`} is refused: ${reason}`,
      options,
    );
    this.code = reason === 'not-found' ? 'BINARY_NOT_FOUND' : 'BINARY_REFUSED';
    this.reason = reason;
    this.path = requested;
    this.resolved = resolved;
  }
}

const POSIX_BATCH = /\.(?:bat|cmd)$/;
const WIN32_BATCH = /\.(?:bat|cmd)$/i;
const WIN32_EXE = /\.exe$/i;

/**
 * The pure executable rule, applied to the requested and to the resolved path.
 *
 * @returns the first refusal found, or `undefined` when the string is acceptable
 * @public
 */
export function checkExecutablePath(
  value: string,
  platform: ProcessPlatform,
): ExecutableRefusal | undefined {
  const problem = pathProblem(value, platform);
  if (problem !== undefined) return problem;
  const segments = value.split(platform === 'win32' ? /[\\/]/ : '/');
  const batch = platform === 'win32' ? WIN32_BATCH : POSIX_BATCH;
  if (segments.some((segment) => batch.test(segment))) return 'batch-file';
  if (platform === 'win32' && !WIN32_EXE.test(value)) return 'not-exe';
  return undefined;
}

/**
 * Filesystem calls used by {@link resolveExecutable}; injectable for tests.
 *
 * @public
 */
export interface ExecutableFs {
  realpath(value: string): Promise<string>;
  stat(value: string): Promise<ExecutableIdentity>;
  /**
   * Resolves when the current process may execute the file: `access(X_OK)`,
   * which on win32 only checks that the file is still there.
   */
  canExecute(value: string): Promise<void>;
}

const nodeExecutableFs: ExecutableFs = {
  realpath: (value) => realpath(value),
  stat: (value) => stat(value, { bigint: true }),
  canExecute: (value) => access(value, constants.X_OK),
};

/**
 * Options of {@link resolveExecutable}.
 *
 * @public
 */
export interface ResolveExecutableOptions {
  /** Path semantics; the host's by default. */
  readonly platform?: ProcessPlatform;
  /** Filesystem calls; the host filesystem by default. */
  readonly fs?: ExecutableFs;
}

/**
 * Validates an executable path and resolves it to the real file. See the
 * module remarks for the guarantees and their limits.
 *
 * @throws {@link ExecutableResolutionError}
 * @public
 */
export async function resolveExecutable(
  requested: string,
  options: ResolveExecutableOptions = {},
): Promise<ResolvedExecutable> {
  const platform = options.platform ?? hostPlatform();
  const fs = options.fs ?? nodeExecutableFs;

  const lexical = checkExecutablePath(requested, platform);
  if (lexical !== undefined) throw new ExecutableResolutionError(lexical, requested);

  let resolved: string;
  let identity: ExecutableIdentity;
  try {
    resolved = await fs.realpath(requested);
    identity = await fs.stat(resolved);
  } catch (error) {
    const code = errnoCode(error);
    const reason = code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unresolvable';
    throw new ExecutableResolutionError(reason, requested, undefined, { cause: error });
  }

  const refusal = checkExecutablePath(resolved, platform);
  if (refusal !== undefined) throw new ExecutableResolutionError(refusal, requested, resolved);
  if (!identity.isFile()) {
    throw new ExecutableResolutionError('not-regular-file', requested, resolved);
  }
  try {
    await fs.canExecute(resolved);
  } catch (error) {
    throw new ExecutableResolutionError('not-executable', requested, resolved, { cause: error });
  }
  return {
    requested,
    path: resolved,
    size: Number(identity.size),
    mtimeMs: Number(identity.mtimeMs),
    mtimeNs: String(identity.mtimeNs),
    ctimeNs: String(identity.ctimeNs),
  };
}

/**
 * The entries of a `PATH` value that are safe to search for an executable
 * (K7, ADR-0011 §5): empty entries, relative entries, `.` and anything else
 * {@link pathProblem} refuses are dropped, so a lookup never reaches the
 * current directory. On win32 the separator is `;` and entries containing a
 * double quote are dropped (quoting is a shell convention, not a path).
 * Duplicates are removed, keeping the first. Pure.
 *
 * @public
 */
export function safeSearchPathEntries(
  value: string | undefined,
  platform: ProcessPlatform,
): string[] {
  if (value === undefined) return [];
  const entries = value.split(platform === 'win32' ? ';' : ':');
  const kept: string[] = [];
  for (const entry of entries) {
    if (pathProblem(entry, platform) !== undefined) continue;
    if (platform === 'win32' && entry.includes('"')) continue;
    if (!kept.includes(entry)) kept.push(entry);
  }
  return kept;
}
