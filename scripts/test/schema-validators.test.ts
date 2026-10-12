import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

import { composeDocument } from '../lib/schema/compose.mjs';
import { isAjvSpecifier, moduleSpecifiers } from '../lib/schema/imports.mjs';
import { generateValidatorModule } from '../lib/schema/validators.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

const item = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    tags: { type: 'array', uniqueItems: true },
  },
  additionalProperties: false,
};
const list = {
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array', items: item } },
};

const documents = new Map([
  [
    'fixture.schema.json',
    composeDocument(
      {
        file: 'fixture.schema.json',
        title: 'Fixture',
        description: 'd',
        root: 'List',
        defs: { Item: item, List: list },
      },
      'fixture',
    ),
  ],
]);

const validators = [
  {
    name: 'validateItem',
    schema: 'fixture.schema.json',
    def: 'Item',
    type: { from: '../types.js', name: 'Item' },
  },
  {
    name: 'validateList',
    schema: 'fixture.schema.json',
    def: 'List',
    type: { from: '../types.js', name: 'List' },
  },
  {
    name: 'validateAny',
    schema: 'fixture.schema.json',
    def: 'Item',
    type: { from: '../json.js', name: 'JsonObject' },
  },
];

const options = {
  root,
  schemaIdPrefix: 'urn:hudhud:test:',
  documents,
  validators,
  generatedFrom: 'fixture',
};

interface CheckResult {
  ok: boolean;
  value?: unknown;
  issue?: { instancePath: string; schemaPath: string; keyword: string };
}
type Validate = (value: unknown) => CheckResult;

/** Strips the types of a generated module and imports it. */
async function load(source: string): Promise<Record<string, Validate>> {
  const { code } = await esbuild.transform(source, { loader: 'ts', format: 'esm' });
  const dir = mkdtempSync(path.join(tmpdir(), 'hudhud-validators-'));
  try {
    const file = path.join(dir, 'validators.mjs');
    writeFileSync(file, code);
    return (await import(pathToFileURL(file).href)) as Record<string, Validate>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generateValidatorModule', () => {
  it('generates a self-contained typed module', async () => {
    const source = await generateValidatorModule(options);
    expect(source.startsWith('// @ts-nocheck\n')).toBe(true);
    expect(source).toContain(
      "import type { JsonObject } from '../json.js';\nimport type { Item, List } from '../types.js';\n",
    );
    expect(source).toContain(
      'export const validateList: (value: unknown) => SchemaCheck<List> =\n  __hudhudValidators.validateList;',
    );
    // Only the type imports above: the Ajv runtime helpers are bundled.
    expect(moduleSpecifiers(source)).toEqual(['../json.js', '../types.js']);
    expect(source).toContain('function ucs2length(');
    expect(source).not.toMatch(/node_modules\/\.pnpm/);
    expect(source).not.toMatch(/\beval\s*\(|\bFunction\s*\(/);
  });

  it('is deterministic', async () => {
    expect(await generateValidatorModule(options)).toBe(await generateValidatorModule(options));
  });

  it('produces validators that return results instead of throwing', async () => {
    const module = await load(await generateValidatorModule(options));
    const { validateItem, validateList } = module;
    if (validateItem === undefined || validateList === undefined) throw new Error('missing export');
    const value = { name: 'n', tags: [1, 2] };
    expect(validateItem(value)).toEqual({ ok: true, value });
    expect(validateItem({ name: '' })).toEqual({
      ok: false,
      issue: {
        instancePath: '/name',
        schemaPath: '#/properties/name/minLength',
        keyword: 'minLength',
      },
    });
    expect(validateItem({ name: 'n', tags: [1, 1] }).issue?.keyword).toBe('uniqueItems');
    expect(validateList({ items: [{ name: 'n', extra: 1 }] }).issue).toEqual({
      instancePath: '/items/0',
      schemaPath: '#/additionalProperties',
      keyword: 'additionalProperties',
    });
    expect(validateList('x').ok).toBe(false);
  });

  it('refuses an empty validator list and unknown definitions', async () => {
    await expect(generateValidatorModule({ ...options, validators: [] })).rejects.toThrow(
      /no validators/,
    );
    await expect(
      generateValidatorModule({
        ...options,
        validators: [
          {
            ...validators[0],
            name: 'validateX',
            schema: 'other.schema.json',
          } as (typeof validators)[0],
        ],
      }),
    ).rejects.toThrow(/validateX: other.schema.json has no definition Item/);
    await expect(
      generateValidatorModule({
        ...options,
        validators: [
          { ...validators[0], name: 'validateX', def: 'Nope' } as (typeof validators)[0],
        ],
      }),
    ).rejects.toThrow(/has no definition Nope/);
  });
});

describe('import scanning', () => {
  it('finds static, dynamic, re-export, require and reference specifiers', () => {
    const text = [
      '/// <reference types="f" />',
      "import a from 'a';",
      "import type { B } from 'b';",
      "export * from 'c';",
      "const d = await import('d');",
      "const e = require('e');",
      'const s = \'require("ajv/dist/runtime/equal")\';',
      "// import 'ajv';",
    ].join('\n');
    expect(moduleSpecifiers(text).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('recognizes the ajv family only', () => {
    for (const s of ['ajv', 'ajv/dist/2020.js', 'ajv-formats'])
      expect(isAjvSpecifier(s)).toBe(true);
    for (const s of ['ajvx', 'my-ajv', './ajv.js', '@x/ajv']) expect(isAjvSpecifier(s)).toBe(false);
  });
});
