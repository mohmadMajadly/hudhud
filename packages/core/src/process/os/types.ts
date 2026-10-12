/**
 * Interfaces of the thin OS syscall adapters (plan §1.7, §4.8).
 *
 * @remarks
 * Types only. The implementations (`os/posix.ts`, `os/darwin.ts`,
 * `os/win32.ts`) land with the ladders (W2-T7, W2-T8); they contain no logic,
 * only the calls described here, and are coverage-scoped per OS. Every
 * decision (which pid, which group, whether an identity still matches) is
 * made by the pure functions in `process/tree/`, never inside an adapter.
 *
 * This file imports nothing: the `os-adapters-leaf` dependency rule allows
 * the adapters to import only Node built-ins and this file.
 */

/**
 * Linux: the `/proc` filesystem (ADR-0010 "Sweep").
 *
 * @remarks
 * Start times are field 22 of `/proc/<pid>/stat` (clock ticks since boot).
 */
export interface LinuxProcTableCalls {
  readonly source: 'linux-proc';
  /** The numeric entries of `/proc`, in any order. Non-numeric entries are not returned. */
  listPids(): Promise<readonly number[]>;
  /**
   * The raw bytes of `/proc/<pid>/stat`, or `null` when the process no longer
   * exists (`ENOENT`, `ESRCH`). Read as bytes: the command name may hold any
   * byte except NUL, including newlines, parentheses and invalid UTF-8.
   */
  readStat(pid: number): Promise<Uint8Array | null>;
}

/**
 * macOS: `/bin/ps` by absolute path (ADR-0010 "Sweep"; plan §1.7).
 *
 * @remarks
 * Contract of `runPs`: run `/bin/ps` with argv
 * `['-A', '-o', 'pid=,ppid=,pgid=,lstart=,comm=']`, `shell: false`, and an
 * environment of exactly `{ LC_ALL: 'C', TZ: 'UTC0' }`. `LC_ALL=C` fixes the
 * `lstart` format (`Mon Oct 12 17:02:31 2026`); `TZ=UTC0` makes `lstart`
 * unambiguous across DST changes (plan decision of W1-T9, additive to the
 * plan's `LC_ALL=C`). The exact field list is to be confirmed by the macOS
 * gate. Resolves with stdout as bytes; rejects on a non-zero exit.
 */
export interface DarwinPsTableCalls {
  readonly source: 'darwin-ps';
  runPs(): Promise<Uint8Array>;
}

/**
 * Windows: one CIM query over `Win32_Process` (plan §4.7; test-support leak
 * sampling and best-effort diagnostics, not the job ladder).
 *
 * @remarks
 * Contract of `queryProcesses`: run
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <script>`
 * with `shell: false`, where the script sets
 * `[Console]::OutputEncoding = [Text.Encoding]::UTF8` and writes
 * `ConvertTo-Json -Compress -InputObject @(...)` of one object per process:
 * `p` = `ProcessId` (number), `pp` = `ParentProcessId` (number), `t` =
 * `CreationDate.ToFileTimeUtc()` as a decimal string (FILETIME, 100 ns
 * units; a JSON number would lose precision; the parser truncates it to the
 * canonical microseconds, see `tree/start-time.ts`) or `''` when absent, `n` =
 * `Name` (string or null). JSON escapes control characters, so a hostile
 * name cannot forge a record. Resolves with stdout as bytes.
 */
export interface Win32CimTableCalls {
  readonly source: 'win32-cim';
  queryProcesses(): Promise<Uint8Array>;
}

/** Reads of the process table for one platform. */
export type ProcessTableCalls = LinuxProcTableCalls | DarwinPsTableCalls | Win32CimTableCalls;

/** The only signals the POSIX ladder sends (ADR-0010). */
export type PosixSignal = 'SIGTERM' | 'SIGKILL';

/** Result of one `kill(2)` call, mapped from its errno. */
export type SignalOutcome = 'sent' | 'no-such-process' | 'not-permitted';

/**
 * POSIX `kill(2)`.
 *
 * @remarks
 * Callers pass only targets selected by `process/tree/select.ts`; the
 * adapter itself refuses nothing and decides nothing. `signalGroup(pgid)`
 * is `kill(-pgid, signal)`; it is never called for the host's, the
 * launcher's or the CLI's group (ADR-0010, K1).
 */
export interface PosixSignalCalls {
  signalProcess(pid: number, signal: PosixSignal): SignalOutcome;
  signalGroup(pgid: number, signal: PosixSignal): SignalOutcome;
}

/** Result of the best-effort Windows tree kill. */
export interface TaskkillResult {
  readonly exitCode: number | null;
}

/**
 * Windows best-effort fallback (ADR-0009): `taskkill /T /F /PID <pid>` by
 * absolute path `%SystemRoot%\System32\taskkill.exe`, `shell: false`.
 * `TerminateJobObject` belongs to the job addon handle and `TerminateProcess`
 * to the child handle, so neither is here.
 */
export interface Win32TerminateCalls {
  taskkillTree(pid: number): Promise<TaskkillResult>;
}

/** Everything the process layer asks of the operating system. */
export type OsCalls =
  | {
      readonly platform: 'linux';
      /** `process.pid` of the host. */
      readonly hostPid: number;
      readonly processTable: LinuxProcTableCalls;
      readonly signals: PosixSignalCalls;
    }
  | {
      readonly platform: 'darwin';
      readonly hostPid: number;
      readonly processTable: DarwinPsTableCalls;
      readonly signals: PosixSignalCalls;
    }
  | {
      readonly platform: 'win32';
      readonly hostPid: number;
      readonly processTable: Win32CimTableCalls;
      readonly terminate: Win32TerminateCalls;
    };
