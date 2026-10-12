import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  decodeUtf8Lossy,
  group,
  isPid,
  MAX_PID,
  parsePid,
} from '../../../src/process/tree/decode.js';
import { compareStartTime, isCanonicalStartTime } from '../../../src/process/tree/start-time.js';
import { bytes, fcParams, referenceDecode } from './support.js';

describe('decodeUtf8Lossy', () => {
  it('decodes well-formed UTF-8 including astral characters', () => {
    expect(decodeUtf8Lossy(bytes('a) (b c — هدهد 🐦'))).toBe('a) (b c — هدهد 🐦');
  });

  it('replaces each maximal ill-formed subpart with one U+FFFD', () => {
    const cases: [number[], string][] = [
      [[0xff, 0xfe, 0x2d], '��-'],
      [[0xc0, 0x80], '��'],
      [[0xe0, 0x80, 0x80], '���'],
      [[0xe0, 0xa0], '�'],
      [[0xed, 0xa0, 0x80], '���'],
      [[0xf0, 0x80], '��'],
      [[0xf4, 0x90, 0x80, 0x80], '����'],
      [[0xf0, 0x9f, 0x90], '�'],
      [[0xe2, 0x41], '�A'],
    ];
    for (const [input, expected] of cases) {
      const data = new Uint8Array(input);
      expect(decodeUtf8Lossy(data)).toBe(expected);
      expect(decodeUtf8Lossy(data)).toBe(referenceDecode(data));
    }
  });

  it('honours start and end offsets and subarray views', () => {
    const data = bytes('xx(name)yy');
    expect(decodeUtf8Lossy(data, 3, 7)).toBe('name');
    expect(decodeUtf8Lossy(data.subarray(2, 8))).toBe('(name)');
  });

  it('handles output longer than one internal chunk', () => {
    const text = 'é'.repeat(10_000);
    expect(decodeUtf8Lossy(bytes(text))).toBe(text);
  });

  it('matches the WHATWG decoder on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (data) => {
        expect(decodeUtf8Lossy(data)).toBe(referenceDecode(data));
      }),
      fcParams(2000),
    );
  });

  it('round-trips arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        const data = bytes(text);
        expect(decodeUtf8Lossy(data)).toBe(referenceDecode(data));
      }),
      fcParams(),
    );
  });
});

describe('parsePid / isPid / group', () => {
  it('accepts unsigned decimals up to the 32-bit maximum', () => {
    expect(parsePid('0')).toBe(0);
    expect(parsePid('4294967295')).toBe(MAX_PID);
    expect(parsePid('007')).toBe(7);
  });

  it('refuses everything else', () => {
    for (const text of ['', '-1', '+1', '1.5', '1e3', ' 1', '4294967296', '99999999999', 'x']) {
      expect(parsePid(text)).toBeNull();
    }
  });

  it('isPid accepts only integers in range', () => {
    expect(isPid(0)).toBe(true);
    expect(isPid(MAX_PID)).toBe(true);
    for (const value of [-1, 1.5, MAX_PID + 1, Number.NaN, '1', null, undefined]) {
      expect(isPid(value)).toBe(false);
    }
  });

  it('group returns the empty string for a group that did not participate', () => {
    const match = /^(a)(b)?$/.exec('a');
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(group(match, 1)).toBe('a');
    expect(group(match, 2)).toBe('');
  });
});

describe('start times', () => {
  it('accepts canonical unsigned decimals of at most 20 digits', () => {
    for (const value of ['0', '1', '35280234', '134362981734317260', '18446744073709551615']) {
      expect(isCanonicalStartTime(value)).toBe(true);
    }
    for (const value of ['', '00', '01', '-1', '1.0', ' 1', '123456789012345678901', 'x']) {
      expect(isCanonicalStartTime(value)).toBe(false);
    }
  });

  it('orders numerically, like BigInt', () => {
    const canonical = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }).map(String);
    fc.assert(
      fc.property(canonical, canonical, (a, b) => {
        const expected = BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
        expect(Math.sign(compareStartTime(a, b))).toBe(expected);
      }),
      fcParams(),
    );
    expect(compareStartTime('9', '10')).toBeLessThan(0);
    expect(compareStartTime('10', '10')).toBe(0);
    expect(compareStartTime('11', '10')).toBeGreaterThan(0);
  });
});
