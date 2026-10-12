// Builds ustar archives for the tar reader tests, including malformed ones.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export interface EntrySpec {
  readonly name: string;
  /** Type flag character; default '0'. */
  readonly type?: string;
  readonly body?: Uint8Array;
  /** Header size field; defaults to the body length. */
  readonly size?: number;
  /** Raw size field text, overriding `size`. */
  readonly sizeField?: string;
  readonly linkname?: string;
  readonly prefix?: string;
  /** Raw name bytes, overriding `name`. */
  readonly nameBytes?: Uint8Array;
  readonly magic?: string;
  readonly badChecksum?: boolean;
}

const encoder = new TextEncoder();

function put(block: Uint8Array, offset: number, length: number, value: Uint8Array): void {
  block.set(value.subarray(0, length), offset);
}

function octal(value: number, digits: number): string {
  return `${value.toString(8).padStart(digits, '0')}\0`;
}

export function header(spec: EntrySpec): Uint8Array {
  const block = new Uint8Array(512);
  put(block, 0, 100, spec.nameBytes ?? encoder.encode(spec.name));
  put(block, 100, 8, encoder.encode(octal(0o644, 7)));
  put(block, 108, 8, encoder.encode(octal(0, 7)));
  put(block, 116, 8, encoder.encode(octal(0, 7)));
  const size = spec.size ?? spec.body?.byteLength ?? 0;
  put(block, 124, 12, encoder.encode(spec.sizeField ?? octal(size, 11)));
  put(block, 136, 12, encoder.encode(octal(0, 11)));
  block[156] = (spec.type ?? '0').charCodeAt(0);
  put(block, 157, 100, encoder.encode(spec.linkname ?? ''));
  put(block, 257, 8, encoder.encode(spec.magic ?? 'ustar\u000000'));
  put(block, 345, 155, encoder.encode(spec.prefix ?? ''));
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  if (spec.badChecksum === true) sum += 1;
  put(block, 148, 8, encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `));
  return block;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function entry(spec: EntrySpec): Uint8Array {
  const body = spec.body ?? new Uint8Array(0);
  const pad = (512 - (body.byteLength % 512)) % 512;
  return concat([header(spec), body, new Uint8Array(pad)]);
}

/** A pax extended header entry; `raw` is the record text. */
export function pax(raw: string): Uint8Array {
  return entry({ name: 'PaxHeader/x', type: 'x', body: encoder.encode(raw) });
}

/** One pax record with a correct length prefix. */
export function paxRecord(key: string, value: string): string {
  const text = ` ${key}=${value}\n`;
  const textLength = Buffer.byteLength(text);
  let length = textLength + 1;
  while (String(length).length + textLength !== length) length += 1;
  return `${String(length)}${text}`;
}

export const END: Uint8Array = new Uint8Array(1024);

export function archive(...entries: Uint8Array[]): Uint8Array {
  return concat([...entries, END]);
}

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function gzip(data: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(data));
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sri(data: Uint8Array): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}

/** Splits `data` at the given offsets (sorted, deduplicated, in range). */
export function chunked(data: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((cut) => Math.min(Math.max(cut, 0), data.byteLength)))].sort(
    (a, b) => a - b,
  );
  const out: Uint8Array[] = [];
  let start = 0;
  for (const point of [...points, data.byteLength]) {
    out.push(data.subarray(start, point));
    start = point;
  }
  return out;
}

export async function* source(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  for (const chunk of chunks) yield chunk;
}
