// The publish step of a release (scripts/lib/release.mjs; ADR-0014
// amendment 12): the order, the idempotent re-run against what the registry
// holds, the npm arguments, the recovery summary of a partial publish, the
// gate on the tagged commit and the dry run's simulated record.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseManifest } from '../lib/addon-digests.mjs';
import {
  distTag,
  gateProblems,
  integrityOf,
  orderTarballs,
  packumentUrl,
  parsePackument,
  planPublish,
  PUBLISH_ORDER,
  publishArgs,
  REGISTRY,
  renderSummary,
  shallowProblem,
  simulatedRecord,
  type PublishStep,
  type RegistryState,
  type ReleaseTarball,
  type StepResult,
} from '../lib/release.mjs';

const FIXED = ['hudhudjs', '@hudhudjs/core', '@hudhudjs/claude-code'];

function tarball(name: string, version = '0.1.0'): ReleaseTarball {
  return { file: `${name}.tgz`, name, version, integrity: `sha512-${name}` };
}

const TARBALLS = [
  tarball('hudhudjs'),
  tarball('@hudhudjs/claude-code'),
  tarball('@hudhudjs/core'),
  tarball('@hudhudjs/win32-job-x64'),
];

describe('integrityOf and packumentUrl', () => {
  it('gives the registry form of a sha512', () => {
    const bytes = Buffer.from('hudhud');
    expect(integrityOf(bytes)).toBe(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    );
  });

  it('encodes the scope separator only, and refuses anything but a package name', () => {
    expect(packumentUrl('@hudhudjs/core')).toBe(`${REGISTRY}@hudhudjs%2fcore`);
    expect(packumentUrl('hudhudjs')).toBe(`${REGISTRY}hudhudjs`);
    expect(() => packumentUrl('../x')).toThrow('not a package name');
    expect(() => packumentUrl('@a/b/c')).toThrow('not a package name');
  });
});

describe('parsePackument', () => {
  const body = JSON.stringify({
    versions: { '0.1.0': { dist: { integrity: 'sha512-a' } }, '0.2.0': {} },
  });

  it('reads one version, and a 404 as a package that does not exist', () => {
    expect(parsePackument(200, body, '0.1.0')).toEqual({ kind: 'present', integrity: 'sha512-a' });
    expect(parsePackument(200, body, '0.2.0')).toEqual({ kind: 'present', integrity: undefined });
    expect(parsePackument(200, body, '0.3.0')).toEqual({ kind: 'absent' });
    expect(parsePackument(404, 'not found', '0.1.0')).toEqual({ kind: 'absent' });
  });

  it('never takes an error for "absent"', () => {
    expect(parsePackument(500, '', '0.1.0')).toBe('the registry answered HTTP 500');
    expect(parsePackument(403, '', '0.1.0')).toBe('the registry answered HTTP 403');
    expect(parsePackument(200, '<html>', '0.1.0')).toBe(
      'the registry answered with a body that is not JSON',
    );
    expect(parsePackument(200, '{}', '0.1.0')).toBe(
      'the registry answered without a versions object',
    );
    expect(parsePackument(200, 'null', '0.1.0')).toBe(
      'the registry answered without a versions object',
    );
    expect(parsePackument(200, '{"versions":{"0.1.0":5}}', '0.1.0')).toEqual({
      kind: 'present',
      integrity: undefined,
    });
  });
});

describe('orderTarballs', () => {
  it('orders the platform package first, then the core, the adapter and the umbrella', () => {
    const { ordered, problems } = orderTarballs({
      tag: 'v0.1.0',
      fixed: FIXED,
      tarballs: TARBALLS,
    });
    expect(problems).toEqual([]);
    expect(ordered.map((entry) => entry.name)).toEqual([
      '@hudhudjs/win32-job-x64',
      '@hudhudjs/core',
      '@hudhudjs/claude-code',
      'hudhudjs',
    ]);
    expect(PUBLISH_ORDER).toEqual(ordered.map((entry) => entry.name));
  });

  it('lets the addon package keep its own version, never the fixed group', () => {
    const tarballs = [...TARBALLS.slice(0, 3), tarball('@hudhudjs/win32-job-x64', '0.1.0')];
    const next = tarballs.map((entry) =>
      FIXED.includes(String(entry.name)) ? { ...entry, version: '0.2.0' } : entry,
    );
    expect(orderTarballs({ tag: 'v0.2.0', fixed: FIXED, tarballs: next }).problems).toEqual([]);
    expect(orderTarballs({ tag: 'v0.2.0', fixed: FIXED, tarballs }).problems).toEqual([
      '@hudhudjs/core is packed at version 0.1.0, the tag v0.2.0 names 0.2.0',
      '@hudhudjs/claude-code is packed at version 0.1.0, the tag v0.2.0 names 0.2.0',
      'hudhudjs is packed at version 0.1.0, the tag v0.2.0 names 0.2.0',
    ]);
  });

  it('refuses a bad tag, a missing, doubled, unknown or unreadable tarball', () => {
    expect(
      orderTarballs({
        tag: 'release-1',
        fixed: FIXED,
        tarballs: [
          ...TARBALLS.slice(1),
          tarball('@hudhudjs/core'),
          tarball('@hudhudjs/win32-job-arm64'),
          { file: 'notes.txt', name: undefined, version: undefined, integrity: 'x' },
        ],
      }).problems,
    ).toEqual([
      'the tag "release-1" is not v<semver> (for example v0.1.0)',
      'notes.txt: no readable package.json with a name and a version',
      '@hudhudjs/core: 2 tarballs, expected 1',
      'hudhudjs: no tarball (every release publishes @hudhudjs/win32-job-x64, @hudhudjs/core, @hudhudjs/claude-code, hudhudjs)',
      '@hudhudjs/win32-job-arm64: a tarball of a package no release publishes',
    ]);
    expect(
      orderTarballs({ tag: 'v0.1.0', fixed: [...FIXED, 'other'], tarballs: TARBALLS }).problems,
    ).toEqual(['other (fixed group) is not in the publish order']);
  });
});

describe('planPublish (idempotent re-runs)', () => {
  const { ordered } = orderTarballs({ tag: 'v0.1.0', fixed: FIXED, tarballs: TARBALLS });
  const absent: RegistryState = { kind: 'absent' };

  it('publishes what the registry does not hold, in order', () => {
    const registry = new Map(PUBLISH_ORDER.map((name) => [name, absent]));
    const plan = planPublish({ tag: 'v0.1.0', ordered, registry });
    expect(plan.problems).toEqual([]);
    expect(plan.steps.map((step) => [step.name, step.action])).toEqual(
      PUBLISH_ORDER.map((name) => [name, 'publish']),
    );
  });

  it('skips a version already published with the same bytes (a re-run after a partial publish)', () => {
    const registry = new Map<string, RegistryState>(PUBLISH_ORDER.map((name) => [name, absent]));
    registry.set('@hudhudjs/win32-job-x64', {
      kind: 'present',
      integrity: 'sha512-@hudhudjs/win32-job-x64',
    });
    registry.set('@hudhudjs/core', { kind: 'present', integrity: 'sha512-@hudhudjs/core' });
    const plan = planPublish({ tag: 'v0.1.0', ordered, registry });
    expect(plan.problems).toEqual([]);
    expect(plan.steps.map((step) => step.action)).toEqual(['skip', 'skip', 'publish', 'publish']);
  });

  it('stops before publishing anything when a tag version is on the registry with other bytes', () => {
    const registry = new Map<string, RegistryState>(PUBLISH_ORDER.map((name) => [name, absent]));
    registry.set('hudhudjs', { kind: 'present', integrity: 'sha512-other' });
    expect(planPublish({ tag: 'v0.1.0', ordered, registry }).problems).toEqual([
      'hudhudjs@0.1.0 is already on the registry with other bytes (registry sha512-other, this release sha512-hudhudjs); a published version is never replaced: release a new version',
    ]);
  });

  it('keeps an addon version an earlier release published, with a warning when its bytes differ', () => {
    const next = orderTarballs({
      tag: 'v0.2.0',
      fixed: FIXED,
      tarballs: TARBALLS.map((entry) =>
        FIXED.includes(String(entry.name)) ? { ...entry, version: '0.2.0' } : entry,
      ),
    }).ordered;
    const registry = new Map<string, RegistryState>(PUBLISH_ORDER.map((name) => [name, absent]));
    registry.set('@hudhudjs/win32-job-x64', { kind: 'present', integrity: 'sha512-old' });
    const plan = planPublish({ tag: 'v0.2.0', ordered: next, registry });
    expect(plan.problems).toEqual([]);
    expect(plan.steps.map((step) => step.action)).toEqual([
      'skip',
      'publish',
      'publish',
      'publish',
    ]);
    expect(plan.warnings).toEqual([
      '@hudhudjs/win32-job-x64@0.1.0 is already on the registry, published by an earlier release, with other bytes (registry sha512-old, this release sha512-@hudhudjs/win32-job-x64); kept as published',
    ]);
  });

  it('refuses to plan a package the registry was not asked about', () => {
    expect(planPublish({ tag: 'v0.1.0', ordered, registry: new Map() }).problems).toHaveLength(4);
  });
});

describe('publishArgs', () => {
  it('publishes the tarball publicly with provenance required', () => {
    expect(publishArgs({ file: 'a.tgz', version: '0.1.0', dryRun: false })).toEqual([
      'publish',
      'a.tgz',
      '--access',
      'public',
      '--tag',
      'latest',
      '--registry',
      'https://registry.npmjs.org/',
      '--provenance',
    ]);
  });

  it('a dry run publishes nothing and cannot sign', () => {
    const args = publishArgs({ file: 'a.tgz', version: '0.1.0', dryRun: true });
    expect(args).toContain('--dry-run');
    expect(args).toContain('--provenance=false');
    expect(args).not.toContain('--provenance');
  });

  it('never makes a pre-release the latest', () => {
    expect(distTag('0.1.0')).toBe('latest');
    expect(distTag('1.0.0-rc.1')).toBe('next');
    expect(publishArgs({ file: 'a.tgz', version: '1.0.0-rc.1', dryRun: false })).toContain('next');
  });
});

describe('renderSummary', () => {
  const steps: PublishStep[] = PUBLISH_ORDER.map((name) => ({
    name,
    version: '0.1.0',
    file: `${name}.tgz`,
    action: 'publish',
    note: 'not on the registry',
  }));

  it('names a partial publish, what is on the registry, what is left and how to recover', () => {
    const results = new Map<string, StepResult>([
      ['@hudhudjs/win32-job-x64', 'published'],
      ['@hudhudjs/core', 'failed'],
    ]);
    const text = renderSummary({
      tag: 'v0.1.0',
      dryRun: false,
      steps,
      results,
      problems: ['npm publish of @hudhudjs/core@0.1.0 failed (exit code 1)'],
      warnings: [],
    });
    expect(text).toContain('### PARTIAL PUBLISH: recovery');
    expect(text).toContain('On the registry now: `@hudhudjs/win32-job-x64@0.1.0`');
    expect(text).toContain(
      'Still to publish, in this order: `@hudhudjs/core@0.1.0`, `@hudhudjs/claude-code@0.1.0`, `hudhudjs@0.1.0`.',
    );
    expect(text).toContain('"Re-run failed jobs"');
    expect(text).toContain('do not unpublish');
    expect(text).toContain('`npm deprecate <name>@<version> "<reason>"`');
    expect(text).toContain(
      '| 2 | `@hudhudjs/core` | 0.1.0 | publish: not on the registry | failed |',
    );
  });

  it('says when nothing was published, and when everything is', () => {
    const none = renderSummary({
      tag: 'v0.1.0',
      dryRun: false,
      steps,
      results: new Map([['@hudhudjs/win32-job-x64', 'failed']]),
      problems: ['x'],
      warnings: [],
    });
    expect(none).toContain('### Nothing was published: recovery');
    const all = renderSummary({
      tag: 'v0.1.0',
      dryRun: false,
      steps,
      results: new Map(PUBLISH_ORDER.map((name) => [name, 'published'])),
      problems: [],
      warnings: [],
    });
    expect(all).toContain('Every package of v0.1.0 is on the registry.');
    expect(all).not.toContain('recovery');
  });

  it('names a re-run that found everything left on the registry already, and a refusal before any publish', () => {
    const skipped = renderSummary({
      tag: 'v0.1.0',
      dryRun: false,
      steps,
      results: new Map<string, StepResult>([
        ['@hudhudjs/win32-job-x64', 'skipped'],
        ['@hudhudjs/core', 'failed'],
      ]),
      problems: ['npm publish of @hudhudjs/core@0.1.0 failed (exit code 1)'],
      warnings: [],
    });
    expect(skipped).toContain('On the registry now: `@hudhudjs/win32-job-x64@0.1.0`. Still');
    expect(skipped).not.toContain('published by this run');
    const refused = renderSummary({
      tag: 'v0.1.0',
      dryRun: false,
      steps,
      results: new Map(),
      problems: ['hudhudjs@0.1.0 is already on the registry with other bytes'],
      warnings: ['a warning'],
    });
    expect(refused).toContain('### Nothing was published: recovery');
    expect(refused).toContain('2. Find the cause in the log of this step.');
    expect(refused).toContain('- Warning: a warning');
    expect(refused).toContain(
      '- Problem: hudhudjs@0.1.0 is already on the registry with other bytes',
    );
  });

  it('a failed dry run says so', () => {
    const text = renderSummary({
      tag: 'v0.1.0',
      dryRun: true,
      steps: [],
      results: new Map(),
      problems: ['x'],
      warnings: [],
    });
    expect(text).toContain('The dry run FAILED');
    expect(text).not.toContain('| # |');
  });

  it('labels a dry run, which never has a recovery', () => {
    const text = renderSummary({
      tag: 'v0.1.0',
      dryRun: true,
      steps,
      results: new Map(PUBLISH_ORDER.map((name) => [name, 'checked (dry run)'])),
      problems: [],
      warnings: [],
    });
    expect(text).toContain('## Release dry run v0.1.0');
    expect(text).toContain('Dry run: nothing was published.');
    expect(text).not.toContain('recovery');
  });
});

describe('gateProblems', () => {
  const sha = 'a'.repeat(40);
  const run = {
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  };

  it('passes a commit on main whose push run passed', () => {
    expect(gateProblems({ sha, compareStatus: 'identical', runs: [run] })).toEqual([]);
    expect(gateProblems({ sha, compareStatus: 'behind', runs: [run] })).toEqual([]);
  });

  it('refuses a commit that is not on main', () => {
    expect(gateProblems({ sha, compareStatus: 'ahead', runs: [run] })).toEqual([
      `the tagged commit ${sha} is not on main (compare main...${sha}: ahead); tag the merge commit of the version PR`,
    ]);
    expect(gateProblems({ sha, compareStatus: 'diverged', runs: [run] })).toHaveLength(1);
  });

  it('refuses a missing, running or failed push run, and runs of other commits or events', () => {
    expect(
      gateProblems({
        sha,
        compareStatus: 'identical',
        runs: [
          { ...run, head_sha: 'b'.repeat(40) },
          { ...run, event: 'pull_request' },
          { ...run, head_branch: 'v0.1.0' },
        ],
      }),
    ).toEqual([
      `no ci.yml run of a push to main for ${sha}: tag only the merge commit of the version PR, after its push run`,
    ]);
    expect(
      gateProblems({
        sha,
        compareStatus: 'identical',
        runs: [{ ...run, status: 'in_progress', conclusion: null }],
      })[0],
    ).toContain('has not completed');
    expect(
      gateProblems({ sha, compareStatus: 'identical', runs: [{ ...run, conclusion: 'failure' }] }),
    ).toEqual([
      `the ci.yml run of the push to main for ${sha} concluded failure, not success: fix main, release a new version`,
    ]);
  });
});

describe('shallowProblem (the dry run needs the history the version PR has)', () => {
  it('refuses a shallow clone and accepts a full one or no repository', () => {
    expect(shallowProblem(0, 'true\n')).toBe(
      'simulate-version needs the full history (a shallow clone; check out with fetch-depth: 0)',
    );
    expect(shallowProblem(0, 'false\n')).toBeNull();
    expect(shallowProblem(128, '')).toBeNull();
    expect(shallowProblem(null, '')).toBeNull();
  });
});

describe('simulatedRecord', () => {
  it('renames the committed record without touching its builds', () => {
    const dir = fileURLToPath(
      new URL('../../native/win32-job/release/0.0.0-dev/', import.meta.url),
    );
    const manifest = parseManifest(readFileSync(`${dir}manifest.json`, 'utf8'));
    if (typeof manifest === 'string') throw new Error(manifest);
    const files = simulatedRecord(manifest, '0.1.0');
    expect(files.SHA256SUMS).toBe(readFileSync(`${dir}SHA256SUMS`, 'utf8'));
    expect(files['toolchain.json']).toBe(readFileSync(`${dir}toolchain.json`, 'utf8'));
    expect(files['manifest.json']).toBe(
      readFileSync(`${dir}manifest.json`, 'utf8').replace(
        '"release": "0.0.0-dev"',
        '"release": "0.1.0"',
      ),
    );
  });
});
