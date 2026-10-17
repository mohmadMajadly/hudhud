import { describe, expect, it } from 'vitest';

import { pullRequestChanges, pushChanges, treeDiff } from '../lib/ci-diff.mjs';

const MERGE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

/** A fake git: answers by the subcommand, records every call. */
function fakeGit(answers: { revList?: string | Error; diff?: string | Error }) {
  const calls: (readonly string[])[] = [];
  const git = (args: readonly string[]): string => {
    calls.push(args);
    const answer = args.includes('rev-list') ? answers.revList : answers.diff;
    if (answer === undefined) throw new Error(`unexpected git ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { git, calls };
}

describe('treeDiff', () => {
  it('lists the NUL-separated paths between two trees, renames as delete plus add', () => {
    const { git, calls } = fakeGit({ diff: 'docs/a.md\0README.md\0' });
    expect(treeDiff(git, BASE, MERGE)).toEqual({ files: ['docs/a.md', 'README.md'] });
    expect(calls).toEqual([
      ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', BASE, MERGE],
    ]);
  });

  it('reports the first line of a git failure', () => {
    const { git } = fakeGit({ diff: new Error('fatal: bad object\nmore') });
    expect(treeDiff(git, BASE, MERGE)).toEqual({
      files: null,
      problem: `git diff ${BASE} ${MERGE} failed: fatal: bad object`,
    });
  });

  it('reports a non-Error throw as text', () => {
    const git = (): string => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw is the case under test
      throw 'killed';
    };
    expect(treeDiff(git, BASE, MERGE).problem).toBe(`git diff ${BASE} ${MERGE} failed: killed`);
  });
});

describe('pushChanges', () => {
  it('diffs before..after', () => {
    const { git, calls } = fakeGit({ diff: 'docs/a.md\0' });
    expect(pushChanges(git, BASE, MERGE)).toEqual({ files: ['docs/a.md'] });
    expect(calls[0]?.slice(-2)).toEqual([BASE, MERGE]);
  });

  it.each([
    ['a new branch', '0'.repeat(40), MERGE, 'push base'],
    ['a missing before', undefined, MERGE, 'push base'],
    ['a malformed after', BASE, 'HEAD', 'pushed commit'],
  ])('is unknown for %s, without running git', (_name, before, after, cause) => {
    const { git, calls } = fakeGit({});
    const changes = pushChanges(git, before, after);
    expect(changes.files).toBeNull();
    expect(changes.problem).toContain(cause);
    expect(calls).toEqual([]);
  });
});

describe('pullRequestChanges (the merge commit GitHub tests, W7-T1)', () => {
  it('diffs the merge commit against its first parent when its second parent is the head', () => {
    const { git, calls } = fakeGit({
      revList: `${MERGE} ${BASE} ${HEAD}\n`,
      diff: 'docs/a.md\0',
    });
    expect(pullRequestChanges(git, MERGE, HEAD)).toEqual({ files: ['docs/a.md'] });
    expect(calls).toEqual([
      ['rev-list', '--parents', '--max-count=1', MERGE],
      ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', BASE, MERGE],
    ]);
  });

  it.each([
    ['a missing GITHUB_SHA', undefined, HEAD, 'merge commit undefined is not a commit id'],
    ['a malformed head', MERGE, 'main', 'pull request head "main" is not a commit id'],
  ])('is unknown for %s, without running git', (_name, merge, head, problem) => {
    const { git, calls } = fakeGit({});
    expect(pullRequestChanges(git, merge, head)).toEqual({ files: null, problem });
    expect(calls).toEqual([]);
  });

  it('is unknown when the merge commit cannot be read', () => {
    const { git } = fakeGit({ revList: new Error('fatal: bad object') });
    expect(pullRequestChanges(git, MERGE, HEAD)).toEqual({
      files: null,
      problem: `cannot read merge commit ${MERGE}: fatal: bad object`,
    });
  });

  it('is unknown when git names another commit', () => {
    const { git } = fakeGit({ revList: `${BASE} ${HEAD}\n` });
    expect(pullRequestChanges(git, MERGE, HEAD).problem).toBe(
      `git rev-list named "${BASE}", not ${MERGE}`,
    );
  });

  it.each([
    ['a depth-1 checkout (parents not fetched)', `${MERGE}\n`, 0],
    ['a single-parent commit', `${MERGE} ${BASE}\n`, 1],
    ['an octopus merge', `${MERGE} ${BASE} ${HEAD} ${'d'.repeat(40)}\n`, 3],
  ])('is unknown for %s', (_name, revList, count) => {
    const { git, calls } = fakeGit({ revList });
    expect(pullRequestChanges(git, MERGE, HEAD)).toEqual({
      files: null,
      problem: `${MERGE} has ${String(count)} parents fetched, not the 2 of a merge commit (is the checkout deep enough?)`,
    });
    expect(calls).toHaveLength(1);
  });

  it('is unknown when the merge commit merges another head (a stale run)', () => {
    const { git, calls } = fakeGit({ revList: `${MERGE} ${BASE} ${'d'.repeat(40)}\n` });
    expect(pullRequestChanges(git, MERGE, HEAD)).toEqual({
      files: null,
      problem: `${MERGE} merges ${'d'.repeat(40)}, not the pull request head ${HEAD}`,
    });
    expect(calls).toHaveLength(1);
  });

  it('passes a diff failure through', () => {
    const { git } = fakeGit({ revList: `${MERGE} ${BASE} ${HEAD}`, diff: new Error('boom') });
    expect(pullRequestChanges(git, MERGE, HEAD)).toEqual({
      files: null,
      problem: `git diff ${BASE} ${MERGE} failed: boom`,
    });
  });
});
