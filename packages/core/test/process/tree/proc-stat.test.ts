import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseProcStat } from '../../../src/process/tree/proc-stat.js';
import { bytes, fcParams, fixture, referenceDecode } from './support.js';

const REST =
  'S 8 16 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 35280234 2560000 364 18446744073709551615 0\n';

function stat(text: string): Uint8Array {
  return bytes(text);
}

describe('parseProcStat on recorded Linux fixtures', () => {
  const expected = [
    { pid: 1, ppid: 0, pgid: 1, startTime: '35280223', name: 'docker-init' },
    { pid: 8, ppid: 1, pgid: 8, startTime: '35280232', name: 'bash' },
    { pid: 16, ppid: 8, pgid: 16, startTime: '35280234', name: 'a) (b c' },
    { pid: 17, ppid: 8, pgid: 17, startTime: '35280234', name: 'x) R 1 1 1 0' },
    { pid: 18, ppid: 8, pgid: 18, startTime: '35280234', name: 'nl\n9 1 9 Z' },
    { pid: 19, ppid: 8, pgid: 19, startTime: '35280234', name: '��-bad' },
    { pid: 20, ppid: 8, pgid: 20, startTime: '35280234', name: 'bash' },
    { pid: 22, ppid: 20, pgid: 20, startTime: '35280235', name: 'plain' },
    { pid: 23, ppid: 20, pgid: 20, startTime: '35280235', name: 'plain' },
  ];

  for (const record of expected) {
    it(`parses /proc/${String(record.pid)}/stat (${JSON.stringify(record.name)})`, () => {
      expect(parseProcStat(fixture(`linux/proc/${String(record.pid)}/stat`), record.pid)).toEqual(
        record,
      );
    });
  }

  it('refuses a file whose pid differs from the /proc entry that was read', () => {
    expect(parseProcStat(fixture('linux/proc/16/stat'), 17)).toBeNull();
  });
});

describe('parseProcStat on malformed input', () => {
  const malformed: [string, string][] = [
    ['no parentheses', `16 sleep ${REST}`],
    ['close before open', `16 )sleep( ${REST}`],
    ['empty', ''],
    ['non-numeric pid', `x (sleep) ${REST}`],
    ['no space before the name', `16(sleep) ${REST}`],
    ['two spaces before the name', `16  (sleep) ${REST}`],
    ['pid out of range', `4294967296 (sleep) ${REST}`],
    ['no space after the name', `16 (sleep)${REST}`],
    ['multi-letter state', `16 (sleep) SS 8 16 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 35 1\n`],
    [
      'truncated before start time',
      '16 (sleep) S 8 16 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0\n',
    ],
    ['negative ppid', '16 (sleep) S -8 16 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 35 1\n'],
    [
      'ppid out of range',
      '16 (sleep) S 99999999999 16 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 35 1\n',
    ],
    [
      'pgid out of range',
      '16 (sleep) S 8 99999999999 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 35 1\n',
    ],
    [
      'start time with a leading zero',
      '16 (sleep) S 8 16 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 035 1\n',
    ],
    [
      'start time glued to garbage',
      '16 (sleep) S 8 16 1 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 35x 1\n',
    ],
  ];
  for (const [label, text] of malformed) {
    it(`returns null: ${label}`, () => {
      expect(parseProcStat(stat(text))).toBeNull();
    });
  }

  it('accepts negative priority and nice, and a file ending right after the start time', () => {
    expect(parseProcStat(stat('5 (k) S 2 0 0 0 -1 0 0 0 0 0 0 0 0 0 -100 -20 1 0 7'))).toEqual({
      pid: 5,
      ppid: 2,
      pgid: 0,
      startTime: '7',
      name: 'k',
    });
  });

  it('marks state Z as a zombie, and only state Z (a name ending in " Z" is not one)', () => {
    const zombie = '21 (bash) Z 20 20 7 0 -1 4227084 0 0 0 0 0 0 0 0 20 0 1 0 35 0 0\n';
    expect(parseProcStat(stat(zombie))).toEqual({
      pid: 21,
      ppid: 20,
      pgid: 20,
      startTime: '35',
      name: 'bash',
      zombie: true,
    });
    expect(parseProcStat(stat(`18 (nl 9 1 9 Z) ${REST}`))).not.toHaveProperty('zombie');
  });
});

describe('parseProcStat on names that are not plain text', () => {
  // Regression (CI run 39085765979, seed -279742588, counterexample
  // `[Uint8Array.from([239,187,191]),0,0,0,0n,"S"]`): the name is the comm
  // bytes, so a byte order mark is kept, never stripped.
  const named = (name: number[]): Uint8Array =>
    new Uint8Array([...bytes('0 ('), ...name, ...bytes(`) ${REST}`)]);
  const cases: [string, number[], string][] = [
    ['a lone byte order mark', [0xef, 0xbb, 0xbf], '﻿'],
    ['a leading byte order mark', [0xef, 0xbb, 0xbf, 0x78], '﻿x'],
    ['a byte order mark in the middle', [0x61, 0xef, 0xbb, 0xbf, 0x62], 'a﻿b'],
    ['a truncated byte order mark', [0xef, 0xbb, 0x29, 0x20], '�) '],
    ['ill-formed sequences', [0xc0, 0x80, 0xed, 0xa0, 0x80, 0xff], '�'.repeat(6)],
    ['a UTF-16 byte order mark', [0xff, 0xfe, 0x78], '��x'],
  ];
  for (const [label, name, expected] of cases) {
    it(`keeps ${label} as the name`, () => {
      expect(parseProcStat(named(name), 0)).toEqual({
        pid: 0,
        ppid: 8,
        pgid: 16,
        startTime: '35280234',
        name: expected,
      });
    });
  }
});

describe('parseProcStat on arbitrary command names', () => {
  it('never lets the name shift a field, whatever bytes it holds', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 64 }),
        fc.integer({ min: 0, max: 4_194_304 }),
        fc.integer({ min: 0, max: 4_194_304 }),
        fc.integer({ min: 0, max: 4_194_304 }),
        fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
        fc.constantFrom('S', 'Z', 'R', 'D'),
        (name, pid, ppid, pgid, start, state) => {
          const head = bytes(`${String(pid)} (`);
          const tail = bytes(
            `) ${state} ${String(ppid)} ${String(pgid)} 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${String(start)} 1 2 3\n`,
          );
          const file = new Uint8Array([...head, ...name, ...tail]);
          expect(parseProcStat(file, pid)).toEqual({
            pid,
            ppid,
            pgid,
            startTime: String(start),
            name: referenceDecode(name),
            ...(state === 'Z' ? { zombie: true } : {}),
          });
        },
      ),
      fcParams(),
    );
  });

  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (data) => {
        const record = parseProcStat(data);
        if (record !== null) expect(Number.isSafeInteger(record.pid)).toBe(true);
      }),
      fcParams(),
    );
  });
});
