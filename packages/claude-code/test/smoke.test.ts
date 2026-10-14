import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importBuilt } from '../../../scripts/test/support/import-built.mjs';
import * as raw from '../src/raw/index.js';
import * as root from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Run-time export names of each entry point (types are checked by the API reports). */
const ROOT_NAMES = ['CLAUDE_CODE_COMPAT', 'connect', 'hudhud', 'session'];
const RAW_NAMES = ['createSessionRaw', 'raw'];

describe('@hudhud/claude-code', () => {
  it('exports exactly the planned run-time names from source', () => {
    expect(Object.keys(root).sort()).toEqual(ROOT_NAMES);
    expect(Object.keys(raw).sort()).toEqual(RAW_NAMES);
  });

  it('resolves every entry point of the exports map from the built output', () => {
    const results = importBuilt(packageDir, ['@hudhud/claude-code', '@hudhud/claude-code/raw']);
    expect(results).toEqual({
      '@hudhud/claude-code': {
        ok: true,
        file: 'dist/index.js',
        exports: { CLAUDE_CODE_COMPAT: root.CLAUDE_CODE_COMPAT, hudhud: {} },
        names: ROOT_NAMES,
      },
      '@hudhud/claude-code/raw': {
        ok: true,
        file: 'dist/raw/index.js',
        exports: {},
        names: RAW_NAMES,
      },
    });
  });

  it('keeps the public bundle and the tested window consistent', () => {
    expect(root.hudhud.connect).toBe(root.connect);
    expect(root.hudhud.session).toBe(root.session);
    expect(Object.keys(root.hudhud).sort()).toEqual(['connect', 'session']);
    expect(Object.keys(root.CLAUDE_CODE_COMPAT).sort()).toEqual([
      'knownBroken',
      'maxTested',
      'minTested',
    ]);
    expect(Object.isFrozen(root.CLAUDE_CODE_COMPAT)).toBe(true);
  });

  it('exposes no internal through either entry point', () => {
    const exported: readonly string[] = [...ROOT_NAMES, ...RAW_NAMES];
    for (const internal of [
      'connectWith',
      'sessionWith',
      'claudeHarnessOf',
      'disposeWhenClosed',
      'CLAUDE_CODE_ADAPTER',
      'nodeHost',
      'RawChannel',
      'rawChannelOf',
      'openSession',
      'prepareSession',
      'compatStatus',
      'CLAUDE_CODE_KNOWN_BROKEN',
    ]) {
      expect(exported).not.toContain(internal);
    }
  });

  it('does not expose files outside the exports map', () => {
    const results = importBuilt(packageDir, ['@hudhud/claude-code/dist/raw/index.js']);
    expect(results).toEqual({
      '@hudhud/claude-code/dist/raw/index.js': { ok: false, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
    });
  });
});
