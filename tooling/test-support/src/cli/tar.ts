/**
 * Minimal streaming ustar reader for npm tarballs (plan §4.6 step 3).
 *
 * It extracts exactly one regular file, named in advance, and hands its bytes
 * to a sink; it never creates paths from archive contents. Even so it refuses
 * the whole archive, fail closed, on anything outside the shape npm writes:
 *
 * - names that are absolute (`/x`, `C:x`), contain `..`, `.`, empty segments,
 *   backslashes, control characters or invalid UTF-8, or lie outside `package/`;
 * - hard links, symbolic links, character and block devices, FIFOs and every
 *   other entry type except regular files, directories and pax extended
 *   headers (whose `linkpath`, `size` and sparse keys are refused as well);
 * - header checksum or magic mismatch, non-octal numeric fields (base-256
 *   included), entries above the size limits, too many entries;
 * - a duplicate of the wanted entry, a wanted entry of the wrong size;
 * - truncation anywhere, a missing or malformed end-of-archive marker, and
 *   non-zero or oversized data after it.
 *
 * No `tar` subprocess and no third-party archive library: the reader is small
 * enough to be fuzzed exhaustively (test/cli/tar.test.ts).
 */

import { CliFetchError } from './errors.js';

const BLOCK = 512;
/** Upper bound for one pax extended header record set. */
export const MAX_PAX_BYTES: number = 64 * 1024;

/** Options of {@link extractTarEntry}. */
export interface TarExtractOptions {
  /** Archive path of the one entry to extract, for example `package/claude`. */
  readonly wanted: string;
  /** Exact size the wanted entry must have, when known in advance. */
  readonly expectedSize?: number;
  /** Upper bound for the wanted entry. */
  readonly maxWantedSize: number;
  /** Upper bound for every other regular file. */
  readonly maxOtherSize: number;
  /** Upper bound for the number of entries, pax headers included. */
  readonly maxEntries: number;
  /** Upper bound for the zero padding after the end-of-archive marker. */
  readonly maxTrailingBytes: number;
  /** Receives the wanted entry's bytes in order; awaited before reading on. */
  readonly onData: (chunk: Uint8Array) => Promise<void> | void;
}

/** Result of a successful extraction. */
export interface TarExtractResult {
  /** Byte size of the extracted entry. */
  readonly size: number;
}

function refused(message: string): CliFetchError {
  return new CliFetchError('archive-refused', `tar: ${message}`);
}

const TEXT = new TextDecoder('utf-8', { fatal: true });

function decodeText(bytes: Uint8Array, what: string): string {
  try {
    return TEXT.decode(bytes);
  } catch (error) {
    throw new CliFetchError('archive-refused', `tar: ${what} is not valid UTF-8`, { cause: error });
  }
}

/** A NUL-terminated (or field-filling) string field. */
function stringField(header: Uint8Array, start: number, length: number, what: string): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return decodeText(end === -1 ? field : field.subarray(0, end), what);
}

/** An octal numeric field; base-256 and any other encoding are refused. */
function octalField(header: Uint8Array, start: number, length: number, what: string): number {
  const raw = String.fromCharCode(...header.subarray(start, start + length));
  const match = /^ *([0-7]{1,12})[ \0]*$/.exec(raw);
  if (match?.[1] === undefined) throw refused(`${what} is not an octal number`);
  return Number.parseInt(match[1], 8);
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** Validates an entry name; `directory` allows one trailing slash. */
export function checkEntryPath(name: string, directory: boolean): void {
  const path = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  if (path === '') throw refused('empty entry name');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f]/.test(path))
    throw refused(`control character in ${JSON.stringify(path)}`);
  if (path.includes('\\')) throw refused(`backslash in ${JSON.stringify(path)}`);
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw refused(`absolute path ${JSON.stringify(path)}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw refused(`path traversal or empty segment in ${JSON.stringify(path)}`);
  }
  if (segments[0] !== 'package') throw refused(`entry outside package/: ${JSON.stringify(path)}`);
}

/** The `path` key of a pax extended header; refuses keys that would change the entry's meaning. */
export function parsePax(body: Uint8Array): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const lengthText = space === -1 ? '' : String.fromCharCode(...body.subarray(offset, space));
    if (!/^[1-9]\d{0,5}$/.test(lengthText)) throw refused('malformed pax record length');
    const end = offset + Number(lengthText);
    if (end > body.length || body[end - 1] !== 0x0a || end <= space + 1) {
      throw refused('malformed pax record');
    }
    const record = decodeText(body.subarray(space + 1, end - 1), 'pax record');
    const equals = record.indexOf('=');
    if (equals <= 0) throw refused('malformed pax record');
    const key = record.slice(0, equals);
    if (key === 'path') path = record.slice(equals + 1);
    else if (key === 'linkpath' || key === 'size' || key.startsWith('GNU.sparse')) {
      throw refused(`pax key ${JSON.stringify(key)} is not supported`);
    }
    offset = end;
  }
  return path;
}

/** Pulls bytes from an async source on demand. */
class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #buffer: Uint8Array = new Uint8Array(0);

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  /** Appends the next non-empty chunk; false at the end of the source. */
  async #pull(): Promise<boolean> {
    for (;;) {
      const next = await this.#iterator.next();
      if (next.done === true) return false;
      if (next.value.byteLength === 0) continue;
      if (this.#buffer.byteLength === 0) {
        this.#buffer = next.value;
      } else {
        const joined = new Uint8Array(this.#buffer.byteLength + next.value.byteLength);
        joined.set(this.#buffer);
        joined.set(next.value, this.#buffer.byteLength);
        this.#buffer = joined;
      }
      return true;
    }
  }

  /** Exactly `length` bytes; a source that ends first is a truncated archive. */
  async read(length: number): Promise<Uint8Array> {
    while (this.#buffer.byteLength < length) {
      if (!(await this.#pull())) throw refused('truncated archive');
    }
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }

  /** Streams `length` bytes to `sink` (or discards them) without buffering them all. */
  async forward(length: number, sink?: TarExtractOptions['onData']): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.#buffer.byteLength === 0 && !(await this.#pull())) {
        throw refused('truncated archive');
      }
      const take = Math.min(remaining, this.#buffer.byteLength);
      const part = this.#buffer.subarray(0, take);
      this.#buffer = this.#buffer.subarray(take);
      remaining -= take;
      if (sink !== undefined) await sink(part);
    }
  }

  /** Requires everything left to be zero bytes, at most `limit` of them. */
  async expectZeroRest(limit: number): Promise<void> {
    let total = 0;
    do {
      total += this.#buffer.byteLength;
      if (total > limit) throw refused('too much data after the end-of-archive marker');
      if (!isZeroBlock(this.#buffer)) throw refused('data after the end-of-archive marker');
      this.#buffer = new Uint8Array(0);
    } while (await this.#pull());
  }
}

interface Header {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

function parseHeader(block: Uint8Array): Header {
  let sum = 0;
  for (const [index, byte] of block.entries()) {
    sum += index >= 148 && index < 156 ? 0x20 : byte;
  }
  if (octalField(block, 148, 8, 'header checksum') !== sum) {
    throw refused('header checksum mismatch');
  }
  const magic = String.fromCharCode(...block.subarray(257, 265));
  if (magic !== 'ustar\u000000') throw refused('not a POSIX ustar header');
  const name = stringField(block, 0, 100, 'entry name');
  const prefix = stringField(block, 345, 155, 'entry name prefix');
  return {
    name: prefix === '' ? name : `${prefix}/${name}`,
    type: String.fromCharCode(...block.subarray(156, 157)),
    size: octalField(block, 124, 12, 'entry size'),
  };
}

/**
 * Reads a ustar stream and passes the bytes of the one entry named
 * `options.wanted` to `options.onData`. Throws {@link CliFetchError} with code
 * `archive-refused` on every malformed, truncated or refused archive; the
 * sink may have received a prefix of the entry by then, so callers write it
 * to a staging file and discard that on failure.
 */
export async function extractTarEntry(
  source: AsyncIterable<Uint8Array>,
  options: TarExtractOptions,
): Promise<TarExtractResult> {
  const reader = new ByteReader(source);
  let entries = 0;
  let found: number | undefined;
  let pax: { readonly path: string | undefined } | undefined;
  for (;;) {
    const block = await reader.read(BLOCK);
    if (isZeroBlock(block)) {
      if (pax !== undefined) throw refused('pax header without a following entry');
      if (!isZeroBlock(await reader.read(BLOCK))) {
        throw refused('malformed end-of-archive marker');
      }
      await reader.expectZeroRest(options.maxTrailingBytes);
      break;
    }
    entries += 1;
    if (entries > options.maxEntries) throw refused('too many entries');
    const header = parseHeader(block);
    if (header.type === 'x') {
      if (pax !== undefined) throw refused('consecutive pax headers');
      if (header.size > MAX_PAX_BYTES) throw refused('oversized pax header');
      const body = await reader.read(header.size + padding(header.size));
      pax = { path: parsePax(body.subarray(0, header.size)) };
      continue;
    }
    const name = pax?.path ?? header.name;
    pax = undefined;
    switch (header.type) {
      case '5':
        checkEntryPath(name, true);
        if (header.size !== 0) throw refused(`directory ${JSON.stringify(name)} has a size`);
        continue;
      case '0':
      case '\0':
        checkEntryPath(name, false);
        break;
      case '1':
      case '2':
        throw refused(`link entry ${JSON.stringify(name)}`);
      case '3':
      case '4':
      case '6':
        throw refused(`device or FIFO entry ${JSON.stringify(name)}`);
      default:
        throw refused(`unsupported entry type ${JSON.stringify(header.type)}`);
    }
    if (name !== options.wanted) {
      if (header.size > options.maxOtherSize)
        throw refused(`oversized entry ${JSON.stringify(name)}`);
      await reader.forward(header.size + padding(header.size));
      continue;
    }
    if (found !== undefined) throw refused(`duplicate entry ${JSON.stringify(name)}`);
    if (header.size > options.maxWantedSize)
      throw refused(`oversized entry ${JSON.stringify(name)}`);
    if (options.expectedSize !== undefined && header.size !== options.expectedSize) {
      throw refused(
        `${name} has ${String(header.size)} bytes, expected ${String(options.expectedSize)}`,
      );
    }
    await reader.forward(header.size, options.onData);
    await reader.forward(padding(header.size));
    found = header.size;
  }
  if (found === undefined) throw refused(`entry ${JSON.stringify(options.wanted)} not found`);
  return { size: found };
}
