import { decodeUtf8Lossy, isPid } from './decode.js';
import { filetimeToMicroseconds, isCanonicalStartTime } from './start-time.js';
import type { ParsedProcessTable, ProcessRecord } from './types.js';

const BOM = String.fromCharCode(0xfeff);

function parseEntry(entry: unknown): ProcessRecord | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const fields = entry as Readonly<Record<string, unknown>>;
  const pid = fields['p'];
  const ppid = fields['pp'];
  const startTime = fields['t'];
  const name = fields['n'];
  if (
    !isPid(pid) ||
    !isPid(ppid) ||
    typeof startTime !== 'string' ||
    !isCanonicalStartTime(startTime) ||
    (name !== null && typeof name !== 'string')
  ) {
    return null;
  }
  return { pid, ppid, startTime: filetimeToMicroseconds(startTime), name: name ?? '' };
}

/**
 * Parses the JSON written by the Windows CIM query described on
 * `Win32CimTableCalls` (`os/types.ts`): an array of `{p, pp, t, n}`, or a
 * single such object (Windows PowerShell 5.1 unwraps one-element arrays).
 *
 * @remarks
 * Entries without a usable start time (`t` empty) cannot be identified and
 * are counted in `rejected`, as is a document that is not JSON (one
 * rejection, no records). `ParentProcessId` on Windows is never updated
 * when the parent exits, so it may name a reused pid; `descendantsOf`
 * guards against that with start times. The query writes FILETIME 100 ns
 * units; start times are returned in the canonical Windows unit,
 * microseconds (the CIM value has microsecond resolution, so the truncation
 * is exact).
 *
 * @beta
 */
export function parseWin32ProcessJson(output: Uint8Array): ParsedProcessTable {
  let document: unknown;
  try {
    const text = decodeUtf8Lossy(output);
    document = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch {
    return { records: [], rejected: 1 };
  }
  const entries: readonly unknown[] = Array.isArray(document) ? document : [document];
  const records: ProcessRecord[] = [];
  let rejected = 0;
  for (const entry of entries) {
    const record = parseEntry(entry);
    if (record === null) rejected += 1;
    else records.push(record);
  }
  return { records, rejected };
}
