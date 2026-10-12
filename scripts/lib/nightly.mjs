// Pure decision logic of the nightly safety net (ADR-0014, G3, amendment 2):
// run the full matrix only when a new Claude Code CLI version was published
// in the look-back window, or on manual dispatch. Changes to main are not a
// trigger: every non-docs push to main already runs the FULL tier.

/** npm package whose releases trigger a nightly run. */
export const CLI_PACKAGE = '@anthropic-ai/claude-code';

/**
 * Look-back window. Slightly longer than the 24 h schedule so that a delayed
 * scheduled run does not miss a release; an occasional double run is the
 * accepted cost of never missing one.
 */
export const WINDOW_HOURS = 26;

/**
 * @typedef {object} NightlyInput
 * @property {Date} now
 * @property {Date | null} registryModified `modified` time of the CLI's
 *   registry document; null when the registry could not be read.
 * @property {boolean} [forced] Manual dispatch.
 */

/**
 * @typedef {object} NightlyDecision
 * @property {boolean} run Whether to fan out to the full matrix.
 * @property {string[]} reasons Why it runs.
 * @property {string} [error] Set when the registry state is unknown: the
 *   check job fails visibly instead of silently skipping or spending a full
 *   matrix on an outage.
 */

/**
 * @param {NightlyInput} input
 * @returns {NightlyDecision}
 */
export function decideNightly(input) {
  if (input.forced === true) return { run: true, reasons: ['manual dispatch'] };
  if (input.registryModified === null) {
    return { run: false, reasons: [], error: `${CLI_PACKAGE} registry state unknown` };
  }
  const since = input.now.getTime() - WINDOW_HOURS * 60 * 60 * 1000;
  if (input.registryModified.getTime() >= since) {
    return { run: true, reasons: [`${CLI_PACKAGE} published`] };
  }
  return { run: false, reasons: [] };
}

/**
 * Parses an ISO-8601 timestamp; null when invalid.
 *
 * @param {unknown} value
 * @returns {Date | null}
 */
export function parseTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
