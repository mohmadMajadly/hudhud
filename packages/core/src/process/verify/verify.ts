/**
 * Binary verification (ADR-0011 "Binary provenance", K8, K9, plan §1.7,
 * §1.8).
 *
 * @remarks
 * Guarantees of {@link verifyBinary}:
 *
 * - `'advisory'` (the default of the adapters) reads the file and compares
 *   its SHA-256 with the digest table it is given, and does nothing else: it
 *   starts no process (no PowerShell, no `codesign`, never the binary).
 * - `'strict'` first runs the OS signature check (`os-signature.ts`), then
 *   the digest table. A signature that is not valid is `failed` and the
 *   digest is not computed.
 * - The digest is bound to the identity of the file it was computed from
 *   (`sha256File`: device and inode or volume and file index, size, mtime,
 *   from the same handle). That identity must equal the one of the resolved
 *   executable (and, in strict mode, the one read before the signature
 *   check); otherwise the file changed during verification and
 *   {@link BinaryChangedError} is thrown, so a verdict is never reported for
 *   other bytes than the ones checked.
 * - Results are cached per realpath, size, mtime, mode and digest table in a
 *   {@link VerificationCache} (one per Harness, plan §1.8); a hit is used only
 *   after the file identity was read again and still matches.
 *
 * Before anything spawns the binary, {@link assertSpawnable} refuses a
 * strict result that is not `verified` and re-reads the identity (realpath
 * and `stat`) against the verified one ({@link recheckBinary}).
 *
 * Residual (TOCTOU, documented): Node cannot spawn from an open handle, so
 * the path is opened again by the OS at spawn. A replacement between the
 * last identity check and the spawn, or a same-size rewrite within one mtime
 * tick that keeps the file id, is not detected. Writing the binary's
 * directory requires the rights of the user who installed it.
 *
 * @packageDocumentation
 */

import { realpath, stat } from 'node:fs/promises';
import process from 'node:process';

import type { ResolvedExecutable } from '../binary-path.js';
import type { FileIdentity } from '../cwd.js';
import { sha256File, type FileDigest } from '../hash.js';
import {
  checkOsSignature,
  nodeSignatureDeps,
  signaturePlatformOf,
  type SignatureDeps,
  type SignaturePlatform,
} from './os-signature.js';

/**
 * `'advisory'` never blocks and runs no process; `'strict'` refuses anything
 * that is not `verified` (K9).
 *
 * @public
 */
export type VerificationMode = 'advisory' | 'strict';

/**
 * The verification verdict (plan §2.2).
 *
 * @public
 */
export interface BinaryVerification {
  readonly status: 'verified' | 'unverified' | 'failed';
  /**
   * What decided the status: `os-signature` when the signature check failed,
   * `sha256-manifest` when the digest table was compared, `none` when the
   * table had nothing to compare with.
   */
  readonly method: 'os-signature' | 'sha256-manifest' | 'none';
  readonly mode: VerificationMode;
  /** Human-readable reason; names versions and checks, never secrets. */
  readonly detail?: string;
}

/**
 * One known digest of a harness binary for the host platform.
 *
 * @public
 */
export interface KnownDigest {
  readonly version: string;
  /** SHA-256, 64 lower-case hex characters. */
  readonly sha256: string;
  /** File size in bytes, when known; must then match as well. */
  readonly size?: number;
}

/**
 * The identity of a file, as `sha256File` reports it.
 *
 * @public
 */
export interface BinaryIdentity {
  /** `<dev>:<ino>` (POSIX) or `<volume serial>:<file index>` (win32). */
  readonly fileId: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * A verified (or rejected) binary: the verdict bound to the file identity.
 *
 * @public
 */
export interface VerifiedBinary extends BinaryIdentity {
  /** The realpath that was verified; the only path to spawn. */
  readonly path: string;
  /** The SHA-256 of the verified bytes; absent when a strict signature check failed first. */
  readonly sha256?: string;
  readonly verification: BinaryVerification;
  /** The version of the digest-table entry that matched. */
  readonly matchedVersion?: string;
}

/**
 * The file changed between resolution, verification and spawn.
 *
 * @public
 */
export class BinaryChangedError extends Error {
  override readonly name = 'BinaryChangedError';
  readonly code = 'BINARY_CHANGED';
  readonly path: string;

  constructor(filePath: string, options?: { readonly cause?: unknown }) {
    super(`${JSON.stringify(filePath)} changed after it was resolved or verified`, options);
    this.path = filePath;
  }
}

/**
 * Strict mode refused to run a binary whose status is not `verified`. The
 * adapter maps it to the public `BinaryVerificationError`
 * (`BINARY_VERIFICATION_FAILED`).
 *
 * @public
 */
export class BinaryNotVerifiedError extends Error {
  override readonly name = 'BinaryNotVerifiedError';
  readonly code = 'BINARY_VERIFICATION_FAILED';
  readonly path: string;
  readonly verification: BinaryVerification;

  constructor(binary: VerifiedBinary) {
    super(
      `refusing to run ${JSON.stringify(binary.path)}: verification ${binary.verification.status}` +
        (binary.verification.detail === undefined ? '' : ` (${binary.verification.detail})`),
    );
    this.path = binary.path;
    this.verification = binary.verification;
  }
}

/**
 * Filesystem calls used to read a file identity again.
 *
 * @public
 */
export interface IdentityFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileIdentity>;
}

const nodeIdentityFs: IdentityFs = {
  realpath: (value) => realpath(value),
  stat: (value) => stat(value, { bigint: true }),
};

/**
 * Per-Harness cache of verification results (plan §1.8).
 *
 * @public
 */
export class VerificationCache {
  readonly #entries = new Map<string, VerifiedBinary>();

  /** Number of cached results. */
  get size(): number {
    return this.#entries.size;
  }

  /** @internal */
  get(key: string): VerifiedBinary | undefined {
    return this.#entries.get(key);
  }

  /** @internal */
  set(key: string, value: VerifiedBinary): void {
    this.#entries.set(key, value);
  }

  /** @internal */
  delete(key: string): void {
    this.#entries.delete(key);
  }

  /** Drops every result. */
  clear(): void {
    this.#entries.clear();
  }
}

/**
 * Options of {@link verifyBinary}.
 *
 * @public
 */
export interface VerifyBinaryOptions {
  readonly mode: VerificationMode;
  /** The known digests for the host platform (the committed table plus the application's). */
  readonly digests: readonly KnownDigest[];
  /** Which OS signature check strict mode runs; the host's by default. */
  readonly platform?: SignaturePlatform;
  /** The host environment, read only for `SystemRoot` by the Windows check; `process.env` by default. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly cache?: VerificationCache;
  /** Seams for tests; the host's by default. */
  readonly deps?: {
    readonly hash?: (path: string) => Promise<FileDigest>;
    readonly fs?: IdentityFs;
    readonly signature?: Partial<Pick<SignatureDeps, 'fs' | 'run' | 'timeoutMs'>>;
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Validates a digest table: non-empty versions, 64 lower-case hex digests,
 * sizes that are non-negative safe integers.
 *
 * @throws RangeError naming the first bad entry
 * @public
 */
export function checkKnownDigests(digests: readonly KnownDigest[]): void {
  digests.forEach((entry, index) => {
    const bad =
      entry.version.length === 0 ||
      !SHA256_HEX.test(entry.sha256) ||
      (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0));
    if (bad) throw new RangeError(`known digest ${String(index)} is invalid`);
  });
}

function identityOf(stats: FileIdentity): BinaryIdentity {
  return {
    fileId: `${String(stats.dev)}:${String(stats.ino)}`,
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
  };
}

function sameIdentity(a: BinaryIdentity, b: BinaryIdentity): boolean {
  return a.fileId === b.fileId && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function sameSizeAndTime(a: ResolvedExecutable, b: BinaryIdentity): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function cacheKey(binary: ResolvedExecutable, options: VerifyBinaryOptions): string {
  const table = options.digests
    .map((entry) => `${entry.version}=${entry.sha256}/${String(entry.size ?? '')}`)
    .join(',');
  return JSON.stringify([
    options.mode,
    binary.path,
    binary.size,
    binary.mtimeMs,
    options.platform ?? '',
    table,
  ]);
}

/** The digest-table verdict for one digest. */
function compareDigest(
  digest: FileDigest,
  mode: VerificationMode,
  digests: readonly KnownDigest[],
  prefix: string,
): Pick<VerifiedBinary, 'verification' | 'matchedVersion'> {
  if (digests.length === 0) {
    return {
      verification: {
        status: 'unverified',
        method: 'none',
        mode,
        detail: `${prefix}no known digests`,
      },
    };
  }
  const match = digests.find(
    (entry) =>
      entry.sha256 === digest.sha256 && (entry.size === undefined || entry.size === digest.size),
  );
  if (match === undefined) {
    return {
      verification: {
        status: 'unverified',
        method: 'sha256-manifest',
        mode,
        detail: `${prefix}no known digest matches`,
      },
    };
  }
  return {
    verification: {
      status: 'verified',
      method: 'sha256-manifest',
      mode,
      detail: `${prefix}sha256 matches ${match.version}`,
    },
    matchedVersion: match.version,
  };
}

async function readIdentity(fs: IdentityFs, filePath: string): Promise<BinaryIdentity> {
  try {
    return identityOf(await fs.stat(filePath));
  } catch (error) {
    throw new BinaryChangedError(filePath, { cause: error });
  }
}

async function hashBound(
  hash: (path: string) => Promise<FileDigest>,
  binary: ResolvedExecutable,
  expected: BinaryIdentity | undefined,
): Promise<FileDigest> {
  let digest: FileDigest;
  try {
    digest = await hash(binary.path);
  } catch (error) {
    throw new BinaryChangedError(binary.path, { cause: error });
  }
  const unchanged =
    sameSizeAndTime(binary, digest) && (expected === undefined || sameIdentity(expected, digest));
  if (!unchanged) throw new BinaryChangedError(binary.path);
  return digest;
}

async function verifyUncached(
  binary: ResolvedExecutable,
  options: VerifyBinaryOptions,
): Promise<VerifiedBinary> {
  const hash = options.deps?.hash ?? ((value: string) => sha256File(value));
  const { mode, digests } = options;
  if (mode === 'advisory') {
    // Advisory: the digest table only. Nothing is spawned (K8).
    const digest = await hashBound(hash, binary, undefined);
    return { ...bound(binary.path, digest), ...compareDigest(digest, mode, digests, '') };
  }
  const fs = options.deps?.fs ?? nodeIdentityFs;
  const before = await readIdentity(fs, binary.path);
  if (!sameSizeAndTime(binary, before)) throw new BinaryChangedError(binary.path);
  const signature = await checkOsSignature(binary.path, {
    platform: options.platform ?? signaturePlatformOf(process.platform),
    hostEnv: options.hostEnv ?? process.env,
    ...nodeSignatureDeps,
    ...options.deps?.signature,
  });
  if (signature.kind === 'invalid') {
    return {
      path: binary.path,
      ...before,
      verification: { status: 'failed', method: 'os-signature', mode, detail: signature.detail },
    };
  }
  const prefix =
    signature.kind === 'valid'
      ? `${signature.detail}; `
      : 'no OS signature check on this platform; ';
  const digest = await hashBound(hash, binary, before);
  return { ...bound(binary.path, digest), ...compareDigest(digest, mode, digests, prefix) };
}

function bound(filePath: string, digest: FileDigest): Omit<VerifiedBinary, 'verification'> {
  return {
    path: filePath,
    sha256: digest.sha256,
    size: digest.size,
    mtimeMs: digest.mtimeMs,
    fileId: digest.fileId,
  };
}

/**
 * Verifies a resolved executable (see the module remarks).
 *
 * @param binary - the result of `resolveExecutable`
 * @throws {@link BinaryChangedError} when the file changed during
 * verification or cannot be read; RangeError for an invalid digest table or
 * a Windows path with a control character (strict)
 * @public
 */
export async function verifyBinary(
  binary: ResolvedExecutable,
  options: VerifyBinaryOptions,
): Promise<VerifiedBinary> {
  checkKnownDigests(options.digests);
  const cache = options.cache;
  if (cache === undefined) return verifyUncached(binary, options);
  const key = cacheKey(binary, options);
  const cached = cache.get(key);
  if (cached !== undefined) {
    const now = await readIdentity(options.deps?.fs ?? nodeIdentityFs, binary.path).catch(
      () => undefined,
    );
    if (now !== undefined && sameIdentity(now, cached)) return cached;
    cache.delete(key);
  }
  const result = await verifyUncached(binary, options);
  cache.set(key, result);
  return result;
}

/**
 * Folds the version reported by the probe (K4) into the verdict.
 *
 * @remarks
 * - `verified` stays `verified` only when the probe reports the version of
 *   the matched entry; otherwise it is `failed` (the table or the file
 *   disagrees with what runs).
 * - `unverified` becomes `failed` when the table knows the reported version
 *   (its digest is known and differs); otherwise it stays `unverified`
 *   (a version outside the tested window).
 * - `failed` stays `failed`.
 *
 * Pure; the result is a new object.
 *
 * @public
 */
export function settleProbedVersion(
  binary: VerifiedBinary,
  version: string,
  digests: readonly KnownDigest[],
): VerifiedBinary {
  const { verification } = binary;
  const shown = JSON.stringify(version);
  if (verification.status === 'verified' && binary.matchedVersion !== version) {
    return {
      ...binary,
      verification: {
        ...verification,
        status: 'failed',
        detail: `the binary reports ${shown} but its sha256 is that of ${JSON.stringify(binary.matchedVersion)}`,
      },
    };
  }
  if (verification.status === 'unverified' && digests.some((entry) => entry.version === version)) {
    return {
      ...binary,
      verification: {
        ...verification,
        status: 'failed',
        method: 'sha256-manifest',
        detail: `sha256 differs from the known digest of ${shown}`,
      },
    };
  }
  return binary;
}

/**
 * Reads the identity of the verified file again: the realpath of its path
 * must still be that path and its file id, size and mtime unchanged.
 *
 * @throws {@link BinaryChangedError}
 * @public
 */
export async function recheckBinary(
  binary: VerifiedBinary,
  fs: IdentityFs = nodeIdentityFs,
): Promise<void> {
  let resolved: string;
  try {
    resolved = await fs.realpath(binary.path);
  } catch (error) {
    throw new BinaryChangedError(binary.path, { cause: error });
  }
  if (resolved !== binary.path) throw new BinaryChangedError(binary.path);
  const now = await readIdentity(fs, binary.path);
  if (!sameIdentity(now, binary)) throw new BinaryChangedError(binary.path);
}

/**
 * The gate before every spawn of the binary (the K4 probe and the session):
 * strict mode refuses anything but `verified`, then the identity is checked
 * again ({@link recheckBinary}).
 *
 * @throws {@link BinaryNotVerifiedError}, {@link BinaryChangedError}
 * @public
 */
export async function assertSpawnable(
  binary: VerifiedBinary,
  fs: IdentityFs = nodeIdentityFs,
): Promise<void> {
  if (binary.verification.mode === 'strict' && binary.verification.status !== 'verified') {
    throw new BinaryNotVerifiedError(binary);
  }
  await recheckBinary(binary, fs);
}
