// Test timeouts are hang guards, not performance budgets (vitest.config.ts
// HANG_GUARD_MS, W3-Z ruling 4). A guard tighter than the bounds the test
// legitimately consumes, one after another, would fail a slow but correct
// run; so a test that waits on bounded operations sizes its timeout from
// them. Same rule as packages/core/test/unit/process/spawn-support.ts.

/** The suite's default hang guard (vitest.config.ts). */
const HANG_GUARD_MS = 60_000;

/**
 * Margin for the test's own work beyond the bounds it waits on: spawning
 * the fake CLI (a copy of node), the sandbox's file work, assertions.
 */
const TEST_WORK_MARGIN_MS = 30_000;

/**
 * The timeout of a test that waits on the given bounds one after another:
 * their sum plus {@link TEST_WORK_MARGIN_MS}, never less than the default.
 */
export function hangGuard(...boundsMs: readonly number[]): number {
  const sum = boundsMs.reduce((total, ms) => total + ms, 0);
  return Math.max(HANG_GUARD_MS, sum + TEST_WORK_MARGIN_MS);
}
