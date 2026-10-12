// Pure decision logic of the nightly safety net (ADR-0014, G3): run the full
// matrix only when main changed or a new Claude Code CLI version was
// published since the previous nightly window.

/** npm package whose releases trigger a nightly run. */
export const CLI_PACKAGE = '@anthropic-ai/claude-code';

/**
 * Look-back window. Slightly longer than the 24 h schedule so that a delayed
 * scheduled run does not miss a change; an occasional double run is the
 * accepted cost of never missing one.
 */
export const WINDOW_HOURS = 26;

/**
 * @typedef {object} NightlyInput
 * @property {Date} now
 * @property {Date | null} mainCommitTime Committer time of the head of main;
 *   null when unknown.
 * @property {Date | null} registryModified `modified` time of the CLI's
 *   registry document; null when the registry could not be read.
 * @property {boolean} [forced] Manual dispatch.
 */

/**
 * Unknown inputs count as "changed": the check fails open towards running
 * the tests, never towards skipping them.
 *
 * @param {NightlyInput} input
 * @returns {{ run: boolean, reasons: string[] }}
 */
export function decideNightly(input) {
  const since = input.now.getTime() - WINDOW_HOURS * 60 * 60 * 1000;
  /** @type {string[]} */
  const reasons = [];
  if (input.forced === true) reasons.push('manual dispatch');
  if (input.mainCommitTime === null) reasons.push('main head time unknown');
  else if (input.mainCommitTime.getTime() >= since) reasons.push('main changed');
  if (input.registryModified === null) reasons.push('registry state unknown');
  else if (input.registryModified.getTime() >= since) reasons.push(`${CLI_PACKAGE} published`);
  return { run: reasons.length > 0, reasons };
}

/**
 * Parses an ISO-8601 or epoch-seconds timestamp; null when invalid.
 *
 * @param {unknown} value
 * @returns {Date | null}
 */
export function parseTime(value) {
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    return new Date(Number(value.trim()) * 1000);
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
