import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importBuilt } from '../../../scripts/test/support/import-built.mjs';
import * as umbrella from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const dependencies = ['@hudhud/core', '@hudhud/claude-code'];

describe('hudhud (umbrella)', () => {
  it('re-exports the core constants', () => {
    expect({ ...umbrella }).toEqual({ adapterApiVersion: 1 });
  });

  it('resolves from the built output with exactly the exports of its dependencies', () => {
    const results = importBuilt(packageDir, ['hudhud', ...dependencies]);
    const expected = {};
    for (const dependency of dependencies) {
      const result = results[dependency];
      if (result?.ok !== true) throw new Error(`${dependency} did not resolve`);
      Object.assign(expected, result.exports);
    }
    expect(results['hudhud']).toEqual({ ok: true, file: 'dist/index.js', exports: expected });
  });
});
