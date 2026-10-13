/**
 * The tested window of the Claude Code adapter (plan §1.8, ADR-0004 §4, K8,
 * K16).
 *
 * @remarks
 * `CLAUDE_CODE_COMPAT` names the harness versions hudhud was tested against.
 * `maxTested` and `minTested` move only with the version-bump PR the lead
 * prepares locally (`pnpm cli:bump`, K16), together with
 * `tooling/cli-pin.json` and `known-binaries.ts`; a unit test keeps the three
 * in agreement.
 *
 * Policy (ADR-0004 §4 and its amendment, plan §1.8): the status goes into
 * the `compat` event and `harness.compat`. A version outside the window, or
 * one that cannot be parsed, is `'untested'`: reported, never refused (a
 * daily-moving CLI would make hudhud unusable between canary runs). A version
 * listed in `knownBroken` is `'known-broken'`: the connect pipeline (Wave 5)
 * refuses it with `HARNESS_VERSION_KNOWN_BROKEN` unless the application sets
 * `claudeCode.dangerouslyAllowKnownBrokenVersion: true`. This module only
 * computes the status.
 */

import type { CompatInfo } from '@hudhud/core';

/**
 * The tested window of the Claude Code adapter.
 *
 * @public
 */
export const CLAUDE_CODE_COMPAT: {
  readonly minTested: string;
  readonly maxTested: string;
  readonly knownBroken: readonly string[];
} = Object.freeze({
  minTested: '2.1.296',
  maxTested: '2.1.296',
  knownBroken: Object.freeze<string[]>([]),
});

/** The harness name of the `compat` event. */
const HARNESS_NAME = 'claude-code';

/**
 * A parsed `major.minor.patch[-prerelease]` version.
 *
 * @internal
 */
export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?$/;
const NUMERIC = /^\d+$/;

/**
 * Parses a version as `claude --version` prints it (no leading `v`, no build
 * metadata). Returns `undefined` for anything else, including empty
 * pre-release identifiers and numeric ones with a leading zero.
 *
 * @internal
 */
export function parseVersion(text: string): ParsedVersion | undefined {
  const match = VERSION.exec(text);
  if (match === null) return undefined;
  const [, major = '', minor = '', patch = '', pre] = match;
  const prerelease = pre === undefined ? [] : pre.split('.');
  if (
    prerelease.some((id) => id === '' || (NUMERIC.test(id) && id.length > 1 && id.startsWith('0')))
  ) {
    return undefined;
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Semver precedence of two parsed versions: negative, zero or positive.
 * A pre-release is lower than its release.
 *
 * @internal
 */
export function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  for (const [i, left] of a.prerelease.entries()) {
    const right = b.prerelease[i];
    if (right === undefined) return 1;
    const order = compareIdentifier(left, right);
    if (order !== 0) return order;
  }
  return a.prerelease.length < b.prerelease.length ? -1 : 0;
}

/**
 * The window to judge against; defaults to {@link CLAUDE_CODE_COMPAT}.
 *
 * @internal
 */
export interface CompatWindow {
  readonly minTested: string;
  readonly maxTested: string;
  readonly knownBroken: readonly string[];
}

/**
 * Whether a version lies in the tested window.
 *
 * - `'known-broken'`: the version is listed in `knownBroken` (exact string),
 *   whatever the window says.
 * - `'tested'`: in `[minTested, maxTested]` by semver precedence.
 * - `'untested'`: anywhere else, or not a parseable version, or a window with
 *   an unparseable bound (fail towards the warning, never towards `tested`).
 *
 * @internal
 */
export function compatStatus(
  version: string,
  window: CompatWindow = CLAUDE_CODE_COMPAT,
): CompatInfo['status'] {
  if (window.knownBroken.includes(version)) return 'known-broken';
  const parsed = parseVersion(version);
  const min = parseVersion(window.minTested);
  const max = parseVersion(window.maxTested);
  if (parsed === undefined || min === undefined || max === undefined) return 'untested';
  return compareParsed(parsed, min) >= 0 && compareParsed(parsed, max) <= 0 ? 'tested' : 'untested';
}

/**
 * The `CompatInfo` of `harness.compat` and the replayed `compat` event for a
 * probed version.
 *
 * @internal
 */
export function claudeCompatInfo(
  version: string,
  window: CompatWindow = CLAUDE_CODE_COMPAT,
): CompatInfo {
  return {
    harness: HARNESS_NAME,
    version,
    minTested: window.minTested,
    maxTested: window.maxTested,
    knownBroken: [...window.knownBroken],
    status: compatStatus(version, window),
  };
}
