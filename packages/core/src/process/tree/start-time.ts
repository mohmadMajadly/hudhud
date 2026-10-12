/**
 * Start times as canonical unsigned decimal strings (see
 * `ProcessIdentity.startTime`). Strings, not numbers: Linux tick counts are
 * 64-bit and FILETIME values exceed `Number.MAX_SAFE_INTEGER`.
 */

const CANONICAL = /^(?:0|[1-9][0-9]{0,19})$/;

/** True when `value` is a canonical start time: `0` or digits without a leading zero, at most 20 digits. */
export function isCanonicalStartTime(value: string): boolean {
  return CANONICAL.test(value);
}

/**
 * Orders two canonical start times numerically: negative when `a` is
 * earlier, zero when equal, positive when later.
 */
export function compareStartTime(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
