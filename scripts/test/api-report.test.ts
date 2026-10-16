// Tests of the API report driver's package and entry-point discovery. No
// case here reaches API Extractor itself: every fixture package either has
// no config or fails before one is loaded.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkReports, entryPoints, isJsonSubpath, isNativeSubpath } from '../api-report.mjs';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-api-report-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10 });
});

function write(file: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

function manifest(name: string, fields: Record<string, unknown>): void {
  write(`packages/${name}/package.json`, JSON.stringify({ name, ...fields }));
}

const ENTRY = { types: './dist/index.d.ts', default: './dist/index.js' };

describe('isJsonSubpath', () => {
  it.each([
    ['./package.json', true],
    ['./schemas/*.json', true],
    [{ default: './schemas/*.json' }, true],
    [{ import: { default: './a.json' }, require: './a.json' }, true],
    [ENTRY, false],
    [{ types: './x.d.ts', default: './x.json' }, false],
    ['./dist/index.js', false],
    [{}, false],
    [null, false],
  ])('%j -> %s', (target, expected) => {
    expect(isJsonSubpath(target)).toBe(expected);
  });
});

describe('isNativeSubpath', () => {
  it.each([
    ['./hudhud_win32_job.node', true],
    [{ default: './a.node' }, true],
    [{ default: './a.node', types: './a.d.ts' }, false],
    ['./package.json', false],
    [ENTRY, false],
    [{}, false],
    [null, false],
  ])('%j -> %s', (target, expected) => {
    expect(isNativeSubpath(target)).toBe(expected);
  });
});

describe('entryPoints', () => {
  it('returns undefined for a package without an exports field', () => {
    manifest('native', { main: './index.node' });
    expect(entryPoints(path.join(root, 'packages/native'))).toBeUndefined();
  });

  it('skips JSON subpaths, including ./schemas/* and ./package.json', () => {
    manifest('lib', {
      exports: {
        '.': ENTRY,
        './schemas/*': './schemas/*.json',
        './package.json': './package.json',
      },
    });
    expect(entryPoints(path.join(root, 'packages/lib'))).toEqual([
      path.join(root, 'packages/lib/dist/index.d.ts'),
    ]);
  });

  it('skips native addon subpaths (prebuilt platform packages)', () => {
    manifest('platform', {
      exports: {
        './hudhud_win32_job.node': './hudhud_win32_job.node',
        './package.json': './package.json',
      },
    });
    expect(entryPoints(path.join(root, 'packages/platform'))).toEqual([]);
    expect(checkReports(root, { localBuild: false })).toEqual({ problems: [], checked: 0 });
  });

  it('rejects a code subpath without a types condition', () => {
    manifest('lib', { exports: { '.': ENTRY, './raw': './dist/raw/index.js' } });
    expect(() => entryPoints(path.join(root, 'packages/lib'))).toThrow(
      'lib: export ./raw has no "types" condition',
    );
  });

  it('rejects an exports field that is not a subpath map', () => {
    manifest('lib', { exports: './dist/index.js' });
    expect(() => entryPoints(path.join(root, 'packages/lib'))).toThrow(
      'lib: "exports" must be a subpath map',
    );
  });
});

describe('checkReports', () => {
  it('skips packages without exports, JSON-only exports and non-packages', () => {
    manifest('native', { main: './index.node' });
    manifest('data', { exports: { './schemas/*': './schemas/*.json' } });
    mkdirSync(path.join(root, 'packages/not-a-package'), { recursive: true });
    expect(checkReports(root, { localBuild: false })).toEqual({ problems: [], checked: 0 });
  });

  it('fails a package without exports that still has API Extractor configs or reports', () => {
    manifest('a-config', {});
    write('packages/a-config/api-extractor.json', '{}');
    manifest('b-report', {});
    write('packages/b-report/api/b-report.api.md', '');
    expect(checkReports(root, { localBuild: false }).problems).toEqual([
      'a-config: API Extractor configs or reports, but no "exports" field',
      'b-report: API Extractor configs or reports, but no "exports" field',
    ]);
  });

  it('fails an exported entry point without a config and a report without a config', () => {
    manifest('lib', { exports: { '.': ENTRY, './schemas/*': './schemas/*.json' } });
    write('packages/lib/api/stale.api.md', '');
    expect(checkReports(root, { localBuild: false }).problems).toEqual([
      `lib: exported entry point ${path.join('packages', 'lib', 'dist', 'index.d.ts')} has no API Extractor config`,
      'lib/api/stale.api.md: report without a config (stale?)',
    ]);
  });
});
