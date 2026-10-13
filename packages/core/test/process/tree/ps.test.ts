import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parsePsOutput, type PsDialect } from '../../../src/process/tree/ps.js';
import { bytes, fcParams, fixture, referenceDecode } from './support.js';

/** Seconds since the epoch of a UTC wall-clock time, as the parser reports it. */
function utc(iso: string): string {
  return String(Date.parse(`${iso}Z`) / 1000);
}

/**
 * One line in the exact column layout of `dialect`: numbers right-aligned in
 * width 5, `stat` left-justified in width 4, `lstart` left-justified in
 * width 28 (`bsd`) or 24 (`procps`), one space between columns.
 */
function line(
  dialect: PsDialect,
  fields: { pid: number; ppid: number; pgid: number; stat: string; lstart: string },
): string {
  const width = dialect === 'bsd' ? 28 : 24;
  return `${String(fields.pid).padStart(5)} ${String(fields.ppid).padStart(5)} ${String(fields.pgid).padStart(5)} ${fields.stat.padEnd(4)} ${fields.lstart.padEnd(width)} `;
}

describe('parsePsOutput on the recorded Linux procps output (dialect procps)', () => {
  it('parses every line, marks the zombie from stat and keeps hostile names whole', () => {
    const t = (seconds: string): string => utc(`2026-10-13T12:${seconds}`);
    expect(parsePsOutput(fixture('linux/ps.out'), 'procps')).toEqual({
      records: [
        { pid: 1, ppid: 0, pgid: 1, startTime: t('01:57'), name: 'docker-init' },
        { pid: 7, ppid: 1, pgid: 7, startTime: t('01:58'), name: 'bash' },
        { pid: 16, ppid: 7, pgid: 16, startTime: t('01:58'), name: 'a) (b c' },
        { pid: 17, ppid: 7, pgid: 17, startTime: t('01:58'), name: 'x) R 1 1 1 0' },
        { pid: 18, ppid: 7, pgid: 18, startTime: t('01:58'), name: 'nl.9 1 9 Z' },
        { pid: 19, ppid: 7, pgid: 19, startTime: t('01:59'), name: '??-bad' },
        { pid: 20, ppid: 7, pgid: 20, startTime: t('01:59'), name: 'reaper' },
        { pid: 21, ppid: 20, pgid: 20, startTime: t('01:59'), name: 'bash', zombie: true },
        { pid: 22, ppid: 7, pgid: 22, startTime: t('01:59'), name: 'plain' },
        { pid: 23, ppid: 22, pgid: 22, startTime: t('01:59'), name: 'plain' },
        { pid: 25, ppid: 7, pgid: 25, startTime: t('02:00'), name: 'ps' },
      ],
      rejected: 0,
    });
  });

  it('rejects every procps line under the BSD layout (the lstart gap differs)', () => {
    const parsed = parsePsOutput(fixture('linux/ps.out'));
    expect(parsed).toEqual({ records: [], rejected: 11 });
  });
});

describe('parsePsOutput on the macOS output recorded by gate run 2 (research 10)', () => {
  it('parses the arm64 and x64 lines exactly: stat width 4, lstart width 28, bare names kept', () => {
    const t = (iso: string): string => utc(`2026-10-13T${iso}`);
    expect(parsePsOutput(fixture('darwin/ps.recorded-arm64.out'))).toEqual({
      records: [
        {
          pid: 1471,
          ppid: 1342,
          pgid: 948,
          startTime: t('16:27:46'),
          name: '/Users/runner/work/_temp/macos-gate/cli-cache/2.1.296/darwin-arm64/claude',
        },
        { pid: 1507, ppid: 1471, pgid: 1507, startTime: t('16:27:47'), name: '/bin/zsh' },
        { pid: 1509, ppid: 1507, pgid: 1507, startTime: t('16:27:47'), name: 'sleep' },
      ],
      rejected: 0,
    });
    const x64 = parsePsOutput(fixture('darwin/ps.recorded-x64.out'));
    expect(x64.rejected).toBe(0);
    expect(x64.records.map((record) => `${String(record.pid)} ${record.name}`)).toEqual([
      '3173 /Users/runner/work/_temp/macos-gate/cli-cache/2.1.296/darwin-x64/claude',
      '3233 /usr/bin/git',
      '3237 sh',
      '3239 /Applications/Xcode_16.4.app/Contents/Developer/usr/bin/xcodebuild',
      '3336 /bin/zsh',
      '3337 sleep',
    ]);
    expect(x64.records.every((record) => record.zombie === undefined)).toBe(true);
  });
});

describe('parsePsOutput on the synthesized macOS output (BSD layout; see manifest.json)', () => {
  const parsed = parsePsOutput(fixture('darwin/ps.synthesized.out'));
  const byPid = new Map(parsed.records.map((record) => [record.pid, record]));

  it('strips exactly the lstart padding: names are exact', () => {
    expect(byPid.get(1)).toEqual({
      pid: 1,
      ppid: 0,
      pgid: 1,
      startTime: utc('2026-10-05T06:41:09'),
      name: '/sbin/launchd',
    });
    expect(byPid.get(502)?.name).toBe('/opt/claude/versions/2.1.296');
    expect(byPid.get(533)?.name).toBe('  lead');
    expect(byPid.get(534)?.name).toBe('/bin/flags');
  });

  it('keeps names with spaces and parentheses whole, and accepts an empty name', () => {
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

  it('marks a zombie from stat and keeps its parenthesized name as printed', () => {
    expect(byPid.get(532)).toEqual({
      pid: 532,
      ppid: 502,
      pgid: 480,
      startTime: utc('2026-10-12T17:00:12'),
      name: '(security)',
      zombie: true,
    });
    expect(parsed.records.filter((record) => record.zombie === true)).toHaveLength(1);
  });

  it('returns the forged duplicate line for buildSnapshot to drop, and rejects malformed lines', () => {
    expect(parsed.records.filter((record) => record.pid === 480)).toHaveLength(2);
    expect(byPid.has(612)).toBe(false);
    expect(byPid.has(613)).toBe(false);
    // wrong weekday, procps gap, garbage
    expect(parsed.rejected).toBe(3);
  });
});

describe('parsePsOutput line validation', () => {
  const lstart = 'Mon Oct 12 17:00:00 2026';
  const ok = `${line('bsd', { pid: 10, ppid: 1, pgid: 10, stat: 'S', lstart })}name`;
  const malformed: [string, string][] = [
    ['missing columns', `   10     1 S    ${lstart.padEnd(28)} name`],
    ['missing stat', `   10     1    10 ${lstart.padEnd(28)} name`],
    ['stat with a digit', `   10     1    10 S1   ${lstart.padEnd(28)} name`],
    ['stat of 17 characters', `   10     1    10 ${'S'.repeat(17)} ${lstart.padEnd(28)} name`],
    ['unknown month', `   10     1    10 S    ${'Mon Foo 12 17:00:00 2026'.padEnd(28)} name`],
    ['February 30', `   10     1    10 S    ${'Mon Feb 30 17:00:00 2026'.padEnd(28)} name`],
    ['day 0', `   10     1    10 S    ${'Mon Oct  0 17:00:00 2026'.padEnd(28)} name`],
    ['hour 24', `   10     1    10 S    ${'Tue Oct 13 24:00:00 2026'.padEnd(28)} name`],
    ['minute 60', `   10     1    10 S    ${'Mon Oct 12 17:60:00 2026'.padEnd(28)} name`],
    ['second 60', `   10     1    10 S    ${'Mon Oct 12 17:00:60 2026'.padEnd(28)} name`],
    ['year before 1970', `   10     1    10 S    ${'Wed Dec 31 23:59:59 1969'.padEnd(28)} name`],
    ['wrong weekday', `   10     1    10 S    ${'Tue Oct 12 17:00:00 2026'.padEnd(28)} name`],
    ['pid out of range', `4294967296     1    10 S    ${lstart.padEnd(28)} name`],
    ['ppid out of range', `   10 4294967296    10 S    ${lstart.padEnd(28)} name`],
    ['pgid out of range', `   10     1 4294967296 S    ${lstart.padEnd(28)} name`],
    ['no separator before the name', `   10     1    10 S    ${lstart}name`],
    ['the procps gap', `   10     1    10 S    ${lstart} name`],
    ['three padding spaces', `   10     1    10 S    ${lstart}    name`],
    ['negative pid', `  -10     1    10 S    ${lstart.padEnd(28)} name`],
  ];
  for (const [label, text] of malformed) {
    it(`rejects: ${label}`, () => {
      expect(parsePsOutput(bytes(`${ok}\n${text}\n`))).toEqual({
        records: [expect.objectContaining({ pid: 10, name: 'name' })],
        rejected: 1,
      });
    });
  }

  it('accepts the last line without a newline and skips empty lines', () => {
    expect(parsePsOutput(bytes(`\n\n${ok}`)).records).toHaveLength(1);
    expect(parsePsOutput(new Uint8Array())).toEqual({ records: [], rejected: 0 });
  });

  it('accepts a line that ends right after the date (empty name), in both dialects', () => {
    expect(parsePsOutput(bytes(`   10     1    10 S    ${lstart}\n`)).records[0]?.name).toBe('');
    expect(
      parsePsOutput(bytes(`   10     1    10 S    ${lstart}\n`), 'procps').records[0]?.name,
    ).toBe('');
  });

  it('keeps a CR, leading spaces and U+2028 inside the name', () => {
    const [record] = parsePsOutput(bytes(`${ok.slice(0, -4)}  a\r b\n`)).records;
    expect(record?.name).toBe('  a\r b');
  });

  it('decodes ill-formed UTF-8 in the name with replacement characters', () => {
    const text = new Uint8Array([...bytes(`${ok} `), 0xff, 0x0a]);
    expect(parsePsOutput(text).records[0]?.name).toBe('name �');
  });

  it('marks zombies only by a stat starting with Z', () => {
    const at = (stat: string): string => line('bsd', { pid: 10, ppid: 1, pgid: 10, stat, lstart });
    expect(parsePsOutput(bytes(`${at('Z')}(x)\n`)).records[0]).toMatchObject({ zombie: true });
    expect(parsePsOutput(bytes(`${at('Zs')}x\n`)).records[0]).toMatchObject({ zombie: true });
    for (const stat of ['S', 'R+', 'SZ', 'T', 'Ss<']) {
      expect(parsePsOutput(bytes(`${at(stat)}(x)\n`)).records[0]).not.toHaveProperty('zombie');
    }
  });
});

describe('parsePsOutput on arbitrary names', () => {
  const stats = fc.constantFrom('S', 'Ss', 'R+', 'Z', 'S<+Ns', 'U', 'I', 'T');
  for (const dialect of ['bsd', 'procps'] as const) {
    it(`${dialect}: parses the columns exactly and keeps any newline-free name`, () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ maxLength: 48 }).map((name) => name.filter((byte) => byte !== 0x0a)),
          fc.integer({ min: 0, max: 99_999 }),
          fc.integer({ min: 0, max: 99_999 }),
          fc.integer({ min: 0, max: 99_999 }),
          stats,
          fc.date({
            min: new Date('1970-01-01T00:00:00Z'),
            max: new Date('2100-01-01T00:00:00Z'),
            noInvalidDate: true,
          }),
          (name, pid, ppid, pgid, stat, date) => {
            const seconds = Math.floor(date.getTime() / 1000);
            const at = new Date(seconds * 1000);
            // "Mon, 12 Oct 2026 17:00:00 GMT"
            const [weekday, day, month, year, time] = at
              .toUTCString()
              .replace(',', '')
              .split(' ') as [string, string, string, string, string];
            const lstart = `${weekday} ${month} ${day.replace(/^0/, ' ')} ${time} ${year}`;
            const head = bytes(line(dialect, { pid, ppid, pgid, stat, lstart }));
            const output = new Uint8Array([...head, ...name, 0x0a]);
            expect(parsePsOutput(output, dialect)).toEqual({
              records: [
                {
                  pid,
                  ppid,
                  pgid,
                  startTime: String(seconds),
                  name: referenceDecode(name),
                  ...(stat.startsWith('Z') ? { zombie: true } : {}),
                },
              ],
              rejected: 0,
            });
          },
        ),
        fcParams(),
      );
    });
  }

  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (data) => {
        for (const dialect of ['bsd', 'procps'] as const) {
          const { records, rejected } = parsePsOutput(data, dialect);
          expect(records.length + rejected).toBeLessThanOrEqual(data.length);
        }
      }),
      fcParams(),
    );
  });
});
