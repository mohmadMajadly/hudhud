import type { ProcessTableCalls } from '../os/types.js';
import { isPid } from './decode.js';
import { descendantsOf, indexByPid, type DescendantTree } from './descendants.js';
import { parseProcStat } from './proc-stat.js';
import { parsePsOutput } from './ps.js';
import type {
  ParsedProcessTable,
  ProcessIdentity,
  ProcessRecord,
  ProcessSnapshot,
  ProcessTableSource,
} from './types.js';
import { parseWin32ProcessJson } from './win32.js';

/** Turns parser output into a snapshot with unique pids (duplicates are dropped and counted). */
export function buildSnapshot(
  source: ProcessTableSource,
  table: ParsedProcessTable,
): ProcessSnapshot {
  const { byPid, duplicates } = indexByPid(table.records);
  return { source, records: [...byPid.values()], rejected: table.rejected + duplicates };
}

/**
 * `readStat` errors that mean "this entry is not readable by the host", not
 * a failed table: `/proc` mounted with `hidepid=1` (`noaccess`, proc(5))
 * lists other users' processes but refuses their `stat` with `EPERM`
 * (review R3-2); `EACCES` is the same refusal. Such a process can never be
 * a verified descendant, and an unprivileged host cannot signal it anyway.
 */
const UNREADABLE = new Set(['EPERM', 'EACCES']);

function isUnreadable(error: unknown): boolean {
  const code: unknown =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && UNREADABLE.has(code);
}

/**
 * The most `/proc/<pid>/stat` reads in flight at once: a bound on open file
 * descriptors on hosts with many processes. Reading one at a time made a
 * table of 257 processes take about 90 ms in `node:22-bookworm` (review
 * fixes, plan §5.9), and the close path reads the table before EOF and again
 * after the exit.
 *
 * @internal
 */
export const PROC_READ_CONCURRENCY = 16;

/** What one listed entry gave: a record, nothing (exited), or a rejection. */
type EntryRead = ProcessRecord | 'gone' | 'rejected';

async function readEntry(
  calls: Extract<ProcessTableCalls, { source: 'linux-proc' }>,
  pid: number,
): Promise<EntryRead> {
  if (!isPid(pid)) return 'rejected';
  let stat: Uint8Array | null;
  try {
    stat = await calls.readStat(pid);
  } catch (error) {
    // Skipped and counted, like an unparseable entry; any other error fails the table.
    if (!isUnreadable(error)) throw error;
    return 'rejected';
  }
  if (stat === null) return 'gone'; // exited between the listing and the read
  return parseProcStat(stat, pid) ?? 'rejected';
}

async function readLinuxTable(
  calls: Extract<ProcessTableCalls, { source: 'linux-proc' }>,
): Promise<ParsedProcessTable> {
  const pids = await calls.listPids();
  const reads: EntryRead[] = Array.from({ length: pids.length }, () => 'gone');
  // A small pool of readers sharing one iterator (an array iterator has no
  // `return`, so a reader that stops does not close it for the others); the
  // first failure stops every reader from taking more.
  const entries = pids.entries();
  let failed = false;
  const reader = async (): Promise<void> => {
    for (const [index, pid] of entries) {
      if (failed) return;
      try {
        reads[index] = await readEntry(calls, pid);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROC_READ_CONCURRENCY, pids.length) }, () => reader()),
  );
  // In listing order, as one reader in sequence would have produced them.
  const records: ProcessRecord[] = [];
  let rejected = 0;
  for (const read of reads) {
    if (read === 'rejected') rejected += 1;
    else if (read !== 'gone') records.push(read);
  }
  return { records, rejected };
}

/**
 * Reads the whole process table once through the injected OS calls. Reads
 * only; nothing is signalled. Rejects when the underlying call rejects (for
 * example `ps` failing); callers treat that as "no snapshot".
 */
export async function takeSnapshot(calls: ProcessTableCalls): Promise<ProcessSnapshot> {
  switch (calls.source) {
    case 'linux-proc':
      return buildSnapshot(calls.source, await readLinuxTable(calls));
    case 'darwin-ps':
      return buildSnapshot(calls.source, parsePsOutput(await calls.runPs()));
    case 'win32-cim':
      return buildSnapshot(calls.source, parseWin32ProcessJson(await calls.queryProcesses()));
  }
}

/**
 * Dependencies of {@link snapshotDescendants}.
 *
 * @public
 */
export interface SnapshotDeps {
  readonly processTable: ProcessTableCalls;
}

/**
 * A full snapshot plus the tree under one root within it.
 *
 * @public
 */
export interface DescendantSnapshot extends DescendantTree {
  readonly snapshot: ProcessSnapshot;
}

/**
 * Takes a snapshot and returns the descendants of `root` (the spawned pid
 * plus its start time, ADR-0011 J9). The full snapshot is kept because the
 * selection functions also need records outside the tree (the host's
 * process group, for example).
 *
 * @public
 */
export async function snapshotDescendants(
  root: ProcessIdentity,
  deps: SnapshotDeps,
): Promise<DescendantSnapshot> {
  const snapshot = await takeSnapshot(deps.processTable);
  return { snapshot, ...descendantsOf(snapshot.records, root) };
}
