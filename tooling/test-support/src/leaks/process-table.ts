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
 * `/proc/<pid>/cmdline`; Windows one CIM query over `Win32_Process` through
 * `powershell.exe` by absolute path (start time = `CreationDate` in the
 * canonical microseconds). macOS follows its gate (M1). Reads only; nothing
 * here signals a process.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseProcStat, parseWin32ProcessJson } from '@hudhud/core/process';

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
  readonly source: 'win32-cim' | 'linux-proc';
  read(): Promise<readonly ProcessRow[]>;
}

/** A real process: pid 0 (the idle process) is skipped. */
function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The CIM query: one `{p, pp, t, n, c}` object per process (`t` = FILETIME
 * of `CreationDate` as a string, `''` when absent), as a JSON array in UTF-8.
 */
export const WIN32_PROCESS_SCRIPT: string = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
  '  [pscustomobject]@{ p = [int64]$_.ProcessId; pp = [int64]$_.ParentProcessId;',
  "    t = $(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { '' });",
  '    n = $_.Name; c = $_.CommandLine } })',
  'ConvertTo-Json -Compress -Depth 2 -InputObject $rows',
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

/** Runs a PowerShell script and resolves with its stdout. */
export type PowerShellRunner = (script: string) => Promise<string>;

/**
 * Runs `file` with `args` (`shell: false`, hidden window) and resolves with
 * its stdout; rejects when it cannot start or exits non-zero.
 */
export function runCommand(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`${file} failed`, { cause: error }));
      },
    );
  });
}

/**
 * Runs `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
 * -NoProfile -NonInteractive -Command <script>` by absolute path with
 * `shell: false`.
 */
export function powerShellRunner(
  hostEnv: Readonly<Record<string, string | undefined>>,
): PowerShellRunner {
  const exe = path.win32.join(
    windowsSystemRoot(hostEnv),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return (script) => runCommand(exe, ['-NoProfile', '-NonInteractive', '-Command', script]);
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
 * @throws Error for a platform without a leak source yet (macOS: after its gate, M1).
 */
export function hostProcessTable(
  platform: NodeJS.Platform,
  hostEnv: Readonly<Record<string, string | undefined>>,
): ProcessTable {
  if (platform === 'win32') return win32ProcessTable(powerShellRunner(hostEnv));
  if (platform === 'linux') return linuxProcessTable(procReads('/proc'));
  throw new Error(`no process table source for ${platform} yet (macOS follows its gate, M1)`);
}
