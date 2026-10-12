import process from 'node:process';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  createFramer,
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  framerRetention,
  maxFramerLineBytes,
  type Framer,
  type FramerOutput,
} from '../../../src/process/framer.js';
import { DEFAULT_MAX_OUTBOUND_FRAME_BYTES, encodeJsonLine } from '../../../src/protocol/encode.js';

const seedText = process.env['FC_SEED'];
/** Property runs (plan §4.1): at least 1000; `FC_SEED` reproduces a failure. */
const runs = <T>(): fc.Parameters<T> => ({
  numRuns: 1000,
  ...(seedText === undefined ? {} : { seed: Number(seedText) }),
});

const MiB = 1024 * 1024;
const utf8 = new TextEncoder();
const bytesOf = (text: string): Uint8Array => utf8.encode(text);
const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** The one, chunking-independent report of a line above `max`. */
const over = (max: number): FramerOutput => ({
  kind: 'oversized',
  bytes: max + 1,
  details: { maxBytes: max, atLeastBytes: max + 1 },
});

/** Pushes every chunk, checks the memory bound after each, then ends the stream. */
function frame(max: number, chunks: readonly Uint8Array[]): FramerOutput[] {
  const framer = createFramer({ maxLineBytes: max });
  const out: FramerOutput[] = [];
  for (const chunk of chunks) {
    out.push(...framer.push(chunk));
    const { bufferedBytes, capacityBytes } = framerRetention(framer);
    // Held between calls: at most cap + 1 (a pending CR), so never above
    // cap + one chunk for any non-empty chunk.
    expect(bufferedBytes).toBeLessThanOrEqual(max + 1);
    expect(capacityBytes).toBeLessThanOrEqual(max + 1);
    expect(bufferedBytes).toBeLessThanOrEqual(capacityBytes);
  }
  out.push(...framer.end());
  return out;
}

const frameText = (text: string, max = 1024): FramerOutput[] => frame(max, [bytesOf(text)]);

/** Splits `bytes` into consecutive chunks of the given sizes (cycled); empty chunks allowed. */
function chunked(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = sizes.length === 0 ? bytes.length : (sizes[index % sizes.length] ?? 1);
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
    index += 1;
    if (index > bytes.length * 4 + 4) break;
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset));
  return chunks;
}

/**
 * Independent reference model of the framing rules (plan §1.7, 05 §11):
 * split on LF, drop one CR before it, drop a leading BOM on the first line,
 * skip blank lines, one fixed `oversized` report for a line above the cap,
 * fatal UTF-8 decoding.
 */
function reference(bytes: Uint8Array, max: number): FramerOutput[] {
  const out: FramerOutput[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) {
      lines.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  lines.forEach((raw, index) => {
    const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
    const size = line.length;
    if (size > max) {
      out.push(over(max));
      return;
    }
    const bom = index === 0 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf;
    const body = bom ? line.subarray(3) : line;
    if (body.every((b) => b === 0x20 || b === 0x09 || b === 0x0d)) return;
    try {
      out.push({ kind: 'line', text: decoder.decode(body), bytes: size });
    } catch {
      out.push({ kind: 'invalid-utf8', bytes: size });
    }
  });
  return out;
}

/** Bytes biased toward the interesting ones: LF, CR, blanks, BOM and multibyte lead/continuation bytes. */
const streamBytes = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(0x0a, 0x0d, 0x20, 0x09, 0xef, 0xbb, 0xbf) },
      {
        weight: 3,
        arbitrary: fc.constantFrom(0xd8, 0xb1, 0xe2, 0x80, 0xa8, 0xf0, 0x9f, 0x91, 0x8b),
      },
      { weight: 4, arbitrary: fc.integer({ min: 0x21, max: 0x7e }) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 255 }) },
    ),
    { maxLength: 400 },
  )
  .map((values) => Uint8Array.from(values));
const chunkSizes = fc.array(fc.integer({ min: 0, max: 48 }), { maxLength: 12 });

describe('createFramer', () => {
  describe('options', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, maxFramerLineBytes + 1])(
      'refuses maxLineBytes %s',
      (maxLineBytes) => {
        expect(() => createFramer({ maxLineBytes })).toThrow(RangeError);
      },
    );

    it('accepts the bounds 1 and maxFramerLineBytes', () => {
      expect(maxFramerLineBytes).toBe(2 ** 29 - 24);
      expect(frameText('{}\n', maxFramerLineBytes)).toEqual([
        { kind: 'line', text: '{}', bytes: 2 },
      ]);
      expect(frameText('a\nbb\n', 1)).toEqual([{ kind: 'line', text: 'a', bytes: 1 }, over(1)]);
    });
  });

  describe('line endings and blank lines', () => {
    it('frames LF, CRLF and mixed endings alike', () => {
      const expected = [
        { kind: 'line', text: '{"a":1}', bytes: 7 },
        { kind: 'line', text: '{"b":2}', bytes: 7 },
      ];
      expect(frameText('{"a":1}\n{"b":2}\n')).toEqual(expected);
      expect(frameText('{"a":1}\r\n{"b":2}\r\n')).toEqual(expected);
      expect(frameText('{"a":1}\r\n{"b":2}\n')).toEqual(expected);
    });

    it('skips empty and whitespace-only lines (05 §11 run 81)', () => {
      expect(frameText('\n\r\n   \r\n\t\n{"a":1}\r\n   \r\n\n')).toEqual([
        { kind: 'line', text: '{"a":1}', bytes: 7 },
      ]);
    });

    it('keeps a CR that is not right before the LF', () => {
      expect(frameText('a\rb\r\r\n')).toEqual([{ kind: 'line', text: 'a\rb\r', bytes: 4 }]);
    });

    it('splits on LF only, never on U+2028, U+2029 or a lone CR', () => {
      expect(frameText('{"t":"a\u2028b\u2029c"}\rx\n')).toEqual([
        // 7 + 3 (U+2028) + 1 + 3 (U+2029) + 3 + CR + x
        { kind: 'line', text: '{"t":"a\u2028b\u2029c"}\rx', bytes: 19 },
      ]);
    });

    it('returns nothing for an empty chunk or an empty stream', () => {
      const framer = createFramer({ maxLineBytes: 8 });
      expect(framer.push(new Uint8Array(0))).toEqual([]);
      expect(framer.end()).toEqual([]);
    });
  });

  describe('byte order mark', () => {
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);

    it('drops a leading BOM and counts its bytes (05 §11 run 82)', () => {
      expect(frame(64, [concat(bom, bytesOf('{"a":1}\r\n{"b":2}\n'))])).toEqual([
        { kind: 'line', text: '{"a":1}', bytes: 10 },
        { kind: 'line', text: '{"b":2}', bytes: 7 },
      ]);
    });

    it('drops a BOM split across chunks at every offset', () => {
      const stream = concat(bom, bytesOf('{}\n'));
      for (let cut = 0; cut <= stream.length; cut += 1) {
        expect(frame(64, [stream.slice(0, cut), stream.slice(cut)])).toEqual([
          { kind: 'line', text: '{}', bytes: 5 },
        ]);
      }
    });

    it('skips a first line that holds only a BOM and blanks', () => {
      expect(frame(64, [concat(bom, bytesOf(' \r\n{}\n'))])).toEqual([
        { kind: 'line', text: '{}', bytes: 2 },
      ]);
    });

    it('keeps a BOM that does not start the stream', () => {
      expect(frame(64, [concat(bytesOf('{}\n'), bom, bytesOf('{}\n'))])).toEqual([
        { kind: 'line', text: '{}', bytes: 2 },
        { kind: 'line', text: '\ufeff{}', bytes: 5 },
      ]);
      expect(frame(64, [concat(bytesOf('\n'), bom, bytesOf('{}\n'))])).toEqual([
        { kind: 'line', text: '\ufeff{}', bytes: 5 },
      ]);
    });
  });

  describe('multibyte characters', () => {
    const text = '{"text":"رد: مرحبا 👋 é €"}';
    const line = bytesOf(`${text}\n`);
    const expected = [{ kind: 'line', text, bytes: line.length - 1 }];

    it('reassembles a line split in two at every byte offset (05 §11 run 83)', () => {
      for (let cut = 0; cut <= line.length; cut += 1) {
        expect(frame(1024, [line.slice(0, cut), line.slice(cut)])).toEqual(expected);
      }
    });

    it('reassembles a line split in three at every pair of offsets', () => {
      for (let a = 0; a <= line.length; a += 1) {
        for (let b = a; b <= line.length; b += 1) {
          const parts = [line.slice(0, a), line.slice(a, b), line.slice(b)];
          expect(frame(1024, parts)).toEqual(expected);
        }
      }
    });

    it('reassembles a line fed one byte at a time', () => {
      expect(frame(1024, chunked(line, [1]))).toEqual(expected);
    });
  });

  describe('cap', () => {
    const max = 16;

    it('accepts a line of exactly the cap and refuses cap + 1, with LF or CRLF', () => {
      for (const eol of ['\n', '\r\n']) {
        expect(frameText(`${'a'.repeat(max)}${eol}`, max)).toEqual([
          { kind: 'line', text: 'a'.repeat(max), bytes: max },
        ]);
        expect(frameText(`${'a'.repeat(max + 1)}${eol}`, max)).toEqual([over(max)]);
        expect(frameText(`${'a'.repeat(max + 2)}${eol}`, max)).toEqual([over(max)]);
      }
    });

    it('counts multibyte characters in bytes, not code units', () => {
      // 'é' is two bytes: 8 of them are 16 bytes, 9 are 18.
      expect(frameText(`${'é'.repeat(8)}\n`, max)).toEqual([
        { kind: 'line', text: 'é'.repeat(8), bytes: 16 },
      ]);
      expect(frameText(`${'é'.repeat(9)}\n`, max)).toEqual([over(max)]);
    });

    it('reports once, at the byte that crosses the cap, without waiting for the LF', () => {
      const framer = createFramer({ maxLineBytes: max });
      expect(framer.push(bytesOf('z'.repeat(max)))).toEqual([]);
      expect(framerRetention(framer).bufferedBytes).toBe(max);
      // Byte max + 1 is not a CR: the line is above the cap now.
      expect(framer.push(bytesOf('z'))).toEqual([over(max)]);
      expect(framerRetention(framer)).toEqual({ bufferedBytes: 0, capacityBytes: max + 1 });
      for (let i = 0; i < 100; i += 1) expect(framer.push(bytesOf('z'.repeat(100)))).toEqual([]);
      expect(framerRetention(framer).bufferedBytes).toBe(0);
      expect(framer.push(bytesOf('\r\n{}\n'))).toEqual([{ kind: 'line', text: '{}', bytes: 2 }]);
    });

    it('waits one byte when byte max + 1 is a CR that may end the line', () => {
      const framer = createFramer({ maxLineBytes: max });
      expect(framer.push(bytesOf(`${'c'.repeat(max)}\r`))).toEqual([]);
      expect(framerRetention(framer).bufferedBytes).toBe(max + 1);
      expect(framer.push(bytesOf('\r'))).toEqual([over(max)]);
      expect(framer.push(bytesOf('\n'))).toEqual([]);
      expect(framer.push(bytesOf(`${'c'.repeat(max)}\r`))).toEqual([]);
      expect(framer.push(bytesOf('\n'))).toEqual([
        { kind: 'line', text: 'c'.repeat(max), bytes: max },
      ]);
    });

    it('reports a line fed one byte at a time at byte max + 1', () => {
      const framer = createFramer({ maxLineBytes: max });
      const seen: [number, FramerOutput[]][] = [];
      chunked(bytesOf(`${'x'.repeat(max + 5)}\n{}\n`), [1]).forEach((chunk, index) => {
        const out = framer.push(chunk);
        if (out.length > 0) seen.push([index, out]);
      });
      expect(seen).toEqual([
        [max, [over(max)]],
        [max + 8, [{ kind: 'line', text: '{}', bytes: 2 }]],
      ]);
    });

    it('frames the line after an oversized one', () => {
      const big = bytesOf(`${'x'.repeat(1000)}\r\n{"ok":true}\n`);
      expect(frame(max, chunked(big, [7]))).toEqual([
        over(max),
        { kind: 'line', text: '{"ok":true}', bytes: 11 },
      ]);
    });

    it('reports an oversized line that never ends, and nothing more at end()', () => {
      const framer = createFramer({ maxLineBytes: max });
      expect(framer.push(bytesOf('y'.repeat(40)))).toEqual([over(max)]);
      expect(framer.push(bytesOf('y'.repeat(40)))).toEqual([]);
      expect(framer.end()).toEqual([]);
      expect(frame(max, [bytesOf(`${'y'.repeat(40)}\r`)])).toEqual([over(max)]);
    });

    it('streams 256 MiB of one line through a 1 KiB cap with bounded memory', () => {
      const cap = 1024;
      const chunk = new Uint8Array(MiB).fill(0x61);
      const framer = createFramer({ maxLineBytes: cap });
      const before = process.memoryUsage().arrayBuffers;
      for (let i = 0; i < 256; i += 1) {
        expect(framer.push(chunk)).toEqual(i === 0 ? [over(cap)] : []);
        const { bufferedBytes, capacityBytes } = framerRetention(framer);
        expect(bufferedBytes).toBe(0);
        expect(capacityBytes).toBeLessThanOrEqual(cap + 1);
      }
      const growth = process.memoryUsage().arrayBuffers - before;
      // Nothing proportional to the 256 MiB streamed is kept.
      expect(growth).toBeLessThan(16 * MiB);
      expect(framer.push(bytesOf('\n{}\n'))).toEqual([{ kind: 'line', text: '{}', bytes: 2 }]);
    });

    it('frames a 5 MB line under the default inbound cap of 64 MiB (05 §11 run 75)', () => {
      const cap = DEFAULT_MAX_INBOUND_FRAME_BYTES;
      expect(cap).toBe(64 * MiB);
      const text = `{"result":"${'r'.repeat(5_000_000)}"}`;
      const stream = bytesOf(`${text}\n`);
      expect(frame(cap, chunked(stream, [65_536]))).toEqual([
        { kind: 'line', text, bytes: stream.length - 1 },
      ]);
    });

    it('refuses a line of 64 MiB + 1 under the default inbound cap', () => {
      const cap = DEFAULT_MAX_INBOUND_FRAME_BYTES;
      const chunk = new Uint8Array(MiB).fill(0x62);
      const framer = createFramer({ maxLineBytes: cap });
      for (let i = 0; i < 64; i += 1) expect(framer.push(chunk)).toEqual([]);
      expect(framerRetention(framer)).toEqual({ bufferedBytes: cap, capacityBytes: cap });
      // cap + 1 bytes may still be a line of cap bytes plus its CR.
      expect(framer.push(bytesOf('\r'))).toEqual([]);
      expect(framerRetention(framer)).toEqual({ bufferedBytes: cap + 1, capacityBytes: cap + 1 });
      expect(framer.push(Uint8Array.of(0x62))).toEqual([over(cap)]);
      expect(framerRetention(framer)).toEqual({ bufferedBytes: 0, capacityBytes: 4096 });
      expect(framer.push(bytesOf('\n'))).toEqual([]);
    });

    it('releases a grown buffer after a large line completes', () => {
      const framer = createFramer({ maxLineBytes: MiB });
      expect(framer.push(bytesOf('q'.repeat(200_000)))).toEqual([]);
      expect(framerRetention(framer).capacityBytes).toBeGreaterThan(200_000);
      expect(framer.push(bytesOf('\n'))).toEqual([
        { kind: 'line', text: 'q'.repeat(200_000), bytes: 200_000 },
      ]);
      expect(framerRetention(framer)).toEqual({ bufferedBytes: 0, capacityBytes: 4096 });
    });

    it('keeps a modest buffer between lines', () => {
      const framer = createFramer({ maxLineBytes: MiB });
      expect(framer.push(bytesOf(`${'s'.repeat(10_000)}\n`))).toHaveLength(1);
      expect(framerRetention(framer).capacityBytes).toBe(16_384);
    });
  });

  describe('invalid UTF-8', () => {
    it.each([
      ['a lone continuation byte', [0x7b, 0x80, 0x7d]],
      ['an overlong encoding', [0xc0, 0x80]],
      ['an encoded surrogate', [0xed, 0xa0, 0x80]],
      ['a truncated sequence', [0xe2, 0x82]],
      ['a byte that never occurs', [0xff]],
      ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ])('reports %s without its bytes and frames the next line', (_name, bad) => {
      const stream = concat(Uint8Array.from(bad), bytesOf('\r\n{}\n'));
      expect(frame(64, [stream])).toEqual([
        { kind: 'invalid-utf8', bytes: bad.length },
        { kind: 'line', text: '{}', bytes: 2 },
      ]);
    });

    it('decodes Arabic text exactly, with no replacement characters (05 §11 runs 78-80)', () => {
      const [output] = frameText('{"t":"مرحبا"}\n');
      expect(output).toEqual({ kind: 'line', text: '{"t":"مرحبا"}', bytes: 18 });
    });
  });

  describe('end of stream', () => {
    it('frames an unterminated last line at end()', () => {
      const framer = createFramer({ maxLineBytes: 64 });
      expect(framer.push(bytesOf('{"a":1}\n{"b":'))).toEqual([
        { kind: 'line', text: '{"a":1}', bytes: 7 },
      ]);
      expect(framer.push(bytesOf('2}\r'))).toEqual([]);
      expect(framer.end()).toEqual([{ kind: 'line', text: '{"b":2}', bytes: 7 }]);
    });

    it('refuses push and end after end()', () => {
      const framer = createFramer({ maxLineBytes: 64 });
      expect(framer.end()).toEqual([]);
      expect(() => framer.push(bytesOf('{}\n'))).toThrow('The framer has ended.');
      expect(() => framer.end()).toThrow('The framer has ended.');
      expect(framerRetention(framer)).toEqual({ bufferedBytes: 0, capacityBytes: 0 });
    });
  });

  it('copies the bytes it keeps, so the caller may reuse its chunk', () => {
    const framer = createFramer({ maxLineBytes: 64 });
    const chunk = bytesOf('{"a"');
    expect(framer.push(chunk)).toEqual([]);
    chunk.fill(0x20);
    expect(framer.push(bytesOf(':1}\n'))).toEqual([{ kind: 'line', text: '{"a":1}', bytes: 7 }]);
  });

  it('framerRetention refuses an object not made by createFramer', () => {
    const fake: Framer = { push: () => [], end: () => [] };
    expect(() => framerRetention(fake)).toThrow(TypeError);
  });

  describe('properties', () => {
    it('matches the reference model for arbitrary bytes, caps and chunkings', () => {
      fc.assert(
        fc.property(
          streamBytes,
          fc.integer({ min: 1, max: 64 }),
          chunkSizes,
          (bytes, max, sizes) => {
            expect(frame(max, chunked(bytes, sizes))).toEqual(reference(bytes, max));
          },
        ),
        runs(),
      );
    });

    it('produces the same output however the stream is chunked', () => {
      fc.assert(
        fc.property(
          streamBytes,
          fc.integer({ min: 1, max: 32 }),
          chunkSizes,
          (bytes, max, sizes) => {
            expect(frame(max, chunked(bytes, sizes))).toEqual(frame(max, [bytes]));
          },
        ),
        runs(),
      );
    });

    it('never throws on random bytes and keeps memory under cap + one chunk', () => {
      fc.assert(
        fc.property(
          fc.array(fc.uint8Array({ maxLength: 96 }), { maxLength: 24 }),
          fc.integer({ min: 1, max: 48 }),
          (chunks, max) => {
            const framer = createFramer({ maxLineBytes: max });
            for (const chunk of chunks) {
              framer.push(chunk);
              const { bufferedBytes, capacityBytes } = framerRetention(framer);
              expect(bufferedBytes).toBeLessThanOrEqual(max + 1);
              expect(capacityBytes).toBeLessThanOrEqual(max + Math.max(chunk.length, 1));
            }
            framer.end();
          },
        ),
        runs(),
      );
    });

    /** Text lines without LF, a CR at the end or a BOM at the start (those change framing by design). */
    const textLine = fc
      .string({
        unit: fc.oneof(
          fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
          fc.constantFrom('\r', ' ', '\t', '\u2028', '\u2029', 'é', '👋', 'مرحبا', '{', '"'),
        ),
        maxLength: 40,
      })
      .map((line) => line.replaceAll('\n', ' '))
      .filter((line) => line.isWellFormed() && !line.endsWith('\r') && !line.startsWith('\ufeff'));

    it('round-trips text lines across LF/CRLF, a BOM, blank lines and arbitrary chunks', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(textLine, fc.constantFrom('\n', '\r\n'), fc.constantFrom('', '\n', ' \r\n')),
            { maxLength: 12 },
          ),
          fc.boolean(),
          fc.boolean(),
          chunkSizes,
          (lines, withBom, terminated, sizes) => {
            let stream = withBom ? '\ufeff' : '';
            lines.forEach(([line, eol, blank], index) => {
              const last = index === lines.length - 1;
              stream += `${blank}${line}${last && !terminated ? '' : eol}`;
            });
            const expected = lines
              .map(([line]) => line)
              .filter((line) => !/^[ \t\r]*$/u.test(line))
              .map((text) => ({ kind: 'line', text }));
            const actual = frame(256, chunked(bytesOf(stream), sizes)).map((output) => {
              expect(output.kind).toBe('line');
              return output.kind === 'line' ? { kind: output.kind, text: output.text } : output;
            });
            expect(actual).toEqual(expected);
          },
        ),
        runs(),
      );
    });

    it('round-trips encoder output: arbitrary JSON objects survive encode, chunking and framing', () => {
      fc.assert(
        fc.property(
          fc.array(fc.dictionary(fc.string({ unit: 'binary' }), fc.jsonValue()), { maxLength: 6 }),
          chunkSizes,
          (objects, sizes) => {
            const lines = objects.map((object) => {
              const result = encodeJsonLine(
                object as Parameters<typeof encodeJsonLine>[0],
                DEFAULT_MAX_OUTBOUND_FRAME_BYTES,
              );
              if (!result.ok) throw new Error(result.error.message);
              return result.line;
            });
            const outputs = frame(
              DEFAULT_MAX_INBOUND_FRAME_BYTES,
              chunked(bytesOf(lines.join('')), sizes),
            );
            expect(outputs).toHaveLength(objects.length);
            outputs.forEach((output, index) => {
              expect(output.kind).toBe('line');
              const text = output.kind === 'line' ? output.text : '';
              expect(`${text}\n`).toBe(lines[index]);
              expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(objects[index])));
            });
          },
        ),
        runs(),
      );
    });
  });
});
