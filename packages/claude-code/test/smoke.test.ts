import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importBuilt } from '../../../scripts/test/support/import-built.mjs';
import * as raw from '../src/raw/index.js';
import * as root from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

describe('@hudhud/claude-code', () => {
  it('exports nothing yet from its placeholder entry points', () => {
    expect(Object.keys(root)).toEqual([]);
    expect(Object.keys(raw)).toEqual([]);
  });

  it('resolves every entry point of the exports map from the built output', () => {
    const results = importBuilt(packageDir, ['@hudhud/claude-code', '@hudhud/claude-code/raw']);
    expect(results).toEqual({
      '@hudhud/claude-code': { ok: true, file: 'dist/index.js', exports: {}, names: [] },
      '@hudhud/claude-code/raw': { ok: true, file: 'dist/raw/index.js', exports: {}, names: [] },
    });
  });

  it('does not expose files outside the exports map', () => {
    const results = importBuilt(packageDir, ['@hudhud/claude-code/dist/raw/index.js']);
    expect(results).toEqual({
      '@hudhud/claude-code/dist/raw/index.js': { ok: false, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
    });
  });
});
