// The neutral security posture model (plan §1.9, ADR-0012 §7): deviation by
// deep JSON equality, frozen copies, and a JSON round trip.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonValue } from '../../../src/protocol/json.js';
import {
  buildPosture,
  jsonEqual,
  MAX_POSTURE_VALUE_DEPTH,
  parsePosture,
  postureDeviations,
  postureEntry,
  serializePosture,
  type PostureEntryInput,
} from '../../../src/security/posture.js';

/** JSON values without `-0`, which JSON text cannot carry. */
const json: fc.Arbitrary<JsonValue> = fc
  .jsonValue({ maxDepth: 4 })
  .map((value) => JSON.parse(JSON.stringify(value)) as JsonValue);

function nested(depth: number): JsonValue {
  let value: JsonValue = 1;
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

describe('jsonEqual', () => {
  it('compares primitives, arrays in order and objects in any key order', () => {
    expect(jsonEqual(1, 1)).toBe(true);
    expect(jsonEqual(0, -0)).toBe(true);
    expect(jsonEqual('a', 'b')).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual({}, null)).toBe(false);
    expect(jsonEqual('a', {})).toBe(false);
    expect(jsonEqual([1, 2], [1, 2])).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual([1], [1, 1])).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
    expect(jsonEqual({}, [])).toBe(false);
    expect(jsonEqual({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('is reflexive, symmetric and agrees with canonical JSON text', () => {
    const canonical = (value: JsonValue): string =>
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => (x < y ? -1 : 1)))
          : item,
      );
    fc.assert(
      fc.property(json, json, (a, b) => {
        expect(jsonEqual(a, a)).toBe(true);
        expect(jsonEqual(a, b)).toBe(jsonEqual(b, a));
        expect(jsonEqual(a, b)).toBe(canonical(a) === canonical(b));
      }),
    );
  });
});

describe('buildPosture', () => {
  it('computes deviates by deep JSON equality, in the given order', () => {
    const posture = buildPosture([
      { setting: 'b', value: 'x', defaultValue: 'x' },
      { setting: 'a', value: ['user', 'project'], defaultValue: ['user'] },
      { setting: 'c', value: { k: [1] }, defaultValue: { k: [1] } },
      { setting: 'd', value: null, defaultValue: 'refuse' },
    ]);
    expect(posture.entries.map((e) => [e.setting, e.deviates])).toEqual([
      ['b', false],
      ['a', true],
      ['c', false],
      ['d', true],
    ]);
    expect(postureDeviations(posture).map((e) => e.setting)).toEqual(['a', 'd']);
    expect(postureEntry(posture, 'c')?.value).toEqual({ k: [1] });
    expect(postureEntry(posture, 'zz')).toBeUndefined();
  });

  it('returns a frozen deep copy', () => {
    const value = { names: ['A'], __proto__: null } as unknown as JsonValue;
    const input: PostureEntryInput[] = [{ setting: 's', value, defaultValue: [] }];
    const posture = buildPosture(input);
    (value as { names: string[] }).names.push('B');
    expect(posture.entries[0]?.value).toEqual({ names: ['A'] });
    expect(Object.isFrozen(posture)).toBe(true);
    expect(Object.isFrozen(posture.entries)).toBe(true);
    expect(Object.isFrozen(posture.entries[0])).toBe(true);
    expect(Object.isFrozen((posture.entries[0]?.value as { names: string[] }).names)).toBe(true);
  });

  it('keeps a __proto__ key an inert own property', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true}}') as JsonValue;
    const posture = buildPosture([{ setting: 's', value, defaultValue: {} }]);
    const copy = posture.entries[0]?.value as Record<string, unknown>;
    expect(Object.hasOwn(copy, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(posture.entries[0]?.deviates).toBe(true);
  });

  it('refuses adapter bugs: empty or duplicate settings and non-JSON values', () => {
    expect(() => buildPosture([{ setting: '', value: 1, defaultValue: 1 }])).toThrow(
      /entry 0 has no setting name/,
    );
    expect(() =>
      buildPosture([{ setting: 1 as unknown as string, value: 1, defaultValue: 1 }]),
    ).toThrow(TypeError);
    expect(() =>
      buildPosture([
        { setting: 'a', value: 1, defaultValue: 1 },
        { setting: 'a', value: 2, defaultValue: 1 },
      ]),
    ).toThrow(/entry 1 is listed twice/);
    expect(() => buildPosture([{ setting: 'a', value: Number.NaN, defaultValue: 1 }])).toThrow(
      /value that is not JSON/,
    );
    expect(() =>
      buildPosture([{ setting: 'a', value: 1, defaultValue: undefined as unknown as JsonValue }]),
    ).toThrow(/default value that is not JSON/);
    expect(() =>
      buildPosture([
        { setting: 'a', value: nested(MAX_POSTURE_VALUE_DEPTH + 1), defaultValue: null },
      ]),
    ).toThrow(TypeError);
    expect(
      buildPosture([{ setting: 'a', value: nested(MAX_POSTURE_VALUE_DEPTH), defaultValue: null }])
        .entries[0]?.deviates,
    ).toBe(true);
  });
});

describe('serializePosture and parsePosture', () => {
  const entries = fc.uniqueArray(
    fc.record({ setting: fc.string({ minLength: 1 }), value: json, defaultValue: json }),
    { selector: (entry) => entry.setting, maxLength: 8 },
  );

  it('round-trip every posture', () => {
    fc.assert(
      fc.property(entries, (inputs) => {
        const posture = buildPosture(inputs);
        const text = serializePosture(posture);
        const parsed = parsePosture(text);
        expect(parsed).toEqual({ ok: true, posture });
        if (parsed.ok) expect(serializePosture(parsed.posture)).toBe(text);
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(posture)));
      }),
    );
  });

  it('drops unknown members', () => {
    const parsed = parsePosture(
      '{"entries":[{"setting":"a","value":1,"defaultValue":1,"deviates":false,"x":1}],"y":2}',
    );
    expect(parsed).toEqual({
      ok: true,
      posture: { entries: [{ setting: 'a', value: 1, defaultValue: 1, deviates: false }] },
    });
  });

  it('refuses text that is not a posture', () => {
    expect(parsePosture('{')).toEqual({ ok: false, reason: 'not-json' });
    expect(parsePosture('[]')).toEqual({ ok: false, reason: 'schema' });
    expect(parsePosture('{"entries":{}}')).toEqual({ ok: false, reason: 'schema' });
    expect(parsePosture('{"entries":[{"setting":"a","value":1}]}')).toEqual({
      ok: false,
      reason: 'schema',
    });
    expect(
      parsePosture(
        `{"entries":[{"setting":"a","value":${JSON.stringify(nested(40))},"defaultValue":1,"deviates":true}]}`,
      ),
    ).toEqual({ ok: false, reason: 'too-deep' });
  });

  it('refuses invalid entries and deviates flags that disagree with the values', () => {
    const entry = (setting: string, deviates: boolean): string =>
      `{"setting":${JSON.stringify(setting)},"value":"auto","defaultValue":"default","deviates":${String(deviates)}}`;
    expect(parsePosture(`{"entries":[${entry('a', true)},${entry('a', true)}]}`)).toEqual({
      ok: false,
      reason: 'invalid-entry',
      index: 1,
    });
    expect(parsePosture(`{"entries":[${entry('', true)}]}`)).toEqual({
      ok: false,
      reason: 'invalid-entry',
      index: 0,
    });
    // A weakened setting may never pass as the default.
    expect(parsePosture(`{"entries":[${entry('a', true)},${entry('b', false)}]}`)).toEqual({
      ok: false,
      reason: 'deviates-mismatch',
      index: 1,
    });
  });
});
