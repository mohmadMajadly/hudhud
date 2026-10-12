import process from 'node:process';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { encodeJsonLine } from '../../../src/protocol/encode.js';

const seedText = process.env['FC_SEED'];
/** Property runs (plan §4.1): at least 1000; `FC_SEED` reproduces a failure. */
const runs = <T>(): fc.Parameters<T> => ({
  numRuns: 1000,
  ...(seedText === undefined ? {} : { seed: Number(seedText) }),
});

const MiB = 1024 * 1024;
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
type Encodable = Parameters<typeof encodeJsonLine>[0];
/** Feeds a value the type forbids, as an untyped caller could. */
const untyped = (value: unknown): Encodable => value as Encodable;

/** Strings rich in what matters here: controls, line separators, lone surrogates, multibyte. */
const trickyString = fc.string({
  unit: fc.oneof(
    fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
    fc.constantFrom(
      '\n',
      '\r',
      '\u0000',
      '\u001f',
      '\u2028',
      '\u2029',
      '\ud800',
      '\udfff',
      '\ufeff',
      '"',
      '\\',
      'é',
      '€',
      '👋',
    ),
  ),
  maxLength: 30,
});
const jsonObject = fc
  .dictionary(trickyString, fc.oneof(trickyString, fc.jsonValue({ maxDepth: 3 })), { maxKeys: 6 })
  // fast-check's JSON types are structurally equivalent but not assignable.
  .map(untyped);

describe('encodeJsonLine', () => {
  it('writes JSON.stringify(value) followed by exactly one LF', () => {
    expect(encodeJsonLine({ a: 1, b: [true, null, 'x'] }, 64)).toEqual({
      ok: true,
      line: '{"a":1,"b":[true,null,"x"]}\n',
      bytes: 28,
    });
  });

  it('counts UTF-8 bytes, terminator included, as TextEncoder does', () => {
    for (const text of ['', 'é', '€', '👋', 'مرحبا', '\u2028', 'a👋é€\u2029']) {
      const result = encodeJsonLine({ t: text }, 1024);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.bytes).toBe(utf8Bytes(result.line));
    }
  });

  it('escapes LF, CR and every other C0 control, in values and keys', () => {
    const result = encodeJsonLine({ 'k\n\r': 'v\n\r\u0000\u001f\t' }, 1024);
    expect(result).toEqual({
      ok: true,
      line: '{"k\\n\\r":"v\\n\\r\\u0000\\u001f\\t"}\n',
      bytes: 32,
    });
  });

  it('leaves U+2028 and U+2029 verbatim, as JSON.stringify writes them', () => {
    const result = encodeJsonLine({ t: '\u2028\u2029' }, 1024);
    expect(result).toEqual({ ok: true, line: '{"t":"\u2028\u2029"}\n', bytes: 15 });
  });

  it('escapes lone surrogates, so the line is well-formed UTF-16', () => {
    const result = encodeJsonLine({ t: '\ud800x\udfff' }, 1024);
    expect(result).toEqual({ ok: true, line: '{"t":"\\ud800x\\udfff"}\n', bytes: 22 });
  });

  it('encodes a own __proto__ key as data', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true}}') as Encodable;
    expect(encodeJsonLine(value, 64)).toEqual({
      ok: true,
      line: '{"__proto__":{"polluted":true}}\n',
      bytes: 32,
    });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  describe('outbound cap', () => {
    it('accepts a line of exactly the cap and refuses one byte less', () => {
      const line = '{"a":"bcd"}\n';
      expect(encodeJsonLine({ a: 'bcd' }, line.length)).toEqual({ ok: true, line, bytes: 12 });
      expect(encodeJsonLine({ a: 'bcd' }, line.length - 1)).toEqual({
        ok: false,
        error: {
          code: 'OUTBOUND_FRAME_TOO_LARGE',
          message: 'Outbound frame exceeds the cap of 11 bytes; nothing was written.',
          retryable: false,
          details: { maxBytes: 11, atLeastBytes: 12 },
        },
      });
    });

    it('refuses a line whose code units fit but whose UTF-8 bytes do not', () => {
      // 12 code units; 9 + 3 x 3 = 18 bytes.
      const result = encodeJsonLine({ t: '€€€' }, 12);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('OUTBOUND_FRAME_TOO_LARGE');
        expect(result.error.details?.['atLeastBytes']).toBeGreaterThan(12);
      }
      expect(encodeJsonLine({ t: '€€€' }, 18)).toEqual({
        ok: true,
        line: '{"t":"€€€"}\n',
        bytes: 18,
      });
    });

    it('applies the default outbound cap of 32 MiB at the exact boundary', () => {
      const cap = 32 * MiB;
      // '{"a":""}' plus LF is 9 bytes of framing.
      const fits = encodeJsonLine({ a: 'x'.repeat(cap - 9) }, cap);
      expect(fits.ok && fits.bytes).toBe(cap);
      const over = encodeJsonLine({ a: 'x'.repeat(cap - 8) }, cap);
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.error.code).toBe('OUTBOUND_FRAME_TOO_LARGE');
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
      'refuses maxBytes %s',
      (maxBytes) => {
        expect(() => encodeJsonLine({}, maxBytes)).toThrow(RangeError);
      },
    );
  });

  describe('values JSON cannot carry as an object', () => {
    const protocolError = (reason: string): unknown => ({
      ok: false,
      error: {
        code: 'PROTOCOL_ERROR',
        message: `Outbound frame is not a serializable JSON object (${reason}); nothing was written.`,
        retryable: false,
        details: { reason },
      },
    });

    it.each([
      ['null', null],
      ['an array', []],
      ['a string', '{}'],
      ['a number', 1],
      ['undefined', undefined],
    ])('refuses %s', (_name, value) => {
      expect(encodeJsonLine(untyped(value), 64)).toEqual(protocolError('not-object'));
    });

    it('refuses an object whose toJSON returns nothing or a non-object', () => {
      expect(encodeJsonLine(untyped({ toJSON: () => undefined }), 64)).toEqual(
        protocolError('not-object'),
      );
      expect(encodeJsonLine(untyped({ toJSON: () => 5 }), 64)).toEqual(protocolError('not-object'));
      expect(encodeJsonLine(untyped({ toJSON: () => '{' }), 64)).toEqual(
        protocolError('not-object'),
      );
    });

    it('refuses a cycle and a bigint', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      expect(encodeJsonLine(untyped(cyclic), 64)).toEqual(protocolError('not-serializable'));
      expect(encodeJsonLine(untyped({ n: 1n }), 64)).toEqual(protocolError('not-serializable'));
    });

    it('refuses nesting deep enough to exhaust the stack, without throwing', () => {
      let deep: Record<string, unknown> = {};
      for (let i = 0; i < 1_000_000; i += 1) deep = { d: deep };
      expect(encodeJsonLine(untyped(deep), 64 * MiB)).toEqual(protocolError('too-deep'));
    });
  });

  describe('properties', () => {
    it('emits one frame with exactly one LF that round-trips, for arbitrary objects', () => {
      fc.assert(
        fc.property(jsonObject, (value) => {
          const result = encodeJsonLine(value, 32 * MiB);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const { line, bytes } = result;
          expect(line).toBe(`${JSON.stringify(value)}\n`);
          expect(line.indexOf('\n')).toBe(line.length - 1);
          expect(line).not.toContain('\r');
          expect(line.isWellFormed()).toBe(true);
          expect(bytes).toBe(utf8Bytes(line));
          expect(JSON.parse(line)).toEqual(JSON.parse(JSON.stringify(value)));
        }),
        runs(),
      );
    });

    it('accepts exactly the lines within the cap and never truncates', () => {
      fc.assert(
        fc.property(jsonObject, fc.integer({ min: 1, max: 600 }), (value, maxBytes) => {
          const size = utf8Bytes(`${JSON.stringify(value)}\n`);
          const result = encodeJsonLine(value, maxBytes);
          if (size <= maxBytes) {
            expect(result).toEqual({ ok: true, line: `${JSON.stringify(value)}\n`, bytes: size });
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.error.code).toBe('OUTBOUND_FRAME_TOO_LARGE');
              expect(result.error.details?.['maxBytes']).toBe(maxBytes);
              expect(result.error.details?.['atLeastBytes']).toBeGreaterThan(maxBytes);
              expect(result.error.details?.['atLeastBytes']).toBeLessThanOrEqual(size);
            }
          }
        }),
        runs(),
      );
    });
  });
});
