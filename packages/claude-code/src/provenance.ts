/**
 * Provenance data of the Claude Code binary (K4, K8, ADR-0011, plan §1.8):
 * the committed digest table, the application's extra digests, and the
 * `--version` probe's argv and output format.
 *
 * @remarks
 * `known-binaries.ts` is the one reviewed source of the table and of the
 * pinned publisher, updated only by the version-bump PR (K16); a unit test
 * keeps the table equal to `tooling/cli-pin.json`. Nothing is fetched at run
 * time.
 *
 * The darwin entries come from the macOS gate (M1; research 10 §5,
 * research 11).
 *
 * @packageDocumentation
 */

import process from 'node:process';

import { CLAUDE_CODE_PUBLISHER, KNOWN_BINARIES } from './known-binaries.js';

export { CLAUDE_CODE_PUBLISHER, KNOWN_BINARIES };

/**
 * A digest entry: the shape of the core's `KnownDigest`.
 *
 * @internal
 */
export interface ClaudeKnownDigest {
  readonly version: string;
  readonly sha256: string;
  readonly size?: number;
}

/**
 * The platform key of the table: `<process.platform>-<process.arch>`, as
 * the npm platform packages name it (`linux-x64`, `win32-x64`,
 * `darwin-arm64`). musl builds are not told apart: a musl binary does not
 * match the glibc digest and is `unverified`.
 *
 * @internal
 */
export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  return `${platform}-${arch}`;
}

/**
 * The known digests for one platform: the committed table, then the
 * application's `claudeCode.binaryDigests` (already schema-checked; digests
 * are compared lower-case). An application digest is trusted as given: it
 * adds an accepted file, it never removes one.
 *
 * @internal
 */
export function knownDigestsFor(
  key: string,
  applicationDigests: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
  table: typeof KNOWN_BINARIES = KNOWN_BINARIES,
): ClaudeKnownDigest[] {
  const digests: ClaudeKnownDigest[] = [];
  for (const [version, platforms] of Object.entries(table)) {
    const entry = platforms[key];
    if (entry !== undefined) digests.push({ version, sha256: entry.sha256, size: entry.size });
  }
  for (const [version, platforms] of Object.entries(applicationDigests)) {
    const sha256 = platforms[key];
    if (sha256 !== undefined) digests.push({ version, sha256: sha256.toLowerCase() });
  }
  return digests;
}

/**
 * The argv of the K4 probe.
 *
 * @internal
 */
export const CLAUDE_VERSION_PROBE_ARGS: readonly string[] = Object.freeze(['--version']);

/**
 * Timeout of the K4 probe (plan §1.8, §3.1).
 *
 * @internal
 */
export const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 15_000;

/** `2.1.296 (Claude Code)`, 05 §1; a semver pre-release suffix is allowed. */
const VERSION_LINE = /^(\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?) \(Claude Code\)$/;

/**
 * The version in the output of `claude --version`, or `undefined` when the
 * output is not exactly one such line (a trailing line break is allowed).
 *
 * @internal
 */
export function parseClaudeVersion(stdout: string): string | undefined {
  const line = stdout.replace(/\r?\n$/, '');
  return VERSION_LINE.exec(line)?.[1];
}
