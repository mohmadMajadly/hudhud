/**
 * Streaming SHA-256 of a file (plan §1.7; used by binary verification, K8,
 * and the addon loader's pre-`dlopen` check, ADR-0009).
 *
 * @remarks
 * Guarantees of {@link sha256File}:
 *
 * - Memory is bounded by one reusable buffer of `chunkBytes` (4 MiB by
 *   default) whatever the file size; nothing else is allocated per chunk.
 *   Each chunk is one asynchronous read, and under CPU contention every read
 *   waits for the scheduler, so the default is large (W7-T5, the pinned
 *   260 MB win32-x64 CLI on 16 logical CPUs, n = 15 per size unless noted:
 *   idle medians 300 ms (64 KiB, n = 5), 206 ms (1 MiB), 194 ms (4 MiB);
 *   under 16 CPU-bound processes 37 s (64 KiB, n = 5), 2.8 s (1 MiB),
 *   1.2 s (4 MiB)).
 * - The digest covers the bytes read through one open handle, and the handle
 *   is checked to be a regular file before any read (`fstat`, not a separate
 *   `stat`, so the type check and the read see the same file). On POSIX the
 *   file is opened with `O_NONBLOCK`, so a FIFO planted at the path is refused
 *   instead of blocking the open forever.
 * - The size, the modification and change times (`mtimeNs`, `ctimeNs`) and
 *   the file id returned are taken from the same handle, by `fstat` before
 *   and after hashing. If any of them differ between the two, or the bytes
 *   read differ from the size, the file changed while it was read and
 *   {@link FileChangedError} is thrown, so a digest is never bound to the
 *   wrong content.
 * - The handle is always closed.
 *
 * Not guaranteed (TOCTOU): the result describes the file at the time it was
 * read. A file replaced afterwards is not detected here; callers bind the
 * digest to `fileId`, `size`, `mtimeNs` and `ctimeNs` and compare them
 * before use. What this metadata cannot show: on POSIX, a change by root
 * (which can set the clock, and so `ctime`) or on a filesystem whose
 * attributes are cached (NFS, some FUSE mounts); on win32, a same-size
 * rewrite in place by a writer that restores the timestamps
 * (`SetFileInformationByHandle` sets both the write and the change time).
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
  /** Read buffer size in bytes, a positive safe integer; default 4194304 (4 MiB). */
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
  /** Modification time in nanoseconds, decimal. */
  readonly mtimeNs: string;
  /** Status change time (`ctime`) in nanoseconds, decimal. */
  readonly ctimeNs: string;
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
  readonly ctimeNs: bigint;
}

function fileId(stat: HandleStat): string {
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

/** Everything that must agree before and after the read, as one string. */
function fingerprint(stat: HandleStat, bytes: bigint): string {
  return [fileId(stat), stat.size, stat.mtimeNs, stat.ctimeNs, bytes].map(String).join('|');
}

/** The default read buffer (see the module remarks for the measurements). */
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

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
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
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
      mtimeNs: String(before.mtimeNs),
      ctimeNs: String(before.ctimeNs),
      fileId: fileId(before),
    };
  } finally {
    await handle.close();
  }
}
