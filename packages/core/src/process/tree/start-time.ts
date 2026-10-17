/**
 * Start times as canonical unsigned decimal strings (see
 * `ProcessIdentity.startTime`). Strings, not numbers: Linux tick counts are
 * 64-bit and Windows values exceed `Number.MAX_SAFE_INTEGER`.
 *
 * Units per platform:
 * - Linux: clock ticks since boot (field 22 of `/proc/<pid>/stat`).
 * - macOS: seconds since the epoch (`ps` `lstart`, one-second resolution).
 * - Windows: **microseconds** since 1601-01-01 UTC. This is the canonical
 *   Windows unit (lead ruling, W1 closer), so identities recorded by the CIM
 *   query and by the job addon compare directly. The CIM `CreationDate` has
 *   microsecond resolution; its FILETIME value (100 ns units) is truncated
 *   to microseconds by `parseWin32ProcessJson`. The addon reports FILETIME
 *   100 ns values too; its loader (W3-T5) truncates them to microseconds the
 *   same way ({@link filetimeToMicroseconds}) before they leave it.
 */

const CANONICAL = /^(?:0|[1-9][0-9]{0,19})$/;

/**
 * True when `value` is a canonical start time: `0` or digits without a leading zero, at most 20 digits.
 *
 * @public
 */
export function isCanonicalStartTime(value: string): boolean {
  return CANONICAL.test(value);
}

/**
 * Orders two canonical start times numerically: negative when `a` is
 * earlier, zero when equal, positive when later.
 *
 * @public
 */
export function compareStartTime(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Converts a canonical FILETIME start time (100 ns units) to the canonical
 * Windows unit, microseconds, by truncation (exact for the CIM values, which
 * have microsecond resolution).
 *
 * @internal
 */
export function filetimeToMicroseconds(filetime: string): string {
  return filetime.length > 1 ? filetime.slice(0, -1) : '0';
}

/** Milliseconds from 1601-01-01 to 1970-01-01 (the FILETIME and Unix epochs). */
const EPOCH_GAP_MS = 11_644_473_600_000n;

/**
 * Converts a wall-clock instant in Unix epoch milliseconds (`Date.now()`) to
 * the canonical Windows unit, microseconds since 1601-01-01 UTC, so it
 * compares with Windows start times. A fraction of a millisecond is
 * truncated (the result is never later than the instant).
 *
 * @internal
 */
export function epochMsToWindowsStartTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`not an epoch time: ${String(ms)}`);
  return String((BigInt(Math.floor(ms)) + EPOCH_GAP_MS) * 1000n);
}
