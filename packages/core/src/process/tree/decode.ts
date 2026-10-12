/**
 * Small decoding helpers for process-table bytes.
 */

/**
 * WHATWG UTF-8 decoder with replacement (one U+FFFD per maximal ill-formed
 * subpart). A byte order mark is kept: process names are data, not text
 * streams.
 */
const UTF8_LOSSY = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/** Decodes `bytes[start, end)` as UTF-8; never throws. */
export function decodeUtf8Lossy(bytes: Uint8Array, start = 0, end: number = bytes.length): string {
  return UTF8_LOSSY.decode(bytes.subarray(start, end));
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
