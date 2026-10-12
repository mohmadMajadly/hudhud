/**
 * Detection of writes outside the sandbox (05 §13, 07 §13, 08 §9).
 *
 * @remarks
 * Before and after a run, the watched locations of the real user are
 * observed by metadata only: `lstat` (existence, kind, size, mtime) of the
 * places the CLI writes by default, and the entry names of the temp and
 * home directories filtered to Claude-related names. No file is ever read,
 * so the real `~/.claude`, `~/.claude.json` and `%APPDATA%` contents are
 * never touched. Every difference is reported; the caller may ignore a
 * documented confound explicitly (05 §13: the user's own live Claude Code
 * rewrites `~/.claude.json`).
 */

import type { Stats } from 'node:fs';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** What to observe. */
export interface OutsideWatch {
  /** Paths whose metadata is compared. */
  readonly paths: readonly string[];
  /** Directories whose entry names matching `pattern` are compared. */
  readonly listings: readonly { readonly dir: string; readonly pattern: RegExp }[];
}

/** Inputs of {@link outsideWatchList}. */
export interface OutsideWatchInput {
  readonly platform: NodeJS.Platform;
  /** The real user's home (never the sandbox's). */
  readonly home: string;
  /** The real host environment (`APPDATA`, `LOCALAPPDATA`, `TEMP` on Windows). */
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  /** POSIX uid, for `/tmp/cc-socks-<uid>` (05 §13). */
  readonly uid?: number | undefined;
}

const CLAUDE_NAMES = /claude|anthropic|cc-socks|cc-msg/i;
const ANY = /^/;

/** The default watch list of the platform (05 §13). */
export function outsideWatchList(input: OutsideWatchInput): OutsideWatch {
  const { home, hostEnv } = input;
  if (input.platform === 'win32') {
    const api = path.win32;
    const appData = hostEnv['APPDATA'] ?? api.join(home, 'AppData', 'Roaming');
    const localAppData = hostEnv['LOCALAPPDATA'] ?? api.join(home, 'AppData', 'Local');
    const temp = hostEnv['TEMP'] ?? api.join(localAppData, 'Temp');
    return {
      paths: [
        api.join(home, '.claude.json'),
        api.join(home, '.claude'),
        api.join(appData, 'Anthropic'),
        api.join(appData, 'Claude'),
        api.join(localAppData, 'claude-cli-nodejs'),
        api.join(home, '.config', 'claude'),
        api.join(home, '.local', 'state', 'claude'),
        api.join(home, '.cache', 'claude'),
      ],
      listings: [
        { dir: home, pattern: CLAUDE_NAMES },
        { dir: appData, pattern: CLAUDE_NAMES },
        { dir: localAppData, pattern: CLAUDE_NAMES },
        { dir: temp, pattern: CLAUDE_NAMES },
        { dir: api.join(temp, 'claude'), pattern: ANY },
      ],
    };
  }
  const api = path.posix;
  return {
    paths: [
      api.join(home, '.claude.json'),
      api.join(home, '.claude'),
      api.join(home, '.config', 'claude'),
      api.join(home, '.config', 'anthropic'),
      api.join(home, '.cache', 'claude'),
      api.join(home, '.cache', 'claude-cli-nodejs'),
      api.join(home, '.local', 'state', 'claude'),
      api.join(home, '.local', 'share', 'claude'),
      '/etc/claude-code',
      `/tmp/cc-socks-${String(input.uid ?? 0)}`,
    ],
    listings: [
      { dir: home, pattern: CLAUDE_NAMES },
      { dir: '/tmp', pattern: CLAUDE_NAMES },
      { dir: '/var/tmp', pattern: CLAUDE_NAMES },
    ],
  };
}

/** Metadata of one watched path. */
export interface PathState {
  readonly exists: boolean;
  readonly kind?: 'file' | 'directory' | 'other';
  readonly size?: number;
  readonly mtimeMs?: number;
}

/** One observation of the watch list. */
export interface OutsideSnapshot {
  readonly paths: ReadonlyMap<string, PathState>;
  /** Matching entry names per listed directory (`undefined` when it cannot be listed). */
  readonly entries: ReadonlyMap<string, ReadonlySet<string> | undefined>;
}

function kindOf(stats: Stats): NonNullable<PathState['kind']> {
  if (stats.isFile()) return 'file';
  return stats.isDirectory() ? 'directory' : 'other';
}

function stateOf(file: string): PathState {
  try {
    const stats = lstatSync(file);
    return { exists: true, kind: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return { exists: false };
  }
}

function namesIn(dir: string, pattern: RegExp): ReadonlySet<string> | undefined {
  try {
    return new Set(readdirSync(dir).filter((name) => pattern.test(name)));
  } catch {
    return undefined;
  }
}

/** Observes the watch list now (metadata and names only). */
export function snapshotOutside(watch: OutsideWatch): OutsideSnapshot {
  const paths = new Map<string, PathState>();
  for (const file of watch.paths) paths.set(file, stateOf(file));
  const entries = new Map<string, ReadonlySet<string> | undefined>();
  for (const { dir, pattern } of watch.listings) entries.set(dir, namesIn(dir, pattern));
  return { paths, entries };
}

/** One difference between two snapshots. */
export interface OutsideChange {
  /** The watched path, or the new or removed entry inside a listed directory. */
  readonly path: string;
  readonly change: 'modified' | 'created' | 'removed' | 'entry-added' | 'entry-removed';
  readonly before?: PathState;
  readonly after?: PathState;
}

function sameState(a: PathState, b: PathState): boolean {
  return a.exists === b.exists && a.kind === b.kind && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Every difference between `before` and `after` (taken with the same watch list). */
export function diffOutside(
  before: OutsideSnapshot,
  after: OutsideSnapshot,
): readonly OutsideChange[] {
  const changes: OutsideChange[] = [];
  for (const [file, was] of before.paths) {
    const now = after.paths.get(file) ?? { exists: false };
    if (sameState(was, now)) continue;
    const change = !was.exists ? 'created' : !now.exists ? 'removed' : 'modified';
    changes.push({ path: file, change, before: was, after: now });
  }
  for (const [dir, was] of before.entries) {
    const now = after.entries.get(dir);
    const old = was ?? new Set<string>();
    const current = now ?? new Set<string>();
    for (const name of current) {
      if (!old.has(name)) changes.push({ path: path.join(dir, name), change: 'entry-added' });
    }
    for (const name of old) {
      if (!current.has(name)) changes.push({ path: path.join(dir, name), change: 'entry-removed' });
    }
  }
  return changes;
}

/** Thrown by {@link assertNoOutsideWrites}. */
export class OutsideWriteError extends Error {
  override readonly name = 'OutsideWriteError';
  readonly changes: readonly OutsideChange[];

  constructor(changes: readonly OutsideChange[]) {
    super(
      `${String(changes.length)} change(s) outside the sandbox\n${changes.map((c) => `  ${c.change} ${c.path}`).join('\n')}`,
    );
    this.changes = changes;
  }
}

/**
 * Fails when any change is left after `ignore` (an explicit, documented
 * confound such as the user's live Claude Code rewriting `~/.claude.json`).
 *
 * @throws OutsideWriteError
 */
export function assertNoOutsideWrites(
  changes: readonly OutsideChange[],
  ignore: (change: OutsideChange) => boolean = () => false,
): void {
  const left = changes.filter((change) => !ignore(change));
  if (left.length > 0) throw new OutsideWriteError(left);
}
