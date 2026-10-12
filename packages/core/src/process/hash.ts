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
 * - The handle is always closed.
 *
 * Not guaranteed (TOCTOU): the digest describes the file at the time it was
 * read. A file replaced afterwards, or written to concurrently while it is
 * read, is not detected here; callers compare size and mtime before use and
 * treat the digest as evidence about that moment only.
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

// `O_NONBLOCK` is undefined on win32; a bitwise OR treats it as 0 there.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

/**
 * Computes the SHA-256 of a file by streaming it through one fixed buffer.
 *
 * @returns the digest as 64 lower-case hex characters
 * @throws {@link NotRegularFileError}, a `RangeError` for an invalid
 * `chunkBytes`, or the filesystem error of `open`/`read`
 * @public
 */
export async function sha256File(
  filePath: string,
  options: Sha256FileOptions = {},
): Promise<string> {
  const chunkBytes = options.chunkBytes ?? 65536;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError(`chunkBytes must be a positive safe integer, got ${String(chunkBytes)}`);
  }
  const handle = await open(filePath, OPEN_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) throw new NotRegularFileError(filePath);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(chunkBytes);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
