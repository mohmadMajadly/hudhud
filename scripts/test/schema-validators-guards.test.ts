// The safety assertions of the validator generator, driven by a stubbed
// esbuild: an unexpected bundle shape, a leftover import, `eval` or the
// Function constructor in the generated code each fail the build.

import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { composeDocument } from '../lib/schema/compose.mjs';

const stub = vi.hoisted(() => ({ text: '' }));

vi.mock('esbuild', () => ({
  build: () => Promise.resolve({ outputFiles: [{ text: stub.text }] }),
}));

const { generateValidatorModule } = await import('../lib/schema/validators.mjs');

const TAIL = 'export {\n  __hudhudValidators\n};\n';

const options = {
  root: fileURLToPath(new URL('../..', import.meta.url)),
  schemaIdPrefix: 'urn:hudhud:test:',
  documents: new Map([
    [
      'g.schema.json',
      composeDocument(
        {
          file: 'g.schema.json',
          title: 'G',
          description: 'd',
          root: 'G',
          defs: { G: { type: 'object', properties: {} } },
        },
        'guards',
      ),
    ],
  ]),
  validators: [
    { name: 'validateG', schema: 'g.schema.json', def: 'G', type: { from: '../g.js', name: 'G' } },
  ],
  generatedFrom: 'guards',
};

beforeEach(() => {
  stub.text = '';
});

describe('generated code guards', () => {
  it('accepts a well-formed bundle and normalizes pnpm store paths', async () => {
    stub.text = `// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/equal.js\nvar __hudhudValidators = {};\n${TAIL}`;
    const source = await generateValidatorModule(options);
    expect(source).toContain('// node_modules/ajv/dist/runtime/equal.js\n');
  });

  it.each([
    [
      'an unexpected bundle shape',
      'var __hudhudValidators = {};\nexport { other };\n',
      /unexpected esbuild output/,
    ],
    ['a leftover import', `import x from 'ajv';\n${TAIL}`, /imports ajv/],
    ['a require call', `var e = require("ajv/dist/runtime/equal");\n${TAIL}`, /imports ajv\/dist/],
    ['eval', `var v = eval("1");\n${TAIL}`, /uses eval/],
    [
      'the Function constructor',
      `var f = new Function("return 1");\n${TAIL}`,
      /uses the Function constructor/,
    ],
  ])('refuses %s', async (_name, text, error) => {
    stub.text = text;
    await expect(generateValidatorModule(options)).rejects.toThrow(error);
  });
});
