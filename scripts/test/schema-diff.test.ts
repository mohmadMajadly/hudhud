// The additive-only linter (ADR-0005 §5): every forbidden change class fails
// on a fixture schema, every additive change passes.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BASELINE_DIR,
  diffPackages,
  diffSchema,
  formatViolations,
  updateBaseline,
} from '../lib/schema/diff.mjs';

type Schema = Parameters<typeof diffSchema>[1];

/** A baseline exercising every keyword the linter compares. */
function baseline(): Schema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Frame',
    $defs: {
      Kind: { anyOf: [{ enum: ['a', 'b'] }, { type: 'string' }] },
      Frame: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', const: 'frame' },
          count: { type: 'integer', minimum: 0, maximum: 10 },
          name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z]' },
          mode: { enum: ['x', 'y'] },
          kind: { $ref: '#/$defs/Kind' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 5, uniqueItems: true },
          either: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          other: { type: 'string', not: { enum: ['p'] } },
          other2: { not: false },
          forbidden: false,
          inner: { type: 'object', properties: { a: { type: 'number' } } },
          'x-trial': { type: 'string' },
        },
      },
      Strict: {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      },
      Map: { type: 'object', additionalProperties: { type: 'string' } },
      Open: { type: 'object', additionalProperties: true },
      Refs: {
        anyOf: [{ $ref: '#/$defs/Kind' }, { properties: { type: { type: 'string' } } }, true],
      },
      Union: {
        anyOf: [
          { type: 'object', properties: { type: { const: 'one' } } },
          { type: 'object', properties: { type: { const: 'two' } } },
        ],
      },
      List: { type: 'array', items: { $ref: '#/$defs/List' } },
      'x-Experimental': { type: 'object' },
    },
  };
}

type Defs = Record<string, Record<string, unknown>>;

/** Applies `change` to a fresh baseline copy and diffs. */
function diffAfter(change: (defs: Defs, doc: Schema) => void): string[] {
  const current = structuredClone(baseline());
  change(current['$defs'] as Defs, current);
  return diffSchema('f.schema.json', baseline(), current).map((v) => `${v.pointer} ${v.kind}`);
}

const frame = (defs: Defs): Record<string, Record<string, unknown>> =>
  defs['Frame']?.['properties'] as Record<string, Record<string, unknown>>;

describe('diffSchema: forbidden changes', () => {
  it.each<[string, (defs: Defs, doc: Schema) => void, string]>([
    ['a removed definition', (d) => delete d['Strict'], '/$defs/Strict definition-removed'],
    [
      'a renamed definition',
      (d) => {
        d['Kind2'] = d['Kind'] ?? {};
        delete d['Kind'];
        frame(d)['kind'] = { $ref: '#/$defs/Kind2' };
      },
      '/$defs/Kind definition-removed',
    ],
    [
      'a removed property',
      (d) => delete frame(d)['count'],
      '/$defs/Frame/properties/count property-removed',
    ],
    [
      'a narrowed type',
      (d) => (frame(d)['inner'] = { type: 'string' }),
      '/$defs/Frame/properties/inner/type type-narrowed',
    ],
    [
      'number narrowed to integer',
      (d) => (frame(d)['inner'] = { type: 'object', properties: { a: { type: 'integer' } } }),
      '/$defs/Frame/properties/inner/properties/a/type type-narrowed',
    ],
    [
      'a type added',
      (d) => (frame(d)['kind'] = { type: 'string' }),
      '/$defs/Frame/properties/kind/type type-narrowed',
    ],
    [
      'a narrowed enum',
      (d) => (frame(d)['mode'] = { enum: ['x'] }),
      '/$defs/Frame/properties/mode enum-narrowed',
    ],
    [
      'a changed const',
      (d) => (frame(d)['type'] = { type: 'string', const: 'frame2' }),
      '/$defs/Frame/properties/type enum-narrowed',
    ],
    [
      'an enum added',
      (d) =>
        (frame(d)['name'] = {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          pattern: '^[a-z]',
          enum: ['n'],
        }),
      '/$defs/Frame/properties/name enum-narrowed',
    ],
    [
      'a new required entry',
      (d) => (d['Frame'] = { ...d['Frame'], required: ['type', 'count'] }),
      '/$defs/Frame/required required-added',
    ],
    [
      'additionalProperties closed',
      (d) => (d['Frame'] = { ...d['Frame'], additionalProperties: false }),
      '/$defs/Frame/additionalProperties additional-properties-closed',
    ],
    [
      'additionalProperties constrained',
      (d) => (d['Frame'] = { ...d['Frame'], additionalProperties: { type: 'string' } }),
      '/$defs/Frame/additionalProperties additional-properties-narrowed',
    ],
    [
      'an open object constrained',
      (d) => (d['Open'] = { type: 'object', additionalProperties: { type: 'string' } }),
      '/$defs/Open/additionalProperties additional-properties-narrowed',
    ],
    [
      'a narrowed additionalProperties schema',
      (d) =>
        (d['Map'] = { type: 'object', additionalProperties: { type: 'string', minLength: 2 } }),
      '/$defs/Map/additionalProperties/minLength constraint-narrowed',
    ],
    [
      'a raised minimum',
      (d) => (frame(d)['count'] = { type: 'integer', minimum: 1, maximum: 10 }),
      '/$defs/Frame/properties/count/minimum constraint-narrowed',
    ],
    [
      'a lowered maximum',
      (d) => (frame(d)['count'] = { type: 'integer', minimum: 0, maximum: 9 }),
      '/$defs/Frame/properties/count/maximum constraint-narrowed',
    ],
    [
      'a new limit',
      (d) =>
        (frame(d)['tags'] = { type: 'array', items: { type: 'string' }, maxItems: 5, minItems: 1 }),
      '/$defs/Frame/properties/tags/minItems constraint-narrowed',
    ],
    [
      'a changed pattern',
      (d) => (frame(d)['name'] = { type: 'string', minLength: 1, maxLength: 64, pattern: '^a' }),
      '/$defs/Frame/properties/name/pattern constraint-narrowed',
    ],
    [
      'a new multipleOf',
      (d) => (frame(d)['count'] = { type: 'integer', minimum: 0, maximum: 10, multipleOf: 2 }),
      '/$defs/Frame/properties/count/multipleOf constraint-narrowed',
    ],
    [
      'a narrowed item schema',
      (d) =>
        (frame(d)['tags'] = {
          type: 'array',
          items: { type: 'string', maxLength: 3 },
          maxItems: 5,
          uniqueItems: true,
        }),
      '/$defs/Frame/properties/tags/items/maxLength constraint-narrowed',
    ],
    [
      'a removed $ref arm',
      (d) => (d['Refs'] = { anyOf: [{ properties: { type: { type: 'string' } } }, true] }),
      '/$defs/Refs/anyOf/0 union-arm-removed',
    ],
    [
      'a removed boolean arm',
      (d) =>
        (d['Refs'] = {
          anyOf: [{ $ref: '#/$defs/Kind' }, { properties: { type: { type: 'string' } } }],
        }),
      '/$defs/Refs/anyOf/2 union-arm-removed',
    ],
    [
      'an items schema added',
      (d) =>
        (d['List'] = {
          type: 'array',
          items: { $ref: '#/$defs/List' },
          contains: { type: 'string' },
        }),
      '/$defs/List/contains constraint-added',
    ],
    [
      'a value removed from an open enum',
      (d) => (d['Kind'] = { anyOf: [{ enum: ['a'] }, { type: 'string' }] }),
      '/$defs/Kind/anyOf/0 enum-narrowed',
    ],
    [
      'a removed union arm',
      (d) => (frame(d)['either'] = { anyOf: [{ type: 'string' }] }),
      '/$defs/Frame/properties/either/anyOf/1 union-arm-removed',
    ],
    [
      'a removed discriminated arm',
      (d) => (d['Union'] = { anyOf: [{ type: 'object', properties: { type: { const: 'two' } } }] }),
      '/$defs/Union/anyOf/0 union-arm-removed',
    ],
    [
      'a union added',
      (d) =>
        (frame(d)['inner'] = {
          type: 'object',
          properties: { a: { type: 'number' } },
          anyOf: [{ required: ['a'] }],
        }),
      '/$defs/Frame/properties/inner/anyOf constraint-added',
    ],
    [
      'a not added',
      (d) =>
        (frame(d)['name'] = { type: 'string', minLength: 1, maxLength: 64, not: { const: '' } }),
      '/$defs/Frame/properties/name/not constraint-added',
    ],
    [
      'a not enum widened',
      (d) => (frame(d)['other'] = { type: 'string', not: { enum: ['p', 'q'] } }),
      '/$defs/Frame/properties/other/not enum-narrowed',
    ],
    [
      'a not changed',
      (d) => (frame(d)['other'] = { type: 'string', not: { const: 'p' } }),
      '/$defs/Frame/properties/other/not constraint-narrowed',
    ],
    [
      'a property set to false',
      (d) => (frame(d)['count'] = false as never),
      '/$defs/Frame/properties/count closed',
    ],
    [
      'the root moved to another definition',
      (_d, doc) => (doc['$ref'] = '#/$defs/Strict'),
      '/properties/type property-removed',
    ],
  ])('fails on %s', (_name, change, expected) => {
    expect(diffAfter(change)).toContain(expected);
  });

  it('reports a narrowed definition through a $ref once', () => {
    expect(
      diffAfter((d) => (d['Kind'] = { anyOf: [{ enum: ['a'] }, { type: 'string' }] })),
    ).toEqual(['/$defs/Kind/anyOf/0 enum-narrowed']);
  });
});

describe('diffSchema: additive changes pass', () => {
  it.each<[string, (defs: Defs, doc: Schema) => void]>([
    ['no change', () => undefined],
    ['a new optional property', (d) => (frame(d)['later'] = { type: 'string' })],
    ['a new definition', (d) => (d['Later'] = { type: 'object' })],
    ['a widened enum', (d) => (frame(d)['mode'] = { enum: ['x', 'y', 'z'] })],
    [
      'a const widened to an enum',
      (d) => (frame(d)['type'] = { type: 'string', enum: ['frame', 'other'] }),
    ],
    [
      'integer widened to number',
      (d) => (frame(d)['count'] = { type: ['number', 'null'], minimum: 0, maximum: 10 }),
    ],
    ['a type removed', (d) => (frame(d)['inner'] = { properties: { a: { type: 'number' } } })],
    ['a relaxed limit', (d) => (frame(d)['count'] = { type: 'integer', minimum: -1, maximum: 11 })],
    ['a dropped limit', (d) => (frame(d)['name'] = { type: 'string' })],
    [
      'additionalProperties made explicit',
      (d) => (d['Frame'] = { ...d['Frame'], additionalProperties: true }),
    ],
    ['a property schema relaxed to true', (d) => (frame(d)['name'] = true as never)],
    ['a reference to a missing definition', (d) => (frame(d)['name'] = { $ref: '#/$defs/Nope' })],
    [
      'a new union arm',
      (d) =>
        (frame(d)['either'] = {
          anyOf: [{ type: 'null' }, { type: 'string' }, { type: 'number' }],
        }),
    ],
    ['a required entry dropped', (d) => (d['Frame'] = { ...d['Frame'], required: [] })],
    [
      'a strict object gaining a property',
      (d) => ((d['Strict']?.['properties'] as Defs)['b'] = { type: 'string' }),
    ],
    [
      'a strict object opened',
      (d) => (d['Strict'] = { type: 'object', properties: { a: { type: 'string' } } }),
    ],
    ['a not enum narrowed', (d) => (frame(d)['other'] = { type: 'string', not: { enum: [] } })],
    ['an experimental property removed', (d) => delete frame(d)['x-trial']],
    ['an experimental definition removed', (d) => delete d['x-Experimental']],
    [
      'an inline schema hoisted into an equal definition',
      (d) => {
        d['Inner'] = { type: 'object', properties: { a: { type: 'number' } } };
        frame(d)['inner'] = { $ref: '#/$defs/Inner' };
      },
    ],
    [
      'a recursive definition renamed with a compatible copy kept',
      (d) => {
        d['List2'] = { type: 'array', items: { $ref: '#/$defs/List2' } };
        d['Holder'] = { type: 'object', properties: { l: { $ref: '#/$defs/List2' } } };
      },
    ],
  ])('passes %s', (_name, change) => {
    expect(diffAfter(change)).toEqual([]);
  });

  it('follows a renamed recursive definition without looping', () => {
    const base: Schema = {
      $ref: '#/$defs/A',
      $defs: { A: { type: 'array', items: { $ref: '#/$defs/A' } } },
    };
    const current: Schema = {
      $ref: '#/$defs/B',
      $defs: { B: { type: 'array', items: { $ref: '#/$defs/B' } } },
    };
    expect(diffSchema('r.schema.json', base, current).map((v) => v.kind)).toEqual([
      'definition-removed',
    ]);
  });

  it('treats a missing $defs as empty', () => {
    expect(diffSchema('e.schema.json', { type: 'object' }, { type: 'object' })).toEqual([]);
  });
});

describe('diffPackages, updateBaseline and formatViolations', () => {
  let root: string;
  const pkg = 'packages/p';

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-schema-diff-')));
    mkdirSync(path.join(root, pkg, 'schemas'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  });

  const write = (file: string, value: unknown) => {
    writeFileSync(path.join(root, pkg, 'schemas', file), `${JSON.stringify(value)}\n`);
  };

  it('skips packages without a baseline or a schemas directory', () => {
    write('a.schema.json', baseline());
    expect(diffPackages(root, [pkg, 'packages/none'])).toEqual({ violations: [], compared: 0 });
    expect(updateBaseline(root, ['packages/none'])).toEqual([]);
  });

  it('compares each baseline schema with the current one', () => {
    write('a.schema.json', baseline());
    write('b.schema.json', baseline());
    write('version.json', { wireSchemaVersion: 1 });
    expect(updateBaseline(root, [pkg])).toEqual([
      `${pkg}/schemas/${BASELINE_DIR}/a.schema.json`,
      `${pkg}/schemas/${BASELINE_DIR}/b.schema.json`,
    ]);
    expect(existsSync(path.join(root, pkg, 'schemas', BASELINE_DIR, 'version.json'))).toBe(false);
    writeFileSync(path.join(root, pkg, 'schemas', BASELINE_DIR, 'README.md'), 'not a schema\n');
    expect(diffPackages(root, [pkg])).toEqual({ violations: [], compared: 2 });

    const narrowed = baseline();
    delete (narrowed['$defs'] as Defs)['Strict'];
    write('a.schema.json', narrowed);
    rmSync(path.join(root, pkg, 'schemas', 'b.schema.json'));
    const { violations, compared } = diffPackages(root, [pkg]);
    expect(compared).toBe(2);
    expect(formatViolations(violations)).toBe(
      [
        `  - ${pkg}/schemas/a.schema.json#/$defs/Strict: definition-removed (Strict was removed or renamed)`,
        `  - ${pkg}/schemas/b.schema.json#: schema-removed (b.schema.json)`,
      ].join('\n'),
    );
  });

  it('refuses a schema file that is not a JSON object', () => {
    write('a.schema.json', baseline());
    updateBaseline(root, [pkg]);
    write('a.schema.json', []);
    expect(() => diffPackages(root, [pkg])).toThrow(/not a JSON object/);
  });

  it('copies the baseline byte for byte', () => {
    write('a.schema.json', baseline());
    updateBaseline(root, [pkg]);
    const read = (...parts: string[]) =>
      readFileSync(path.join(root, pkg, 'schemas', ...parts), 'utf8');
    expect(read(BASELINE_DIR, 'a.schema.json')).toBe(read('a.schema.json'));
  });
});
