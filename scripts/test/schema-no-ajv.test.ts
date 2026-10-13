// check:no-ajv (ADR-0005 §4): passes on clean built output and fails on a
// planted Ajv import in any form a consumer would load.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanBuiltOutput } from '../lib/schema/no-ajv.mjs';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-no-ajv-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10 });
});

function put(file: string, text: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/** Clean output that mentions Ajv only in strings and comments. */
function cleanPackage(): void {
  put(
    'packages/a/dist/index.js',
    "import { y } from './y.js';\nexport const x = y;\n// import 'ajv'\n",
  );
  put(
    'packages/a/dist/protocol/generated/validators.gen.js',
    'var f = function () {};\nf.code = \'require("ajv/dist/runtime/ucs2length").default\';\n',
  );
  put('packages/a/dist/index.d.ts', 'export declare const x = 1;\n');
  put('packages/a/dist/index.js.map', '{"sources":["ajv"]}');
  put('packages/a/src/index.ts', "import 'ajv';\n");
  put('packages/b/package.json', '{}');
}

describe('scanBuiltOutput', () => {
  it('passes on clean output and counts the scanned files', () => {
    cleanPackage();
    expect(scanBuiltOutput(root)).toEqual({ scanned: 3, imports: [] });
  });

  it('reports nothing scanned when there is no build', () => {
    put('packages/a/src/index.ts', 'export {};\n');
    expect(scanBuiltOutput(root)).toEqual({ scanned: 0, imports: [] });
  });

  it.each([
    ['a static import', 'dist/a.js', "import 'ajv';\n", 'ajv'],
    [
      'a named import',
      'dist/b.mjs',
      "import { Ajv } from 'ajv/dist/2020.js';\n",
      'ajv/dist/2020.js',
    ],
    [
      'a require call',
      'dist/c.cjs',
      'const e = require("ajv/dist/runtime/equal");\n',
      'ajv/dist/runtime/equal',
    ],
    ['a dynamic import', 'dist/nested/d.js', "await import('ajv-formats');\n", 'ajv-formats'],
    ['a re-export', 'dist/e.js', "export * from 'ajv';\n", 'ajv'],
    [
      'a declaration import',
      'dist/f.d.ts',
      "import type { ValidateFunction } from 'ajv';\n",
      'ajv',
    ],
    ['a type reference', 'dist/g.d.mts', '/// <reference types="ajv" />\n', 'ajv'],
  ])('fails on %s', (_name, file, text, specifier) => {
    cleanPackage();
    put(`packages/a/${file}`, text);
    expect(scanBuiltOutput(root).imports).toEqual([{ file: `packages/a/${file}`, specifier }]);
  });

  it('scans another packages directory', () => {
    put('other/a/dist/x.js', "import 'ajv';\n");
    expect(scanBuiltOutput(root, 'other')).toEqual({
      scanned: 1,
      imports: [{ file: 'other/a/dist/x.js', specifier: 'ajv' }],
    });
  });
});
