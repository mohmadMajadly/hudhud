// Every package under packages/ ships the repository's LICENSE and NOTICE
// (Apache-2.0 §4(a) and §4(d); W7-Z). npm packs a LICENSE whatever `files`
// says, but not a NOTICE, so `files` names it. The copies are committed and
// must equal the root files byte for byte; `pnpm check:tarball` compares
// the packed copies again (scripts/lib/tarball.mjs `checkLegalFiles`).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

const packages = readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}`)
  .filter((dir) => existsSync(path.join(REPO, dir, 'package.json')));

describe('package LICENSE and NOTICE', () => {
  it('finds the five packages', () => {
    expect(packages.sort()).toEqual([
      'packages/claude-code',
      'packages/core',
      'packages/hudhud',
      'packages/win32-job-arm64',
      'packages/win32-job-x64',
    ]);
  });

  describe.each(packages)('%s', (dir) => {
    it.each(['LICENSE', 'NOTICE'])('carries the repository %s byte for byte', (name) => {
      const copy = readFileSync(path.join(REPO, dir, name));
      expect(copy.equals(readFileSync(path.join(REPO, name)))).toBe(true);
    });

    it('lists NOTICE in files, so the tarball carries it', () => {
      const manifest = JSON.parse(readFileSync(path.join(REPO, dir, 'package.json'), 'utf8')) as {
        files?: unknown;
      };
      expect(manifest.files).toEqual(expect.arrayContaining(['NOTICE']));
    });
  });
});
