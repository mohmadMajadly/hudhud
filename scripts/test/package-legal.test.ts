// Every package under packages/ ships the repository's LICENSE and NOTICE
// (Apache-2.0 §4(a) and §4(d); W7-Z). npm packs a LICENSE whatever `files`
// says, but not a NOTICE, so `files` names it. The LICENSE copies are
// committed and must equal the root file byte for byte. A NOTICE copy must
// begin with the root NOTICE; after it, a package lists the third-party code
// it bundles, each under a `--- <package> ---` heading followed by that
// package's own license text, exactly (review finding R6-2: the generated
// validators of @hudhudjs/claude-code inline Ajv's and fast-deep-equal's
// MIT-licensed code). `pnpm check:tarball` checks the packed copies again
// (scripts/lib/tarball.mjs `checkLegalFiles`, `checkBundledNotices`).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bundledPackages } from '../lib/tarball.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ROOT_NOTICE = readFileSync(path.join(REPO, 'NOTICE'), 'utf8');

const packages = readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}`)
  .filter((dir) => existsSync(path.join(REPO, dir, 'package.json')));

/** Every TypeScript and JavaScript file under a directory, recursively. */
function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:[cm]?js|[cm]?ts)$/u.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** The third-party packages a package's sources bundle (esbuild markers). */
function bundledBy(dir: string): string[] {
  const names = sources(path.join(REPO, dir, 'src')).flatMap((file) =>
    bundledPackages(readFileSync(file, 'utf8')),
  );
  return [...new Set(names)].sort();
}

/**
 * The LICENSE text of an installed package, resolved from the repository
 * root or from the directory of another bundled package (fast-deep-equal is
 * a dependency of Ajv, not of the repository).
 */
function licenseOf(name: string, from: readonly string[]): string {
  for (const base of [REPO, ...from]) {
    try {
      const manifest = createRequire(path.join(base, 'noop.js')).resolve(`${name}/package.json`);
      return readFileSync(path.join(path.dirname(manifest), 'LICENSE'), 'utf8');
    } catch {
      // try the next base
    }
  }
  throw new Error(`cannot resolve the installed ${name} and its LICENSE`);
}

/** The directories of the installed packages, for nested resolution. */
function packageDirs(names: readonly string[]): string[] {
  return names.flatMap((name) => {
    try {
      return [
        path.dirname(createRequire(path.join(REPO, 'noop.js')).resolve(`${name}/package.json`)),
      ];
    } catch {
      return [];
    }
  });
}

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

  it('knows what the generated validators bundle today', () => {
    expect(bundledBy('packages/claude-code')).toEqual(['ajv', 'fast-deep-equal']);
    expect(bundledBy('packages/core')).toEqual([]);
  });

  describe.each(packages)('%s', (dir) => {
    it('carries the repository LICENSE byte for byte', () => {
      const copy = readFileSync(path.join(REPO, dir, 'LICENSE'));
      expect(copy.equals(readFileSync(path.join(REPO, 'LICENSE')))).toBe(true);
    });

    it('carries the repository NOTICE, then the license of every package it bundles', () => {
      const notice = readFileSync(path.join(REPO, dir, 'NOTICE'), 'utf8');
      expect(notice.startsWith(ROOT_NOTICE)).toBe(true);
      const rest = notice.slice(ROOT_NOTICE.length);
      const bundled = bundledBy(dir);
      if (bundled.length === 0) {
        expect(rest).toBe('');
        return;
      }
      const headings = [...rest.matchAll(/^--- (\S+) ---$/gmu)].map((match) => String(match[1]));
      expect(headings).toEqual(bundled);
      const dirs = packageDirs(bundled);
      for (const name of bundled) {
        expect(rest).toContain(`\n--- ${name} ---\n\n${licenseOf(name, dirs)}`);
      }
    });

    it('lists NOTICE in files, so the tarball carries it', () => {
      const manifest = JSON.parse(readFileSync(path.join(REPO, dir, 'package.json'), 'utf8')) as {
        files?: unknown;
      };
      expect(manifest.files).toEqual(expect.arrayContaining(['NOTICE']));
    });
  });
});
