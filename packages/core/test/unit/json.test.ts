import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_JSON_DEPTH,
  isJsonObject,
  isJsonValue,
  ownArray,
  ownBoolean,
  ownNumber,
  ownObject,
  ownString,
  parseJsonLine,
  type JsonObject,
} from '../../src/protocol/json.js';

const nested = (depth: number, open = '[', close = ']'): string =>
  open.repeat(depth) + close.repeat(depth);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseJsonLine', () => {
  it('parses an object line', () => {
    expect(parseJsonLine('{"type":"x","n":[1,{"a":null}]}')).toEqual({
      ok: true,
      value: { type: 'x', n: [1, { a: null }] },
    });
  });

  it('accepts surrounding whitespace and a trailing CR', () => {
    expect(parseJsonLine(' {"a":1}\r')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('refuses text that is not JSON', () => {
    expect(parseJsonLine('not json')).toEqual({ ok: false, reason: 'not-json' });
    expect(parseJsonLine('')).toEqual({ ok: false, reason: 'not-json' });
    expect(parseJsonLine('{"a":1}{"b":2}')).toEqual({ ok: false, reason: 'not-json' });
  });

  it('refuses JSON that is not an object', () => {
    for (const text of ['[]', '1', '"s"', 'null', 'true']) {
      expect(parseJsonLine(text)).toEqual({ ok: false, reason: 'not-object' });
    }
  });

  it('refuses nesting beyond the limit before parsing', () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(parseJsonLine(`{"a":${nested(DEFAULT_MAX_JSON_DEPTH)}}`)).toEqual({
      ok: false,
      reason: 'too-deep',
    });
    expect(parse).not.toHaveBeenCalled();
    expect(parseJsonLine(`{"a":${nested(DEFAULT_MAX_JSON_DEPTH - 1)}}`).ok).toBe(true);
    expect(parseJsonLine(nested(100_000, '{"a":', '}')).ok).toBe(false);
  });

  it('takes the limit as a parameter', () => {
    expect(parseJsonLine('{"a":{"b":{}}}', 3).ok).toBe(true);
    expect(parseJsonLine('{"a":{"b":{}}}', 2)).toEqual({ ok: false, reason: 'too-deep' });
  });

  it('does not count brackets inside strings, including after escapes', () => {
    const text = `{"s":"${'['.repeat(1000)}\\"${'{'.repeat(1000)}\\\\","t":"]"}`;
    expect(parseJsonLine(text, 2)).toEqual({
      ok: true,
      value: { s: `${'['.repeat(1000)}"${'{'.repeat(1000)}\\`, t: ']' },
    });
  });

  it('maps a RangeError of JSON.parse to too-deep', () => {
    vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    expect(parseJsonLine('{}')).toEqual({ ok: false, reason: 'too-deep' });
  });

  it('keeps a __proto__ key inert (ADR-0012 §8)', () => {
    const result = parseJsonLine('{"__proto__":{"polluted":true},"type":"x"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.hasOwn(result.value, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(ownObject(result.value, '__proto__')).toEqual({ polluted: true });
  });

  it('round-trips arbitrary JSON objects', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (value) => {
        const text = JSON.stringify(value);
        expect(parseJsonLine(text)).toEqual({ ok: true, value: JSON.parse(text) as unknown });
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(typeof parseJsonLine(text).ok).toBe('boolean');
      }),
      { numRuns: 1000 },
    );
  });
});

describe('isJsonObject', () => {
  it('accepts plain and null-prototype objects only', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject(Object.create(null))).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('x')).toBe(false);
    expect(isJsonObject(new Date(0))).toBe(false);
    expect(isJsonObject(new Map())).toBe(false);
  });
});

describe('isJsonValue', () => {
  it('accepts JSON values of every kind', () => {
    for (const value of [null, true, 0, -1.5, 's', [], {}, { a: [1, { b: null }] }]) {
      expect(isJsonValue(value)).toBe(true);
    }
  });

  it('refuses values JSON cannot represent', () => {
    for (const value of [
      undefined,
      Number.NaN,
      Infinity,
      1n,
      Symbol('s'),
      () => 1,
      new Date(0),
      { a: undefined },
      [() => 1],
    ]) {
      expect(isJsonValue(value)).toBe(false);
    }
  });

  it('refuses cycles and shared containers', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(isJsonValue(cycle)).toBe(false);
    const shared = { x: 1 };
    expect(isJsonValue({ a: shared, b: shared })).toBe(false);
  });

  it('refuses nesting beyond the limit without recursion', () => {
    let deep: unknown = [];
    for (let i = 1; i < 100_000; i += 1) deep = [deep];
    expect(isJsonValue(deep)).toBe(false);
    expect(isJsonValue([[[]]], 3)).toBe(true);
    expect(isJsonValue([[[]]], 2)).toBe(false);
  });

  it('accepts whatever JSON.parse produces', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(isJsonValue(JSON.parse(JSON.stringify(value)))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('own accessors', () => {
  const obj: JsonObject = JSON.parse(
    '{"s":"x","n":1,"b":false,"o":{"k":1},"a":[1],"nul":null}',
  ) as JsonObject;

  it('return own members of the expected JSON type', () => {
    expect(ownString(obj, 's')).toBe('x');
    expect(ownNumber(obj, 'n')).toBe(1);
    expect(ownBoolean(obj, 'b')).toBe(false);
    expect(ownObject(obj, 'o')).toEqual({ k: 1 });
    expect(ownArray(obj, 'a')).toEqual([1]);
  });

  it('return undefined for a member of another type', () => {
    expect(ownString(obj, 'n')).toBeUndefined();
    expect(ownNumber(obj, 's')).toBeUndefined();
    expect(ownBoolean(obj, 'nul')).toBeUndefined();
    expect(ownObject(obj, 'a')).toBeUndefined();
    expect(ownArray(obj, 'o')).toBeUndefined();
  });

  it('never read inherited members', () => {
    const inherited = Object.create({ s: 'inherited', toString: 'x' }) as JsonObject;
    expect(ownString(inherited, 's')).toBeUndefined();
    expect(ownString(obj, 'toString')).toBeUndefined();
    expect(ownString(obj, 'missing')).toBeUndefined();
  });
});
