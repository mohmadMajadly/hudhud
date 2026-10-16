// End-to-end tests of the CI entry points as the workflows call them: the
// classifier (GitHub event payload in, $GITHUB_OUTPUT out) and the gate.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('..', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-ci-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

function node(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string = dir,
) {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitIn(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@users.noreply.github.com', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function git(...args: string[]): string {
  return gitIn(dir, ...args);
}

function commit(file: string): string {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), `${file}\n`);
  git('add', file);
  git('commit', '--quiet', '--no-verify', '-m', file);
  return head();
}

/**
 * The commit HEAD names, read from the repository files instead of a third
 * git process per commit (each spawn costs tens of milliseconds on Windows,
 * far more on a loaded host).
 */
function head(): string {
  const ref = readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
  if (!ref.startsWith('ref: ')) return ref;
  return readFileSync(path.join(dir, '.git', ref.slice('ref: '.length)), 'utf8').trim();
}

function classify(
  event: string,
  payload: unknown,
  extra: Record<string, string> = {},
  cwd: string = dir,
) {
  const eventPath = path.join(dir, 'event.json');
  const output = path.join(dir, 'output.txt');
  writeFileSync(eventPath, typeof payload === 'string' ? payload : JSON.stringify(payload));
  writeFileSync(output, '');
  const result = node(
    'ci-classify.mjs',
    [],
    { GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, ...extra },
    cwd,
  );
  expect(result.status).toBe(0);
  return { output: readFileSync(output, 'utf8'), stdout: result.stdout };
}

/**
 * A pull request as GitHub tests it: `pull` merges `head` into the base
 * branch, whose tip moved on after the branch point (a code change the pull
 * request does not contain). Returns the merge commit and the base tip.
 */
function pullMerge(headFile: string): { merge: string; head: string; base: string } {
  git('init', '--quiet');
  const root = commit('README.md');
  git('checkout', '--quiet', '-b', 'feature');
  const headSha = commit(headFile);
  git('checkout', '--quiet', '-b', 'pull', root);
  const base = commit('packages/core/src/base-moved.ts');
  git('merge', '--quiet', '--no-ff', '--no-edit', '--no-verify', 'feature');
  return { merge: head(), head: headSha, base };
}

/**
 * A shallow clone of the `pull` branch, as actions/checkout fetches
 * `refs/pull/<n>/merge` with `fetch-depth`.
 */
function shallowClone(depth: number): string {
  const clone = path.join(dir, `clone-${String(depth)}`);
  gitIn(
    dir,
    'clone',
    '--quiet',
    `--depth=${String(depth)}`,
    '--branch',
    'pull',
    pathToFileURL(dir).href,
    clone,
  );
  return clone;
}

describe('ci-classify.mjs', () => {
  // W7-T1: with the depth-1 checkout the PR diff `base...head` failed with
  // `fatal: Invalid symmetric difference expression` and every pull request
  // ran FULL. The diff is now the merge commit against its first parent, and
  // the checkout fetches depth 2: exactly the merge commit and its parents.
  it('classifies a pull request from its merge commit in a depth-2 checkout', () => {
    const docs = pullMerge('docs/a.md');
    const clone = shallowClone(2);
    const pr = (headSha: string, draft: boolean) => ({
      pull_request: {
        base: { sha: docs.base },
        head: { sha: headSha },
        draft,
        labels: [{ name: 'x' }],
      },
    });
    const run = (headSha: string, draft: boolean) =>
      classify('pull_request', pr(headSha, draft), { GITHUB_SHA: docs.merge }, clone);

    // The base branch's own code change after the branch point is not part
    // of the pull request: docs only, LIGHT.
    const light = run(docs.head, false);
    expect(light.output).toBe('tier=LIGHT\nlinux-node=[]\n');
    expect(light.stdout).not.toContain('::warning::');
    // A merge commit of another head (a stale run) is not trusted.
    const stale = run(docs.base, false);
    expect(stale.output).toBe('tier=FULL\nlinux-node=["22","24","26"]\n');
    expect(stale.stdout).toContain(`::warning::changed files unknown: ${docs.merge} merges`);
  }, 60_000);

  it('classifies a code pull request by draft state; a depth-1 checkout is FULL with its cause', () => {
    const code = pullMerge('packages/core/src/x.ts');
    const deep = shallowClone(2);
    const pr = (draft: boolean) => ({
      pull_request: { base: { sha: code.base }, head: { sha: code.head }, draft },
    });
    const sha = { GITHUB_SHA: code.merge };
    expect(classify('pull_request', pr(true), sha, deep).output).toBe(
      'tier=STANDARD\nlinux-node=["22"]\n',
    );
    expect(classify('pull_request', pr(false), sha, deep).output).toBe(
      'tier=FULL\nlinux-node=["22","24","26"]\n',
    );
    // The defect's checkout: the parents are missing; unknown diff, FULL
    // for a ready pull request, the designed STANDARD for a draft.
    const shallow = shallowClone(1);
    const ready = classify('pull_request', pr(false), sha, shallow);
    expect(ready.output).toBe('tier=FULL\nlinux-node=["22","24","26"]\n');
    expect(ready.stdout).toContain('has 0 parents fetched, not the 2 of a merge commit');
    expect(classify('pull_request', pr(true), sha, shallow).output).toBe(
      'tier=STANDARD\nlinux-node=["22"]\n',
    );
  }, 60_000);

  it('falls back to FULL when the diff cannot be computed', () => {
    git('init', '--quiet');
    const payload = {
      pull_request: { base: { sha: 'deadbeef' }, head: { sha: 'cafebabe' }, draft: false },
    };
    expect(classify('pull_request', payload, { GITHUB_SHA: 'f'.repeat(40) }).output).toBe(
      'tier=FULL\nlinux-node=["22","24","26"]\n',
    );
  });

  it('falls back to FULL on an unreadable event payload', () => {
    const result = classify('pull_request', '{not json');
    expect(result.output).toBe('tier=FULL\nlinux-node=["22","24","26"]\n');
    expect(result.stdout).toContain('classifier error');
  });

  it('honours full=true and non-PR events', () => {
    expect(classify('workflow_dispatch', {}).output).toContain('tier=STANDARD');
    expect(classify('workflow_dispatch', {}, { CI_FULL_REQUESTED: 'true' }).output).toContain(
      'tier=FULL',
    );
    expect(classify('push', {}, { GITHUB_REF: 'refs/heads/main' }).output).toContain('tier=FULL');
  });

  it('classifies pushes to main from the before..after diff, FULL when it is unknowable', () => {
    git('init', '--quiet');
    const base = commit('packages/core/src/x.ts');
    const docsHead = commit('docs/a.md');
    const main = { GITHUB_REF: 'refs/heads/main' };
    const push = (before: unknown, after: string, env = main) =>
      classify('push', before === undefined ? {} : { before }, { ...env, GITHUB_SHA: after })
        .output;

    expect(push(base, docsHead)).toBe('tier=LIGHT\nlinux-node=[]\n');
    const codeHead = commit('scripts/y.mjs');
    expect(push(docsHead, codeHead)).toContain('tier=FULL');
    // multi-commit push: everything since `before` counts
    expect(push(base, codeHead)).toContain('tier=FULL');
    // new branch, missing, malformed or unfetchable (force push) before
    expect(push('0'.repeat(40), docsHead)).toContain('tier=FULL');
    expect(push(undefined, docsHead)).toContain('tier=FULL');
    expect(push('not-a-sha', docsHead)).toContain('tier=FULL');
    expect(push('f'.repeat(40), docsHead)).toContain('tier=FULL');
    // tags are always FULL, even docs-only
    expect(push(base, docsHead, { GITHUB_REF: 'refs/tags/v1.0.0' })).toContain('tier=FULL');
    // Real git and node processes (8 git, 8 node; about 3.5 s on Windows with
    // coverage). The timeout is a hang guard, not a performance budget (W3-Z
    // ruling 4).
  }, 60_000);

  it('classifies a local file list', () => {
    const result = node('ci-classify.mjs', ['--files', 'docs/a.md', 'README.md'], {});
    expect(result.stdout).toContain('tier=LIGHT');
  });
});

describe('ci-gate.mjs', () => {
  const needs = (results: Record<string, string>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(results).map(([job, result]) => [job, { result, outputs: {} }]),
      ),
    );

  it('passes a green FULL run', () => {
    const result = node('ci-gate.mjs', [], {
      CI_TIER: 'FULL',
      CI_NEEDS: needs({
        classify: 'success',
        docs: 'skipped',
        linux: 'success',
        windows: 'success',
        macos: 'success',
      }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ci-gate: passed');
  });

  it('fails a FULL run whose macOS job was skipped', () => {
    const result = node('ci-gate.mjs', [], {
      CI_TIER: 'FULL',
      CI_NEEDS: needs({
        classify: 'success',
        docs: 'skipped',
        linux: 'success',
        windows: 'success',
        macos: 'skipped',
      }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('macos: required on FULL but skipped');
  });

  it('fails when classify produced no tier', () => {
    const result = node('ci-gate.mjs', [], { CI_TIER: '', CI_NEEDS: '{"classify":{}}' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown tier ""');
  });
});
