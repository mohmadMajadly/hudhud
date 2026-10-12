import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Utf8StreamDecoder } from '../../../src/observability/utf8.js';

/** Reference: the WHATWG decoder of the host, streamed over the same chunks. */
function reference(chunks: readonly Uint8Array[]): string {
  const decoder = new TextDecoder('utf-8');
  let out = '';
  for (const chunk of chunks) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

function decodeAll(chunks: readonly Uint8Array[]): string {
  const decoder = new Utf8StreamDecoder();
  let out = '';
  for (const chunk of chunks) out += decoder.decode(chunk, true);
  return out + decoder.decode(new Uint8Array(0), false);
}

/** Splits `bytes` at the given cut points (any order, clamped). */
function chunked(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const point of points) {
    chunks.push(bytes.subarray(start, point));
    start = point;
  }
  chunks.push(bytes.subarray(start));
  return chunks;
}

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('Utf8StreamDecoder', () => {
  it('decodes ASCII, 2-, 3- and 4-byte sequences', () => {
    const text = 'aéم€\u{1f600}z';
    expect(decodeAll([new TextEncoder().encode(text)])).toBe(text);
  });

  it('completes a sequence split at every offset', () => {
    const text = 'x\u{1f600}الéy';
    const encoded = new TextEncoder().encode(text);
    for (let cut = 0; cut <= encoded.length; cut += 1) {
      expect(decodeAll(chunked(encoded, [cut]))).toBe(text);
    }
  });

  it('holds at most three pending bytes and reports them', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.decode(bytes(0xf0, 0x9f, 0x98), true)).toBe('');
    expect(decoder.pendingBytes).toBe(3);
    expect(decoder.decode(bytes(0x80), true)).toBe('\u{1f600}');
    expect(decoder.pendingBytes).toBe(0);
  });

  it('replaces an incomplete sequence at the end of the stream', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(bytes(0x61, 0xe2, 0x82), false)).toBe('a�');
    expect(decoder.pendingBytes).toBe(0);
  });

  it.each([
    ['invalid lead bytes', bytes(0x80, 0xbf, 0xc0, 0xc1, 0xf5, 0xff)],
    ['overlong E0 and surrogate ED', bytes(0xe0, 0x80, 0x80, 0xed, 0xa0, 0x80)],
    ['overlong F0 and above F4', bytes(0xf0, 0x80, 0x80, 0x80, 0xf4, 0x90, 0x80, 0x80)],
    ['truncated then ASCII', bytes(0xe2, 0x82, 0x41, 0xc3, 0x42)],
  ])('matches TextDecoder on %s', (_name, input) => {
    expect(decodeAll([input])).toBe(reference([input]));
  });

  it('decodes inputs longer than one conversion slice', () => {
    const text = 'abé'.repeat(5000);
    expect(decodeAll([new TextEncoder().encode(text)])).toBe(text);
  });

  it('equals TextDecoder for arbitrary bytes and chunkings', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 64 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        (input, cuts) => {
          const chunks = chunked(input, cuts);
          expect(decodeAll(chunks)).toBe(reference(chunks));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('round-trips arbitrary text under arbitrary chunkings', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 40 }),
        fc.array(fc.nat()),
        (text, cuts) => {
          expect(decodeAll(chunked(new TextEncoder().encode(text), cuts))).toBe(text);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
