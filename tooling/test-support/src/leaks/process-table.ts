/**
 * Process-table reads for the leak assertions (plan §4.7; 07 §13).
 *
 * @remarks
 * Each row carries the identity used everywhere in hudhud (pid plus start
 * time, ADR-0011 J9), parsed by the core parsers of `@hudhud/core/process`
 * so it compares with spawn identities, plus the command line, which the
 * core snapshots do not read: the suite-level sweep finds survivors by the
 * sandbox root in their command lines (07 §13). Sources: Linux
 * `/proc/<pid>/stat` (start time = field 22, clock ticks since boot) and
 * `/proc/<pid>/cmdline`; Windows one WMI query over `Win32_Process` through
 * `powershell.exe` by absolute path (start time = `CreationDate` in the
 * canonical microseconds); macOS the core `ps` adapter of
 * `osCallsFor('darwin')` and its parser (start time = `lstart`, seconds), plus
 * one more `/bin/ps` run for the command lines, joined by pid and start
 * time. The `ps` fields are still to be confirmed by the macOS gate (M1,
 * ADR-0010). Reads only; nothing here signals a process other than a read
 * command of its own that exceeded its bounds ({@link WIN32_READ_LIMITS},
 * {@link DARWIN_READ_LIMITS}).
 */

import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  osCallsFor,
  parseProcStat,
  parsePsOutput,
  parseWin32ProcessJson,
} from '@hudhud/core/process';
import type { OsCalls, ProcessRecord } from '@hudhud/core/process';

import { windowsSystemRoot } from '../launcher/env.js';

/** One process, identified by pid plus start time. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** Decimal start time in the source's unit; compare only within one source. */
  readonly startTime: string;
  /** Untrusted image or command name; informational only. */
  readonly name: string;
  /** Untrusted command line (arguments joined by spaces); `''` when unknown. */
  readonly commandLine: string;
}

/** Reads the whole process table. */
export interface ProcessTable {
  readonly source: 'win32-cim' | 'linux-proc' | 'darwin-ps';
  read(): Promise<readonly ProcessRow[]>;
}

/** A real process: pid 0 (the idle process) is skipped. */
function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The WMI query: one `{p, pp, t, n, c}` object per process (`t` = FILETIME
 * of `CreationDate` as a string, `''` when absent), as a JSON array in UTF-8.
 * Built like the core query (`os/win32.ts` `CIM_SCRIPT`): in-box .NET
 * classes only, no cmdlet, so PowerShell discovers no module, and `t` from
 * the DMTF datetime exactly as the core computes it, so start times compare
 * with spawn identities.
 */
export const WIN32_PROCESS_SCRIPT: string = [
  "$ErrorActionPreference = 'Stop'",
  '$inv = [Globalization.CultureInfo]::InvariantCulture',
  "$null = [Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')",
  "$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')",
  "$query = [Management.ManagementObjectSearcher]::new('SELECT ProcessId, ParentProcessId, CreationDate, Name, CommandLine FROM Win32_Process')",
  '$rows = [Collections.Generic.List[object]]::new()',
  'foreach ($o in $query.Get()) {',
  "  $d = $o['CreationDate']",
  '  $t = [string]::Empty',
  '  if ($null -ne $d) {',
  "    $u = [DateTime]::ParseExact($d.Substring(0, 21), 'yyyyMMddHHmmss.ffffff', $inv, [Globalization.DateTimeStyles]'AssumeUniversal, AdjustToUniversal')",
  '    $t = $u.AddMinutes(-[int]$d.Substring(21)).ToFileTimeUtc().ToString($inv)',
  '  }',
  '  $row = [Collections.Generic.Dictionary[string, object]]::new()',
  "  $row['p'] = [int64]$o['ProcessId']; $row['pp'] = [int64]$o['ParentProcessId']; $row['t'] = $t",
  "  $row['n'] = $o['Name']; $row['c'] = $o['CommandLine']",
  '  $rows.Add($row)',
  '}',
  '$json = [Web.Script.Serialization.JavaScriptSerializer]::new()',
  '$json.MaxJsonLength = [int]::MaxValue',
  '$bytes = [Text.UTF8Encoding]::new($false).GetBytes($json.Serialize($rows))',
  '$stdout = [Console]::OpenStandardOutput()',
  '$stdout.Write($bytes, 0, $bytes.Length)',
  '$stdout.Flush()',
].join('\n');

/**
 * Parses the output of {@link WIN32_PROCESS_SCRIPT}. Malformed entries
 * (and pid 0, the idle process) are skipped; a document that is not JSON
 * yields no rows.
 */
export function parseWin32Processes(text: string): readonly ProcessRow[] {
  // pid, ppid, start time and name: the core parser, so start times are in
  // the canonical Windows unit (microseconds) that spawn identities use.
  const { records } = parseWin32ProcessJson(new TextEncoder().encode(text));
  if (records.length === 0) return [];
  // The command line is the one field the core query does not carry.
  const commandLines = new Map<number, string>();
  const document: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const entries: readonly unknown[] = Array.isArray(document) ? document : [document];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const pid: unknown = Reflect.get(entry, 'p');
    const commandLine: unknown = Reflect.get(entry, 'c');
    if (isPid(pid) && typeof commandLine === 'string') commandLines.set(pid, commandLine);
  }
  return records
    .filter((record) => isPid(record.pid))
    .map((record) => ({
      pid: record.pid,
      ppid: record.ppid,
      startTime: record.startTime,
      name: record.name,
      commandLine: commandLines.get(record.pid) ?? '',
    }));
}

/**
 * Parses `/proc/<pid>/stat` and `/proc/<pid>/cmdline` of one process. The
 * name sits between the first `(` and the last `)` and may contain
 * anything, so fields are taken after the last `)` only.
 *
 * @returns the row, or `null` when the stat text is malformed.
 */
export function parseLinuxProcess(stat: string, cmdline: string): ProcessRow | null {
  // The core parser (`@hudhud/core/process`), as for every other snapshot.
  const record = parseProcStat(new TextEncoder().encode(stat));
  if (record === null || !isPid(record.pid)) return null;
  return {
    pid: record.pid,
    ppid: record.ppid,
    startTime: record.startTime,
    name: record.name,
    commandLine: cmdline
      .split('\0')
      .filter((arg) => arg !== '')
      .join(' '),
  };
}

/**
 * Parses the two `ps` outputs of {@link darwinProcessTable}: the identity
 * table (`pid ppid pgid stat lstart comm`, the core parser) and the same layout
 * with `args` for `comm`, joined by pid and start time, so a pid reused
 * between the two runs never gets another process's command line. A pid
 * listed twice in either output (a forged line) is dropped, as the core
 * snapshots do.
 */
export function parseDarwinProcesses(
  table: Uint8Array,
  commandLines: Uint8Array,
): readonly ProcessRow[] {
  const unique = (records: readonly ProcessRecord[]): ProcessRecord[] => {
    const counts = new Map<number, number>();
    for (const record of records) counts.set(record.pid, (counts.get(record.pid) ?? 0) + 1);
    return records.filter((record) => counts.get(record.pid) === 1);
  };
  const lines = new Map(
    unique(parsePsOutput(commandLines).records).map((record) => [
      `${String(record.pid)}@${record.startTime}`,
      record.name,
    ]),
  );
  return unique(parsePsOutput(table).records)
    .filter((record) => isPid(record.pid))
    .map((record) => ({
      pid: record.pid,
      ppid: record.ppid,
      startTime: record.startTime,
      name: record.name,
      commandLine: lines.get(`${String(record.pid)}@${record.startTime}`) ?? '',
    }));
}

/** Absolute path of `ps` on macOS; never looked up through `PATH`. */
export const DARWIN_PS_PATH = '/bin/ps';

/**
 * The command-line `ps` run: the core layout (`os/darwin.ts`) with `args`
 * for `comm`, wide output (`-ww`), and the same environment, so `lstart`
 * matches the identity table to the second.
 */
export const DARWIN_ARGS_PS: readonly string[] = [
  '-A',
  '-ww',
  '-o',
  'pid=,ppid=,pgid=,stat=,lstart=,args=',
];

/** The complete environment of {@link DARWIN_ARGS_PS} (as the core `ps` contract). */
export const DARWIN_PS_ENV: Readonly<Record<string, string>> = { LC_ALL: 'C', TZ: 'UTC0' };

/** The two `ps` runs of {@link darwinProcessTable}. */
export interface DarwinReads {
  /** The core identity table (`DarwinPsTableCalls.runPs`). */
  identities(): Promise<Uint8Array>;
  /** The {@link DARWIN_ARGS_PS} output. */
  commandLines(): Promise<Uint8Array>;
}

/** The macOS process table from `ps` (see the module remarks). */
export function darwinProcessTable(reads: DarwinReads): ProcessTable {
  return {
    source: 'darwin-ps',
    async read() {
      const [table, commandLines] = await Promise.all([reads.identities(), reads.commandLines()]);
      return parseDarwinProcesses(table, commandLines);
    },
  };
}

/** Runs a PowerShell script and resolves with its stdout. */
export type PowerShellRunner = (script: string) => Promise<string>;

/** Bounds of one command run. */
export interface CommandLimits {
  /** Milliseconds before the command is killed and the run rejects. */
  readonly timeoutMs: number;
  /** Bytes of stdout accepted; one more kills the command and the run rejects. */
  readonly maxStdoutBytes: number;
}

/** Stdout cap of a process-table read, as the core adapters (`os/win32.ts`, `os/darwin.ts`). */
const TABLE_OUTPUT_CAP = 64 * 1024 * 1024;

/**
 * Bounds of the Windows CIM query: the core's process-table read bound
 * (`os/win32.ts` `DEFAULT_LIMITS`, 60 s), for the same query on the same
 * hosts (0.3 to 1.3 s measured on GitHub-hosted Windows runners).
 */
export const WIN32_READ_LIMITS: CommandLimits = Object.freeze({
  timeoutMs: 60_000,
  maxStdoutBytes: TABLE_OUTPUT_CAP,
});

/**
 * Bounds of a macOS `ps` run: the core's process-table read bound
 * (`os/darwin.ts` `DEFAULT_LIMITS`, 30 s).
 */
export const DARWIN_READ_LIMITS: CommandLimits = Object.freeze({
  timeoutMs: 30_000,
  maxStdoutBytes: TABLE_OUTPUT_CAP,
});

/**
 * Runs `file` with `args` and resolves with its stdout as bytes.
 *
 * @remarks
 * The semantics of the core's `runBoundedCommand`, rejecting instead of
 * reporting an outcome: `shell: false`, hidden window, stdin and stderr
 * ignored. When `limits.timeoutMs` passes or stdout exceeds
 * `limits.maxStdoutBytes`, the command is killed through its own handle
 * (`SIGKILL`; `TerminateProcess` on Windows) and its stdout pipe destroyed,
 * so a descendant holding the pipe cannot hold the run, and the run rejects.
 * It also rejects when the command cannot start or exits other than with 0.
 * `env` is the complete environment when given, the host's otherwise.
 */
function runBounded(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
  limits: CommandLimits,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(env === undefined ? {} : { env: { ...env } }),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    // Kills the command and rejects; a later settle of the promise is a no-op.
    const end = (error: Error): void => {
      failed = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdout.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      end(new Error(`${file} timed out after ${String(limits.timeoutMs)} ms`));
    }, limits.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.maxStdoutBytes) {
        end(new Error(`${file} wrote more than ${String(limits.maxStdoutBytes)} bytes`));
      } else {
        chunks.push(chunk);
      }
    });
    child.once('error', (error) => {
      end(new Error(`${file} failed`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failed) return;
      if (code === 0) resolve(new Uint8Array(Buffer.concat(chunks)));
      else reject(new Error(`${file} failed: exit code ${String(code)}, signal ${String(signal)}`));
    });
  });
}

/**
 * Runs `file` with `args` in the host environment and resolves with its
 * stdout as UTF-8; bounded by `limits` (see {@link runCommandBytes}).
 */
export async function runCommand(
  file: string,
  args: readonly string[],
  limits: CommandLimits = WIN32_READ_LIMITS,
): Promise<string> {
  return Buffer.from(await runBounded(file, args, undefined, limits)).toString('utf8');
}

/**
 * Runs `file` with `args` and exactly `env` (`shell: false`, hidden window)
 * and resolves with its stdout as bytes. Bounded by `limits`: on a timeout
 * or more stdout than the cap the command is killed through its handle and
 * the run rejects; it also rejects when the command cannot start or exits
 * non-zero.
 */
export function runCommandBytes(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  limits: CommandLimits = DARWIN_READ_LIMITS,
): Promise<Uint8Array> {
  return runBounded(file, args, env, limits);
}

/**
 * Runs `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
 * -NoProfile -NonInteractive -Command <script>` by absolute path with
 * `shell: false`, each run bounded by `limits`.
 */
export function powerShellRunner(
  hostEnv: Readonly<Record<string, string | undefined>>,
  limits: CommandLimits = WIN32_READ_LIMITS,
): PowerShellRunner {
  const exe = path.win32.join(
    windowsSystemRoot(hostEnv),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return (script) => runCommand(exe, ['-NoProfile', '-NonInteractive', '-Command', script], limits);
}

/** The Windows process table through one CIM query. */
export function win32ProcessTable(run: PowerShellRunner): ProcessTable {
  return {
    source: 'win32-cim',
    async read() {
      return parseWin32Processes(await run(WIN32_PROCESS_SCRIPT));
    },
  };
}

/** Reads of a `/proc` file system. */
export interface ProcReads {
  /** Entry names of the `/proc` root. */
  list(): Promise<readonly string[]>;
  /** Text of `<root>/<pid>/<file>`, or `null` when the process is gone or unreadable. */
  read(pid: string, file: 'stat' | 'cmdline'): Promise<string | null>;
}

/** {@link ProcReads} over the real `/proc` (or another root, for tests). */
export function procReads(root: string): ProcReads {
  return {
    list: () => readdir(root),
    async read(pid, file) {
      try {
        return await readFile(path.join(root, pid, file), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** The Linux process table from `/proc`. */
export function linuxProcessTable(reads: ProcReads): ProcessTable {
  return {
    source: 'linux-proc',
    async read() {
      const rows: ProcessRow[] = [];
      for (const entry of await reads.list()) {
        if (!/^[0-9]+$/.test(entry)) continue;
        const stat = await reads.read(entry, 'stat');
        if (stat === null) continue;
        const row = parseLinuxProcess(stat, (await reads.read(entry, 'cmdline')) ?? '');
        if (row !== null) rows.push(row);
      }
      return rows;
    },
  };
}

/**
 * The process table of `platform` with the real host reads.
 *
 * @throws Error for a platform without a process table source.
 */
export function hostProcessTable(
  platform: NodeJS.Platform,
  hostEnv: Readonly<Record<string, string | undefined>>,
): ProcessTable {
  if (platform === 'win32') return win32ProcessTable(powerShellRunner(hostEnv));
  if (platform === 'linux') return linuxProcessTable(procReads('/proc'));
  if (platform === 'darwin') {
    // osCallsFor('darwin') always composes the darwin adapters.
    const { processTable } = osCallsFor('darwin', process.pid) as Extract<
      OsCalls,
      { readonly platform: 'darwin' }
    >;
    return darwinProcessTable({
      identities: () => processTable.runPs(),
      commandLines: () => runCommandBytes(DARWIN_PS_PATH, DARWIN_ARGS_PS, DARWIN_PS_ENV),
    });
  }
  throw new Error(`no process table source for ${platform}`);
}
