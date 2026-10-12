/**
 * Generic NDJSON line encoder with an outbound byte cap (plan §1.4, ADR-0011 §7).
 *
 * @remarks
 * Sans-IO (ADR-0006): no host globals, no I/O; errors are returned as data.
 *
 * @packageDocumentation
 */

import { makeErrorData, type KnownErrorData } from './errors.js';
import type { JsonObject } from './json.js';

/**
 * Default outbound line cap: 32 MiB (ADR-0011 §7).
 *
 * @public
 */
export const DEFAULT_MAX_OUTBOUND_FRAME_BYTES: number = 32 * 1024 * 1024;

/**
 * Result of {@link encodeJsonLine}.
 *
 * @public
 */
export type EncodeJsonLineResult =
  | { readonly ok: true; readonly line: string; readonly bytes: number }
  | { readonly ok: false; readonly error: KnownErrorData };

/**
 * UTF-8 byte length of `text`, as `TextEncoder` would produce it, without
 * allocating the encoded bytes. Counting stops once `limit` is exceeded.
 *
 * @remarks
 * `text` must be well-formed UTF-16 (every high surrogate followed by a low
 * one). `JSON.stringify` guarantees that: it escapes lone surrogates (ES2019).
 */
function utf8Length(text: string, limit: number): number {
  let bytes = 0;
  const length = text.length;
  for (let i = 0; i < length && bytes <= limit; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      // A surrogate pair: one supplementary code point, four bytes.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function protocolError(reason: string): EncodeJsonLineResult {
  return {
    ok: false,
    error: makeErrorData(
      'PROTOCOL_ERROR',
      `Outbound frame is not a serializable JSON object (${reason}); nothing was written.`,
      { reason },
    ),
  };
}

/**
 * Encodes one JSON object as one NDJSON line.
 *
 * @remarks
 * `line` is `JSON.stringify(value) + "\n"` and contains exactly one line feed,
 * the terminator: `JSON.stringify` escapes every C0 control character, so no
 * raw LF or CR can occur inside the frame. U+2028 and U+2029 are left as
 * `JSON.stringify` writes them (verbatim, valid JSON since ES2019); their UTF-8
 * encodings contain no LF byte, and NDJSON framing splits on LF only.
 *
 * `bytes` is the UTF-8 length of `line`, terminator included. A line above
 * `maxBytes` yields `OUTBOUND_FRAME_TOO_LARGE` and no line, so the caller
 * writes nothing (no truncation). A value `JSON.stringify` cannot encode as an
 * object (a cycle, nesting deep enough to exhaust the stack, a `bigint`, a
 * non-object at run time) yields `PROTOCOL_ERROR`. This function never throws
 * for a valid `maxBytes`.
 *
 * @param value - The frame to encode.
 * @param maxBytes - The outbound cap in bytes, a positive safe integer; usually
 * {@link DEFAULT_MAX_OUTBOUND_FRAME_BYTES}.
 * @throws RangeError when `maxBytes` is not a positive safe integer.
 * @public
 */
export function encodeJsonLine(value: JsonObject, maxBytes: number): EncodeJsonLineResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`maxBytes must be a positive safe integer, got ${String(maxBytes)}`);
  }
  // Runtime guard: the type admits only objects, callers may still pass others.
  const candidate: unknown = value;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return protocolError('not-object');
  }
  let json: unknown;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    return protocolError(error instanceof RangeError ? 'too-deep' : 'not-serializable');
  }
  // A `toJSON` method can turn the object into anything, including nothing.
  if (typeof json !== 'string' || !json.startsWith('{')) {
    return protocolError('not-object');
  }
  const line = `${json}\n`;
  // Every UTF-16 code unit is at least one UTF-8 byte: skip counting when the
  // cap is already exceeded by the unit count.
  const bytes = line.length > maxBytes ? line.length : utf8Length(line, maxBytes);
  if (bytes > maxBytes) {
    return {
      ok: false,
      error: makeErrorData(
        'OUTBOUND_FRAME_TOO_LARGE',
        `Outbound frame exceeds the cap of ${String(maxBytes)} bytes; nothing was written.`,
        { maxBytes, atLeastBytes: bytes },
      ),
    };
  }
  return { ok: true, line, bytes };
}
