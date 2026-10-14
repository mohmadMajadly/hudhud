import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importBuilt } from '../../../scripts/test/support/import-built.mjs';
import * as umbrella from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const dependencies = ['@hudhud/core', '@hudhud/claude-code'];

describe('hudhud (umbrella)', () => {
  it('re-exports the core and the Claude Code entry points', () => {
    expect(umbrella.adapterApiVersion).toBe(1);
    expect(umbrella.wireSchemaVersion).toBe(1);
    expect(Object.keys(umbrella)).toEqual(
      expect.arrayContaining(['HudhudError', 'connect', 'session', 'hudhud', 'CLAUDE_CODE_COMPAT']),
    );
    expect(umbrella.hudhud.connect).toBe(umbrella.connect);
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

  it('leaves out the unstable raw tier and the adapter-author entry points', () => {
    const names = Object.keys(umbrella);
    for (const absent of [
      'raw',
      'createSessionRaw',
      'createSession',
      'HarnessBase',
      'openSession',
      'Fanout',
      'encodeJsonLine',
      'spawnHarnessProcess',
    ]) {
      expect(names).not.toContain(absent);
    }
  });

  it('does not expose files outside the exports map', () => {
    expect(importBuilt(packageDir, ['hudhud/dist/index.js'])).toEqual({
      'hudhud/dist/index.js': { ok: false, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
    });
  });
});
