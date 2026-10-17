// Shape of the job addon platform packages (plan §6.2, K17) and how the core
// depends on them: os/cpu, exports, files, no scripts, no dependencies,
// provenance, and the never-committed addon.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WIN32_JOB_ADDON_SPECIFIER } from '../../packages/core/src/process/containment/win32-job.js';
import { isPublishable } from '../lib/tarball.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

function read(file: string): string {
  return readFileSync(path.join(REPO, file), 'utf8');
}

function manifest(dir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(read(`${dir}/package.json`));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${dir}: not an object`);
  return parsed as Record<string, unknown>;
}

const core = manifest('packages/core');

describe.each([
  // x64 is published: private until the release flow lifts the flag, like
  // every published package here (they all declare publishConfig).
  ['x64', 'packages/win32-job-x64', { publishConfig: { access: 'public', provenance: true } }],
  // ARM64 stays private in v1 (K17, lead ruling on A2): no publishConfig, so
  // neither the release flow nor the tarball check treats it as published.
  ['arm64', 'packages/win32-job-arm64', {}],
])('the %s platform package', (cpu, dir, publish) => {
  const pkg = manifest(dir);

  it('declares exactly the plan §6.2 manifest', () => {
    expect(pkg).toEqual({
      name: `@hudhudjs/win32-job-${cpu}`,
      // Versioned with the other packages by changesets (ADR-0004).
      version: core['version'],
      private: true,
      description: expect.any(String) as string,
      license: 'Apache-2.0',
      os: ['win32'],
      cpu: [cpu],
      exports: {
        './hudhud_win32_job.node': './hudhud_win32_job.node',
        './package.json': './package.json',
      },
      files: ['hudhud_win32_job.node', 'SHA256SUMS', 'NOTICE'],
      engines: core['engines'],
      ...publish,
    });
    expect(isPublishable(pkg)).toBe(cpu === 'x64');
  });

  it('has no scripts and no dependencies of any kind', () => {
    for (const field of [
      'scripts',
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'bundleDependencies',
      'bundledDependencies',
      'main',
      'bin',
    ]) {
      expect(pkg).not.toHaveProperty(field);
    }
  });

  it('carries the repository license and notice and never commits the addon', () => {
    expect(read(`${dir}/LICENSE`)).toBe(read('LICENSE'));
    expect(read(`${dir}/NOTICE`)).toBe(read('NOTICE'));
    const ignored = read(`${dir}/.gitignore`)
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(ignored).toEqual(['hudhud_win32_job.node', 'SHA256SUMS', 'toolchain.json']);
  });
});

describe('the core', () => {
  it('depends optionally on the x64 package the loader resolves, never on arm64 (K17)', () => {
    expect(core['optionalDependencies']).toEqual({ '@hudhudjs/win32-job-x64': 'workspace:*' });
    expect(WIN32_JOB_ADDON_SPECIFIER.startsWith('@hudhudjs/win32-job-x64/')).toBe(true);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      expect(JSON.stringify(core[field] ?? {})).not.toContain('win32-job');
    }
  });

  it('is the only workspace package that depends on a platform package', () => {
    for (const dir of ['packages/claude-code', 'packages/hudhud', 'tooling/test-support']) {
      expect(read(`${dir}/package.json`)).not.toContain('win32-job');
    }
  });
});
