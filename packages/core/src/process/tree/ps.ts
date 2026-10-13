import { decodeUtf8Lossy, parsePid } from './decode.js';
import type { ParsedProcessTable, ProcessRecord } from './types.js';

const NEWLINE = 0x0a;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * The `ps` implementation that printed the output; it fixes the width of
 * the `lstart` column.
 *
 * - `bsd`: macOS `/bin/ps`. `lstart` is a left-justified column of width
 *   28, so the 24-character date is followed by 4 padding spaces and then
 *   the one-space column separator. macOS gate run 1 showed exactly these 4
 *   spaces at the start of every name parsed with a single separator.
 * - `procps`: procps-ng on Linux. `lstart` has width 24: the date is
 *   followed by the separator only.
 *
 * @public
 */
export type PsDialect = 'bsd' | 'procps';

/** Spaces between the end of the `lstart` date and the first character of `comm`. */
const LSTART_GAP: Readonly<Record<PsDialect, number>> = { bsd: 5, procps: 1 };

/**
 * `pid ppid pgid stat lstart comm`: numbers right-aligned, `stat` one token
 * without spaces (left-justified, padded), `lstart` in the C locale
 * (`%a %b %e %H:%M:%S %Y`), then exactly the dialect's gap and the command
 * name to the end of the line. A line that ends right after the date has an
 * empty name. `[\s\S]` keeps any character, including CR and U+2028, inside
 * the name; because the gap is matched exactly, a name's own leading spaces
 * stay part of it.
 */
function linePattern(dialect: PsDialect): RegExp {
  const gap = ' '.repeat(LSTART_GAP[dialect]);
  return new RegExp(
    `^ *([0-9]+) +([0-9]+) +([0-9]+) +([A-Za-z<>+]{1,16}) +([A-Z][a-z]{2}) ([A-Z][a-z]{2}) +([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})(?:${gap}([\\s\\S]*))?$`,
  );
}

const LINES: Readonly<Record<PsDialect, RegExp>> = {
  bsd: linePattern('bsd'),
  procps: linePattern('procps'),
};

/**
 * Converts the `lstart` fields, printed in UTC (`TZ=UTC0`), to seconds since
 * the epoch; `null` for an impossible date or a weekday that does not match.
 */
function lstartSeconds(fields: readonly string[]): string | null {
  const [weekday, monthName, day, hour, minute, second, year] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const month = (MONTHS as readonly string[]).indexOf(monthName);
  const [y, d, h, m, s] = [year, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 0 || y < 1970 || h > 23 || m > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, month, d, h, m, s));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== d ||
    WEEKDAYS[date.getUTCDay()] !== weekday
  ) {
    return null;
  }
  return String(date.getTime() / 1000);
}

function parseLine(line: string, pattern: RegExp): ProcessRecord | null {
  const match = pattern.exec(line);
  if (match === null) return null;
  const [, pidText, ppidText, pgidText, stat, ...rest] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    ...string[],
  ];
  const pid = parsePid(pidText);
  const ppid = parsePid(ppidText);
  const pgid = parsePid(pgidText);
  const startTime = lstartSeconds(rest.slice(0, 7));
  if (pid === null || ppid === null || pgid === null || startTime === null) return null;
  const record: ProcessRecord = { pid, ppid, pgid, startTime, name: rest[7] ?? '' };
  // State `Z` (both dialects): exited, not yet reaped by its parent.
  return stat.startsWith('Z') ? { ...record, zombie: true } : record;
}

/**
 * Parses the output of
 * `/bin/ps -A -o pid=,ppid=,pgid=,stat=,lstart=,comm=` run with `LC_ALL=C`
 * and `TZ=UTC0`: macOS (dialect `bsd`, the default), or procps-ng on Linux,
 * which prints the same columns with a narrower `lstart` (dialect `procps`).
 *
 * @remarks
 * One record per line. Lines that do not match the column layout are
 * counted in `rejected`. The name is exactly what `ps` printed for `comm`,
 * without the column padding. macOS prints `(<p_comm>)`, the 16-byte kernel
 * name in parentheses, when it cannot read a process's arguments: for every
 * zombie, and for processes the caller may not inspect. A zombie is marked
 * `zombie: true` from the `stat` column; it is never inferred from the name.
 * A command name containing a newline can forge a line; such a line is
 * either malformed (rejected) or names a pid that also has its real line,
 * and `buildSnapshot` drops every duplicated pid. Start times are seconds
 * since the epoch (one-second resolution).
 *
 * @public
 */
export function parsePsOutput(output: Uint8Array, dialect: PsDialect = 'bsd'): ParsedProcessTable {
  const pattern = LINES[dialect];
  const records: ProcessRecord[] = [];
  let rejected = 0;
  let start = 0;
  while (start < output.length) {
    let end = output.indexOf(NEWLINE, start);
    if (end < 0) end = output.length;
    if (end > start) {
      const record = parseLine(decodeUtf8Lossy(output, start, end), pattern);
      if (record === null) rejected += 1;
      else records.push(record);
    }
    start = end + 1;
  }
  return { records, rejected };
}
