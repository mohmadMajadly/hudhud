/**
 * Download, verify, extract and install one CLI binary (plan §4.6 steps 2-4),
 * shared by the pinned fetch and the newest-version canary.
 *
 * Order, fail closed at each step: download the tarball into its own staging
 * directory; compare its sha512 with the expected integrity before reading a
 * single byte of it; gunzip and extract only `package/<file>` with the in-repo
 * ustar reader; compare sha256 and size when they are known; install
 * atomically. The binary is never executed, and no archive path is ever used
 * to build a file path.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, open } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { createStaging, installBinary, removeStaging } from './cache.js';
import type { CacheIdentity, CachePaths } from './cache.js';
import { CliFetchError } from './errors.js';
import { MAX_BINARY_BYTES } from './pin.js';
import { downloadTarball } from './registry.js';
import type { RegistryOptions, VersionDocument } from './registry.js';
import { extractTarEntry } from './tar.js';

/** Upper bound for a platform tarball (the 2.1.296 tarballs are ~80-90 MiB). */
export const MAX_TARBALL_BYTES: number = 512 * 1024 * 1024;

/** Limits for the non-binary entries of a platform package (README, LICENSE, package.json). */
const MAX_OTHER_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 64;
const MAX_TRAILING_BYTES = 1024 * 1024;

/** What to install; `sha256` and `size` are checked when given (pinned mode). */
export interface InstallTarget {
  readonly package: string;
  readonly version: string;
  readonly platform: string;
  readonly file: string;
  /** Integrity the tarball must have: the pin's, or the one recorded from the registry. */
  readonly integrity: string;
  readonly sha256?: string;
  readonly size?: number;
}

/** Inputs shared by every install. */
export interface InstallContext {
  readonly registry: RegistryOptions;
  readonly paths: CachePaths;
  readonly hostPlatform: NodeJS.Platform;
}

/** Extracts `package/<file>` of the gzipped tarball `tgz` into the new file `out`. */
async function extractBinary(
  tgz: string,
  out: string,
  target: InstallTarget,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const hash = createHash('sha256');
  const handle = await open(out, 'wx', 0o700);
  let size = 0;
  try {
    await pipeline(
      createReadStream(tgz),
      createGunzip(),
      async (source: AsyncIterable<Uint8Array>) => {
        ({ size } = await extractTarEntry(source, {
          wanted: `package/${target.file}`,
          ...(target.size === undefined ? {} : { expectedSize: target.size }),
          maxWantedSize: MAX_BINARY_BYTES,
          maxOtherSize: MAX_OTHER_ENTRY_BYTES,
          maxEntries: MAX_ENTRIES,
          maxTrailingBytes: MAX_TRAILING_BYTES,
          onData: async (chunk) => {
            hash.update(chunk);
            await handle.write(chunk);
          },
        }));
      },
    );
    await handle.sync();
  } catch (error) {
    if (error instanceof CliFetchError) throw error;
    throw new CliFetchError('archive-refused', `${target.package}: unreadable tarball`, {
      cause: error,
    });
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Fetches `document.tarball`, verifies it against `target.integrity`, extracts
 * and checks the binary and installs it with its stamp. Returns the identity
 * that was installed (sha256 and size as extracted).
 */
export async function installFromRegistry(
  context: InstallContext,
  target: InstallTarget,
  document: VersionDocument,
): Promise<CacheIdentity> {
  const staging = await createStaging(context.paths.root);
  try {
    const tgz = path.join(staging, 'package.tgz');
    const downloaded = await downloadTarball(
      context.registry,
      document.tarball,
      tgz,
      MAX_TARBALL_BYTES,
    );
    if (downloaded.integrity !== target.integrity) {
      throw new CliFetchError(
        'integrity-mismatch',
        `${target.package}@${target.version}: tarball ${downloaded.integrity}, expected ${target.integrity}`,
      );
    }
    const staged = path.join(staging, target.file);
    const extracted = await extractBinary(tgz, staged, target);
    // The size was enforced by the tar reader (`expectedSize`) before any byte was written.
    if (target.sha256 !== undefined && extracted.sha256 !== target.sha256) {
      throw new CliFetchError(
        'binary-mismatch',
        `${target.package}@${target.version}: binary sha256 ${extracted.sha256}, expected ${target.sha256}`,
      );
    }
    await chmod(staged, 0o755);
    const identity: CacheIdentity = {
      package: target.package,
      version: target.version,
      platform: target.platform,
      file: target.file,
      integrity: target.integrity,
      sha256: extracted.sha256,
      size: extracted.size,
    };
    await installBinary(staged, context.paths, identity, context.hostPlatform);
    return identity;
  } finally {
    await removeStaging(staging);
  }
}
