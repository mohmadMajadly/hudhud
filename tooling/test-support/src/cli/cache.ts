/**
 * The binary cache of the pinned-CLI fetch (plan §4.6 steps 4-5):
 * `<root>/<version>/<platform>/<file>` plus a `verified.json` stamp.
 *
 * - Directories are created owner-only; the version and platform directories
 *   must be real directories (not links) and, on POSIX, not group- or
 *   world-writable. The root itself is the caller's choice.
 * - Installation is atomic: the binary is staged in the same file system and
 *   renamed into place; the stamp is written to a temporary file and renamed.
 * - A cached binary is never trusted without re-hashing it on every use. The
 *   hash is taken through one open descriptor whose identity (device, inode)
 *   must equal the path's before and after hashing, and whose size and mtime
 *   must not change while hashing, so a swap during verification is detected.
 *   What remains is inherent to spawning by path: an attacker who can write
 *   the owner-only cache directory after verification can replace the file.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CliFetchError } from './errors.js';

const STAMP_FILE = 'verified.json';
const MAX_STAMP_BYTES = 4096;
const HASH_BUFFER_BYTES = 1024 * 1024;

/** File locations of one cached binary. */
export interface CachePaths {
  readonly root: string;
  readonly versionDir: string;
  readonly platformDir: string;
  readonly binary: string;
  readonly stamp: string;
}

/** Everything a cached binary is verified against; also the stamp's content. */
export interface CacheIdentity {
  readonly package: string;
  readonly version: string;
  readonly platform: string;
  readonly file: string;
  /** The tarball integrity the binary was extracted from. */
  readonly integrity: string;
  readonly sha256: string;
  readonly size: number;
}

/** A binary that passed verification just now. */
export interface VerifiedBinary {
  readonly binaryPath: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * Cache locations. `version`, `platform` and `file` must already be validated
 * (pin.ts patterns); they are single path segments by construction.
 */
export function cachePaths(
  root: string,
  version: string,
  platform: string,
  file: string,
): CachePaths {
  const resolved = path.resolve(root);
  const versionDir = path.join(resolved, version);
  const platformDir = path.join(versionDir, platform);
  return {
    root: resolved,
    versionDir,
    platformDir,
    binary: path.join(platformDir, file),
    stamp: path.join(platformDir, STAMP_FILE),
  };
}

function invalid(message: string, cause?: unknown): CliFetchError {
  return new CliFetchError('cache-invalid', message, cause === undefined ? undefined : { cause });
}

async function lstatOrInvalid(file: string): Promise<BigIntStats> {
  try {
    return await lstat(file, { bigint: true });
  } catch (error) {
    throw invalid(`${file}: not cached`, error);
  }
}

function checkMode(file: string, stats: BigIntStats, hostPlatform: NodeJS.Platform): void {
  if (hostPlatform !== 'win32' && (stats.mode & 0o022n) !== 0n) {
    throw invalid(`${file}: group- or world-writable`);
  }
}

async function checkDirectory(dir: string, hostPlatform: NodeJS.Platform): Promise<void> {
  const stats = await lstatOrInvalid(dir);
  if (!stats.isDirectory()) throw invalid(`${dir}: not a directory (links are refused)`);
  checkMode(dir, stats, hostPlatform);
}

async function readStamp(file: string): Promise<unknown> {
  const stats = await lstatOrInvalid(file);
  if (!stats.isFile() || stats.size > BigInt(MAX_STAMP_BYTES)) {
    throw invalid(`${file}: not a regular stamp file`);
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw invalid(`${file}: unreadable stamp`, error);
  }
}

const IDENTITY_KEYS = [
  'package',
  'version',
  'platform',
  'file',
  'integrity',
  'sha256',
  'size',
] as const;

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Re-verifies a cached binary against `expected`: directory shape, stamp,
 * file type, size and a fresh sha256 (see the module comment for the swap
 * checks). Throws {@link CliFetchError} `cache-invalid` on any deviation,
 * including a missing cache.
 */
export async function verifyCachedBinary(
  paths: CachePaths,
  expected: CacheIdentity,
  hostPlatform: NodeJS.Platform,
): Promise<VerifiedBinary> {
  await checkDirectory(paths.versionDir, hostPlatform);
  await checkDirectory(paths.platformDir, hostPlatform);
  const stamp = await readStamp(paths.stamp);
  for (const key of IDENTITY_KEYS) {
    if (typeof stamp !== 'object' || stamp === null || Reflect.get(stamp, key) !== expected[key]) {
      throw invalid(`${paths.stamp}: stamp does not match the expected ${key}`);
    }
  }
  const before = await lstatOrInvalid(paths.binary);
  if (!before.isFile()) throw invalid(`${paths.binary}: not a regular file (links are refused)`);
  checkMode(paths.binary, before, hostPlatform);
  if (before.size !== BigInt(expected.size)) {
    throw invalid(
      `${paths.binary}: ${String(before.size)} bytes, expected ${String(expected.size)}`,
    );
  }
  const handle = await open(paths.binary, 'r');
  let digest: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(opened, before)) throw invalid(`${paths.binary}: replaced while opening`);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(HASH_BUFFER_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    digest = hash.digest('hex');
    const after = await handle.stat({ bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
      throw invalid(`${paths.binary}: modified while hashing`);
    }
  } finally {
    await handle.close();
  }
  const current = await lstatOrInvalid(paths.binary);
  if (!sameFile(current, before)) throw invalid(`${paths.binary}: replaced while hashing`);
  if (digest !== expected.sha256) {
    throw invalid(`${paths.binary}: sha256 ${digest}, expected ${expected.sha256}`);
  }
  return { binaryPath: paths.binary, sha256: digest, size: expected.size };
}

/**
 * A new, empty, owner-only staging directory for untrusted downloads, inside
 * the cache root so the final rename stays on one file system.
 */
export async function createStaging(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(root, '.staging-'));
}

/** Removes a staging directory and everything in it. */
export async function removeStaging(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Moves a verified staged binary into the cache atomically and writes its
 * stamp. The staged file must be in the same file system (see
 * {@link createStaging}).
 */
export async function installBinary(
  staged: string,
  paths: CachePaths,
  identity: CacheIdentity,
  hostPlatform: NodeJS.Platform,
): Promise<void> {
  await mkdir(paths.platformDir, { recursive: true, mode: 0o700 });
  await checkDirectory(paths.versionDir, hostPlatform);
  await checkDirectory(paths.platformDir, hostPlatform);
  await rm(paths.stamp, { force: true });
  try {
    await rename(staged, paths.binary);
  } catch (error) {
    throw invalid(
      `${paths.binary}: cannot replace the cached binary (is a process still using it?)`,
      error,
    );
  }
  const stamp: Record<string, string | number> = { schema: 1 };
  for (const key of IDENTITY_KEYS) stamp[key] = identity[key];
  const temporary = `${paths.stamp}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stamp, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  await rename(temporary, paths.stamp);
}
