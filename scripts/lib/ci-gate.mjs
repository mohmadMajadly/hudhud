// Pure decision logic of the `ci-gate` job (ADR-0014): the only required
// check. Fails on any failed or cancelled job, on an unknown tier, and when a
// job the tier requires did not succeed (for example a skipped Windows job on
// FULL).

/** @typedef {import('./ci-classify.mjs').Tier} Tier */

/**
 * Jobs that must succeed per tier. Jobs not listed may be skipped.
 *
 * @type {Readonly<Record<Tier, readonly string[]>>}
 */
export const REQUIRED_JOBS = Object.freeze({
  LIGHT: Object.freeze(['classify', 'docs']),
  STANDARD: Object.freeze(['classify', 'linux', 'node-floor']),
  FULL: Object.freeze(['classify', 'linux', 'node-floor', 'windows', 'macos']),
});

/**
 * @param {unknown} value
 * @returns {value is Tier}
 */
function isTier(value) {
  return value === 'LIGHT' || value === 'STANDARD' || value === 'FULL';
}

/**
 * @param {unknown} tier The tier reported by the classify job.
 * @param {Readonly<Record<string, string>>} results Job id to result
 *   (`success`, `failure`, `cancelled`, `skipped`).
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function evaluateGate(tier, results) {
  /** @type {string[]} */
  const problems = [];
  for (const [job, result] of Object.entries(results)) {
    if (result === 'failure' || result === 'cancelled') problems.push(`${job}: ${result}`);
  }
  if (!isTier(tier)) {
    problems.push(`unknown tier ${JSON.stringify(tier)}`);
    return { ok: false, problems };
  }
  for (const job of REQUIRED_JOBS[tier]) {
    const result = results[job];
    if (result !== 'success') {
      problems.push(`${job}: required on ${tier} but ${result ?? 'missing'}`);
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
