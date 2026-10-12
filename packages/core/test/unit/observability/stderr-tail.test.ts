import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { REDACTED } from '../../../src/observability/redact.js';
import {
  StderrTail,
  TRUNCATED,
  type StderrTailOptions,
} from '../../../src/observability/stderr-tail.js';
import { filler, multiLineSecret, secretShaped, secretValue, separator } from './arbitraries.js';

const R = REDACTED;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function tailOf(text: string, options: StderrTailOptions = {}): StderrTail {
  const tail = new StderrTail(options);
  tail.push(utf8(text));
  tail.end();
  return tail;
}

describe('StderrTail', () => {
  it('keeps short output as is and counts bytes', () => {
    const tail = tailOf('line one\nline two\n');
    expect(tail.read()).toBe('line one\nline two\n');
    expect(tail.receivedBytes).toBe(18);
    expect(tail.truncated).toBe(false);
  });

  it('is empty before any input', () => {
    const tail = new StderrTail();
    expect(tail.read()).toBe('');
    expect(tail.retainedCodeUnits).toBe(0);
  });

  it('renders CRLF and lone CR as LF, also when split across chunks', () => {
    const tail = new StderrTail();
    tail.push('a\r');
    tail.push('\nb\rc\r');
    tail.push('\r\nd');
    tail.end();
    expect(tail.read()).toBe('a\nb\nc\n\nd');
  });

  it('accepts string chunks without counting them as bytes', () => {
    const tail = new StderrTail();
    tail.push('text');
    tail.end();
    expect(tail.read()).toBe('text');
    expect(tail.receivedBytes).toBe(0);
  });

  it('ignores input after end and a second end', () => {
    const tail = tailOf('done');
    tail.push('more');
    tail.push(utf8('more'));
    tail.end();
    expect(tail.read()).toBe('done');
  });

  it('flushes an incomplete UTF-8 sequence as U+FFFD at end', () => {
    const tail = new StderrTail();
    tail.push(Uint8Array.from([0x61, 0xe2, 0x82]));
    expect(tail.retainedCodeUnits).toBe(3);
    tail.end();
    expect(tail.read()).toBe('a�');
  });

  it('decodes a multi-byte character split across chunks', () => {
    const bytes = utf8('\u{1f600}');
    const tail = new StderrTail();
    for (const byte of bytes) tail.push(Uint8Array.of(byte));
    tail.end();
    expect(tail.read()).toBe('\u{1f600}');
  });

  it('keeps the last maxChars code units', () => {
    const tail = tailOf('0123456789\nabcdefghij\n', { maxChars: 8, maxLineChars: 100 });
    expect(tail.read()).toBe('defghij\n');
    expect(tail.truncated).toBe(true);
  });

  it('keeps at most maxLines lines', () => {
    expect(tailOf('a\nb\nc\nd\n', { maxLines: 2 }).read()).toBe('c\nd\n');
    expect(tailOf('a\nb\nc\nd', { maxLines: 2 }).read()).toBe('c\nd');
    expect(tailOf('a\nb\nc\nd', { maxLines: 1 }).read()).toBe('d');
  });

  it('drops the rest of an overlong line and marks it', () => {
    const tail = tailOf('short\nabcdefghij klmnop\nnext\n', { maxLineChars: 11 });
    expect(tail.read()).toBe(`short\nabcdefghij ${TRUNCATED}\nnext\n`);
    const cut = tailOf('abcdefghij klm\n', { maxLineChars: 12 });
    expect(cut.read()).toBe(`abcdefghij ${R}${TRUNCATED}\n`);
    expect(tail.truncated).toBe(true);
  });

  it('masks a cut token of an overlong line', () => {
    const tail = tailOf('see https://user:passw0rd@host\n', { maxLineChars: 20 });
    expect(tail.read()).toBe(`see ${R}${TRUNCATED}\n`);
  });

  it('caps a single redacted line that grew beyond maxChars', () => {
    const tail = tailOf(`${'x'.repeat(6)}\n`, { secrets: ['x'], maxChars: 16 });
    expect(tail.read()).toBe(`${R}\n`);
    const grown = tailOf(`${'x y '.repeat(4)}\n`, { secrets: ['x'], maxChars: 16 });
    expect(grown.read().length).toBeLessThanOrEqual(16);
    expect(grown.truncated).toBe(true);
  });

  it('never starts with half of a surrogate pair', () => {
    const tail = tailOf('ab\u{1f600}cd', { maxChars: 3, maxLineChars: 10 });
    expect(tail.read()).toBe('cd');
    const head = tailOf('ab\u{1f600}cd', { maxLineChars: 3 });
    expect(head.read()).toBe(`${R}${TRUNCATED}`);
    expect(head.read().isWellFormed()).toBe(true);
  });

  it('redacts secrets split across chunks', () => {
    const tail = new StderrTail({ secrets: ['TOPSECRET'] });
    tail.push('error TOP');
    tail.push(utf8('SEC'));
    tail.push('RET here\nAuthorization: Bea');
    tail.push('rer abc\n');
    tail.end();
    expect(tail.read()).toBe(`error ${R} here\nAuthorization: ${R}\n`);
  });

  it('masks the incomplete current line on a read before end', () => {
    const tail = new StderrTail({ secrets: ['TOP SECRET'] });
    tail.push('first\nvalue TOP S');
    expect(tail.read()).toBe(`first\nvalue ${R}`);
    tail.push('ECRET done');
    expect(tail.read()).toBe(`first\nvalue ${R} ${R}`);
    tail.end();
    expect(tail.read()).toBe(`first\nvalue ${R} done`);
  });

  it.each([
    ['maxChars', { maxChars: 0 }],
    ['maxLines', { maxLines: 1.5 }],
    ['maxLineChars', { maxLineChars: Number.NaN }],
  ])('rejects an invalid %s', (name, options) => {
    expect(() => new StderrTail(options)).toThrow(
      new RangeError(`StderrTail: ${name} must be a positive safe integer`),
    );
  });

  it('defaults to the last 2048 code units', () => {
    const tail = tailOf(`${'y'.repeat(3000)}\n`.repeat(3), { maxLineChars: 4096 });
    expect(tail.read()).toBe(`${'y'.repeat(2047)}\n`);
  });
});

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

const options: fc.Arbitrary<StderrTailOptions> = fc.record({
  maxChars: fc.integer({ min: 1, max: 160 }),
  maxLines: fc.integer({ min: 1, max: 8 }),
  maxLineChars: fc.integer({ min: 1, max: 80 }),
});

/** Stderr text mixing filler, literal secrets (multi-line too) and secret shapes. */
const stream = fc
  .tuple(
    fc.array(fc.oneof(secretValue, multiLineSecret), { minLength: 1, maxLength: 3 }),
    fc.array(fc.oneof(filler, fc.nat({ max: 2 }), secretShaped), { maxLength: 14 }),
    separator,
  )
  .map(([secrets, parts, sep]) => ({
    secrets,
    text: parts
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'number') return sep + (secrets[part % secrets.length] ?? '') + sep;
        return sep + part.text + sep;
      })
      .join(''),
  }));

describe('StderrTail properties', () => {
  it('never exposes any fragment of a secret, at any read, across any chunking', () => {
    fc.assert(
      fc.property(
        stream,
        options,
        fc.array(fc.nat(), { maxLength: 12 }),
        ({ secrets, text }, opts, cuts) => {
          const tail = new StderrTail({ ...opts, secrets });
          for (const chunk of chunked(utf8(text), cuts)) {
            tail.push(chunk);
            // Secrets alone use A-Z0-9 (arbitraries.ts).
            expect(tail.read()).not.toMatch(/[A-Z0-9]/);
          }
          tail.end();
          expect(tail.read()).not.toMatch(/[A-Z0-9]/);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('final output does not depend on the chunking', () => {
    fc.assert(
      fc.property(
        stream,
        options,
        fc.array(fc.nat(), { maxLength: 12 }),
        ({ secrets, text }, opts, cuts) => {
          const whole = new StderrTail({ ...opts, secrets });
          whole.push(utf8(text));
          whole.end();
          const parts = new StderrTail({ ...opts, secrets });
          for (const chunk of chunked(utf8(text), cuts)) parts.push(chunk);
          parts.end();
          expect(parts.read()).toBe(whole.read());
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('bounds memory, length and lines, and stays well-formed UTF-16', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.uint8Array({ maxLength: 300 }),
            fc.string({ unit: 'grapheme', maxLength: 300 }),
          ),
          {
            maxLength: 30,
          },
        ),
        options,
        fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }),
        (chunks, opts, secrets) => {
          const tail = new StderrTail({ ...opts, secrets });
          const check = (): void => {
            expect(tail.retainedCodeUnits).toBeLessThanOrEqual(tail.retainedBound);
            const out = tail.read();
            expect(out.length).toBeLessThanOrEqual(opts.maxChars ?? 2048);
            expect(out.split('\n').length - (out.endsWith('\n') ? 1 : 0)).toBeLessThanOrEqual(
              opts.maxLines ?? 100,
            );
          };
          for (const chunk of chunks) {
            tail.push(chunk);
            check();
          }
          tail.end();
          check();
          const wellFormedInput = chunks.every((chunk) => typeof chunk === 'string');
          if (wellFormedInput) expect(tail.read().isWellFormed()).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('holds memory flat for megabytes of input', () => {
    const tail = new StderrTail({ secrets: ['NEVER'] });
    const line = utf8(`${'مx'.repeat(700)}NEVER\n`);
    const noBreak = utf8('z'.repeat(4096));
    for (let i = 0; i < 1000; i += 1) {
      tail.push(i % 2 === 0 ? line : noBreak);
      expect(tail.retainedCodeUnits).toBeLessThanOrEqual(tail.retainedBound);
    }
    expect(tail.receivedBytes).toBeGreaterThan(2_000_000);
    expect(tail.retainedBound).toBe(2 * 2048 + 1 + 2048 + 3);
  });
});
