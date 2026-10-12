import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importBuilt } from '../../../scripts/test/support/import-built.mjs';
import { adapterApiVersion } from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

describe('@hudhud/core', () => {
  it('exports the adapter API version as a positive integer', () => {
    expect(adapterApiVersion).toBe(1);
    expect(Number.isSafeInteger(adapterApiVersion)).toBe(true);
  });

  it('resolves every entry point of the exports map from the built output', () => {
    const results = importBuilt(packageDir, [
      '@hudhud/core',
      '@hudhud/core/protocol',
      '@hudhud/core/process',
    ]);
    expect(results).toEqual({
      '@hudhud/core': { ok: true, file: 'dist/index.js', exports: { adapterApiVersion: 1 } },
      '@hudhud/core/protocol': { ok: true, file: 'dist/protocol/index.js', exports: {} },
      '@hudhud/core/process': { ok: true, file: 'dist/process/index.js', exports: {} },
    });
  });

  it('does not expose files outside the exports map', () => {
    const results = importBuilt(packageDir, [
      '@hudhud/core/dist/index.js',
      '@hudhud/core/src/index.ts',
    ]);
    expect(results).toEqual({
      '@hudhud/core/dist/index.js': { ok: false, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
      '@hudhud/core/src/index.ts': { ok: false, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
    });
  });
});
