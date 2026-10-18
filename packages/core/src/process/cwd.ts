/**
 * Working-directory validation before spawn (ADR-0011 §9, J10, plan §1.7).
 *
 * @remarks
 * Guarantees of {@link validateCwd}:
 *
 * - The returned string is absolute, free of NUL, well-formed UTF-16, and on
 *   win32 never in the `\\?\` or `\\.\` device namespace: hudhud never
 *   auto-prefixes (07 §6: a prefixed cwd makes the CLI run in the 8.3 alias,
 *   which splits transcripts and degrades the Bash tool).
 * - It names an existing directory at the time of the check, resolved through
 *   symlinks, junctions and `subst` drives (`realpath`), so one directory is
 *   always passed under one spelling (macOS gate item 6: `/tmp` is
 *   `/private/tmp`, case-insensitive volumes). 8.3 short names come back as
 *   long names; on win32 the case is the one stored on disk.
 * - On win32 it is at most {@link WIN32_CWD_MAX_LENGTH} UTF-16 code units: a
 *   plain spawn fails from 259 units with a misleading `ENOENT` (07 §6).
 *   When the canonical path is longer but the caller spelled the same
 *   directory through a shorter alias (a `subst` drive or a junction, the
 *   workarounds ADR-0011 §9 names), the alias is returned instead, after
 *   checking that it is the same directory (volume and file id). Otherwise
 *   {@link CwdValidationError} with code `CWD_TOO_LONG` is thrown.
 * - Input spellings that Windows silently rewrites are refused rather than
 *   normalized: alternate data streams (`:` after the drive), segments with a
 *   trailing dot or space, reserved device names (`CON`, `NUL`, `COM1`, ...).
 *
 * Not guaranteed (TOCTOU): the directory can be replaced, removed or turned
 * into a link between this check and the spawn; the result is a string, not a
 * handle. The check refuses mistakes and misleading failures; it is not a
 * sandbox boundary.
 *
 * @packageDocumentation
 */

import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Path semantics a check applies. `posix` covers Linux and macOS.
 *
 * @beta
 */
export type ProcessPlatform = 'win32' | 'posix';

/**
 * Maps a Node platform name to the path semantics hudhud applies.
 *
 * @param nodePlatform - defaults to the host's `process.platform`
 * @beta
 */
export function hostPlatform(nodePlatform: NodeJS.Platform = process.platform): ProcessPlatform {
  return nodePlatform === 'win32' ? 'win32' : 'posix';
}

/**
 * Longest cwd, in UTF-16 code units, that a plain Windows spawn accepts
 * (07 §6: 258 works, 259 fails with `ENOENT`).
 *
 * @beta
 */
export const WIN32_CWD_MAX_LENGTH = 258;

/**
 * Why a path string is refused before the filesystem is consulted.
 *
 * @beta
 */
export type PathProblem =
  | 'empty'
  | 'nul'
  | 'ill-formed'
  | 'not-absolute'
  | 'device-namespace'
  | 'alternate-data-stream'
  | 'trailing-dot-or-space'
  | 'reserved-device-name';

const WIN32_DEVICE_PREFIX = /^[\\/]{2}[?.][\\/]|^\\\?\?\\/;
const WIN32_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WIN32_UNC = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;
const WIN32_RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?:\..*)?$/i;

/**
 * Lexical checks shared by the cwd and executable rules. Pure.
 *
 * @remarks
 * POSIX: absolute means a leading `/`. Win32: a drive-absolute path
 * (`C:\...`) or a UNC path (`\\server\share\...`); drive-relative (`C:x`),
 * root-relative (`\x`) and device-namespace paths are refused, as are
 * spellings Windows rewrites silently (see the module remarks).
 *
 * @returns the first problem found, or `undefined` when the string is acceptable
 * @beta
 */
export function pathProblem(value: string, platform: ProcessPlatform): PathProblem | undefined {
  if (value.length === 0) return 'empty';
  if (value.includes('\0')) return 'nul';
  if (!value.isWellFormed()) return 'ill-formed';
  if (platform === 'posix') return value.startsWith('/') ? undefined : 'not-absolute';

  if (WIN32_DEVICE_PREFIX.test(value)) return 'device-namespace';
  let rest: string;
  if (WIN32_DRIVE_ABSOLUTE.test(value)) rest = value.slice(3);
  else if (WIN32_UNC.test(value)) rest = value.slice(2);
  else return 'not-absolute';

  for (const segment of rest.split(/[\\/]/)) {
    if (segment.includes(':')) return 'alternate-data-stream';
    if (segment === '.' || segment === '..') continue;
    if (segment.endsWith('.') || segment.endsWith(' ')) return 'trailing-dot-or-space';
    if (WIN32_RESERVED_NAME.test(segment)) return 'reserved-device-name';
  }
  return undefined;
}

/**
 * Why a cwd is refused by the pure rule {@link checkCwdPath}.
 *
 * @beta
 */
export type CwdProblem = PathProblem | 'too-long';

/**
 * The pure cwd rule: the lexical checks of {@link pathProblem} plus, on
 * win32, the length limit of {@link WIN32_CWD_MAX_LENGTH} UTF-16 code units.
 * Apply it to the string that will be passed to spawn.
 *
 * @beta
 */
export function checkCwdPath(value: string, platform: ProcessPlatform): CwdProblem | undefined {
  const problem = pathProblem(value, platform);
  if (problem !== undefined) return problem;
  if (platform === 'win32' && value.length > WIN32_CWD_MAX_LENGTH) return 'too-long';
  return undefined;
}

/**
 * Why {@link validateCwd} refused a cwd.
 *
 * @beta
 */
export type CwdErrorReason = CwdProblem | 'not-found' | 'not-directory' | 'unresolvable';

/**
 * Thrown by {@link validateCwd}. The adapter maps `code` to the public
 * `CwdInvalidError` / `CwdTooLongError` (plan §3.1).
 *
 * @beta
 */
export class CwdValidationError extends Error {
  override readonly name = 'CwdValidationError';
  /** `CWD_TOO_LONG` for the win32 length rule, `CWD_INVALID` otherwise. */
  readonly code: 'CWD_INVALID' | 'CWD_TOO_LONG';
  readonly reason: CwdErrorReason;
  /** The cwd as the caller passed it. */
  readonly path: string;
  /** The canonical path, when it was resolved. */
  readonly resolved: string | undefined;

  constructor(
    reason: CwdErrorReason,
    cwdPath: string,
    resolved?: string,
    options?: { readonly cause?: unknown },
  ) {
    super(cwdMessage(reason, cwdPath, resolved), options);
    this.code = reason === 'too-long' ? 'CWD_TOO_LONG' : 'CWD_INVALID';
    this.reason = reason;
    this.path = cwdPath;
    this.resolved = resolved;
  }
}

function cwdMessage(reason: CwdErrorReason, cwdPath: string, resolved?: string): string {
  const shown = JSON.stringify(cwdPath);
  if (reason === 'too-long') {
    return (
      `cwd ${shown} resolves to ${JSON.stringify(resolved ?? cwdPath)}, which is longer than ` +
      `${String(WIN32_CWD_MAX_LENGTH)} UTF-16 code units; Windows cannot start a process there. ` +
      'Use a shorter path, or a subst drive or directory junction with a shorter path, ' +
      'and use it consistently (resume keys on the cwd). hudhud never adds a \\\\?\\ prefix.'
    );
  }
  if (reason === 'not-found') return `cwd ${shown} does not exist`;
  if (reason === 'not-directory') return `cwd ${shown} is not a directory`;
  if (reason === 'unresolvable') return `cwd ${shown} cannot be resolved`;
  return `cwd ${shown} is refused: ${reason}`;
}

/**
 * Identity facts of a filesystem entry, as `stat(path, { bigint: true })`
 * returns them.
 *
 * @beta
 */
export interface FileIdentity {
  isFile(): boolean;
  isDirectory(): boolean;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeMs: bigint;
}

/**
 * {@link FileIdentity} with the timestamps an executable's identity compares
 * in nanoseconds (`stat(path, { bigint: true })` returns them): the
 * modification time and the status change time (`ctime`). On POSIX the
 * kernel sets `ctime` on every data, mode, link or timestamp change, and an
 * unprivileged process cannot set it back; on win32 Node reports the NTFS
 * change time, which a writer can set, so it is compared but is not a
 * security property there.
 *
 * @beta
 */
export interface ExecutableIdentity extends FileIdentity {
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/**
 * Filesystem calls used by {@link validateCwd}; injectable for tests.
 *
 * @beta
 */
export interface CwdFs {
  realpath(value: string): Promise<string>;
  stat(value: string): Promise<FileIdentity>;
}

/** The host filesystem: libuv `realpath` and a bigint `stat`. */
const nodeCwdFs: CwdFs = {
  realpath: (value) => realpath(value),
  stat: (value) => stat(value, { bigint: true }),
};

/**
 * Error codes of a failed filesystem call, read without trusting its shape.
 *
 * @internal
 */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) {
    return undefined;
  }
  const code: unknown = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const NOT_FOUND = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Validates and canonicalizes a cwd before spawn. See the module remarks for
 * the guarantees and their limits.
 *
 * @param cwd - absolute path as given by the application
 * @param platform - path semantics; pass {@link hostPlatform}() in production
 * @param fs - filesystem calls; the host filesystem by default
 * @returns the path to pass as the child's cwd
 * @throws {@link CwdValidationError}
 * @beta
 */
export async function validateCwd(
  cwd: string,
  platform: ProcessPlatform,
  fs: CwdFs = nodeCwdFs,
): Promise<string> {
  const lexical = pathProblem(cwd, platform);
  if (lexical !== undefined) throw new CwdValidationError(lexical, cwd);

  let canonical: string;
  let identity: FileIdentity;
  try {
    canonical = await fs.realpath(cwd);
    identity = await fs.stat(canonical);
  } catch (error) {
    const reason = NOT_FOUND.has(errnoCode(error) ?? '') ? 'not-found' : 'unresolvable';
    throw new CwdValidationError(reason, cwd, undefined, { cause: error });
  }
  if (!identity.isDirectory()) throw new CwdValidationError('not-directory', cwd, canonical);

  const problem = checkCwdPath(canonical, platform);
  if (problem === undefined) return canonical;
  if (problem !== 'too-long') throw new CwdValidationError(problem, cwd, canonical);

  // The canonical path is too long for a win32 spawn. A shorter alias the
  // caller chose (subst drive, junction) is accepted when it is provably the
  // same directory; it stays the caller's spelling, so it must be used
  // consistently (ADR-0011 §9).
  const alias = path.win32.resolve(cwd);
  if (checkCwdPath(alias, platform) === undefined && (await sameEntry(fs, alias, identity))) {
    return alias;
  }
  throw new CwdValidationError('too-long', cwd, canonical);
}

async function sameEntry(fs: CwdFs, value: string, expected: FileIdentity): Promise<boolean> {
  try {
    const actual = await fs.stat(value);
    return (
      actual.isDirectory() &&
      expected.ino !== 0n &&
      actual.ino === expected.ino &&
      actual.dev === expected.dev
    );
  } catch {
    return false;
  }
}
