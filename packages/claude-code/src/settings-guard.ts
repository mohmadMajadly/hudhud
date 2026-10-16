/**
 * The project credential guard (`projectCredentialEnv`, K5, L1, ADR-0012 §2,
 * plan §1.8).
 *
 * @remarks
 * Before spawn, whenever the effective setting sources include `project` or
 * `local` and `projectCredentialEnv` is not `'allow'`, the guard reads the
 * project settings files the CLI could apply and refuses with
 * `ProjectCredentialEnvError` when their `env` sets a credential or routing
 * variable ({@link isProjectCredentialEnvName}) or when they carry a
 * top-level `apiKeyHelper`. Read only; nothing is written. Under `'allow'`
 * the adapter runs the same scan without the refusal
 * ({@link scanProjectSettings}): its findings feed `managedPolicy` and a
 * diagnostic, so allowing them is never silent (W3-Z ruling 3).
 *
 * Scan set (L1, research 08 §7, CLI 2.1.296): `.claude/settings.json` and
 * `.claude/settings.local.json` in
 *
 * - the cwd;
 * - the nearest git root: the first directory, walking up from the cwd,
 *   whose `.git` entry is a directory or a file;
 * - the main worktree root: a `.git` file is followed through `gitdir:` and
 *   that directory's `commondir` (a linked worktree); the root is the parent
 *   of the common dir when it is named `.git`, else the common dir itself
 *   (the CLI's rule for a bare common dir). Both the lexical and the
 *   physical spelling of the gitdir are tried, so `..` in `commondir` cannot
 *   steer the guard away from the CLI's choice.
 *
 * Resolution is a filesystem walk only; git is never spawned. The walk starts
 * from the cwd as given and, when it differs, from its physical path, and
 * scans the union. A cwd with no `.git` entry up to the filesystem root is
 * not in a repository: the CLI then reads the cwd only (08 §2, cases c and
 * d), and so does the guard. When the git root cannot be resolved (a
 * symlinked `.git`, a `.git` that is neither file nor directory, an
 * unreadable, oversized or malformed `.git` file, an unreadable `gitdir` or
 * `commondir`, or a link to another host), the guard falls back to the K5
 * superset, the cwd and every ancestor, and reports diagnostic
 * `settings-guard.git-root-unresolved`. The fallback skips the user's config
 * directory (the effective `CLAUDE_CONFIG_DIR`, else `~/.claude`, compared by
 * physical path): its settings are user settings, the user's own choice. The
 * skip is recorded (`skipped`, reason `'user-config-dir'`) and the directory
 * is never read.
 *
 * Refused `env` names are credential, routing or TLS-trust variables
 * ({@link isProjectCredentialEnvName}): API credentials and endpoints,
 * provider switches, proxies and TLS trust settings, each of which lets a
 * repository redirect or intercept the API traffic and its credentials.
 *
 * Reading (fail closed: anything the guard cannot evaluate refuses):
 *
 * - Every path is resolved component by component with `lstat`/`readlink`
 *   (at most 40 links). A link whose target names another host (win32 UNC
 *   or `\\?\UNC\`), a drive-relative or root-relative win32 target, or a
 *   target with NUL is never followed; such a settings file refuses
 *   (`remote-link`, `unsupported-link`), so hudhud never authenticates to a
 *   host a repository names. A symlinked settings file or `.claude`
 *   directory is followed, as the CLI follows it, and recorded (`symlinks`
 *   in the report and in the error, diagnostic
 *   `settings-guard.symlink-followed`). A dangling link refuses.
 * - Files are opened with `O_NOFOLLOW` and `O_NONBLOCK` where the OS has
 *   them, must be regular files on the open handle, and are read up to
 *   2 MiB ({@link SETTINGS_MAX_BYTES}, the CLI's own cap); larger files
 *   refuse (`oversized`).
 * - Decoding and parsing follow the CLI (static reading of the 2.1.296
 *   binary, research 08 §6 method): bytes starting `FF FE` are UTF-16LE,
 *   everything else UTF-8; a file that is empty or whitespace only is `{}`;
 *   otherwise one leading U+FEFF is removed and the text goes to
 *   `JSON.parse`, strict JSON without comments. The guard uses the same
 *   `JSON.parse`, so duplicate keys resolve as they do in the CLI (last
 *   wins). Anything the guard cannot parse refuses (`invalid-json`,
 *   `too-deep` beyond 512 levels, `not-object`); if the CLI were more
 *   lenient (comments), such a file still refuses.
 * - `env` must be an object (`env-not-object`); an own `__proto__` key at
 *   the top level or in `env` refuses (`prototype-key`), since a merge that
 *   assigns it would change the prototype. Keys are read as own keys only.
 *
 * Output never carries a value from a settings file: errors and diagnostics
 * name variables (control characters escaped, at most 256 characters) and
 * file paths only. Parser and filesystem messages are never copied.
 *
 * Not guaranteed (TOCTOU, ADR-0012 §2): files can change between this check
 * and the CLI's read; on win32 there is no `O_NOFOLLOW`, so the last path
 * component can be swapped for a link after resolution. The check refuses
 * configured redirection; it is not a sandbox boundary. The scan set is tied
 * to the tested CLI window; the canary re-runs the lookup check (W7-T2).
 * `--add-dir` entries are not scanned: the CLI never applies their `env`
 * (L3).
 *
 * @packageDocumentation
 */

import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { ProjectCredentialEnvError, type JsonObject } from '@hudhudjs/core';
import { hostPlatform, type ProcessPlatform } from '@hudhudjs/core/process';
import { isJsonObject, parseJsonLine } from '@hudhudjs/core/protocol';

import type { EffectiveSessionOptions } from './options-types.js';

/** Largest settings file the guard reads, in bytes (the CLI's cap, 2 MiB). */
export const SETTINGS_MAX_BYTES: number = 2 * 1024 * 1024;

/** Largest `.git` file or `commondir` file the guard reads, in bytes. */
export const GIT_FILE_MAX_BYTES: number = 64 * 1024;

/** Most links followed while resolving one path. */
export const MAX_LINK_HOPS = 40;

/** The settings files of one directory, under its `.claude` directory. */
export const SETTINGS_FILE_NAMES: readonly string[] = ['settings.json', 'settings.local.json'];

const NAME_OUTPUT_MAX = 256;

/**
 * Credential, routing or TLS-trust variables: each lets a repository redirect
 * or intercept the CLI's API traffic and the credentials it carries (C3,
 * 07 §9). `NO_PROXY` is not listed: it only narrows proxying.
 */
const CREDENTIAL_EXACT = new Set([
  // credential and routing
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  // traffic interception: proxies
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  // traffic interception: TLS trust
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
]);
const ANTHROPIC_ANY_BASE_URL = /^ANTHROPIC_[\s\S]*_BASE_URL$/;

function matchesCredentialPattern(name: string): boolean {
  const key = name.toUpperCase();
  return (
    CREDENTIAL_EXACT.has(key) ||
    ANTHROPIC_ANY_BASE_URL.test(key) ||
    key.startsWith('CLAUDE_CODE_USE_')
  );
}

/**
 * Whether a project settings `env` key sets a credential, routing or
 * TLS-trust variable: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_*_BASE_URL`, `CLAUDE_CODE_USE_*`
 * (ADR-0012 §2), and the interception variables `HTTPS_PROXY`,
 * `HTTP_PROXY`, `ALL_PROXY`, `NODE_TLS_REJECT_UNAUTHORIZED`,
 * `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
 * `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE` (lead ruling: the same class as
 * C3). `NO_PROXY` is not refused. `projectCredentialEnv: 'allow'` lifts all.
 *
 * @remarks
 * Any case, on every OS (win32 names are case-insensitive; elsewhere this
 * refuses more than the CLI applies, never less). The part before a first
 * `=` or NUL is checked as well, since an environment block ends the name
 * there.
 */
export function isProjectCredentialEnvName(name: string): boolean {
  const head = name.replace(/[=\0][\s\S]*$/, '');
  return matchesCredentialPattern(name) || matchesCredentialPattern(head);
}

/** A variable name as it may appear in output: escaped, bounded. */
function displayName(name: string): string {
  const bounded = name.length > NAME_OUTPUT_MAX ? `${name.slice(0, NAME_OUTPUT_MAX)}...` : name;
  return bounded.replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

// ---------------------------------------------------------------------------
// Filesystem port

/** What `lstat` reports for a path, without following a final link. */
export type SettingsEntryKind = 'file' | 'directory' | 'symlink' | 'other';

/** Result of reading one file through {@link SettingsGuardFs.readFile}. */
export type SettingsFileRead =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array }
  | { readonly kind: 'absent' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'oversized' };

/**
 * The filesystem calls of the guard, injected so the core is testable.
 *
 * @remarks
 * Every method may throw; the guard treats a throw as "cannot evaluate"
 * (fail closed) and never copies the thrown message.
 */
export interface SettingsGuardFs {
  /** `lstat`; `null` when the path does not exist (`ENOENT`, `ENOTDIR`). */
  lstat(path: string): Promise<SettingsEntryKind | null>;
  /** The link text of a symbolic link or junction. */
  readlink(path: string): Promise<string>;
  /**
   * Reads a regular file of at most `maxBytes` bytes, without following a
   * final link where the OS allows it and without blocking on special files.
   */
  readFile(path: string, maxBytes: number): Promise<SettingsFileRead>;
}

/** Everything the guard needs from the host. */
export interface SettingsGuardDeps {
  readonly fs: SettingsGuardFs;
  readonly platform: ProcessPlatform;
  /** The host's working directory, used when the cwd option is not set. */
  readonly processCwd: string;
  /**
   * The user's config directory ({@link userConfigDirOf}). Its settings are
   * user settings, the user's own choice: the ancestor fallback never reads
   * them. `null` when there is none to skip.
   */
  readonly userConfigDir: string | null;
}

/**
 * The user's config directory: the `configDir` option, else a non-empty
 * `CLAUDE_CONFIG_DIR` in `env`, else `<home>/.claude`.
 */
export function userConfigDirOf(
  configDir: string | null,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: ProcessPlatform,
): string {
  if (configDir !== null) return configDir;
  const fromEnv = env['CLAUDE_CONFIG_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return (platform === 'win32' ? path.win32 : path.posix).join(home, '.claude');
}

interface StatsLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Maps `lstat` results to {@link SettingsEntryKind}. */
export function entryKindOf(stats: StatsLike): SettingsEntryKind {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

/** The open flags of a settings read: read only, no final link, no blocking. */
export function settingsOpenFlags(flags: {
  readonly O_RDONLY: number;
  readonly O_NOFOLLOW?: number | undefined;
  readonly O_NONBLOCK?: number | undefined;
}): number {
  return flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0);
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

/** A read whose size changed under the guard. */
class FileChangedDuringRead extends Error {}

/** The part of an open file handle that {@link readRegularFile} uses. */
export interface SettingsReadHandle {
  stat(): Promise<{ isFile(): boolean; readonly size: number }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

/** Opens a file for {@link readRegularFile}. */
export type OpenSettingsFile = (file: string, flags: number) => Promise<SettingsReadHandle>;

/**
 * Reads a regular file of at most `maxBytes` bytes through an open handle:
 * the type and size are checked on the handle, not on the path, and a size
 * change during the read throws.
 */
export async function readRegularFile(
  file: string,
  maxBytes: number,
  openFile: OpenSettingsFile,
): Promise<SettingsFileRead> {
  let handle: SettingsReadHandle;
  try {
    handle = await openFile(file, settingsOpenFlags(constants));
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' };
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: 'not-a-file' };
    if (stats.size > maxBytes) return { kind: 'oversized' };
    const buffer = new Uint8Array(maxBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total === buffer.length) break;
    }
    if (total > maxBytes) return { kind: 'oversized' };
    if (total !== stats.size) throw new FileChangedDuringRead('file changed while read');
    return { kind: 'ok', bytes: buffer.subarray(0, total) };
  } finally {
    await handle.close();
  }
}

const openForRead: OpenSettingsFile = (file, flags) => open(file, flags);

/** The guard's filesystem port on Node's `fs`. */
export function nodeSettingsGuardFs(): SettingsGuardFs {
  return {
    async lstat(file) {
      try {
        return entryKindOf(await lstat(file));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    readlink: (file) => readlink(file),
    readFile: (file, maxBytes) => readRegularFile(file, maxBytes, openForRead),
  };
}

/** Host dependencies: Node's `fs`, the host platform and `process.cwd()`. */
export function nodeSettingsGuardDeps(configDir: string | null): SettingsGuardDeps {
  const platform = hostPlatform();
  return {
    fs: nodeSettingsGuardFs(),
    platform,
    processCwd: process.cwd(),
    userConfigDir: userConfigDirOf(configDir, process.env, homedir(), platform),
  };
}

// ---------------------------------------------------------------------------
// Path resolution

/** Why a settings file could not be evaluated (`details.problems[].reason`). */
export type SettingsFileProblem =
  | 'invalid-json'
  | 'too-deep'
  | 'not-object'
  | 'env-not-object'
  | 'prototype-key'
  | 'oversized'
  | 'not-a-file'
  | 'unreadable'
  | 'dangling-symlink'
  | 'symlink-loop'
  | 'remote-link'
  | 'unsupported-link';

/** Why the git root could not be resolved (diagnostic `data.reason`). */
export type GitRootProblem =
  | 'git-entry-symlink'
  | 'git-entry-other'
  | 'git-entry-unreadable'
  | 'git-file-oversized'
  | 'git-file-malformed'
  | 'gitdir-unresolvable'
  | 'commondir-unreadable'
  | 'commondir-oversized'
  | 'commondir-malformed'
  | 'commondir-unresolvable';

type PathApi = typeof path.posix;

interface Context {
  readonly fs: SettingsGuardFs;
  readonly platform: ProcessPlatform;
  readonly p: PathApi;
}

type LinkTarget =
  | { readonly kind: 'absolute'; readonly root: string; readonly rest: string }
  | { readonly kind: 'relative'; readonly rest: string }
  | { readonly kind: 'remote' }
  | { readonly kind: 'unsupported' };

const WIN32_LOCAL_DEVICE = /^(?:[\\/]{2}[?.]|\\\?\?)[\\/]([A-Za-z]:[\\/][\s\S]*)$/;
const WIN32_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Classifies a path written by someone else (a link target, `gitdir:`,
 * `commondir`) before anything touches it.
 */
function classifyTarget(target: string, ctx: Context): LinkTarget {
  if (target.includes('\0') || target === '') return { kind: 'unsupported' };
  if (ctx.platform === 'posix') {
    return target.startsWith('/')
      ? { kind: 'absolute', root: '/', rest: target }
      : { kind: 'relative', rest: target };
  }
  const local = WIN32_LOCAL_DEVICE.exec(target)?.[1];
  const spelled = local ?? target;
  if (/^[\\/]{2}/.test(spelled)) return { kind: 'remote' };
  if (WIN32_DRIVE_ABSOLUTE.test(spelled)) {
    return { kind: 'absolute', root: `${spelled.slice(0, 2)}\\`, rest: spelled.slice(3) };
  }
  if (/^[A-Za-z]:/.test(spelled) || /^[\\/]/.test(spelled)) return { kind: 'unsupported' };
  return { kind: 'relative', rest: spelled };
}

/** Absolute form of a classified non-remote target relative to `base`. */
function absoluteTarget(
  target: LinkTarget & { readonly kind: 'absolute' | 'relative' },
  base: string,
  ctx: Context,
): string {
  return target.kind === 'absolute'
    ? ctx.p.join(target.root, target.rest)
    : ctx.p.join(base, target.rest);
}

function segmentsOf(text: string, ctx: Context): string[] {
  return text.split(ctx.platform === 'win32' ? /[\\/]+/ : /\/+/).filter((s) => s !== '');
}

type Resolved =
  | {
      readonly ok: true;
      readonly path: string;
      readonly kind: Exclude<SettingsEntryKind, 'symlink'>;
      /** Whether a link was crossed below the base. */
      readonly linked: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'unreadable' | 'symlink-loop' | 'remote-link' | 'unsupported-link';
    }
  | {
      readonly ok: false;
      readonly reason: 'absent';
      /** The missing component was named by a link (a dangling link). */
      readonly dangling: boolean;
    };

/**
 * Resolves `segments` below the physical directory `base`, one component at
 * a time, never following a link to another host.
 */
async function resolveBelow(
  base: string,
  segments: readonly string[],
  ctx: Context,
): Promise<Resolved> {
  let current = base;
  let kind: Exclude<SettingsEntryKind, 'symlink'> = 'directory';
  let linked = false;
  let hops = 0;
  const pending = [...segments].reverse().map((name) => ({ name, fromLink: false }));
  for (let segment = pending.pop(); segment !== undefined; segment = pending.pop()) {
    if (segment.name === '.') continue;
    if (segment.name === '..') {
      current = ctx.p.dirname(current);
      kind = 'directory';
      continue;
    }
    const next = ctx.p.join(current, segment.name);
    let found: SettingsEntryKind | null;
    try {
      found = await ctx.fs.lstat(next);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (found === null) return { ok: false, reason: 'absent', dangling: segment.fromLink };
    if (found !== 'symlink') {
      current = next;
      kind = found;
      continue;
    }
    linked = true;
    hops += 1;
    if (hops > MAX_LINK_HOPS) return { ok: false, reason: 'symlink-loop' };
    let text: string;
    try {
      text = await ctx.fs.readlink(next);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    const target = classifyTarget(text, ctx);
    if (target.kind === 'remote') return { ok: false, reason: 'remote-link' };
    if (target.kind === 'unsupported') return { ok: false, reason: 'unsupported-link' };
    if (target.kind === 'absolute') current = target.root;
    const named = segmentsOf(target.rest, ctx).map((name) => ({ name, fromLink: true }));
    pending.push(...named.reverse());
  }
  return { ok: true, path: current, kind, linked };
}

/** Resolves an absolute path to its physical spelling. */
function resolvePhysical(absolute: string, ctx: Context): Promise<Resolved> {
  const { root } = ctx.p.parse(absolute);
  return resolveBelow(root, segmentsOf(absolute.slice(root.length), ctx), ctx);
}

const fold = (text: string, ctx: Context): string =>
  ctx.platform === 'win32' ? text.toLowerCase() : text;

function decodeText(bytes: Uint8Array, utf16: boolean): string {
  return new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', { ignoreBOM: true }).decode(bytes);
}

// ---------------------------------------------------------------------------
// Git root

type GitScope =
  | { readonly kind: 'repo'; readonly gitRoot: string; readonly mainRoots: readonly string[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'unresolved'; readonly reason: GitRootProblem; readonly path: string };

async function findGitScope(start: string, ctx: Context): Promise<GitScope> {
  let dir = start;
  for (;;) {
    const entry = ctx.p.join(dir, '.git');
    let kind: SettingsEntryKind | null;
    try {
      kind = await ctx.fs.lstat(entry);
    } catch {
      return { kind: 'unresolved', reason: 'git-entry-unreadable', path: entry };
    }
    if (kind === 'directory') return { kind: 'repo', gitRoot: dir, mainRoots: [] };
    if (kind === 'file') return resolveGitFile(dir, entry, ctx);
    if (kind === 'symlink') return { kind: 'unresolved', reason: 'git-entry-symlink', path: entry };
    if (kind === 'other') return { kind: 'unresolved', reason: 'git-entry-other', path: entry };
    const parent = ctx.p.dirname(dir);
    if (parent === dir) return { kind: 'none' };
    dir = parent;
  }
}

type SmallRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly oversized: boolean };

async function readSmall(file: string, ctx: Context): Promise<SmallRead> {
  let read: SettingsFileRead;
  try {
    read = await ctx.fs.readFile(file, GIT_FILE_MAX_BYTES);
  } catch {
    return { ok: false, oversized: false };
  }
  if (read.kind !== 'ok') return { ok: false, oversized: read.kind === 'oversized' };
  const text = decodeText(read.bytes, false).trim();
  return { ok: true, text };
}

const GITDIR_PREFIX = 'gitdir:';

/** Follows a `.git` file to the main worktree root (linked worktree). */
async function resolveGitFile(gitRoot: string, entry: string, ctx: Context): Promise<GitScope> {
  const unresolved = (reason: GitRootProblem, at: string): GitScope => ({
    kind: 'unresolved',
    reason,
    path: at,
  });
  const content = await readSmall(entry, ctx);
  if (!content.ok) {
    return unresolved(content.oversized ? 'git-file-oversized' : 'git-entry-unreadable', entry);
  }
  if (!content.text.startsWith(GITDIR_PREFIX)) return unresolved('git-file-malformed', entry);
  const gitdirTarget = classifyTarget(content.text.slice(GITDIR_PREFIX.length).trim(), ctx);
  if (gitdirTarget.kind === 'remote' || gitdirTarget.kind === 'unsupported') {
    return unresolved('gitdir-unresolvable', entry);
  }
  const gitdir = absoluteTarget(gitdirTarget, gitRoot, ctx);
  const physical = await resolvePhysical(gitdir, ctx);
  if (!physical.ok) {
    // A missing gitdir leaves the CLI at the git root (no main worktree).
    if (physical.reason === 'absent') return { kind: 'repo', gitRoot, mainRoots: [] };
    return unresolved('gitdir-unresolvable', gitdir);
  }
  const commondirFile = ctx.p.join(physical.path, 'commondir');
  const commondir = await resolveBelow(physical.path, ['commondir'], ctx);
  if (!commondir.ok && commondir.reason === 'absent' && !commondir.dangling) {
    // No commondir: a submodule or a separate git dir; the git root is the root.
    return { kind: 'repo', gitRoot, mainRoots: [] };
  }
  if (!commondir.ok || commondir.kind !== 'file') {
    return unresolved('commondir-unreadable', commondirFile);
  }
  const common = await readSmall(commondir.path, ctx);
  if (!common.ok) {
    return unresolved(
      common.oversized ? 'commondir-oversized' : 'commondir-unreadable',
      commondirFile,
    );
  }
  if (common.text === '') return unresolved('commondir-malformed', commondirFile);
  const commonTarget = classifyTarget(common.text, ctx);
  if (commonTarget.kind === 'remote' || commonTarget.kind === 'unsupported') {
    return unresolved('commondir-unresolvable', commondirFile);
  }
  const mainRoots = [gitdir, physical.path].map((dir) => {
    const commonDir = absoluteTarget(commonTarget, dir, ctx);
    return fold(ctx.p.basename(commonDir), ctx) === '.git' ? ctx.p.dirname(commonDir) : commonDir;
  });
  return { kind: 'repo', gitRoot, mainRoots };
}

function ancestorsOf(dir: string, ctx: Context): string[] {
  const chain = [dir];
  for (let parent = ctx.p.dirname(dir); parent !== chain.at(-1); parent = ctx.p.dirname(parent)) {
    chain.push(parent);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Settings files

type Evaluation =
  | { readonly ok: true; readonly variables: readonly string[]; readonly apiKeyHelper: boolean }
  | { readonly ok: false; readonly problem: SettingsFileProblem };

/** Evaluates the bytes of one settings file as the CLI would decode them. */
function evaluateSettings(bytes: Uint8Array): Evaluation {
  const text = decodeText(bytes, bytes[0] === 0xff && bytes[1] === 0xfe);
  if (text.trim() === '') return { ok: true, variables: [], apiKeyHelper: false };
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const parsed = parseJsonLine(body);
  if (!parsed.ok) {
    return { ok: false, problem: parsed.reason === 'not-json' ? 'invalid-json' : parsed.reason };
  }
  const settings = parsed.value;
  if (Object.hasOwn(settings, '__proto__')) return { ok: false, problem: 'prototype-key' };
  const apiKeyHelper = Object.hasOwn(settings, 'apiKeyHelper');
  if (!Object.hasOwn(settings, 'env')) return { ok: true, variables: [], apiKeyHelper };
  const env = settings['env'];
  if (!isJsonObject(env)) return { ok: false, problem: 'env-not-object' };
  if (Object.hasOwn(env, '__proto__')) return { ok: false, problem: 'prototype-key' };
  return { ok: true, variables: Object.keys(env).filter(isProjectCredentialEnvName), apiKeyHelper };
}

/** A settings file reached through a link (recorded, ADR-0012 §2). */
export interface SettingsSymlink {
  /** The path the CLI opens. */
  readonly path: string;
  /** The physical file the link leads to. */
  readonly target: string;
}

/** A diagnostic of the guard: names and paths only. */
export interface SettingsGuardDiagnostic {
  readonly code: 'settings-guard.git-root-unresolved' | 'settings-guard.symlink-followed';
  readonly message: string;
  readonly data: JsonObject;
}

/** The outcome of a guard run that did not refuse. */
export interface SettingsGuardReport {
  /**
   * `'not-applicable'`: the sources include neither `project` nor `local`.
   * `'allowed'`: `projectCredentialEnv: 'allow'`, nothing read.
   * `'clean'`: the scan set was read and nothing refused.
   */
  readonly outcome: 'not-applicable' | 'allowed' | 'clean';
  /** `'git-roots'` (L1) or `'ancestors'` (fallback); `null` when nothing was read. */
  readonly scope: 'git-roots' | 'ancestors' | null;
  /** Directories whose `.claude` settings files were looked up, in order. */
  readonly roots: readonly string[];
  /** Settings files that existed and were read. */
  readonly files: readonly string[];
  readonly symlinks: readonly SettingsSymlink[];
  readonly diagnostics: readonly SettingsGuardDiagnostic[];
  /** Directories the ancestor fallback left unread (the user's config directory). */
  readonly skipped: readonly SettingsGuardSkip[];
}

/**
 * A `.claude` directory the ancestor fallback did not read: it is the
 * user's config directory, whose settings are user settings (lead ruling).
 */
export interface SettingsGuardSkip {
  readonly path: string;
  readonly reason: 'user-config-dir';
}

interface FileFinding {
  readonly file: string;
  readonly variables: readonly string[];
  readonly apiKeyHelper: boolean;
}

interface FileProblem {
  readonly file: string;
  readonly reason: SettingsFileProblem;
}

class Scan {
  readonly files: string[] = [];
  readonly symlinks: SettingsSymlink[] = [];
  readonly findings: FileFinding[] = [];
  readonly problems: FileProblem[] = [];
  readonly diagnostics: SettingsGuardDiagnostic[] = [];
  readonly skipped: SettingsGuardSkip[] = [];
  readonly #seen = new Set<string>();
  readonly #ctx: Context;

  constructor(ctx: Context) {
    this.#ctx = ctx;
  }

  /** True the first time a physical path is seen. */
  first(physical: string): boolean {
    const key = fold(physical, this.#ctx);
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    return true;
  }

  linked(file: string, target: string): void {
    this.symlinks.push({ path: file, target });
    this.diagnostics.push({
      code: 'settings-guard.symlink-followed',
      message: `The settings file ${file} is reached through a link to ${target}; the guard read the target.`,
      data: { path: file, target },
    });
  }
}

async function scanRoot(
  root: string,
  userConfigKey: string | null,
  scan: Scan,
  ctx: Context,
): Promise<void> {
  const physicalRoot = await resolvePhysical(root, ctx);
  if (physicalRoot.ok && userConfigKey !== null) {
    // Only lstat/readlink: the user's config directory is never read.
    const claude = await resolveBelow(physicalRoot.path, ['.claude'], ctx);
    if (claude.ok && fold(claude.path, ctx) === userConfigKey) {
      scan.skipped.push({ path: ctx.p.join(root, '.claude'), reason: 'user-config-dir' });
      return;
    }
  }
  for (const name of SETTINGS_FILE_NAMES) {
    const file = ctx.p.join(root, '.claude', name);
    if (!physicalRoot.ok) {
      // A missing root holds no settings; any other failure refuses.
      if (physicalRoot.reason !== 'absent') {
        scan.problems.push({ file, reason: physicalRoot.reason });
      }
      continue;
    }
    const resolved = await resolveBelow(physicalRoot.path, ['.claude', name], ctx);
    if (!resolved.ok) {
      if (resolved.reason !== 'absent') scan.problems.push({ file, reason: resolved.reason });
      else if (resolved.dangling) scan.problems.push({ file, reason: 'dangling-symlink' });
      continue;
    }
    if (!scan.first(resolved.path)) continue;
    if (resolved.linked) scan.linked(file, resolved.path);
    if (resolved.kind !== 'file') {
      scan.problems.push({ file, reason: 'not-a-file' });
      continue;
    }
    await scanFile(file, resolved.path, scan, ctx);
  }
}

async function scanFile(file: string, physical: string, scan: Scan, ctx: Context): Promise<void> {
  let read: SettingsFileRead;
  try {
    read = await ctx.fs.readFile(physical, SETTINGS_MAX_BYTES);
  } catch {
    scan.problems.push({ file, reason: 'unreadable' });
    return;
  }
  // Removed after resolution: the CLI cannot read it either (TOCTOU residual).
  if (read.kind === 'absent') return;
  if (read.kind !== 'ok') {
    scan.problems.push({ file, reason: read.kind });
    return;
  }
  scan.files.push(file);
  const evaluation = evaluateSettings(read.bytes);
  if (!evaluation.ok) {
    scan.problems.push({ file, reason: evaluation.problem });
    return;
  }
  if (evaluation.variables.length > 0 || evaluation.apiKeyHelper) {
    scan.findings.push({
      file,
      variables: evaluation.variables.map(displayName),
      apiKeyHelper: evaluation.apiKeyHelper,
    });
  }
}

/**
 * The physical spelling of the user's config directory, folded, resolved with
 * the same component-wise link handling; `null` when there is none or it
 * cannot be resolved (then nothing is skipped: fail closed).
 */
async function userConfigKeyOf(dir: string | null, ctx: Context): Promise<string | null> {
  if (dir === null || !ctx.p.isAbsolute(dir)) return null;
  const resolved = await resolvePhysical(ctx.p.normalize(dir), ctx);
  return resolved.ok && resolved.kind === 'directory' ? fold(resolved.path, ctx) : null;
}

const unique = (items: readonly string[], ctx: Context): string[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = fold(item, ctx);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Runs the project credential guard for a session about to spawn.
 *
 * @returns the report when nothing refuses
 * @throws `ProjectCredentialEnvError` when a scanned settings file sets a
 *   credential or routing variable or `apiKeyHelper`, or cannot be
 *   evaluated. `details`: `files` (every file with a finding or a problem),
 *   `variables` (names), `apiKeyHelper`, `unparseable` (files with a
 *   problem), `problems` (`{ file, reason }`), `findings` (per file),
 *   `symlinks`, `skipped`, `scope` and `diagnostics`. Never a value.
 */
export async function checkProjectCredentialEnv(
  session: Pick<EffectiveSessionOptions, 'cwd' | 'settingSources' | 'projectCredentialEnv'>,
  deps: SettingsGuardDeps,
): Promise<SettingsGuardReport> {
  const empty = {
    scope: null,
    roots: [],
    files: [],
    symlinks: [],
    diagnostics: [],
    skipped: [],
  } as const;
  const sources = session.settingSources;
  if (!sources.includes('project') && !sources.includes('local')) {
    return { outcome: 'not-applicable', ...empty };
  }
  if (session.projectCredentialEnv === 'allow') return { outcome: 'allowed', ...empty };
  const { scan, scope, scanned } = await scanSet(session, deps);
  if (scan.findings.length === 0 && scan.problems.length === 0) {
    return {
      outcome: 'clean',
      scope,
      roots: scanned,
      files: scan.files,
      symlinks: scan.symlinks,
      diagnostics: scan.diagnostics,
      skipped: scan.skipped,
    };
  }
  throw guardError(scan, scope);
}

/**
 * What {@link scanProjectSettings} found: the report fields of a scan plus
 * its findings, names and paths only.
 */
export interface ProjectSettingsScan {
  readonly scope: 'git-roots' | 'ancestors';
  readonly roots: readonly string[];
  readonly files: readonly string[];
  readonly symlinks: readonly SettingsSymlink[];
  readonly diagnostics: readonly SettingsGuardDiagnostic[];
  readonly skipped: readonly SettingsGuardSkip[];
  /** Credential or routing variable names the scanned files set (sorted, unique). */
  readonly variables: readonly string[];
  /** A scanned file has a top-level `apiKeyHelper`. */
  readonly apiKeyHelper: boolean;
  /** Files that could not be evaluated (the guard would refuse them). */
  readonly unparseable: readonly string[];
}

/**
 * The scan of {@link checkProjectCredentialEnv}, read-only, without refusing:
 * for a session that runs with `projectCredentialEnv: 'allow'`, whose
 * findings still feed `managedPolicy` and a diagnostic (W3-Z ruling 3, W5
 * ruling 3). The same scan set, caps and link handling; names, never values.
 */
export async function scanProjectSettings(
  session: Pick<EffectiveSessionOptions, 'cwd'>,
  deps: SettingsGuardDeps,
): Promise<ProjectSettingsScan> {
  const { scan, scope, scanned } = await scanSet(session, deps);
  return {
    scope,
    roots: scanned,
    files: scan.files,
    symlinks: scan.symlinks,
    diagnostics: scan.diagnostics,
    skipped: scan.skipped,
    variables: [...new Set(scan.findings.flatMap((f) => f.variables))].sort(),
    apiKeyHelper: scan.findings.some((f) => f.apiKeyHelper),
    unparseable: [...new Set(scan.problems.map((p) => p.file))],
  };
}

async function scanSet(
  session: Pick<EffectiveSessionOptions, 'cwd'>,
  deps: SettingsGuardDeps,
): Promise<{
  readonly scan: Scan;
  readonly scope: 'git-roots' | 'ancestors';
  readonly scanned: string[];
}> {
  const ctx: Context = {
    fs: deps.fs,
    platform: deps.platform,
    p: deps.platform === 'win32' ? path.win32 : path.posix,
  };
  const lexical = ctx.p.resolve(deps.processCwd, session.cwd ?? deps.processCwd);
  const physical = await resolvePhysical(lexical, ctx);
  const starts = unique(physical.ok ? [lexical, physical.path] : [lexical], ctx);

  const scan = new Scan(ctx);
  const roots: string[] = [];
  let fallback = false;
  for (const start of starts) {
    const scope = await findGitScope(start, ctx);
    roots.push(start);
    if (scope.kind === 'repo') roots.push(scope.gitRoot, ...scope.mainRoots);
    if (scope.kind === 'unresolved') {
      fallback = true;
      scan.diagnostics.push({
        code: 'settings-guard.git-root-unresolved',
        message: `The git root of ${start} could not be resolved (${scope.reason} at ${scope.path}); the guard reads the settings of the cwd and every ancestor.`,
        data: { cwd: start, reason: scope.reason, path: scope.path },
      });
    }
  }
  const scanned = unique(
    fallback ? [...roots, ...starts.flatMap((start) => ancestorsOf(start, ctx))] : roots,
    ctx,
  );
  const userConfigKey = fallback ? await userConfigKeyOf(deps.userConfigDir, ctx) : null;
  for (const root of scanned) await scanRoot(root, userConfigKey, scan, ctx);

  return { scan, scope: fallback ? 'ancestors' : 'git-roots', scanned };
}

function guardError(scan: Scan, scope: 'git-roots' | 'ancestors'): ProjectCredentialEnvError {
  const files = [...new Set([...scan.findings, ...scan.problems].map(({ file }) => file))];
  const findings = {
    files,
    variables: [...new Set(scan.findings.flatMap((f) => f.variables))].sort(),
    apiKeyHelper: scan.findings.some((f) => f.apiKeyHelper),
    unparseable: [...new Set(scan.problems.map((p) => p.file))],
  };
  const { message } = ProjectCredentialEnvError.fromFindings(findings);
  return new ProjectCredentialEnvError(message, {
    details: {
      ...findings,
      problems: scan.problems.map(({ file, reason }) => ({ file, reason })),
      findings: scan.findings.map(({ file, variables, apiKeyHelper }) => ({
        file,
        variables: [...variables],
        apiKeyHelper,
      })),
      symlinks: scan.symlinks.map(({ path: file, target }) => ({ path: file, target })),
      skipped: scan.skipped.map(({ path: dir, reason }) => ({ path: dir, reason })),
      scope,
      diagnostics: scan.diagnostics.map(({ code, message: text, data }) => ({
        code,
        message: text,
        data,
      })),
    },
  });
}
