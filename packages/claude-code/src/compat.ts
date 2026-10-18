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
 * Rolling window (ADR-0004 §4, amendment of 2026-10-18): `maxTested` is the
 * pin, the newest admitted version; `minTested` is the oldest version still
 * kept; every published release between them was admitted (the integration
 * suite green against it on Linux, Windows and macOS) and has its digests in
 * `KNOWN_BINARIES`.
 *
 * Policy (ADR-0004 §4 and its amendment, plan §1.8): the status goes into
 * the `compat` event and `harness.compat`, and an `'untested'` status also
 * into the session diagnostic `compat.untested`. A version outside the
 * window, or one that cannot be parsed, is `'untested'`: reported, never
 * refused (a daily-moving CLI would make hudhud unusable between canary
 * runs). A version
 * listed in `knownBroken` is `'known-broken'`: `connect` refuses it with
 * `HARNESS_VERSION_KNOWN_BROKEN` unless the application sets
 * `claudeCode.dangerouslyAllowKnownBrokenVersion: true`, and a session whose
 * harness drifted to such a version fails its handshake the same way (W5
 * ruling 1). This module only computes the status and holds the listings.
 *
 * Every listing carries a committed reason ({@link CLAUDE_CODE_KNOWN_BROKEN});
 * `knownBroken` is derived from it, so a version cannot be listed without one,
 * and {@link checkKnownBrokenListings} (run by a unit test) refuses an empty,
 * oversized or control-character reason, a duplicate or an unparseable
 * version. The reason is what `details.reason` of the refusal carries; harness
 * output never is.
 */

import type { CompatInfo } from '@hudhudjs/core';

import type { KnownBrokenListing } from './protocol/machine/index.js';

export type { KnownBrokenListing } from './protocol/machine/index.js';

/**
 * The known-broken Claude Code versions, each with the committed reason of
 * its listing (ADR-0004 §4 amendment). Changed only by a reviewed commit.
 *
 * @internal
 */
export const CLAUDE_CODE_KNOWN_BROKEN: readonly KnownBrokenListing[] = Object.freeze([]);

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
  maxTested: '2.1.302',
  knownBroken: Object.freeze(listedVersions(CLAUDE_CODE_KNOWN_BROKEN)),
});

/**
 * The versions of the listings, in order.
 *
 * @internal
 */
export function listedVersions(listings: readonly KnownBrokenListing[]): string[] {
  return listings.map((listing) => listing.version);
}

/**
 * The window plus the listings: what `connect` judges a probed version by.
 *
 * @internal
 */
export interface CompatPolicy {
  readonly minTested: string;
  readonly maxTested: string;
  readonly knownBroken: readonly KnownBrokenListing[];
}

/**
 * The policy of this adapter: {@link CLAUDE_CODE_COMPAT} with its listings.
 *
 * @internal
 */
export const CLAUDE_CODE_COMPAT_POLICY: CompatPolicy = Object.freeze({
  minTested: CLAUDE_CODE_COMPAT.minTested,
  maxTested: CLAUDE_CODE_COMPAT.maxTested,
  knownBroken: CLAUDE_CODE_KNOWN_BROKEN,
});

/**
 * The {@link CompatWindow} of a policy.
 *
 * @internal
 */
export function windowOf(policy: CompatPolicy): CompatWindow {
  return {
    minTested: policy.minTested,
    maxTested: policy.maxTested,
    knownBroken: listedVersions(policy.knownBroken),
  };
}

/** Longest committed reason. */
export const MAX_KNOWN_BROKEN_REASON_LENGTH = 512;

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Checks the listings: each version parses and is listed once, each reason
 * is non-empty after trimming, at most {@link MAX_KNOWN_BROKEN_REASON_LENGTH}
 * characters and free of control characters.
 *
 * @throws TypeError naming the first bad listing
 * @internal
 */
export function checkKnownBrokenListings(listings: readonly KnownBrokenListing[]): void {
  const seen = new Set<string>();
  listings.forEach((listing, index) => {
    const at = `known-broken listing ${String(index)}`;
    if (parseVersion(listing.version) === undefined) {
      throw new TypeError(`${at}: the version does not parse`);
    }
    if (seen.has(listing.version)) throw new TypeError(`${at}: the version is listed twice`);
    seen.add(listing.version);
    const reason = listing.reason;
    if (
      reason.trim() === '' ||
      reason.length > MAX_KNOWN_BROKEN_REASON_LENGTH ||
      CONTROL.test(reason)
    ) {
      throw new TypeError(`${at}: the version needs a committed reason (one line of text)`);
    }
  });
}

/**
 * The listing of a version, or `undefined` when it is not listed.
 *
 * @internal
 */
export function knownBrokenListing(
  version: string,
  policy: CompatPolicy = CLAUDE_CODE_COMPAT_POLICY,
): KnownBrokenListing | undefined {
  return policy.knownBroken.find((listing) => listing.version === version);
}

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
