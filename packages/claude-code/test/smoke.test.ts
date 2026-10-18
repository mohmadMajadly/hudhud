import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importBuilt } from '../../../scripts/test/support/import-built.mjs';
import * as raw from '../src/raw/index.js';
import * as root from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Run-time export names of each entry point (types are checked by the API reports). */
const ROOT_NAMES = ['CLAUDE_CODE_COMPAT', 'connect', 'hudhud', 'session'];
const RAW_NAMES = ['RAW_CONTROL_MAX_IN_FLIGHT', 'createSessionRaw', 'raw'];

describe('@hudhudjs/claude-code', () => {
  it('exports exactly the planned run-time names from source', () => {
    expect(Object.keys(root).sort()).toEqual(ROOT_NAMES);
    expect(Object.keys(raw).sort()).toEqual(RAW_NAMES);
  });

  it('resolves every entry point of the exports map from the built output', () => {
    const results = importBuilt(packageDir, ['@hudhudjs/claude-code', '@hudhudjs/claude-code/raw']);
    expect(results).toEqual({
      '@hudhudjs/claude-code': {
        ok: true,
        file: 'dist/index.js',
        exports: { CLAUDE_CODE_COMPAT: root.CLAUDE_CODE_COMPAT, hudhud: {} },
        names: ROOT_NAMES,
      },
      '@hudhudjs/claude-code/raw': {
        ok: true,
        file: 'dist/raw/index.js',
        exports: { RAW_CONTROL_MAX_IN_FLIGHT: 64 },
        names: RAW_NAMES,
      },
    });
  });

  // R5-6: the documented specifier names the schema file (`.json`); the one
  // without `.json` resolves to the same file.
  it('imports every schema by its file name and without .json', () => {
    const names = readdirSync(new URL('../schemas/', import.meta.url)).filter((name) =>
      name.endsWith('.json'),
    );
    expect(names).toContain('options.schema.json');
    const forms = (name: string) => [
      `@hudhudjs/claude-code/schemas/${name}`,
      `@hudhudjs/claude-code/schemas/${name.slice(0, -'.json'.length)}`,
    ];
    const results = importBuilt(packageDir, names.flatMap(forms));
    for (const name of names) {
      for (const specifier of forms(name)) {
        expect(results[specifier]).toMatchObject({
          ok: true,
          file: `schemas/${name}`,
          names: ['default'],
        });
      }
    }
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
    const results = importBuilt(packageDir, ['@hudhudjs/claude-code/dist/raw/index.js']);
    expect(results).toEqual({
      '@hudhudjs/claude-code/dist/raw/index.js': {
        ok: false,
        code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      },
    });
  });
});
