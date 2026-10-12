/**
 * Small, dependency-free decoding helpers for process-table bytes.
 *
 * @remarks
 * The core package is compiled without Node or DOM type definitions, so
 * `TextDecoder` is not available here. `decodeUtf8Lossy` implements the
 * WHATWG UTF-8 decoder with replacement (one U+FFFD per maximal ill-formed
 * subpart), which the tests compare with Node's `TextDecoder` on arbitrary
 * bytes.
 */

const REPLACEMENT = 0xfffd;
const CHUNK = 4096;

/** Decodes `bytes[start, end)` as UTF-8; never throws. */
export function decodeUtf8Lossy(bytes: Uint8Array, start = 0, end: number = bytes.length): string {
  const parts: string[] = [];
  let units: number[] = [];
  const emit = (codePoint: number): void => {
    units.push(codePoint);
    if (units.length === CHUNK) {
      parts.push(String.fromCodePoint(...units));
      units = [];
    }
  };

  let needed = 0;
  let seen = 0;
  let codePoint = 0;
  let lower = 0x80;
  let upper = 0xbf;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = start;
  while (i < end) {
    const byte = view.getUint8(i);
    if (needed === 0) {
      i += 1;
      if (byte <= 0x7f) {
        emit(byte);
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        codePoint = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        if (byte === 0xed) upper = 0x9f;
        needed = 2;
        codePoint = byte & 0x0f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        if (byte === 0xf4) upper = 0x8f;
        needed = 3;
        codePoint = byte & 0x07;
      } else {
        emit(REPLACEMENT);
      }
      continue;
    }
    if (byte < lower || byte > upper) {
      // Ill-formed: emit one replacement and reprocess this byte as a lead.
      needed = 0;
      seen = 0;
      codePoint = 0;
      lower = 0x80;
      upper = 0xbf;
      emit(REPLACEMENT);
      continue;
    }
    i += 1;
    lower = 0x80;
    upper = 0xbf;
    codePoint = (codePoint << 6) | (byte & 0x3f);
    seen += 1;
    if (seen === needed) {
      emit(codePoint);
      needed = 0;
      seen = 0;
      codePoint = 0;
    }
  }
  if (needed !== 0) emit(REPLACEMENT);
  parts.push(String.fromCodePoint(...units));
  return parts.join('');
}

const UNSIGNED_DECIMAL = /^[0-9]+$/;

/** Largest pid accepted from any source (Windows pids are 32-bit unsigned). */
export const MAX_PID = 0xffff_ffff;

/** Parses an unsigned decimal pid in `[0, MAX_PID]`; `null` for anything else. */
export function parsePid(text: string): number | null {
  if (!UNSIGNED_DECIMAL.test(text) || text.length > 10) return null;
  const value = Number(text);
  return value <= MAX_PID ? value : null;
}

/** True for an integer pid in `[0, MAX_PID]`. */
export function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PID;
}

/** Capture group `index` of a match, or `''` when that group did not participate. */
export function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? '';
}
