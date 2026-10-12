/**
 * Fetch, verify and cache the pinned Claude Code CLI (plan §4.6, ADR-0013
 * §9). The binary is fetched at test time only and never redistributed
 * (ADR-0015); it is never executed here.
 *
 * Every value is checked against the pin, never against what the registry
 * just said: the registry's `dist.integrity` must equal the pinned one, the
 * downloaded tarball's sha512 must equal the pinned integrity, and the
 * extracted binary's sha256 and size must equal the pinned ones.
 */

import { cachePaths, verifyCachedBinary } from './cache.js';
import type { CacheIdentity, CachePaths } from './cache.js';
import { CliFetchError } from './errors.js';
import { installFromRegistry } from './install.js';
import { requirePinned } from './pin.js';
import type { CliPin } from './pin.js';
import { fetchVersionDocument } from './registry.js';
import type { RegistryOptions } from './registry.js';

/** A verified CLI binary in the cache. */
export interface CliBinary {
  /** Absolute path of the verified binary inside the cache. */
  readonly binaryPath: string;
  readonly version: string;
  readonly platform: string;
  readonly integrity: string;
  readonly sha256: string;
  readonly size: number;
  /** `hit`: the cached copy re-verified; `fetched`: downloaded in this call. */
  readonly cache: 'hit' | 'fetched';
}

/** Where the cache lives and how the host checks file modes. */
export interface CacheOptions {
  readonly cacheRoot: string;
  /** Host platform for the POSIX mode checks; `process.platform` in production. */
  readonly hostPlatform: NodeJS.Platform;
}

function pinnedIdentity(
  pin: CliPin,
  platform: string,
): { identity: CacheIdentity; paths: (root: string) => CachePaths } {
  const entry = requirePinned(pin, platform);
  const identity: CacheIdentity = {
    package: entry.package,
    version: pin.version,
    platform,
    file: entry.file,
    integrity: entry.integrity,
    sha256: entry.sha256,
    size: entry.size,
  };
  return { identity, paths: (root) => cachePaths(root, pin.version, platform, entry.file) };
}

function result(identity: CacheIdentity, binaryPath: string, cache: CliBinary['cache']): CliBinary {
  return {
    binaryPath,
    version: identity.version,
    platform: identity.platform,
    integrity: identity.integrity,
    sha256: identity.sha256,
    size: identity.size,
    cache,
  };
}

/**
 * Re-verifies the cached pinned binary of `platform` without any network
 * access (each test session calls this). Throws {@link CliFetchError}
 * `cache-invalid` when it is missing or does not verify.
 */
export async function verifyPinnedCli(
  options: CacheOptions & { readonly pin: CliPin; readonly platform: string },
): Promise<CliBinary> {
  const { identity, paths } = pinnedIdentity(options.pin, options.platform);
  const verified = await verifyCachedBinary(
    paths(options.cacheRoot),
    identity,
    options.hostPlatform,
  );
  return result(identity, verified.binaryPath, 'hit');
}

/**
 * Returns the verified pinned binary of `platform`, fetching it when the
 * cache does not hold a copy that verifies. The installed copy is re-hashed
 * before it is returned.
 */
export async function ensurePinnedCli(
  options: CacheOptions & {
    readonly pin: CliPin;
    readonly platform: string;
    readonly registry: RegistryOptions;
  },
): Promise<CliBinary> {
  const { identity, paths: pathsFor } = pinnedIdentity(options.pin, options.platform);
  const paths = pathsFor(options.cacheRoot);
  try {
    const cached = await verifyCachedBinary(paths, identity, options.hostPlatform);
    return result(identity, cached.binaryPath, 'hit');
  } catch (error) {
    if (!(error instanceof CliFetchError)) throw error;
  }
  const document = await fetchVersionDocument(options.registry, identity.package, identity.version);
  if (document.integrity !== identity.integrity) {
    throw new CliFetchError(
      'integrity-mismatch',
      `${identity.package}@${identity.version}: the registry states ${document.integrity}, the pin ${identity.integrity}`,
    );
  }
  await installFromRegistry(
    { registry: options.registry, paths, hostPlatform: options.hostPlatform },
    identity,
    document,
  );
  const installed = await verifyCachedBinary(paths, identity, options.hostPlatform);
  return result(identity, installed.binaryPath, 'fetched');
}
