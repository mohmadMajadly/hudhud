import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importBuilt } from '../../../scripts/test/support/import-built.mjs';
import * as umbrella from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const dependencies = ['@hudhud/core', '@hudhud/claude-code'];

describe('hudhud (umbrella)', () => {
  it('re-exports the core entry point', () => {
    expect(umbrella.adapterApiVersion).toBe(1);
    expect(umbrella.wireSchemaVersion).toBe(1);
    expect(Object.keys(umbrella)).toContain('HudhudError');
  });

  it('resolves from the built output with exactly the exports of its dependencies', () => {
    const results = importBuilt(packageDir, ['hudhud', ...dependencies]);
    const expected = {};
    const names = new Set<string>();
    for (const dependency of dependencies) {
      const result = results[dependency];
      if (result?.ok !== true) throw new Error(`${dependency} did not resolve`);
      Object.assign(expected, result.exports);
      for (const name of result.names) names.add(name);
    }
    expect(results['hudhud']).toEqual({
      ok: true,
      file: 'dist/index.js',
      exports: expected,
      names: [...names].sort(),
    });
  });
});
