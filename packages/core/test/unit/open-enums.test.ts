// ADR-0005 §6 (pre-release review R5-4): every enum of the data hudhud gives
// applications accepts unknown values on read. In the committed schemas an
// enum is therefore always the known-values arm of an open enum (an `anyOf`
// with `{ type: 'string' }`), and a `const` is only an event's `type`
// discriminator or the `estimate: true` marker. The conformance fixture
// format is closed on purpose: a runner must refuse a direction it cannot
// replay (ADR-0005 §6 amendment).

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { JsonObject, JsonValue as Json } from '../../src/protocol/json.js';

const READ_SCHEMAS = [
  'events.schema.json',
  'errors.schema.json',
  'capabilities.schema.json',
  'posture.schema.json',
];

/** Pointers of the `const`s that are allowed: discriminators and markers. */
const ALLOWED_CONST = /\/properties\/(?:type|estimate)$/u;

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAnyString(value: Json): boolean {
  return isObject(value) && Object.keys(value).length === 1 && value['type'] === 'string';
}

function isList(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

/** Every closed `enum` or disallowed `const`, by JSON Pointer. */
function closedEnums(schema: Json, pointer = '', openArm = false): string[] {
  if (isList(schema)) {
    return schema.flatMap((item, index) => closedEnums(item, `${pointer}/${String(index)}`));
  }
  if (!isObject(schema)) return [];
  const found: string[] = [];
  if (schema['enum'] !== undefined && !openArm) found.push(`${pointer} enum`);
  if (schema['const'] !== undefined && !ALLOWED_CONST.test(pointer)) {
    found.push(`${pointer} const`);
  }
  const anyOf = schema['anyOf'];
  const open = isList(anyOf) && anyOf.some(isAnyString);
  for (const [key, value] of Object.entries(schema)) {
    const at = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (key === 'anyOf' && isList(value)) {
      value.forEach((arm, index) =>
        found.push(...closedEnums(arm, `${at}/${String(index)}`, open)),
      );
    } else {
      found.push(...closedEnums(value, at));
    }
  }
  return found;
}

function read(name: string): Json {
  return JSON.parse(
    readFileSync(new URL(`../../schemas/${name}`, import.meta.url), 'utf8'),
  ) as Json;
}

describe('open enums (ADR-0005 §6)', () => {
  it.each(READ_SCHEMAS)('%s has no closed enum', (name) => {
    expect(closedEnums(read(name))).toEqual([]);
  });

  it('finds a closed enum, a const and a closed arm, and accepts an open enum', () => {
    expect(
      closedEnums({
        $defs: {
          Closed: { enum: ['a'] },
          Open: { anyOf: [{ enum: ['a'] }, { type: 'string' }] },
          ClosedUnion: { anyOf: [{ enum: ['a'] }, { type: 'number' }] },
          Arm: {
            type: 'object',
            properties: { type: { const: 'x' }, status: { const: 'y' }, estimate: { const: true } },
          },
          List: { type: 'array', items: [{ enum: [1] }] },
        },
      }),
    ).toEqual([
      '/$defs/Closed enum',
      '/$defs/ClosedUnion/anyOf/0 enum',
      '/$defs/Arm/properties/status const',
      '/$defs/List/items/0 enum',
    ]);
  });

  it('keeps the conformance format closed on purpose', () => {
    expect(closedEnums(read('conformance.schema.json')).length).toBeGreaterThan(0);
  });
});
