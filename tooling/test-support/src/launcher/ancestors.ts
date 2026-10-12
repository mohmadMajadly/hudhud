/**
 * Forbidden-ancestor check of the sandbox (05 §13.1, plan §1.11, §4.4).
 *
 * @remarks
 * With its cwd below a directory that holds `.claude`, the CLI treats that
 * directory as project config: the real user's `~/.claude` leaked into the
 * system prompt of a sandboxed run (05 §13.1), and neither
 * `CLAUDE_CONFIG_DIR` nor the HOME redirect prevents it. `CLAUDE.md` and
 * `.mcp.json` are read the same way. A run directory is therefore refused
 * when the real home, or any directory holding one of those names, is the
 * directory itself or one of its ancestors. Both the lexical path and its
 * real path (symlinks, junctions, Windows 8.3 short names resolved) are
 * checked. The check only tests for existence; nothing is read.
 */

import path from 'node:path';

import { SandboxRefusedError } from './errors.js';

/** Names whose presence in an ancestor makes a directory unusable. */
export const FORBIDDEN_ANCESTOR_ENTRIES: readonly string[] = ['.claude', 'CLAUDE.md', '.mcp.json'];

/** File-system probes of the check, injected so every branch is testable on every OS. */
export interface AncestorProbe {
  /** Whether `file` exists (any type, links not followed); never reads it. */
  exists(file: string): boolean;
  /** The real path of an existing `dir`, or `undefined` when it cannot be resolved. */
  realpath(dir: string): string | undefined;
}

/** One reason a directory is refused. */
export interface AncestorHit {
  /** The ancestor (or the directory itself) that is forbidden. */
  readonly ancestor: string;
  /** `home` when it is a real home directory, otherwise the forbidden entry name found in it. */
  readonly reason: string;
}

/** Inputs of {@link findForbiddenAncestors}. */
export interface AncestorCheck {
  /** Absolute directory to check (normally the run directory or the test root). */
  readonly dir: string;
  /** Every path of the real user's home (from the environment and the account database). */
  readonly homes: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly probe: AncestorProbe;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** `dir` and each of its ancestors up to the root, nearest first. */
export function ancestorsOf(dir: string, platform: NodeJS.Platform): readonly string[] {
  const api = pathApi(platform);
  const out: string[] = [];
  let current = api.resolve(dir);
  for (;;) {
    out.push(current);
    const parent = api.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

function comparable(file: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(file);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Lists every reason `dir` is unusable as a sandbox directory: an ancestor
 * (inclusive) that is a real home, or that contains one of
 * {@link FORBIDDEN_ANCESTOR_ENTRIES}. Checks the lexical path and its real
 * path. An empty result means the directory is usable.
 */
export function findForbiddenAncestors(check: AncestorCheck): readonly AncestorHit[] {
  const { platform, probe } = check;
  const api = pathApi(platform);
  const homes = new Set<string>();
  for (const home of check.homes) {
    if (home === '' || !api.isAbsolute(home)) continue;
    homes.add(comparable(home, platform));
    const real = probe.realpath(home);
    if (real !== undefined) homes.add(comparable(real, platform));
  }
  const starts = [api.resolve(check.dir)];
  const real = probe.realpath(check.dir);
  if (real !== undefined && comparable(real, platform) !== comparable(check.dir, platform)) {
    starts.push(api.resolve(real));
  }
  const hits: AncestorHit[] = [];
  const seen = new Set<string>();
  for (const start of starts) {
    for (const ancestor of ancestorsOf(start, platform)) {
      const key = comparable(ancestor, platform);
      if (seen.has(key)) continue;
      seen.add(key);
      if (homes.has(key)) hits.push({ ancestor, reason: 'home' });
      for (const name of FORBIDDEN_ANCESTOR_ENTRIES) {
        if (probe.exists(api.join(ancestor, name))) hits.push({ ancestor, reason: name });
      }
    }
  }
  return hits;
}

/** How to fix a refused test root, per platform (plan §4.4). */
export function testRootInstructions(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'Set HUDHUD_TEST_ROOT to a directory outside your user profile with no .claude, CLAUDE.md or .mcp.json above it, for example a fresh directory on another drive or a temporary `subst` drive (subst T: C:\\hudhud-test-root; then HUDHUD_TEST_ROOT=T:\\).'
    : 'Set HUDHUD_TEST_ROOT to a directory on a native file system outside your home with no .claude, CLAUDE.md or .mcp.json above it (for example /var/tmp/hudhud-test-root, or run the tests in a container).';
}

/**
 * Throws {@link SandboxRefusedError} `forbidden-ancestor` when
 * {@link findForbiddenAncestors} reports anything.
 */
export function assertNoForbiddenAncestors(check: AncestorCheck): void {
  const hits = findForbiddenAncestors(check);
  if (hits.length === 0) return;
  const lines = hits.map((hit) =>
    hit.reason === 'home'
      ? `  ${hit.ancestor} is the real home directory`
      : `  ${hit.ancestor} contains ${hit.reason}`,
  );
  throw new SandboxRefusedError(
    'forbidden-ancestor',
    `refusing sandbox directory ${check.dir}: the CLI would read the real user's config through an ancestor (05 §13.1)\n${lines.join('\n')}\n${testRootInstructions(check.platform)}`,
  );
}
