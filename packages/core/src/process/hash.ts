/**
 * Streaming SHA-256 of a file (plan §1.7; used by binary verification, K8,
 * and the addon loader's pre-`dlopen` check, ADR-0009).
 *
 * @remarks
 * Guarantees of {@link sha256File}:
 *
 * - Memory is bounded by one reusable buffer of `chunkBytes` (64 KiB by
 *   default) whatever the file size; nothing else is allocated per chunk.
 * - The digest covers the bytes read through one open handle, and the handle
 *   is checked to be a regular file before any read (`fstat`, not a separate
 *   `stat`, so the type check and the read see the same file). On POSIX the
 *   file is opened with `O_NONBLOCK`, so a FIFO planted at the path is refused
 *   instead of blocking the open forever.
 * - The size, mtime and file id returned are taken from the same handle, by
 *   `fstat` before and after hashing. If size, mtime or file id differ
 *   between the two, or the bytes read differ from the size, the file
 *   changed while it was read and {@link FileChangedError} is thrown, so a
 *   digest is never bound to the wrong content.
 * - The handle is always closed.
 *
 * Not guaranteed (TOCTOU): the result describes the file at the time it was
 * read. A file replaced afterwards is not detected here; callers bind the
 * digest to `fileId`, `size` and `mtimeMs` and compare them before use. A
 * same-size write within one mtime tick during the read is not detectable
 * from metadata.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * Options of {@link sha256File}.
 *
 * @public
 */
export interface Sha256FileOptions {
  /** Read buffer size in bytes, a positive safe integer; default 65536. */
  readonly chunkBytes?: number;
}

/**
 * Thrown by {@link sha256File} when the path does not name a regular file.
 *
 * @public
 */
export class NotRegularFileError extends Error {
  override readonly name = 'NotRegularFileError';
  readonly path: string;

  constructor(filePath: string) {
    super(`${JSON.stringify(filePath)} is not a regular file`);
    this.path = filePath;
  }
}

/**
 * Thrown by {@link sha256File} when the file changed while it was read.
 *
 * @public
 */
export class FileChangedError extends Error {
  override readonly name = 'FileChangedError';
  readonly path: string;

  constructor(filePath: string) {
    super(`${JSON.stringify(filePath)} changed while it was hashed`);
    this.path = filePath;
  }
}

/**
 * Result of {@link sha256File}: the digest bound to the identity of the file
 * it was computed from.
 *
 * @public
 */
export interface FileDigest {
  /** SHA-256 as 64 lower-case hex characters. */
  readonly sha256: string;
  /** Size in bytes. */
  readonly size: number;
  /** Modification time in whole milliseconds. */
  readonly mtimeMs: number;
  /**
   * `<dev>:<ino>` in decimal: device and inode on POSIX, volume serial
   * number and file index on win32.
   */
  readonly fileId: string;
}

interface HandleStat {
  isFile(): boolean;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeMs: bigint;
  readonly mtimeNs: bigint;
}

function fileId(stat: HandleStat): string {
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

/** Everything that must agree before and after the read, as one string. */
function fingerprint(stat: HandleStat, bytes: bigint): string {
  return `${fileId(stat)}|${String(stat.size)}|${String(stat.mtimeNs)}|${String(bytes)}`;
}

// `O_NONBLOCK` is undefined on win32; a bitwise OR treats it as 0 there.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

/**
 * Computes the SHA-256 of a file by streaming it through one fixed buffer,
 * bound to the file's identity (see the module remarks).
 *
 * @throws {@link NotRegularFileError}, {@link FileChangedError}, a
 * `RangeError` for an invalid `chunkBytes`, or the filesystem error of
 * `open`/`read`
 * @public
 */
export async function sha256File(
  filePath: string,
  options: Sha256FileOptions = {},
): Promise<FileDigest> {
  const chunkBytes = options.chunkBytes ?? 65536;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError(`chunkBytes must be a positive safe integer, got ${String(chunkBytes)}`);
  }
  const handle = await open(filePath, OPEN_FLAGS);
  try {
    const before: HandleStat = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new NotRegularFileError(filePath);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let total = 0n;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      total += BigInt(bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after: HandleStat = await handle.stat({ bigint: true });
    if (fingerprint(before, before.size) !== fingerprint(after, total)) {
      throw new FileChangedError(filePath);
    }
    return {
      sha256: hash.digest('hex'),
      size: Number(before.size),
      mtimeMs: Number(before.mtimeMs),
      fileId: fileId(before),
    };
  } finally {
    await handle.close();
  }
}
