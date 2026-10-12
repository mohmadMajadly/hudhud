import { describe, expect, it } from 'vitest';

import {
  JSON_SCHEMA_DIALECT,
  canonicalJson,
  composeDocument,
  isPlainObject,
  serializeJson,
} from '../lib/schema/compose.mjs';

type Doc = Parameters<typeof composeDocument>[0];

const usage = {
  type: 'object',
  properties: { input: { type: 'integer' }, output: { type: 'integer' } },
};

function doc(defs: Doc['defs'], root = Object.keys(defs)[0] ?? 'Missing'): Doc {
  return { file: 'x.schema.json', title: 'X', description: 'd', root, defs };
}

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: null }, 'x'] })).toBe(
      '{"a":[{"c":null,"d":1},"x"],"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson('s')).toBe('"s"');
  });
});

describe('serializeJson', () => {
  it('writes two-space JSON with a final LF', () => {
    expect(serializeJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });
});

describe('isPlainObject', () => {
  it('accepts objects only', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(1)).toBe(false);
  });
});

describe('composeDocument', () => {
  it('writes the dialect, a comment, the root reference and the definitions', () => {
    const composed = composeDocument(doc({ Usage: usage }), 'pkg/schema-src/x.ts');
    expect(composed).toEqual({
      $schema: JSON_SCHEMA_DIALECT,
      $comment: 'Generated from pkg/schema-src/x.ts by scripts/schema/build.mjs. Do not edit.',
      title: 'X',
      description: 'd',
      $ref: '#/$defs/Usage',
      $defs: { Usage: usage },
    });
  });

  it('replaces sub-schemas equal to a named definition by a reference', () => {
    const kind = { anyOf: [{ enum: ['a'] }, { type: 'string' }] };
    const result = {
      type: 'object',
      properties: {
        usage: {
          ...usage,
          properties: { output: { type: 'integer' }, input: { type: 'integer' } },
        },
        list: { type: 'array', items: kind, prefixItems: [kind] },
        either: { anyOf: [usage, { type: 'null' }] },
        not: { not: kind },
        open: { type: 'object', additionalProperties: usage },
        closed: { type: 'object', additionalProperties: false },
        constant: { const: usage },
      },
    };
    const composed = composeDocument(doc({ Result: result, Usage: usage, Kind: kind }), 'x');
    const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
    expect(composed['$defs']).toEqual({
      Result: {
        type: 'object',
        properties: {
          usage: ref('Usage'),
          list: { type: 'array', items: ref('Kind'), prefixItems: [ref('Kind')] },
          either: { anyOf: [ref('Usage'), { type: 'null' }] },
          not: { not: ref('Kind') },
          open: { type: 'object', additionalProperties: ref('Usage') },
          closed: { type: 'object', additionalProperties: false },
          // Data keywords are values, not schemas.
          constant: { const: usage },
        },
      },
      Usage: usage,
      Kind: kind,
    });
  });

  it('refuses invalid definitions', () => {
    expect(() => composeDocument(doc({ usage }), 'x')).toThrow(/not PascalCase/);
    expect(() => composeDocument(doc({ Id: { type: 'string' } }), 'x')).toThrow(/bare type/);
    expect(() => composeDocument(doc({ Empty: {} }), 'x')).toThrow(/bare type/);
    expect(() => composeDocument(doc({ A: usage, B: { ...usage } }), 'x')).toThrow(
      /definitions A and B are identical/,
    );
    expect(() => composeDocument(doc({ A: usage }, 'B'), 'x')).toThrow(/root "B"/);
  });
});
