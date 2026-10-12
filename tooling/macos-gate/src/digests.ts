/**
 * Gate fetch of the darwin CLI binaries (plan Â§4.6, Â§5.4 M1; ADR-0011, K16).
 *
 * The pinned fetch (`tooling/test-support/src/cli/pinned.ts`) refuses
 * platforms marked `pendingGate`, because their digests are not pinned yet.
 * This mode exists for the macOS gate only and reuses the fetcher's modules
 * (registry client, ustar reader, cache, cross-check manifest validation):
 *
 * 1. Read the registry document of the pinned version (registry.npmjs.org
 *    only, canonical tarball URL). Its `dist.integrity` is the npm integrity.
 * 2. Read `manifest.json` of the Agent SDK release that bundles this CLI
 *    version (given explicitly: the SDK's `latest` moves on), verified
 *    against the SDK's own registry integrity. Its `version` must equal the
 *    pinned CLI version and it must list the platform: an unavailable
 *    cross-check fails closed here.
 * 3. Download the platform tarball, require its sha512 to equal the npm
 *    integrity, extract the binary and require its sha256 and size to equal
 *    the manifest's; install it into the gate's own cache and re-hash it.
 * 4. When the pin entry already holds digests, every value must also equal
 *    the pin (`verified-against-pin`); while it is `pendingGate` the digests
 *    are recorded (`recorded`) for the lead to commit (W7-T4).
 *
 * The binary is never executed here.
 */

import path from 'node:path';

import {
  cachePaths,
  createStaging,
  removeStaging,
  verifyCachedBinary,
} from '../../test-support/src/cli/cache.js';
import { manifestEntry, SDK_PACKAGE } from '../../test-support/src/cli/crosscheck.js';
import { CliFetchError } from '../../test-support/src/cli/errors.js';
import {
  extractFromTarball,
  installFromRegistry,
  MAX_TARBALL_BYTES,
  MAX_TRAILING_BYTES,
} from '../../test-support/src/cli/install.js';
import { isValidVersion, parsePin } from '../../test-support/src/cli/pin.js';
import type { CliPin, PinnedBinary } from '../../test-support/src/cli/pin.js';
import { downloadTarball, fetchVersionDocument } from '../../test-support/src/cli/registry.js';
import type { RegistryOptions } from '../../test-support/src/cli/registry.js';

/**
 * The Agent SDK release that bundles CLI 2.1.296 (research 05 Â§1, 01 [SDKPKG]).
 * A different pinned version needs a different SDK version (`--sdk-version`).
 */
export const DEFAULT_SDK_VERSION = '0.3.296';

/** The darwin platforms of the gate (ADR-0014 item 1: both are hashed on every runner). */
export const DARWIN_PLATFORMS = ['darwin-arm64', 'darwin-x64'] as const;

const MANIFEST_ENTRY = 'package/manifest.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SDK_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_SDK_ENTRIES = 256;

/** The independent digests of one platform binary, from the SDK manifest. */
export interface ManifestDigest {
  /** `@anthropic-ai/claude-agent-sdk@<version>`. */
  readonly source: string;
  /** The SDK tarball's registry integrity it was verified against. */
  readonly sdkIntegrity: string;
  readonly sha256: string;
  readonly size: number;
}

/** What the gate observed and verified for one platform. */
export interface GateDigest {
  readonly platform: string;
  readonly package: string;
  readonly version: string;
  readonly file: string;
  /** The registry's `dist.integrity`, equal to the downloaded tarball's sha512. */
  readonly integrity: string;
  readonly sha256: string;
  readonly size: number;
  readonly manifest: ManifestDigest;
  /** `recorded`: the pin entry is `pendingGate`; `verified-against-pin`: it holds equal digests. */
  readonly pinStatus: 'recorded' | 'verified-against-pin';
  readonly recordedAt: string;
}

/** Options of {@link fetchGateBinary}. */
export interface GateFetchOptions {
  readonly pin: CliPin;
  readonly platform: string;
  readonly sdkVersion: string;
  readonly cacheRoot: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly registry: RegistryOptions;
  readonly now: () => Date;
}

/**
 * Reads the `platform` entry of the SDK `manifest.json` of `sdkVersion`,
 * which must describe CLI `cliVersion`. Nothing of the SDK is executed or
 * kept; the staging directory is removed.
 */
export async function sdkManifestDigest(
  options: { readonly registry: RegistryOptions; readonly stagingRoot: string },
  sdkVersion: string,
  cliVersion: string,
  platform: string,
  file: string,
): Promise<ManifestDigest> {
  if (!isValidVersion(sdkVersion)) {
    throw new CliFetchError(
      'cross-check-failed',
      `invalid SDK version ${JSON.stringify(sdkVersion)}`,
    );
  }
  const source = `${SDK_PACKAGE}@${sdkVersion}`;
  const document = await fetchVersionDocument(options.registry, SDK_PACKAGE, sdkVersion);
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
    const entry = manifestEntry(manifest, cliVersion, platform, file, source);
    return { source, sdkIntegrity: document.integrity, ...entry };
  } finally {
    await removeStaging(staging);
  }
}

/**
 * Fetches and verifies the binary of `platform` for the gate (see the module
 * comment) and returns its digests and the verified path in the gate cache.
 */
export async function fetchGateBinary(
  options: GateFetchOptions,
): Promise<{ readonly digest: GateDigest; readonly binaryPath: string }> {
  const { pin, platform } = options;
  const entry = pin.platforms.get(platform);
  if (entry === undefined) {
    throw new CliFetchError('platform-unavailable', `no pin entry for platform ${platform}`);
  }
  const pinned: PinnedBinary | undefined = 'pendingGate' in entry ? undefined : entry;
  const document = await fetchVersionDocument(options.registry, entry.package, pin.version);
  if (pinned !== undefined && document.integrity !== pinned.integrity) {
    throw new CliFetchError(
      'integrity-mismatch',
      `${entry.package}@${pin.version}: the registry states ${document.integrity}, the pin ${pinned.integrity}`,
    );
  }
  const manifest = await sdkManifestDigest(
    { registry: options.registry, stagingRoot: options.cacheRoot },
    options.sdkVersion,
    pin.version,
    platform,
    entry.file,
  );
  if (
    pinned !== undefined &&
    (manifest.sha256 !== pinned.sha256 || manifest.size !== pinned.size)
  ) {
    throw new CliFetchError(
      'cross-check-failed',
      `${manifest.source} manifest.json disagrees with the pin for ${platform}`,
    );
  }
  const paths = cachePaths(options.cacheRoot, pin.version, platform, entry.file);
  const identity = await installFromRegistry(
    { registry: options.registry, paths, hostPlatform: options.hostPlatform },
    {
      package: entry.package,
      version: pin.version,
      platform,
      file: entry.file,
      integrity: document.integrity,
      sha256: manifest.sha256,
      size: manifest.size,
    },
    document,
  );
  const verified = await verifyCachedBinary(paths, identity, options.hostPlatform);
  return {
    binaryPath: verified.binaryPath,
    digest: {
      platform,
      package: entry.package,
      version: pin.version,
      file: entry.file,
      integrity: identity.integrity,
      sha256: verified.sha256,
      size: verified.size,
      manifest,
      pinStatus: pinned === undefined ? 'recorded' : 'verified-against-pin',
      recordedAt: options.now().toISOString(),
    },
  };
}

/** The digest record the gate writes (`digests.json`). */
export interface DigestRecord {
  readonly schema: 'hudhud-macos-gate-digests/1';
  readonly version: string;
  /** Entries in the exact shape of `tooling/cli-pin.json` platforms, ready for W7-T4. */
  readonly platforms: Readonly<Record<string, PinnedBinary>>;
  /** Where each value was verified. */
  readonly provenance: Readonly<
    Record<
      string,
      {
        readonly npmIntegrity: string;
        readonly manifest: ManifestDigest;
        readonly pinStatus: GateDigest['pinStatus'];
        readonly recordedAt: string;
      }
    >
  >;
}

/**
 * Builds the digest record of a run. Every digest must be for `version`, and
 * the result must be accepted by the pin parser, so it can be committed as is.
 */
export function digestRecord(version: string, digests: readonly GateDigest[]): DigestRecord {
  const platforms: Record<string, PinnedBinary> = {};
  const provenance: Record<string, DigestRecord['provenance'][string]> = {};
  for (const digest of digests) {
    if (digest.version !== version) {
      throw new Error(`digest of ${digest.platform} is for ${digest.version}, not ${version}`);
    }
    platforms[digest.platform] = {
      package: digest.package,
      file: digest.file,
      integrity: digest.integrity,
      sha256: digest.sha256,
      size: digest.size,
    };
    provenance[digest.platform] = {
      npmIntegrity: digest.integrity,
      manifest: digest.manifest,
      pinStatus: digest.pinStatus,
      recordedAt: digest.recordedAt,
    };
  }
  // Fails when an entry would not be a valid pin entry (pattern, package, file).
  parsePin({ version, platforms }, 'digest record');
  return { schema: 'hudhud-macos-gate-digests/1', version, platforms, provenance };
}
