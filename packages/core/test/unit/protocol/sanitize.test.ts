import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sanitizeForDisplay } from '../../../src/protocol/events/sanitize.js';

const seedText = process.env['FC_SEED'];
const runs = <T>(): fc.Parameters<T> => ({
  numRuns: 2000,
  ...(seedText === undefined ? {} : { seed: Number(seedText) }),
});

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;

/** Every code unit the sanitizer must never let through. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

describe('sanitizeForDisplay (ADR-0012 §8)', () => {
  describe('examples', () => {
    it.each([
      ['plain text', 'hello, world', 'hello, world'],
      ['tab and line feed', 'a\tb\nc', 'a\tb\nc'],
      ['carriage return', 'safe\roverwritten\r\n', 'safeoverwritten\n'],
      ['SGR colour', `${ESC}[31mred${ESC}[0m`, 'red'],
      ['CSI with private parameters', `${ESC}[?1049h${ESC}[2J${ESC}[H`, ''],
      ['CSI with intermediates', `a${ESC}[1 qb`, 'ab'],
      ['CSI cursor movement', `x${ESC}[10;20Hy`, 'xy'],
      ['8-bit CSI', 'a\u009b31mb', 'ab'],
      ['OSC title with BEL', `${ESC}]0;evil title${BEL}text`, 'text'],
      ['OSC hyperlink with ST', `${ESC}]8;;https://evil.example${ST}click${ESC}]8;;${ST}`, 'click'],
      ['OSC 52 clipboard write', `${ESC}]52;c;cm0gLXJmIC8K${BEL}ok`, 'ok'],
      ['8-bit OSC with 8-bit ST', 'a\u009d0;t\u009cb', 'ab'],
      ['unterminated OSC swallows the rest', `ok${ESC}]0;never ends`, 'ok'],
      ['OSC ended by CAN', `${ESC}]0;x\u0018after`, 'after'],
      ['OSC ended by SUB', `${ESC}]0;x\u001aafter`, 'after'],
      ['OSC ended by another sequence', `${ESC}]0;x${ESC}[31mred`, 'red'],
      ['DCS', `${ESC}Pq#0;2;0;0;0${ST}after`, 'after'],
      ['8-bit DCS', '\u0090payload\u009cafter', 'after'],
      ['SOS, PM, APC', `${ESC}Xs${ST}${ESC}^p${ST}${ESC}_a${ST}.`, '.'],
      ['8-bit SOS, PM, APC', '\u0098s\u009c\u009ep\u009c\u009fa\u009c.', '.'],
      ['two-character escapes', `${ESC}7${ESC}8${ESC}c${ESC}=x`, 'x'],
      ['nF escape with intermediates', `${ESC}(B${ESC}#8x`, 'x'],
      ['ESC at the end', `x${ESC}`, 'x'],
      ['ESC before a non-ASCII character', `${ESC}é`, 'é'],
      ['ESC ESC sequence', `${ESC}${ESC}[1mb`, 'b'],
      ['malformed CSI keeps what does not fit', `${ESC}[12é`, 'é'],
      ['CSI at the end', `x${ESC}[12`, 'x'],
      ['nF escape at the end', `x${ESC}(`, 'x'],
      ['C0 controls', 'a\u0000b\u0001c\u0008d\u000be\u000cf\u001fg', 'abcdefg'],
      ['BEL alone', `ding${BEL}`, 'ding'],
      ['DEL and C1', 'a\u007fb\u0085c\u009cd', 'abcd'],
      ['bidi overrides (Trojan Source)', 'access\u202e\u2066level\u2069\u202c', 'accesslevel'],
      [
        'all bidi embeddings and isolates',
        '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069x',
        'x',
      ],
      [
        'directional marks and Arabic text stay',
        'هدهد \u200f(x)\u200e \u061c',
        'هدهد \u200f(x)\u200e \u061c',
      ],
      ['emoji and lone surrogates stay', '👋\ud800', '👋\ud800'],
    ])('%s', (_name, input, expected) => {
      expect(sanitizeForDisplay(input)).toBe(expected);
    });

    it('returns the same string when nothing is removed', () => {
      const text = 'nothing to remove';
      expect(sanitizeForDisplay(text)).toBe(text);
    });

    it('replaces line feeds and tabs in single-line mode', () => {
      expect(sanitizeForDisplay('a\nb\tc\r\nd', { singleLine: true })).toBe('a b c d');
      expect(sanitizeForDisplay('plain', { singleLine: true })).toBe('plain');
      expect(sanitizeForDisplay('a\nb', { singleLine: false })).toBe('a\nb');
    });
  });

  describe('properties', () => {
    /** Units rich in what matters: introducers, terminators, parameters, controls, bidi. */
    const unit = fc.oneof(
      { weight: 3, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }) },
      {
        weight: 2,
        arbitrary: fc.constantFrom(
          ESC,
          '[',
          ']',
          'P',
          'X',
          '^',
          '_',
          '\\',
          '(',
          '#',
          ';',
          '0',
          '9',
          '?',
          ' ',
          'm',
          'H',
          '~',
          BEL,
          '\u0018',
          '\u001a',
          '\r',
          '\n',
          '\t',
          '\u007f',
          '\u0090',
          '\u0098',
          '\u009b',
          '\u009c',
          '\u009d',
          '\u009e',
          '\u009f',
          '\u0085',
          '\u202a',
          '\u202e',
          '\u2066',
          '\u2069',
          '\u200f',
          '\ud800',
        ),
      },
    );
    const tricky = fc.string({ unit, maxLength: 64 });
    /** Text with no controls at all. */
    const safe = fc
      .string({ unit: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }) })
      .filter((text) => !FORBIDDEN.test(text) && !text.includes('\n') && !text.includes('\t'));
    const params = fc.string({
      unit: fc.constantFrom('0', '1', '9', ';', '?', '<', '='),
      maxLength: 8,
    });
    const final = fc.constantFrom('m', 'H', 'J', 'K', 'h', 'l', '~', '@');
    const payload = fc.string({
      unit: fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 1 }),
      maxLength: 16,
    });
    const csi = fc
      .tuple(fc.constantFrom(`${ESC}[`, '\u009b'), params, final)
      .map((parts) => parts.join(''));
    const controlString = fc
      .tuple(
        fc.constantFrom(
          `${ESC}]`,
          `${ESC}P`,
          `${ESC}X`,
          `${ESC}^`,
          `${ESC}_`,
          '\u009d',
          '\u0090',
          '\u0098',
          '\u009e',
          '\u009f',
        ),
        payload,
        fc.constantFrom(BEL, ST, '\u009c'),
      )
      .map((parts) => parts.join(''));
    const sequence = fc.oneof(csi, controlString);

    it('never throws and never lets a control through', () => {
      fc.assert(
        fc.property(tricky, fc.boolean(), (text, singleLine) => {
          const out = sanitizeForDisplay(text, { singleLine });
          expect(out).not.toMatch(FORBIDDEN);
          expect(out.includes(ESC)).toBe(false);
          if (singleLine) expect(/[\n\t]/u.test(out)).toBe(false);
        }),
        runs(),
      );
    });

    it('never throws on arbitrary strings', () => {
      fc.assert(
        fc.property(fc.string({ unit: 'binary' }), (text) => {
          expect(sanitizeForDisplay(text)).not.toMatch(FORBIDDEN);
        }),
        runs(),
      );
    });

    it('is idempotent and never grows the text', () => {
      fc.assert(
        fc.property(tricky, (text) => {
          const once = sanitizeForDisplay(text);
          expect(sanitizeForDisplay(once)).toBe(once);
          expect(once.length).toBeLessThanOrEqual(text.length);
        }),
        runs(),
      );
    });

    it('keeps text without controls unchanged', () => {
      fc.assert(
        fc.property(safe, (text) => {
          expect(sanitizeForDisplay(text)).toBe(text);
        }),
        runs(),
      );
    });

    it('removes exactly the well-formed CSI and control-string sequences between safe text', () => {
      fc.assert(
        fc.property(fc.array(fc.tuple(safe, sequence), { maxLength: 6 }), safe, (pieces, tail) => {
          const text = pieces.map(([before, seq]) => before + seq).join('') + tail;
          const expected = pieces.map(([before]) => before).join('') + tail;
          expect(sanitizeForDisplay(text)).toBe(expected);
        }),
        runs(),
      );
    });

    it('does not mutate its argument and is pure', () => {
      fc.assert(
        fc.property(tricky, (text) => {
          const copy = text.slice();
          const first = sanitizeForDisplay(text);
          expect(text).toBe(copy);
          expect(sanitizeForDisplay(text)).toBe(first);
        }),
        runs(),
      );
    });
  });
});

describe('the sanitizer is a display helper only', () => {
  const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

  it('is not applied to data on its way to the application', () => {
    // No core source but the protocol barrel may import it: a machine, the
    // binding or the process layer never rewrites harness text.
    const importers = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /sanitize(\.js)?['"]/u.test(readFileSync(path.join(SRC, file), 'utf8')));
    expect(importers.filter((file) => file !== 'protocol/index.ts')).toEqual([]);
  });
});
