// The versioning model the release tag relies on (ADR-0004 amendment of
// 2026-10-17, ADR-0014 amendment 10; review findings R6-3, R7-2, R7-5):
// `hudhudjs`, `@hudhudjs/core` and `@hudhudjs/claude-code` are one changesets
// `fixed` group, so they always carry one version and a `v<version>` tag
// names it; the addon package stays outside it, versioned by its release
// record; the arm64 addon package stays private (K17).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkRepositoryFields, type PackageJson } from '../lib/tarball.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

interface ChangesetsConfig {
  readonly fixed?: unknown;
  readonly linked?: unknown;
  readonly privatePackages?: unknown;
}

function read(file: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO, file), 'utf8'));
}

describe('release versioning', () => {
  const config = read('.changeset/config.json') as ChangesetsConfig;

  it('releases the three library packages in one fixed group', () => {
    expect(config.fixed).toEqual([['hudhudjs', '@hudhudjs/core', '@hudhudjs/claude-code']]);
    expect(config.linked).toEqual([]);
  });

  it('leaves the addon packages out of it, and the arm64 one private', () => {
    const fixed = JSON.stringify(config.fixed);
    expect(fixed).not.toContain('win32-job');
    const arm64 = read('packages/win32-job-arm64/package.json') as {
      private?: unknown;
      publishConfig?: unknown;
    };
    expect(arm64.private).toBe(true);
    expect(arm64.publishConfig).toBeUndefined();
  });

  it('publishes the four packages publicly with provenance, and nothing else (checklist 4.2)', () => {
    expect((config as { access?: unknown }).access).toBe('public');
    for (const dir of [
      'packages/hudhud',
      'packages/core',
      'packages/claude-code',
      'packages/win32-job-x64',
    ]) {
      const manifest = read(`${dir}/package.json`) as {
        private?: unknown;
        publishConfig?: unknown;
      };
      expect(manifest.private, dir).toBeUndefined();
      expect(manifest.publishConfig, dir).toEqual({ access: 'public', provenance: true });
    }
    for (const dir of ['packages/win32-job-arm64', 'tooling/test-support', '.']) {
      const manifest = read(`${dir}/package.json`) as {
        private?: unknown;
        publishConfig?: unknown;
      };
      expect(manifest.private, dir).toBe(true);
      expect(manifest.publishConfig, dir).toBeUndefined();
    }
  });

  it('gives the three library packages one version today', () => {
    const versions = ['packages/hudhud', 'packages/core', 'packages/claude-code'].map(
      (dir) => (read(`${dir}/package.json`) as { version?: unknown }).version,
    );
    expect(new Set(versions).size).toBe(1);
  });

  it('every published package links its source in the same repository (R6-4)', () => {
    const published = [
      'packages/hudhud',
      'packages/core',
      'packages/claude-code',
      'packages/win32-job-x64',
    ];
    const core = read('packages/core/package.json') as { repository?: { url?: unknown } };
    const slug = /^git\+https:\/\/github\.com\/([^/]+\/hudhud)\.git$/u.exec(
      String(core.repository?.url),
    )?.[1];
    expect(slug).toBeDefined();
    for (const dir of published) {
      const manifest = read(`${dir}/package.json`) as PackageJson;
      expect(manifest.publishConfig).toBeDefined();
      expect(checkRepositoryFields(manifest, dir, String(slug))).toEqual([]);
    }
    const arm64 = read('packages/win32-job-arm64/package.json') as Record<string, unknown>;
    expect(arm64['repository']).toBeUndefined();
  });
});
