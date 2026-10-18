import { decodeUtf8Lossy, group, parsePid } from './decode.js';
import { isCanonicalStartTime } from './start-time.js';
import type { ProcessRecord } from './types.js';

const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const HEAD = /^([0-9]+) $/;

/**
 * The fields after the command name (proc(5)): ` state ppid pgrp`, then
 * sixteen signed integers (session, tty_nr, tpgid, flags, minflt, cminflt,
 * majflt, cmajflt, utime, stime, cutime, cstime, priority, nice,
 * num_threads, itrealvalue), then `starttime` (field 22, clock ticks since
 * boot), then the remaining fields.
 */
const TAIL = /^ ([A-Za-z]) ([0-9]+) ([0-9]+)(?: -?[0-9]+){16} ([0-9]+)(?:[ \n]|$)/;

/**
 * Parses the bytes of one Linux `/proc/<pid>/stat` file (proc(5)).
 *
 * @remarks
 * The command name sits between the first `(` and the **last** `)`: it may
 * itself contain spaces, parentheses and newlines (the kernel writes it
 * unescaped), and it may be ill-formed UTF-8. Every field after it is
 * ASCII. The parser locates the parentheses on bytes, so a hostile name
 * cannot shift fields.
 *
 * @param stat - the file's bytes.
 * @param expectedPid - when given, the pid in the file must equal it (the
 *   pid of the `/proc` entry that was read).
 * @returns the record, or `null` for anything malformed.
 *
 * @beta
 */
export function parseProcStat(stat: Uint8Array, expectedPid?: number): ProcessRecord | null {
  const open = stat.indexOf(OPEN_PAREN);
  const close = stat.lastIndexOf(CLOSE_PAREN);
  if (open < 0 || close < open) return null;

  const head = HEAD.exec(decodeUtf8Lossy(stat, 0, open));
  const pid = head === null ? null : parsePid(group(head, 1));
  if (pid === null || (expectedPid !== undefined && pid !== expectedPid)) return null;

  const tail = TAIL.exec(decodeUtf8Lossy(stat, close + 1));
  if (tail === null) return null;
  const ppid = parsePid(group(tail, 2));
  const pgid = parsePid(group(tail, 3));
  const startTime = group(tail, 4);
  if (ppid === null || pgid === null || !isCanonicalStartTime(startTime)) return null;

  const record: ProcessRecord = {
    pid,
    ppid,
    pgid,
    startTime,
    name: decodeUtf8Lossy(stat, open + 1, close),
  };
  return group(tail, 1) === 'Z' ? { ...record, zombie: true } : record;
}
