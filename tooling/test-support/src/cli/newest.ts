/**
 * Newest-version variant of the CLI fetch for the canary (K16, plan §4.6).
 *
 * "Newest" means the version behind the `latest` dist-tag of
 * `@anthropic-ai/claude-code`: what `npm install` gives users, not the highest
 * version number ever published (pre-release and `next` tags are ignored).
 *
 * Steps: read the platform package's registry document and record its
 * `dist.integrity` before downloading anything; look up the independent
 * digests of the binary in the matching Agent SDK manifest (crosscheck.ts);
 * download the tarball and verify it against the recorded integrity; extract
 * the binary and, when the cross-check is available, require its sha256 and
 * size to match the manifest (fail closed). The record is the trust anchor
 * for the run only: it is written to the job summary for review and to the
 * run-local pin file ({@link runPinFile}) that the integration harness reads
 * under `HUDHUD_CLI_CHANNEL=newest`, and it is never committed (the lead
 * bumps the pin locally with `pnpm cli:bump`, K16, which reuses
 * {@link fetchRecordedCli} for an exact version).
 */

import path from 'node:path';

import { cachePaths, verifyCachedBinary } from './cache.js';
import { sdkCrossCheck } from './crosscheck.js';
import type { CrossCheckSource } from './crosscheck.js';
import { CliFetchError } from './errors.js';
import { installFromRegistry } from './install.js';
import {
  CLI_PACKAGE,
  binaryFileName,
  isValidPlatform,
  isValidVersion,
  platformPackage,
} from './pin.js';
import type { CacheOptions, CliBinary } from './pinned.js';
import { fetchLatest, fetchVersionDocument } from './registry.js';
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
  /**
   * `verified`: sha256 and size equal the matching Agent SDK manifest;
   * `unavailable`: no SDK release bundles this CLI version yet.
   */
  readonly crossCheck: 'verified' | 'unavailable';
  /** The SDK release used, or why the cross-check was unavailable. */
  readonly crossCheckDetail: string;
}

/** Options of {@link fetchRecordedCli}. */
export interface RecordedFetchOptions extends CacheOptions {
  readonly platform: string;
  readonly registry: RegistryOptions;
  readonly now: () => Date;
  /** The exact CLI version to record and fetch. */
  readonly version: string;
  /**
   * The Agent SDK release whose manifest must describe this CLI version
   * (fail closed). Without it the SDK's `latest` is used, and the
   * cross-check is `unavailable` when that bundles another CLI version.
   */
  readonly sdkVersion?: string | undefined;
}

/** The version behind the `latest` dist-tag of the CLI: the canary's "newest". */
export async function newestCliVersion(registry: RegistryOptions): Promise<string> {
  return (await fetchLatest(registry, CLI_PACKAGE)).version;
}

function crossCheckFor(options: RecordedFetchOptions, file: string): Promise<CrossCheckSource> {
  const context = { registry: options.registry, stagingRoot: options.cacheRoot };
  return options.sdkVersion === undefined
    ? sdkCrossCheck(context, options.version, options.platform, file)
    : sdkCrossCheck(context, options.version, options.platform, file, options.sdkVersion);
}

/**
 * Records the registry integrity of `options.version` for `platform`, then
 * fetches, cross-checks and verifies that exact version (always from the
 * registry, never from the cache) and returns the run-local pin with the
 * verified, re-hashed binary.
 */
export async function fetchRecordedCli(
  options: RecordedFetchOptions,
): Promise<{ readonly runPin: RunPin; readonly binary: CliBinary }> {
  if (!isValidPlatform(options.platform)) {
    throw new CliFetchError('platform-unavailable', `unsupported platform ${options.platform}`);
  }
  const { version } = options;
  if (!isValidVersion(version)) {
    throw new CliFetchError('pin-invalid', `not a SemVer version: ${JSON.stringify(version)}`);
  }
  const pkg = platformPackage(options.platform);
  const file = binaryFileName(options.platform);
  const document = await fetchVersionDocument(options.registry, pkg, version);
  const recordedAt = options.now().toISOString();
  const crossCheck = await crossCheckFor(options, file);
  const paths = cachePaths(options.cacheRoot, version, options.platform, file);
  const identity = await installFromRegistry(
    { registry: options.registry, paths, hostPlatform: options.hostPlatform },
    {
      package: pkg,
      version,
      platform: options.platform,
      file,
      integrity: document.integrity,
      ...(crossCheck.status === 'available'
        ? { sha256: crossCheck.sha256, size: crossCheck.size }
        : {}),
    },
    document,
  );
  const verified = await verifyCachedBinary(paths, identity, options.hostPlatform);
  return {
    runPin: {
      ...identity,
      recordedAt,
      crossCheck: crossCheck.status === 'available' ? 'verified' : 'unavailable',
      crossCheckDetail:
        crossCheck.status === 'available'
          ? `${crossCheck.source} manifest.json (SDK integrity ${crossCheck.sdkIntegrity})`
          : crossCheck.reason,
    },
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

/**
 * Fetches the newest published CLI for `platform` ({@link newestCliVersion},
 * then {@link fetchRecordedCli}).
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
  return fetchRecordedCli({ ...options, version: await newestCliVersion(options.registry) });
}

/** File name of the run-local pin inside the cache root. */
export const RUN_PIN_FILE = 'run-pin.json';

/** Where the run-local pin of a cache root lives. */
export function runPinFile(cacheRoot: string): string {
  return path.join(path.resolve(cacheRoot), RUN_PIN_FILE);
}

/**
 * The run-local pin as a `cli-pin.json` document (one version, the fetched
 * platforms), so the integration harness verifies the canary's binary
 * exactly as it verifies the committed pin. The record's time and
 * cross-check go into `$comment`.
 *
 * @throws CliFetchError `pin-invalid` when the pins are empty or name
 *   different versions or the same platform twice.
 */
export function runPinDocument(runPins: readonly RunPin[]): string {
  const [first] = runPins;
  if (first === undefined) throw new CliFetchError('pin-invalid', 'no run-local pin to write');
  const platforms: Record<string, unknown> = {};
  for (const runPin of runPins) {
    if (runPin.version !== first.version) {
      throw new CliFetchError(
        'pin-invalid',
        `run-local pins name ${first.version} and ${runPin.version}`,
      );
    }
    if (runPin.platform in platforms) {
      throw new CliFetchError('pin-invalid', `run-local pin lists ${runPin.platform} twice`);
    }
    platforms[runPin.platform] = {
      package: runPin.package,
      file: runPin.file,
      integrity: runPin.integrity,
      sha256: runPin.sha256,
      size: runPin.size,
    };
  }
  const checks = runPins
    .map((runPin) => `${runPin.platform} ${runPin.crossCheck} (${runPin.crossCheckDetail})`)
    .join('; ');
  const document = {
    $comment: `Run-local pin of the canary (K16), recorded from the registry at ${first.recordedAt}; never committed. Cross-check: ${checks}.`,
    version: first.version,
    platforms,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
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
    `| Cross-check | **${runPin.crossCheck}**: ${runPin.crossCheckDetail} |`,
    '',
  ].join('\n');
}
