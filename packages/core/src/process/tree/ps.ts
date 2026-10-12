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
 * `pid ppid pgid lstart comm`: numbers right-aligned, `lstart` in the C
 * locale (`%a %b %e %H:%M:%S %Y`), then one space and the command name to
 * the end of the line. `[\s\S]` keeps any character, including CR and
 * U+2028, inside the name.
 */
const LINE =
  /^ *([0-9]+) +([0-9]+) +([0-9]+) +([A-Z][a-z]{2}) ([A-Z][a-z]{2}) +([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})(?: ([\s\S]*))?$/;

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

function parseLine(line: string): ProcessRecord | null {
  const match = LINE.exec(line);
  if (match === null) return null;
  const [, pidText, ppidText, pgidText, ...rest] = match as unknown as [
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
  return { pid, ppid, pgid, startTime, name: rest[7] ?? '' };
}

/**
 * Parses the output of
 * `/bin/ps -A -o pid=,ppid=,pgid=,lstart=,comm=` run with `LC_ALL=C` and
 * `TZ=UTC0` (macOS; procps on Linux prints the same columns).
 *
 * @remarks
 * One record per line. Lines that do not match the column layout are
 * counted in `rejected`. A command name containing a newline can forge a
 * line; such a line is either malformed (rejected) or names a pid that
 * also has its real line, and `buildSnapshot` drops every duplicated pid.
 * Start times are seconds since the epoch (one-second resolution).
 */
export function parsePsOutput(output: Uint8Array): ParsedProcessTable {
  const records: ProcessRecord[] = [];
  let rejected = 0;
  let start = 0;
  while (start < output.length) {
    let end = output.indexOf(NEWLINE, start);
    if (end < 0) end = output.length;
    if (end > start) {
      const record = parseLine(decodeUtf8Lossy(output, start, end));
      if (record === null) rejected += 1;
      else records.push(record);
    }
    start = end + 1;
  }
  return { records, rejected };
}
