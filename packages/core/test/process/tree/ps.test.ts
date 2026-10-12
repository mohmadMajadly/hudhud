import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parsePsOutput } from '../../../src/process/tree/ps.js';
import { bytes, fcParams, fixture, referenceDecode } from './support.js';

/** Seconds since the epoch of a UTC wall-clock time, as the parser reports it. */
function utc(iso: string): string {
  return String(Date.parse(`${iso}Z`) / 1000);
}

describe('parsePsOutput on the recorded Linux procps output', () => {
  it('parses every line with C-locale lstart in UTC', () => {
    const at = utc('2026-10-12T17:02:31');
    expect(parsePsOutput(fixture('linux/ps.out'))).toEqual({
      records: [
        { pid: 1, ppid: 0, pgid: 1, startTime: at, name: 'docker-init' },
        { pid: 8, ppid: 1, pgid: 8, startTime: at, name: 'bash' },
        { pid: 16, ppid: 8, pgid: 16, startTime: at, name: 'a) (b c' },
        { pid: 17, ppid: 8, pgid: 17, startTime: at, name: 'x) R 1 1 1 0' },
        { pid: 18, ppid: 8, pgid: 18, startTime: at, name: 'nl.9 1 9 Z' },
        { pid: 19, ppid: 8, pgid: 19, startTime: at, name: '??-bad' },
        { pid: 20, ppid: 8, pgid: 20, startTime: at, name: 'bash' },
        { pid: 22, ppid: 20, pgid: 20, startTime: at, name: 'plain' },
        { pid: 23, ppid: 20, pgid: 20, startTime: at, name: 'plain' },
        { pid: 34, ppid: 8, pgid: 34, startTime: utc('2026-10-12T17:02:32'), name: 'ps' },
      ],
      rejected: 0,
    });
  });
});

describe('parsePsOutput on the synthesized macOS output (not recorded; see manifest.json)', () => {
  const parsed = parsePsOutput(fixture('darwin/ps.synthesized.out'));

  it('keeps names with spaces and parentheses whole, and accepts an empty name', () => {
    const byPid = new Map(parsed.records.map((record) => [record.pid, record]));
    expect(byPid.get(1)?.startTime).toBe(utc('2026-10-05T06:41:09'));
    expect(byPid.get(520)?.name).toBe(
      '/Applications/Tool (beta) Helper.app/Contents/MacOS/Tool (beta) Helper',
    );
    expect(byPid.get(521)).toEqual({
      pid: 521,
      ppid: 520,
      pgid: 520,
      startTime: utc('2026-10-12T17:00:11'),
      name: '/tmp/x) R 1 1 ??bad',
    });
    expect(byPid.get(531)?.name).toBe('');
  });

  it('returns the forged duplicate line for buildSnapshot to drop, and rejects malformed lines', () => {
    expect(parsed.records.filter((record) => record.pid === 480)).toHaveLength(2);
    expect(parsed.records.some((record) => record.pid === 612)).toBe(false);
    expect(parsed.rejected).toBe(2);
  });
});

describe('parsePsOutput line validation', () => {
  const ok = '  10     1    10 Mon Oct 12 17:00:00 2026 name';
  const malformed: [string, string][] = [
    ['missing columns', '  10     1 Mon Oct 12 17:00:00 2026 name'],
    ['unknown month', '  10     1    10 Mon Foo 12 17:00:00 2026 name'],
    ['February 30', '  10     1    10 Mon Feb 30 17:00:00 2026 name'],
    ['day 0', '  10     1    10 Mon Oct  0 17:00:00 2026 name'],
    ['hour 24', '  10     1    10 Tue Oct 13 24:00:00 2026 name'],
    ['minute 60', '  10     1    10 Mon Oct 12 17:60:00 2026 name'],
    ['second 60', '  10     1    10 Mon Oct 12 17:00:60 2026 name'],
    ['year before 1970', '  10     1    10 Wed Dec 31 23:59:59 1969 name'],
    ['wrong weekday', '  10     1    10 Tue Oct 12 17:00:00 2026 name'],
    ['pid out of range', '  4294967296     1    10 Mon Oct 12 17:00:00 2026 name'],
    ['ppid out of range', '  10     4294967296    10 Mon Oct 12 17:00:00 2026 name'],
    ['pgid out of range', '  10     1    4294967296 Mon Oct 12 17:00:00 2026 name'],
    ['no separator before the name', '  10     1    10 Mon Oct 12 17:00:00 2026name'],
    ['negative pid', ' -10     1    10 Mon Oct 12 17:00:00 2026 name'],
  ];
  for (const [label, line] of malformed) {
    it(`rejects: ${label}`, () => {
      expect(parsePsOutput(bytes(`${ok}\n${line}\n`))).toEqual({
        records: [expect.objectContaining({ pid: 10 })],
        rejected: 1,
      });
    });
  }

  it('accepts the last line without a newline and skips empty lines', () => {
    expect(parsePsOutput(bytes(`\n\n${ok}`)).records).toHaveLength(1);
    expect(parsePsOutput(new Uint8Array())).toEqual({ records: [], rejected: 0 });
  });

  it('keeps a CR, leading spaces and U+2028 inside the name', () => {
    const [record] = parsePsOutput(
      bytes('  10     1    10 Mon Oct 12 17:00:00 2026  a\r b\n'),
    ).records;
    expect(record?.name).toBe(' a\r b');
  });

  it('decodes ill-formed UTF-8 in the name with replacement characters', () => {
    const line = new Uint8Array([...bytes(`${ok} `), 0xff, 0x0a]);
    expect(parsePsOutput(line).records[0]?.name).toBe('name �');
  });
});

describe('parsePsOutput on arbitrary names', () => {
  it('parses the columns exactly and keeps any newline-free name', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 48 }).map((name) => name.filter((byte) => byte !== 0x0a)),
        fc.integer({ min: 0, max: 99_999 }),
        fc.integer({ min: 0, max: 99_999 }),
        fc.integer({ min: 0, max: 99_999 }),
        fc.date({
          min: new Date('1970-01-01T00:00:00Z'),
          max: new Date('2100-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        (name, pid, ppid, pgid, date) => {
          const seconds = Math.floor(date.getTime() / 1000);
          const at = new Date(seconds * 1000);
          // "Mon, 12 Oct 2026 17:00:00 GMT"
          const [weekday, day, month, year, time] = at
            .toUTCString()
            .replace(',', '')
            .split(' ') as [string, string, string, string, string];
          const lstart = `${weekday} ${month} ${day.replace(/^0/, ' ')} ${time} ${year}`;
          const line = bytes(
            `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pgid).padStart(5)} ${lstart} `,
          );
          const output = new Uint8Array([...line, ...name, 0x0a]);
          expect(parsePsOutput(output)).toEqual({
            records: [{ pid, ppid, pgid, startTime: String(seconds), name: referenceDecode(name) }],
            rejected: 0,
          });
        },
      ),
      fcParams(),
    );
  });

  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (data) => {
        const { records, rejected } = parsePsOutput(data);
        expect(records.length + rejected).toBeLessThanOrEqual(data.length);
      }),
      fcParams(),
    );
  });
});
