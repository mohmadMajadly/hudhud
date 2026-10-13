import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSchemaSource, parseSchemaSource } from '../lib/schema/source.mjs';

const valid = {
  documents: [
    {
      file: 'a.schema.json',
      title: 'A',
      description: 'd',
      root: 'A',
      defs: { A: { type: 'object' } },
    },
  ],
  data: [{ file: 'version.json', json: { wireSchemaVersion: 1 } }],
  validators: [
    {
      name: 'validateA',
      schema: 'a.schema.json',
      def: 'A',
      type: { from: '../types.js', name: 'A' },
    },
  ],
};

/** A module namespace with `schemaSource` replaced at one path. */
function withChange(change: (copy: typeof valid) => void): unknown {
  const copy = structuredClone(valid);
  change(copy);
  return { schemaSource: copy };
}

describe('parseSchemaSource', () => {
  it('returns the export as plain JSON, dropping non-enumerable markers', () => {
    const def = { type: 'object' };
    Object.defineProperty(def, '~kind', { value: 'Object', enumerable: false });
    const parsed = parseSchemaSource(
      withChange((copy) => {
        Object.assign(copy.documents[0] ?? {}, { defs: { A: def } });
      }),
      'entry',
    );
    expect(parsed).toEqual(valid);
    expect(Object.getOwnPropertyNames(parsed.documents[0]?.defs['A'])).toEqual(['type']);
  });

  it('refuses a namespace without a schemaSource object', () => {
    expect(() => parseSchemaSource({}, 'entry')).toThrow(/entry: export "schemaSource"/);
    expect(() => parseSchemaSource(42, 'entry')).toThrow(/export "schemaSource"/);
  });

  it.each([
    ['documents not an array', (c: typeof valid) => Object.assign(c, { documents: {} })],
    ['a document not an object', (c: typeof valid) => Object.assign(c, { documents: [1] })],
    ['defs not an object', (c: typeof valid) => Object.assign(c.documents[0] ?? {}, { defs: [] })],
    [
      'a def not an object',
      (c: typeof valid) => Object.assign(c.documents[0] ?? {}, { defs: { A: true } }),
    ],
    [
      'a bad file name',
      (c: typeof valid) => Object.assign(c.documents[0] ?? {}, { file: '../a.json' }),
    ],
    ['an empty title', (c: typeof valid) => Object.assign(c.documents[0] ?? {}, { title: '' })],
    ['a non-string root', (c: typeof valid) => Object.assign(c.documents[0] ?? {}, { root: 1 })],
    ['data json not an object', (c: typeof valid) => Object.assign(c.data[0] ?? {}, { json: [] })],
    [
      'a bad validator name',
      (c: typeof valid) => Object.assign(c.validators[0] ?? {}, { name: 'a-b' }),
    ],
    [
      'a validator without type',
      (c: typeof valid) => Object.assign(c.validators[0] ?? {}, { type: 'x' }),
    ],
    [
      'a non-relative type module',
      (c: typeof valid) =>
        Object.assign(c.validators[0] ?? {}, { type: { from: 'pkg', name: 'A' } }),
    ],
  ])('refuses %s', (_name, change) => {
    expect(() => parseSchemaSource(withChange(change), 'entry')).toThrow(/^entry: /);
  });
});

describe('loadSchemaSource', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-schema-src-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  });

  it('bundles and imports a TypeScript entry with relative imports', async () => {
    writeFileSync(
      path.join(root, 'defs.ts'),
      "export const A: { readonly type: string } = { type: 'object' };\n",
    );
    writeFileSync(
      path.join(root, 'entry.ts'),
      [
        "import { A } from './defs.js';",
        'interface Source { documents: unknown[]; data: unknown[]; validators: unknown[] }',
        'export const schemaSource: Source = {',
        "  documents: [{ file: 'a.schema.json', title: 'A', description: 'd', root: 'A', defs: { A } }],",
        "  data: [{ file: 'version.json', json: { wireSchemaVersion: 1 } }],",
        "  validators: [{ name: 'validateA', schema: 'a.schema.json', def: 'A', type: { from: '../types.js', name: 'A' } }],",
        '};',
      ].join('\n'),
    );
    await expect(loadSchemaSource(root, 'entry.ts')).resolves.toEqual(valid);
  });

  it('fails on an entry that does not build', async () => {
    writeFileSync(
      path.join(root, 'entry.ts'),
      "import { x } from './missing.js';\nexport { x };\n",
    );
    await expect(loadSchemaSource(root, 'entry.ts')).rejects.toThrow();
  });
});
