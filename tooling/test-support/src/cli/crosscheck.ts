/**
 * Independent cross-check of a newest-version CLI binary (K16, research 05
 * §1): the Agent SDK package that bundles the same CLI version ships a
 * `manifest.json` with the sha256 and size of every platform binary.
 *
 * The SDK tarball goes through the same registry rules as the CLI (allowlisted
 * host, canonical tarball URL, sha512 against the registry's integrity) and the
 * same ustar reader. Only `package/manifest.json` is read, into memory, and
 * parsed as JSON data: nothing of the SDK is executed, imported or written
 * outside the staging directory, which is removed afterwards, and nothing is
 * copied into the repository (ADR-0015).
 *
 * The SDK publishes after the CLI. When the SDK's `latest` does not bundle the
 * CLI version under test, the cross-check is `unavailable` (recorded, not a
 * failure). A manifest that exists but disagrees fails closed.
 */

import path from 'node:path';

import { createStaging, removeStaging } from './cache.js';
import { CliFetchError } from './errors.js';
import { MAX_TRAILING_BYTES, MAX_TARBALL_BYTES, extractFromTarball } from './install.js';
import { isValidSha256, isValidSize, isValidVersion } from './pin.js';
import { downloadTarball, fetchLatest, fetchVersionDocument } from './registry.js';
import type { RegistryOptions } from './registry.js';

/** The npm package whose manifest serves as the independent digest source. */
export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const MANIFEST_ENTRY = 'package/manifest.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
/** The SDK ships bundled JavaScript entries of a few MiB each. */
const MAX_SDK_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_SDK_ENTRIES = 256;

/** Outcome of the cross-check source lookup. */
export type CrossCheckSource =
  | {
      readonly status: 'available';
      /** `@anthropic-ai/claude-agent-sdk@<version>`. */
      readonly source: string;
      /** The SDK tarball's registry integrity it was verified against. */
      readonly sdkIntegrity: string;
      /** Expected sha256 and size of the CLI binary, from the manifest. */
      readonly sha256: string;
      readonly size: number;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

function failed(message: string): CliFetchError {
  return new CliFetchError('cross-check-failed', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a parsed SDK manifest and returns the entry of `platform`. */
export function manifestEntry(
  manifest: unknown,
  cliVersion: string,
  platform: string,
  file: string,
  source: string,
): { readonly sha256: string; readonly size: number } {
  if (!isRecord(manifest) || manifest['version'] !== cliVersion) {
    throw failed(`${source} manifest.json is not for CLI ${cliVersion}`);
  }
  const platforms = manifest['platforms'];
  const entry = isRecord(platforms) ? platforms[platform] : undefined;
  if (!isRecord(entry)) throw failed(`${source} manifest.json has no ${platform} entry`);
  const { binary, checksum, size } = entry;
  if (
    binary !== file ||
    typeof checksum !== 'string' ||
    !isValidSha256(checksum) ||
    !isValidSize(size)
  ) {
    throw failed(`${source} manifest.json has a malformed ${platform} entry`);
  }
  return { sha256: checksum, size };
}

/** An available cross-check. */
export type AvailableCrossCheck = Extract<CrossCheckSource, { readonly status: 'available' }>;

/** Where {@link sdkCrossCheck} reads and stages. */
export interface CrossCheckOptions {
  readonly registry: RegistryOptions;
  readonly stagingRoot: string;
}

/**
 * Looks up the independent digests of the `platform` binary of CLI
 * `cliVersion` in the matching Agent SDK manifest.
 *
 * Without `sdkVersion` (the canary), the SDK's `latest` release is used and
 * the cross-check is `unavailable` when it bundles another CLI version.
 * With an explicit `sdkVersion` (the macOS gate, whose pinned CLI is older
 * than the SDK's `latest`), that release is read and must describe
 * `cliVersion` and `platform`: the cross-check is then available or fails
 * closed.
 */
export function sdkCrossCheck(
  options: CrossCheckOptions,
  cliVersion: string,
  platform: string,
  file: string,
): Promise<CrossCheckSource>;
export function sdkCrossCheck(
  options: CrossCheckOptions,
  cliVersion: string,
  platform: string,
  file: string,
  sdkVersion: string,
): Promise<AvailableCrossCheck>;
export async function sdkCrossCheck(
  options: CrossCheckOptions,
  cliVersion: string,
  platform: string,
  file: string,
  sdkVersion?: string,
): Promise<CrossCheckSource> {
  let version: string;
  if (sdkVersion === undefined) {
    const latest = await fetchLatest(options.registry, SDK_PACKAGE);
    if (latest.claudeCodeVersion !== cliVersion) {
      return {
        status: 'unavailable',
        reason: `${SDK_PACKAGE}@${latest.version} (latest) bundles CLI ${latest.claudeCodeVersion ?? 'unknown'}, not ${cliVersion}`,
      };
    }
    version = latest.version;
  } else {
    if (!isValidVersion(sdkVersion)) {
      throw failed(`invalid SDK version ${JSON.stringify(sdkVersion)}`);
    }
    version = sdkVersion;
  }
  const source = `${SDK_PACKAGE}@${version}`;
  const document = await fetchVersionDocument(options.registry, SDK_PACKAGE, version);
  const staging = await createStaging(options.stagingRoot);
  try {
    const tgz = path.join(staging, 'sdk.tgz');
    const downloaded = await downloadTarball(
      options.registry,
      document.tarball,
      tgz,
      MAX_TARBALL_BYTES,
    );
    if (downloaded.integrity !== document.integrity) {
      throw new CliFetchError(
        'integrity-mismatch',
        `${source}: tarball ${downloaded.integrity}, registry ${document.integrity}`,
      );
    }
    const chunks: Uint8Array[] = [];
    await extractFromTarball(tgz, source, {
      wanted: MANIFEST_ENTRY,
      maxWantedSize: MAX_MANIFEST_BYTES,
      maxOtherSize: MAX_SDK_ENTRY_BYTES,
      maxEntries: MAX_SDK_ENTRIES,
      maxTrailingBytes: MAX_TRAILING_BYTES,
      onData: (chunk) => {
        chunks.push(chunk.slice());
      },
    });
    let manifest: unknown;
    try {
      manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      throw new CliFetchError('cross-check-failed', `${source} manifest.json is not JSON`, {
        cause: error,
      });
    }
    const expected = manifestEntry(manifest, cliVersion, platform, file, source);
    return { status: 'available', source, sdkIntegrity: document.integrity, ...expected };
  } finally {
    await removeStaging(staging);
  }
}
