import { describe, expect, it } from 'vitest';

import {
  FULL_LABEL,
  LINUX_NODE_VERSIONS,
  MAX_FILES,
  classify,
  classifyPaths,
  isDocsOnlyPath,
  isWellFormedPath,
  parseNameList,
} from '../lib/ci-classify.mjs';

describe('classifyPaths (default FULL)', () => {
  it.each([
    [['docs/architecture.md'], 'LIGHT'],
    [['docs/adr/0014-ci-strategy.md', 'README.md'], 'LIGHT'],
    [['CHANGELOG.md', 'LICENSE', 'docs/research/img.png'], 'LIGHT'],
    // risky paths
    [['packages/core/src/index.ts'], 'FULL'],
    [['.github/workflows/ci.yml'], 'FULL'],
    [['scripts/ci-classify.mjs'], 'FULL'],
    [['scripts/test/ci-classify.test.ts'], 'FULL'],
    [['pnpm-lock.yaml'], 'FULL'],
    [['package.json'], 'FULL'],
    [['packages/core/package.json'], 'FULL'],
    [['tsconfig.base.json'], 'FULL'],
    [['vitest.config.ts'], 'FULL'],
    [['.nvmrc'], 'FULL'],
    [['packages/core/test/smoke.test.ts'], 'FULL'],
    [['CONTRIBUTING.md'], 'FULL'],
    [['packages/core/README.md'], 'FULL'],
    // unknown and odd paths
    [['unknown-file'], 'FULL'],
    [['docs'], 'FULL'],
    [['Docs/architecture.md'], 'FULL'],
    [['readme.md'], 'FULL'],
    [['docs/../package.json'], 'FULL'],
    [['docs/./x.md'], 'FULL'],
    [['docs//x.md'], 'FULL'],
    [['/docs/x.md'], 'FULL'],
    [['docs\\x.md'], 'FULL'],
    [['docs/x\u0007.md'], 'FULL'],
    [[''], 'FULL'],
    // a mixed change set takes the maximum
    [['docs/architecture.md', 'packages/core/src/index.ts'], 'FULL'],
  ] as const)('%j -> %s', (files, tier) => {
    expect(classifyPaths(files).tier).toBe(tier);
  });

  it('treats an empty change set as FULL', () => {
    expect(classifyPaths([])).toEqual({ tier: 'FULL', reason: 'empty change set' });
  });

  it('treats an unknown change set (diff failure) as FULL', () => {
    expect(classifyPaths(null).tier).toBe('FULL');
  });

  it('treats a very large change set as FULL without inspecting it', () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => `docs/${String(i)}.md`);
    expect(classifyPaths(files)).toEqual({
      tier: 'FULL',
      reason: `more than ${String(MAX_FILES)} changed files`,
    });
    expect(classifyPaths(files.slice(0, MAX_FILES)).tier).toBe('LIGHT');
  });

  it('counts both sides of a rename (git diff --no-renames lists both)', () => {
    expect(classifyPaths(parseNameList('docs/moved.md\0scripts/was-here.mjs\0')).tier).toBe('FULL');
  });
});

describe('path predicates', () => {
  it('accepts only normalized relative paths', () => {
    expect(isWellFormedPath('docs/a.md')).toBe(true);
    expect(isWellFormedPath('docs/a.md/')).toBe(false);
    expect(isWellFormedPath('..')).toBe(false);
  });

  it('matches root documentation files exactly', () => {
    expect(isDocsOnlyPath('README.md')).toBe(true);
    expect(isDocsOnlyPath('docs/README.md')).toBe(true);
    expect(isDocsOnlyPath('README.md.ts')).toBe(false);
  });
});

describe('classify (event + paths)', () => {
  const code = ['packages/core/src/index.ts'];
  const docs = ['docs/architecture.md'];

  it.each([
    ['docs-only draft PR', { event: 'pull_request', files: docs, draft: true }, 'LIGHT'],
    ['docs-only ready PR', { event: 'pull_request', files: docs, draft: false }, 'LIGHT'],
    ['code change in a draft PR', { event: 'pull_request', files: code, draft: true }, 'STANDARD'],
    ['code change in a ready PR', { event: 'pull_request', files: code, draft: false }, 'FULL'],
    ['PR with unknown draft state', { event: 'pull_request', files: code }, 'FULL'],
    ['draft PR whose diff failed', { event: 'pull_request', files: null, draft: true }, 'STANDARD'],
    ['ready PR whose diff failed', { event: 'pull_request', files: null, draft: false }, 'FULL'],
    [
      'draft docs PR labelled full-ci',
      { event: 'pull_request', files: docs, draft: true, labels: ['bug', FULL_LABEL] },
      'FULL',
    ],
    ['push to main', { event: 'push', files: null, ref: 'refs/heads/main' }, 'FULL'],
    ['release tag', { event: 'push', files: null, ref: 'refs/tags/v1.0.0' }, 'FULL'],
    ['push to another branch', { event: 'push', files: null, ref: 'refs/heads/topic' }, 'FULL'],
    ['push without ref', { event: 'push', files: null }, 'FULL'],
    ['merge queue', { event: 'merge_group', files: null }, 'FULL'],
    ['schedule', { event: 'schedule', files: null }, 'FULL'],
    ['manual run', { event: 'workflow_dispatch', files: null }, 'STANDARD'],
    [
      'manual run with full=true',
      { event: 'workflow_dispatch', files: null, fullRequested: true },
      'FULL',
    ],
    ['unknown event', { event: 'pull_request_target', files: docs }, 'FULL'],
  ] as const)('%s -> %s', (_name, input, tier) => {
    expect(classify(input).tier).toBe(tier);
  });

  it('explains its decision', () => {
    expect(classify({ event: 'pull_request', files: code, draft: true }).reason).toContain(
      'packages/core/src/index.ts',
    );
  });
});

describe('Node matrix per tier', () => {
  it('runs Linux on the engines floor for STANDARD and on 22, 24 and 26 for FULL', () => {
    expect(LINUX_NODE_VERSIONS).toEqual({ LIGHT: [], STANDARD: ['22'], FULL: ['22', '24', '26'] });
  });
});
