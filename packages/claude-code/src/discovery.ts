/**
 * Discovery of the Claude Code binary (K7, ADR-0011 §5, plan §1.8).
 *
 * @remarks
 * Order, first hit wins:
 *
 * 1. `binaryPath` when given. Nothing else is tried: a missing or refused
 *    explicit path is an error.
 * 2. The native installer launcher (01 §4.1): `~/.local/bin/claude`
 *    (`%USERPROFILE%\.local\bin\claude.exe`). On POSIX it is a symbolic link
 *    to `~/.local/share/claude/versions/<version>`; it is resolved to that
 *    file (realpath) and the layout is reported with the version from the
 *    file name. On Windows the installer copies the binary there; the copy
 *    itself is the binary. A launcher that exists but is refused (not a
 *    regular file, not executable, a batch file) stops discovery with
 *    `BinaryRefusedError` instead of falling through to `PATH`.
 * 3. A `PATH` lookup over the safe entries only (`safeSearchPathEntries`:
 *    empty, relative and `.` entries dropped), with the current directory
 *    also dropped when spelled absolutely. Only `claude.exe` is looked for on
 *    Windows (`.cmd`/`.bat` shims are never candidates). On POSIX an entry
 *    whose directory, or the directory of the resolved file, is
 *    world-writable is skipped (binary planting). Entries whose candidate is
 *    missing or refused are skipped, as a shell lookup would.
 *
 * `node_modules` is never probed (planting, 02 §10 item 9). Every candidate
 * tried is reported. Each hit is a realpath'd regular, executable file
 * (`resolveExecutable`), the input of verification; its identity is bound by
 * the digest in `verifyBinary` and checked again before every spawn.
 *
 * @packageDocumentation
 */

import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { BinaryNotFoundError, BinaryRefusedError } from '@hudhudjs/core';
import {
  ExecutableResolutionError,
  hostPlatform,
  pathProblem,
  resolveExecutable,
  safeSearchPathEntries,
  type ProcessPlatform,
  type ResolvedExecutable,
} from '@hudhudjs/core/process';

/**
 * Where the binary came from (plan §2.2 `BinaryInfo.source`).
 *
 * @internal
 */
export type BinarySource = 'option' | 'native-install' | 'path';

/**
 * One path discovery tried.
 *
 * @internal
 */
export interface DiscoveryCandidate {
  readonly source: BinarySource;
  readonly path: string;
  readonly outcome: 'selected' | 'not-found' | 'refused' | 'skipped';
  readonly reason?: string;
}

/**
 * The layout of the native installer launcher (01 §4.1).
 *
 * @internal
 */
export interface LauncherLayout {
  /**
   * `versions-link`: a symbolic link into `~/.local/share/claude/versions`;
   * `copy`: a regular file (the Windows installer); `other`: a link elsewhere.
   */
  readonly kind: 'versions-link' | 'copy' | 'other';
  /** The version named by the file in `versions/`, for `versions-link`. */
  readonly version?: string;
}

/**
 * The discovered binary.
 *
 * @internal
 */
export interface DiscoveredBinary {
  readonly source: BinarySource;
  /** The path as found or given, before realpath. */
  readonly requestedPath: string;
  /** The validated executable; `executable.path` is the realpath to verify. */
  readonly executable: ResolvedExecutable;
  /** Present for `native-install`. */
  readonly launcher?: LauncherLayout;
  readonly candidates: readonly DiscoveryCandidate[];
}

/**
 * Filesystem calls of discovery besides `resolveExecutable`.
 *
 * @internal
 */
export interface DiscoveryFs {
  lstat(value: string): Promise<{ isSymbolicLink(): boolean }>;
  realpath(value: string): Promise<string>;
  /** `stat` of a directory: its permission bits. */
  stat(value: string): Promise<{ readonly mode: number }>;
}

/**
 * Inputs of {@link discoverBinary}.
 *
 * @internal
 */
export interface DiscoveryDeps {
  readonly platform: ProcessPlatform;
  /** The host environment, read only for `PATH`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory; discovery skips the launcher without one. */
  readonly home: string | undefined;
  /** The current directory, never searched. */
  readonly cwd: string;
  readonly resolve: (value: string) => Promise<ResolvedExecutable>;
  readonly fs: DiscoveryFs;
}

/**
 * The host's discovery inputs.
 *
 * @internal
 */
export function nodeDiscoveryDeps(): DiscoveryDeps {
  const platform = hostPlatform();
  return {
    platform,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    resolve: (value) => resolveExecutable(value, { platform }),
    fs: { lstat, realpath, stat },
  };
}

/** A version directory entry name: a semver version. */
const VERSION_NAME = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/;

function pathApi(platform: ProcessPlatform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function samePath(a: string, b: string, platform: ProcessPlatform): boolean {
  const api = pathApi(platform);
  const left = api.resolve(a);
  const right = api.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function refusalDetails(candidates: readonly DiscoveryCandidate[]): {
  candidates: { source: string; path: string; outcome: string; reason?: string }[];
} {
  return {
    candidates: candidates.map((candidate) => ({
      source: candidate.source,
      path: candidate.path,
      outcome: candidate.outcome,
      ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    })),
  };
}

type Attempt =
  | { readonly ok: true; readonly executable: ResolvedExecutable }
  | { readonly ok: false; readonly error: ExecutableResolutionError };

async function attempt(deps: DiscoveryDeps, value: string): Promise<Attempt> {
  try {
    return { ok: true, executable: await deps.resolve(value) };
  } catch (error) {
    if (error instanceof ExecutableResolutionError) return { ok: false, error };
    throw error;
  }
}

function refused(
  source: BinarySource,
  value: string,
  error: ExecutableResolutionError,
  candidates: readonly DiscoveryCandidate[],
): BinaryRefusedError {
  return new BinaryRefusedError(error.message, {
    details: {
      source,
      path: value,
      reason: error.reason,
      ...(error.resolved === undefined ? {} : { resolved: error.resolved }),
      ...refusalDetails(candidates),
    },
    cause: error,
  });
}

async function explicit(binaryPath: string, deps: DiscoveryDeps): Promise<DiscoveredBinary> {
  const result = await attempt(deps, binaryPath);
  if (result.ok) {
    return {
      source: 'option',
      requestedPath: binaryPath,
      executable: result.executable,
      candidates: [{ source: 'option', path: binaryPath, outcome: 'selected' }],
    };
  }
  if (result.error.code === 'BINARY_NOT_FOUND') {
    throw new BinaryNotFoundError(result.error.message, {
      details: {
        path: binaryPath,
        ...refusalDetails([{ source: 'option', path: binaryPath, outcome: 'not-found' }]),
      },
      cause: result.error,
    });
  }
  throw refused('option', binaryPath, result.error, [
    { source: 'option', path: binaryPath, outcome: 'refused', reason: result.error.reason },
  ]);
}

/** The layout of a resolved launcher (see {@link LauncherLayout}). */
async function launcherLayout(
  launcher: string,
  executable: ResolvedExecutable,
  home: string,
  deps: DiscoveryDeps,
): Promise<LauncherLayout | 'changed'> {
  let isLink: boolean;
  let target: string;
  try {
    isLink = (await deps.fs.lstat(launcher)).isSymbolicLink();
    target = await deps.fs.realpath(launcher);
  } catch {
    return 'changed';
  }
  // The launcher must still resolve to the file that was validated.
  if (!samePath(target, executable.path, deps.platform)) return 'changed';
  if (!isLink) return { kind: 'copy' };
  const api = pathApi(deps.platform);
  let versions: string;
  try {
    versions = await deps.fs.realpath(api.join(home, '.local', 'share', 'claude', 'versions'));
  } catch {
    return { kind: 'other' };
  }
  const name = api.basename(executable.path);
  return samePath(api.dirname(executable.path), versions, deps.platform) && VERSION_NAME.test(name)
    ? { kind: 'versions-link', version: name }
    : { kind: 'other' };
}

async function nativeInstall(
  deps: DiscoveryDeps,
  candidates: DiscoveryCandidate[],
): Promise<DiscoveredBinary | undefined> {
  const home = deps.home;
  if (home === undefined || pathProblem(home, deps.platform) !== undefined) {
    candidates.push({ source: 'native-install', path: '', outcome: 'skipped', reason: 'no-home' });
    return undefined;
  }
  const api = pathApi(deps.platform);
  const launcher = api.join(
    home,
    '.local',
    'bin',
    deps.platform === 'win32' ? 'claude.exe' : 'claude',
  );
  const result = await attempt(deps, launcher);
  if (!result.ok) {
    if (result.error.code === 'BINARY_NOT_FOUND') {
      candidates.push({ source: 'native-install', path: launcher, outcome: 'not-found' });
      return undefined;
    }
    candidates.push({
      source: 'native-install',
      path: launcher,
      outcome: 'refused',
      reason: result.error.reason,
    });
    throw refused('native-install', launcher, result.error, candidates);
  }
  const layout = await launcherLayout(launcher, result.executable, home, deps);
  if (layout === 'changed') {
    candidates.push({
      source: 'native-install',
      path: launcher,
      outcome: 'refused',
      reason: 'launcher-changed',
    });
    throw new BinaryRefusedError(
      `launcher ${JSON.stringify(launcher)} changed while it was resolved`,
      {
        details: {
          source: 'native-install',
          path: launcher,
          reason: 'launcher-changed',
          ...refusalDetails(candidates),
        },
      },
    );
  }
  candidates.push({ source: 'native-install', path: launcher, outcome: 'selected' });
  return {
    source: 'native-install',
    requestedPath: launcher,
    executable: result.executable,
    launcher: layout,
    candidates,
  };
}

/**
 * The `PATH` value (`value` undefined when absent), or `null` when Windows
 * spellings of the name disagree.
 */
function pathValue(
  env: Readonly<Record<string, string | undefined>>,
  platform: ProcessPlatform,
): { readonly value: string | undefined } | null {
  if (platform !== 'win32') return { value: env['PATH'] };
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === 'PATH' && value !== undefined) values.add(value);
  }
  if (values.size > 1) return null;
  const [value] = values;
  return { value };
}

/** POSIX: world-writable directories are never trusted to hold the binary. */
async function worldWritable(deps: DiscoveryDeps, directory: string): Promise<boolean> {
  if (deps.platform === 'win32') return false;
  try {
    return ((await deps.fs.stat(directory)).mode & 0o002) !== 0;
  } catch {
    return true;
  }
}

async function searchPath(
  deps: DiscoveryDeps,
  candidates: DiscoveryCandidate[],
): Promise<DiscoveredBinary | undefined> {
  const found = pathValue(deps.env, deps.platform);
  if (found === null) {
    candidates.push({ source: 'path', path: '', outcome: 'skipped', reason: 'path-ambiguous' });
    return undefined;
  }
  const api = pathApi(deps.platform);
  const name = deps.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const entry of safeSearchPathEntries(found.value, deps.platform)) {
    const candidate = api.join(entry, name);
    if (samePath(entry, deps.cwd, deps.platform)) {
      candidates.push({
        source: 'path',
        path: candidate,
        outcome: 'skipped',
        reason: 'current-directory',
      });
      continue;
    }
    const result = await attempt(deps, candidate);
    if (!result.ok) {
      const notFound = result.error.code === 'BINARY_NOT_FOUND';
      candidates.push({
        source: 'path',
        path: candidate,
        outcome: notFound ? 'not-found' : 'refused',
        ...(notFound ? {} : { reason: result.error.reason }),
      });
      continue;
    }
    if (
      (await worldWritable(deps, entry)) ||
      (await worldWritable(deps, api.dirname(result.executable.path)))
    ) {
      candidates.push({
        source: 'path',
        path: candidate,
        outcome: 'refused',
        reason: 'world-writable-directory',
      });
      continue;
    }
    candidates.push({ source: 'path', path: candidate, outcome: 'selected' });
    return { source: 'path', requestedPath: candidate, executable: result.executable, candidates };
  }
  return undefined;
}

/**
 * Finds the Claude Code binary (see the module remarks).
 *
 * @param binaryPath - the `binaryPath` option, or `null`
 * @throws `BinaryNotFoundError` (with `details.candidates`) or `BinaryRefusedError`
 * @internal
 */
export async function discoverBinary(
  binaryPath: string | null,
  deps: DiscoveryDeps = nodeDiscoveryDeps(),
): Promise<DiscoveredBinary> {
  if (binaryPath !== null) return explicit(binaryPath, deps);
  const candidates: DiscoveryCandidate[] = [];
  const native = await nativeInstall(deps, candidates);
  if (native !== undefined) return native;
  const found = await searchPath(deps, candidates);
  if (found !== undefined) return found;
  throw new BinaryNotFoundError('no Claude Code binary was found', {
    details: refusalDetails(candidates),
  });
}
