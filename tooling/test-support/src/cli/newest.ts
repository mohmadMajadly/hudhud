/**
 * Newest-version variant of the CLI fetch for the canary (K16, plan §4.6).
 *
 * Resolves the version behind the `latest` dist-tag of the CLI package, reads
 * the platform package's registry document and records its `dist.integrity`
 * before downloading anything. The tarball is then verified against that
 * record, exactly like a pinned fetch, and the extracted binary's sha256 and
 * size are recorded into a run-local pin. The record is the trust anchor for
 * the run only; it is written to the job summary for review and never
 * committed (the lead bumps the pin locally, K16).
 */

import { cachePaths, verifyCachedBinary } from './cache.js';
import { installFromRegistry } from './install.js';
import { CLI_PACKAGE, binaryFileName, isValidPlatform, platformPackage } from './pin.js';
import { CliFetchError } from './errors.js';
import type { CacheOptions, CliBinary } from './pinned.js';
import { fetchLatestVersion, fetchVersionDocument } from './registry.js';
import type { RegistryOptions } from './registry.js';

/** The run-local pin of a newest-version fetch. */
export interface RunPin {
  readonly version: string;
  readonly platform: string;
  readonly package: string;
  readonly file: string;
  /** The registry's `dist.integrity`, recorded before the download. */
  readonly integrity: string;
  /** sha256 and size of the extracted binary, recorded after verification. */
  readonly sha256: string;
  readonly size: number;
  /** ISO-8601 time the integrity was recorded. */
  readonly recordedAt: string;
}

/**
 * Fetches the newest published CLI for `platform` (always from the registry,
 * never from the cache) and returns the run-local pin with the verified,
 * re-hashed binary.
 */
export async function fetchNewestCli(
  options: CacheOptions & {
    readonly platform: string;
    readonly registry: RegistryOptions;
    readonly now: () => Date;
  },
): Promise<{ readonly runPin: RunPin; readonly binary: CliBinary }> {
  if (!isValidPlatform(options.platform)) {
    throw new CliFetchError('platform-unavailable', `unsupported platform ${options.platform}`);
  }
  const version = await fetchLatestVersion(options.registry, CLI_PACKAGE);
  const pkg = platformPackage(options.platform);
  const file = binaryFileName(options.platform);
  const document = await fetchVersionDocument(options.registry, pkg, version);
  const recordedAt = options.now().toISOString();
  const paths = cachePaths(options.cacheRoot, version, options.platform, file);
  const identity = await installFromRegistry(
    { registry: options.registry, paths, hostPlatform: options.hostPlatform },
    { package: pkg, version, platform: options.platform, file, integrity: document.integrity },
    document,
  );
  const verified = await verifyCachedBinary(paths, identity, options.hostPlatform);
  return {
    runPin: { ...identity, recordedAt },
    binary: {
      binaryPath: verified.binaryPath,
      version,
      platform: options.platform,
      integrity: identity.integrity,
      sha256: identity.sha256,
      size: identity.size,
      cache: 'fetched',
    },
  };
}

/** A Markdown block for the job summary (`$GITHUB_STEP_SUMMARY`). */
export function runPinSummary(runPin: RunPin): string {
  return [
    `### Newest Claude Code CLI: ${runPin.version} (${runPin.platform})`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Package | \`${runPin.package}@${runPin.version}\` |`,
    `| Registry integrity (recorded ${runPin.recordedAt}) | \`${runPin.integrity}\` |`,
    `| Binary sha256 | \`${runPin.sha256}\` |`,
    `| Binary size | ${String(runPin.size)} |`,
    '',
  ].join('\n');
}
