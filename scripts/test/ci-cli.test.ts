// End-to-end tests of the CI entry points as the workflows call them: the
// classifier (GitHub event payload in, $GITHUB_OUTPUT out) and the gate.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('..', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-ci-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

function node(script: string, args: readonly string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@users.noreply.github.com', ...args],
    { cwd: dir, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
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

function classify(event: string, payload: unknown, extra: Record<string, string> = {}) {
  const eventPath = path.join(dir, 'event.json');
  const output = path.join(dir, 'output.txt');
  writeFileSync(eventPath, typeof payload === 'string' ? payload : JSON.stringify(payload));
  writeFileSync(output, '');
  const result = node('ci-classify.mjs', [], {
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: output,
    ...extra,
  });
  expect(result.status).toBe(0);
  return { output: readFileSync(output, 'utf8'), stdout: result.stdout };
}

describe('ci-classify.mjs', () => {
  it('classifies pull requests from the real diff between base and head', () => {
    git('init', '--quiet');
    const base = commit('README.md');
    const docsHead = commit('docs/a.md');
    const pr = (head: string, draft: boolean) => ({
      pull_request: { base: { sha: base }, head: { sha: head }, draft, labels: [{ name: 'x' }] },
    });

    expect(classify('pull_request', pr(docsHead, false)).output).toBe(
      'tier=LIGHT\nlinux-node=[]\n',
    );

    const codeHead = commit('packages/core/src/x.ts');
    expect(classify('pull_request', pr(codeHead, true)).output).toBe(
      'tier=STANDARD\nlinux-node=["22"]\n',
    );
    expect(classify('pull_request', pr(codeHead, false)).output).toBe(
      'tier=FULL\nlinux-node=["22","24","26"]\n',
    );
  });

  it('falls back to FULL when the diff cannot be computed', () => {
    git('init', '--quiet');
    const payload = {
      pull_request: { base: { sha: 'deadbeef' }, head: { sha: 'cafebabe' }, draft: false },
    };
    expect(classify('pull_request', payload).output).toBe(
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
