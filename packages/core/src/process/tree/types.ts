/**
 * Which process-table source produced a snapshot. Start times of different
 * sources are not comparable, except that every Windows source uses the
 * canonical microseconds (see `tree/start-time.ts`).
 *
 * @public
 */
export type ProcessTableSource = 'linux-proc' | 'darwin-ps' | 'win32-cim';

/**
 * Identity of a process: its pid plus its start time (ADR-0010, ADR-0011
 * J9). A pid alone is never an identity, because pids are reused.
 *
 * @public
 */
export interface ProcessIdentity {
  readonly pid: number;
  /**
   * Canonical unsigned decimal (no sign, no leading zeros, at most 20
   * digits) in the unit of the snapshot's source: clock ticks since boot
   * (`linux-proc`), seconds since the epoch at one-second resolution
   * (`darwin-ps`), microseconds since 1601-01-01 UTC (`win32-cim`, the
   * canonical Windows unit, see `tree/start-time.ts`). Compare only within
   * one source.
   */
  readonly startTime: string;
}

/**
 * One row of a process-table snapshot.
 *
 * @public
 */
export interface ProcessRecord extends ProcessIdentity {
  readonly ppid: number;
  /** Process-group id; absent on Windows, which has no process groups. */
  readonly pgid?: number;
  /**
   * Command name as reported by the OS, decoded from bytes with U+FFFD for
   * ill-formed UTF-8. Untrusted: may hold spaces, parentheses, newlines and
   * control characters. Informational only; never used for a decision.
   * On macOS, `(<name>)` in parentheses means `ps` could not read the
   * process's arguments (a zombie, or a process the caller may not inspect).
   */
  readonly name: string;
  /**
   * `true` for a zombie: the process exited and its parent has not reaped it
   * yet (state `Z`, read from `/proc/<pid>/stat` or the `ps` `stat` column).
   * A zombie still holds its pid, so its identity stays valid, but it runs
   * nothing and signals have no effect on it. Absent for a live process and
   * on Windows, which has no zombies.
   */
  readonly zombie?: true;
}

/**
 * A process table read at one instant from one source.
 *
 * @public
 */
export interface ProcessSnapshot {
  readonly source: ProcessTableSource;
  /** Records with unique pids (every duplicated pid is dropped, see {@link ProcessSnapshot.rejected}). */
  readonly records: readonly ProcessRecord[];
  /**
   * Entries that could not be used: unparseable lines or files, records
   * without a start time, and every record of a pid that appeared more than
   * once (a sign of a forged line).
   */
  readonly rejected: number;
}

/**
 * Output of a process-table parser before pid deduplication.
 *
 * @public
 */
export interface ParsedProcessTable {
  readonly records: readonly ProcessRecord[];
  readonly rejected: number;
}
