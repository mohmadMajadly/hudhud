// Change sets of the CI tier classifier (ADR-0014): which paths a pull
// request or a push to main changes. Git is injected, so every branch is
// unit-tested without a repository; scripts/ci-classify.mjs supplies the
// real one. A change set that cannot be computed is `files: null` with the
// cause, never a guess: the classifier then picks its default-deny tier.

import { isDiffableSha, parseNameList } from './ci-classify.mjs';

/**
 * Runs git with `args` in the checkout and returns its stdout; throws when
 * git fails (for example a commit that was never fetched).
 *
 * @typedef {(args: readonly string[]) => string} Git
 */

/**
 * @typedef {object} ChangeSet
 * @property {string[] | null} files Changed paths (old and new path of a
 *   rename both included); null when the diff could not be computed.
 * @property {string} [problem] Why `files` is null.
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  const text = error instanceof Error ? error.message : String(error);
  const end = text.indexOf('\n');
  return end === -1 ? text : text.slice(0, end);
}

/**
 * Paths that differ between the trees of two commits.
 *
 * @param {Git} git
 * @param {string} from
 * @param {string} to
 * @returns {ChangeSet}
 */
export function treeDiff(git, from, to) {
  try {
    const output = git([
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      from,
      to,
    ]);
    return { files: parseNameList(output) };
  } catch (error) {
    return { files: null, problem: `git diff ${from} ${to} failed: ${messageOf(error)}` };
  }
}

/**
 * What a push changed: the diff `before..after`. The workflow fetches
 * `before` alone at depth 1 (ADR-0014 amendment 1). A new branch (all-zero
 * id), a missing or malformed id and an unfetchable `before` (force push)
 * leave it unknown.
 *
 * @param {Git} git
 * @param {unknown} before `github.event.before`
 * @param {unknown} after `GITHUB_SHA`
 * @returns {ChangeSet}
 */
export function pushChanges(git, before, after) {
  if (!isDiffableSha(before)) {
    return { files: null, problem: `push base ${JSON.stringify(before)} is not a commit id` };
  }
  if (!isDiffableSha(after)) {
    return { files: null, problem: `pushed commit ${JSON.stringify(after)} is not a commit id` };
  }
  return treeDiff(git, before, after);
}

/**
 * What a pull request changes, read from the merge commit GitHub tested
 * (`GITHUB_SHA`, the tip of `refs/pull/<n>/merge`): its tree against its
 * first parent, the base branch commit it was merged onto. The workflow
 * checks it out at depth 2, so both parents are present without any history
 * beyond them. The second parent must be the pull request's head, or the
 * merge commit belongs to another push of the branch and nothing is assumed.
 *
 * Replaces `git diff <base>...<head>`, which needs the merge base and failed
 * on the depth-1 checkout with `fatal: Invalid symmetric difference
 * expression` (W7-T1).
 *
 * @param {Git} git
 * @param {unknown} merge `GITHUB_SHA` of the pull_request event.
 * @param {unknown} head `pull_request.head.sha` of the event payload.
 * @returns {ChangeSet}
 */
export function pullRequestChanges(git, merge, head) {
  if (!isDiffableSha(merge)) {
    return { files: null, problem: `merge commit ${JSON.stringify(merge)} is not a commit id` };
  }
  if (!isDiffableSha(head)) {
    return { files: null, problem: `pull request head ${JSON.stringify(head)} is not a commit id` };
  }
  let line;
  try {
    line = git(['rev-list', '--parents', '--max-count=1', merge]).trim();
  } catch (error) {
    return { files: null, problem: `cannot read merge commit ${merge}: ${messageOf(error)}` };
  }
  const [self, ...parents] = line.split(' ');
  if (self !== merge) {
    return { files: null, problem: `git rev-list named ${JSON.stringify(self)}, not ${merge}` };
  }
  if (parents.length !== 2) {
    return {
      files: null,
      problem: `${merge} has ${String(parents.length)} parents fetched, not the 2 of a merge commit (is the checkout deep enough?)`,
    };
  }
  const [base, merged] = /** @type {[string, string]} */ (parents);
  if (merged !== head) {
    return {
      files: null,
      problem: `${merge} merges ${merged}, not the pull request head ${head}`,
    };
  }
  return treeDiff(git, base, merge);
}
