// Pure CI tier classifier (ADR-0014). Default-deny: anything that is not
// proven safe is FULL. No I/O here; scripts/ci-classify.mjs supplies inputs.

/** @typedef {'LIGHT' | 'STANDARD' | 'FULL'} Tier */

/**
 * @typedef {object} ClassifyInput
 * @property {string} event GitHub event name.
 * @property {readonly string[] | null} files Changed paths (old and new path
 *   of renames both included); null when the diff could not be computed.
 * @property {string} [ref] GITHUB_REF.
 * @property {boolean} [draft] Whether the pull request is a draft.
 * @property {readonly string[]} [labels] Pull request label names.
 * @property {boolean} [fullRequested] `full` input of workflow_dispatch or workflow_call.
 */

/**
 * @typedef {object} Classification
 * @property {Tier} tier
 * @property {string} reason
 */

/** Label that forces the FULL tier on a pull request. */
export const FULL_LABEL = 'full-ci';

/** Diffs larger than this are not inspected file by file: FULL. */
export const MAX_FILES = 2000;

/** Root files that are documentation only (exact, case-sensitive). */
const LIGHT_ROOT_FILES = new Set(['README.md', 'CHANGELOG.md', 'LICENSE']);

/** Directory prefixes that are documentation only. */
const LIGHT_PREFIXES = ['docs/'];

/** Node versions per tier for the Linux job (ADR-0014, ADR-0017). */
export const LINUX_NODE_VERSIONS = Object.freeze({
  LIGHT: Object.freeze([]),
  STANDARD: Object.freeze(['22']),
  FULL: Object.freeze(['22', '24', '26']),
});

/**
 * A path is well-formed when it is a normalized, relative, forward-slash
 * path without empty, `.` or `..` segments and without control characters.
 * Anything else is treated as hostile or confused input.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isWellFormedPath(path) {
  if (path === '' || path.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isDocsOnlyPath(path) {
  if (!isWellFormedPath(path)) return false;
  return LIGHT_ROOT_FILES.has(path) || LIGHT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Risk of a change set, from paths alone: LIGHT when every path is
 * documentation, FULL otherwise (including empty, unknown or oversized sets).
 *
 * @param {readonly string[] | null} files
 * @returns {Classification}
 */
export function classifyPaths(files) {
  if (files === null) return { tier: 'FULL', reason: 'changed files unknown (diff failed)' };
  if (files.length === 0) return { tier: 'FULL', reason: 'empty change set' };
  if (files.length > MAX_FILES) {
    return { tier: 'FULL', reason: `more than ${String(MAX_FILES)} changed files` };
  }
  const risky = files.find((file) => !isDocsOnlyPath(file));
  if (risky !== undefined)
    return { tier: 'FULL', reason: `non-docs path: ${JSON.stringify(risky)}` };
  return { tier: 'LIGHT', reason: 'documentation-only change set' };
}

/**
 * Decides the CI tier from the event and the change set.
 *
 * @param {ClassifyInput} input
 * @returns {Classification}
 */
export function classify(input) {
  if (input.fullRequested === true) return { tier: 'FULL', reason: 'full run requested' };

  switch (input.event) {
    case 'pull_request': {
      if (input.labels?.includes(FULL_LABEL) === true) {
        return { tier: 'FULL', reason: `label ${FULL_LABEL}` };
      }
      const paths = classifyPaths(input.files);
      if (paths.tier === 'LIGHT') return paths;
      // Draft = not ready for review: one Linux job. Ready (or unknown) = FULL.
      if (input.draft === true)
        return { tier: 'STANDARD', reason: `draft pull request; ${paths.reason}` };
      return { tier: 'FULL', reason: `pull request ready for review; ${paths.reason}` };
    }
    case 'workflow_dispatch':
      return { tier: 'STANDARD', reason: 'manual run without full=true' };
    case 'push':
      if (input.ref === 'refs/heads/main') return { tier: 'FULL', reason: 'push to main' };
      if (input.ref?.startsWith('refs/tags/') === true) return { tier: 'FULL', reason: 'tag push' };
      return { tier: 'FULL', reason: `push to unexpected ref ${String(input.ref)}` };
    case 'merge_group':
      return { tier: 'FULL', reason: 'merge queue' };
    case 'schedule':
      return { tier: 'FULL', reason: 'scheduled run' };
    default:
      return { tier: 'FULL', reason: `unrecognized event ${input.event}` };
  }
}

/**
 * Parses NUL-separated `git diff --name-only -z` output.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function parseNameList(output) {
  return output.split('\0').filter((name) => name !== '');
}
