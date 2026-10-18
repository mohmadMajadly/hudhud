/**
 * Windows syscall adapter (plan §1.7, §4.7, §4.8): the CIM process-table
 * query. The best-effort `taskkill` calls (ADR-0009) live in
 * `process/taskkill.ts`, which also checks the realpath of the executable.
 *
 * @remarks
 * The query runs a System32 binary by absolute path under `%SystemRoot%`, with
 * `shell: false`, `windowsHide: true`, not detached, stdin and stderr
 * ignored, the current directory `%SystemRoot%\System32` (never the host's
 * current directory, which may be an untrusted checkout in the DLL search
 * order), and an explicit environment: `SystemRoot`, a `PATH` of the
 * System32 directories only, and for PowerShell a `PSModulePath` of the
 * in-box modules only, `WINDIR` and `USERPROFILE` equal to `SystemRoot`
 * (PowerShell aborts with an empty `USERPROFILE`), `TEMP` and `TMP` equal to
 * `%SystemRoot%\Temp` (with an empty `TEMP` PowerShell falls into
 * ConstrainedLanguage at random), and every other
 * variable libuv would otherwise copy from the host (see
 * `WIN32_REQUIRED_ENV_NAMES` in `win32-env.ts`) set to the empty string.
 *
 * `%SystemRoot%` and `powershell.exe` are resolved when a call is made (not
 * when the adapter is created) by the injected
 * {@link Win32AdapterOptions.powershell}: in production
 * `resolveSystem32PowerShell` of `taskkill.ts` (wired in `spawn.ts`), the
 * resolution every System32 call site shares: a validated, unambiguous
 * `SystemRoot` and a realpath equal to the expected path (no junction or link
 * redirecting `System32`), a regular file (review R1-3). A refusal throws
 * instead of running a binary from an unexpected place. The resolution is
 * injected because this leaf module may import nothing but Node built-ins.
 *
 * Imports only Node built-ins and `os/types.ts` (rule `os-adapters-leaf`), so
 * the small command runner repeats the one in `os/darwin.ts` on purpose.
 * Coverage is scoped to Windows hosts (`vitest.os.config.ts`).
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';

import type { Win32CimTableCalls } from './types.js';

/** `powershell.exe` below `%SystemRoot%\System32` (Windows PowerShell 5.1). */
export const POWERSHELL_BELOW_SYSTEM32 = 'WindowsPowerShell\\v1.0\\powershell.exe';

/** The absolute paths and environment used for one `%SystemRoot%`. */
export interface System32Layout {
  readonly powershell: string;
  readonly env: Readonly<Record<string, string>>;
}

/** @internal */
export function system32Layout(systemRoot: string): System32Layout {
  const system32 = `${systemRoot}\\System32`;
  const psHome = `${system32}\\WindowsPowerShell\\v1.0`;
  return {
    powershell: `${system32}\\${POWERSHELL_BELOW_SYSTEM32}`,
    env: {
      SystemRoot: systemRoot,
      PATH: `${system32};${systemRoot};${system32}\\Wbem;${psHome}`,
      PSModulePath: `${psHome}\\Modules`,
      // Every libuv-required variable is set, so libuv copies none from the
      // host (WIN32_REQUIRED_ENV_NAMES in win32-env.ts). PowerShell 5.1 aborts
      // with an empty USERPROFILE (measured), so it gets the OS directory.
      WINDIR: systemRoot,
      HOMEDRIVE: '',
      HOMEPATH: '',
      LOGONSERVER: '',
      SYSTEMDRIVE: '',
      // An empty TEMP makes PowerShell 5.1's script-policy probe fail at
      // random, which drops it into ConstrainedLanguage (measured).
      TEMP: `${systemRoot}\\Temp`,
      TMP: `${systemRoot}\\Temp`,
      USERDOMAIN: '',
      USERNAME: '',
      USERPROFILE: systemRoot,
    },
  };
}

/**
 * The PowerShell script of the {@link Win32CimTableCalls} contract: one
 * object per process with `p` (pid), `pp` (parent pid), `t` (creation time as
 * a FILETIME decimal string, `''` when absent) and `n` (name or null), as one
 * JSON array in UTF-8 without a byte order mark.
 *
 * @remarks
 * The same WQL query over `Win32_Process` that `Get-CimInstance` runs, but
 * through the in-box .NET classes only (`System.Management` for WMI,
 * `System.Web.Extensions` for JSON): no cmdlet is called, so PowerShell
 * never discovers or auto-loads a module. Module discovery is what made
 * every query slow under the restricted environment above (measured on
 * Windows 11 with PowerShell 5.1: 750 ms with `Get-CimInstance` and
 * `ConvertTo-Json`, 450 ms with this script; the cmdlet form also depends
 * on `USERPROFILE` for its module analysis cache). `t` is computed from the
 * DMTF datetime WMI reports (`yyyyMMddHHmmss.ffffff` local time plus the
 * UTC offset in minutes), exactly, without a local-time round trip; it
 * equals `CreationDate.ToFileTimeUtc()` of the cmdlet form (verified on
 * every process of a live table).
 */
export const CIM_SCRIPT: string = [
  "$ErrorActionPreference = 'Stop'",
  '$inv = [Globalization.CultureInfo]::InvariantCulture',
  "$null = [Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')",
  "$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')",
  "$query = [Management.ManagementObjectSearcher]::new('SELECT ProcessId, ParentProcessId, CreationDate, Name FROM Win32_Process')",
  '$rows = [Collections.Generic.List[object]]::new()',
  'foreach ($o in $query.Get()) {',
  "  $d = $o['CreationDate']",
  '  $t = [string]::Empty',
  '  if ($null -ne $d) {',
  "    $u = [DateTime]::ParseExact($d.Substring(0, 21), 'yyyyMMddHHmmss.ffffff', $inv, [Globalization.DateTimeStyles]'AssumeUniversal, AdjustToUniversal')",
  '    $t = $u.AddMinutes(-[int]$d.Substring(21)).ToFileTimeUtc().ToString($inv)',
  '  }',
  '  $row = [Collections.Generic.Dictionary[string, object]]::new()',
  "  $row['p'] = [int64]$o['ProcessId']; $row['pp'] = [int64]$o['ParentProcessId']; $row['t'] = $t; $row['n'] = $o['Name']",
  '  $rows.Add($row)',
  '}',
  '$json = [Web.Script.Serialization.JavaScriptSerializer]::new()',
  '$json.MaxJsonLength = [int]::MaxValue',
  '$bytes = [Text.UTF8Encoding]::new($false).GetBytes($json.Serialize($rows))',
  '$stdout = [Console]::OpenStandardOutput()',
  '$stdout.Write($bytes, 0, $bytes.Length)',
  '$stdout.Flush()',
].join('\n');

/** The PowerShell argv before the script. */
export const POWERSHELL_ARGS: readonly string[] = Object.freeze([
  '-NoProfile',
  '-NonInteractive',
  '-Command',
]);

/** Limits of {@link runCommand}. */
export interface CommandLimits {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
}

/** The default limits of {@link runCommand}: the bound of one process table read. */
export const DEFAULT_LIMITS: CommandLimits = Object.freeze({
  timeoutMs: 60_000,
  maxStdoutBytes: 64 * 1024 * 1024,
});

/** What a finished command reported. */
export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
}

/** A command runner; resolves with the exit code whatever it is. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string,
) => Promise<CommandResult>;

/**
 * Runs `file` with `args` and `env` in `cwd` (the host's current directory
 * when absent): `shell: false`, `windowsHide`, not detached, stdin and
 * stderr ignored. Resolves with the exit code (`null` when the process ended
 * by a signal) and stdout; rejects on a spawn error, the timeout (the command
 * is then ended through its own handle) or stdout beyond the cap.
 *
 * @internal
 */
export function runCommand(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  limits: CommandLimits = DEFAULT_LIMITS,
  cwd?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      detached: false,
      ...(cwd === undefined ? {} : { cwd }),
      env: { ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const onError = (error: Error): void => {
      failure ??= error;
    };
    const fail = (error: Error): void => {
      onError(error);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      fail(new Error(`${file} timed out after ${String(limits.timeoutMs)} ms`));
    }, limits.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxStdoutBytes) {
        fail(new Error(`${file} wrote more than ${String(limits.maxStdoutBytes)} bytes`));
      } else {
        chunks.push(chunk);
      }
    });
    child.on('error', onError);
    // After a failed spawn the pipe may report ENOTCONN (07 §6); never unhandled.
    child.stdout.on('error', onError);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure === undefined) {
        resolve({ exitCode: code, stdout: new Uint8Array(Buffer.concat(chunks)) });
      } else {
        reject(failure);
      }
    });
  });
}

/**
 * The resolved `powershell.exe` of {@link Win32AdapterOptions.powershell}:
 * the validated `SystemRoot` it lies under, or why it may not run (the shape
 * of `resolveSystem32PowerShell` in `taskkill.ts`).
 */
export type CheckedPowerShell =
  | { readonly ok: true; readonly systemRoot: string }
  | { readonly ok: false; readonly reason: string };

/** Options of the Windows adapters. */
export interface Win32AdapterOptions {
  /**
   * Resolves `%SystemRoot%` and checks `powershell.exe` under it, at every
   * query; production passes `resolveSystem32PowerShell` of `taskkill.ts`
   * over the host environment (see the module remarks). Required: this leaf
   * module cannot import that check, and a query never runs an unchecked
   * binary.
   */
  readonly powershell: () => Promise<CheckedPowerShell>;
  /** The command runner; {@link runCommand} by default. */
  readonly run?: CommandRunner;
}

const defaultRun: CommandRunner = (file, args, env, cwd) =>
  runCommand(file, args, env, DEFAULT_LIMITS, cwd);

/**
 * The Windows process table (contract on {@link Win32CimTableCalls}).
 * Rejects, running nothing, when `powershell.exe` is refused, and rejects
 * when PowerShell exits with a non-zero code.
 *
 * @internal
 */
export function createWin32CimTableCalls(options: Win32AdapterOptions): Win32CimTableCalls {
  const run = options.run ?? defaultRun;
  return {
    source: 'win32-cim',
    async queryProcesses() {
      const checked = await options.powershell();
      if (!checked.ok) throw new Error(`powershell.exe is unavailable: ${checked.reason}`);
      const layout = system32Layout(checked.systemRoot);
      const result = await run(
        layout.powershell,
        [...POWERSHELL_ARGS, CIM_SCRIPT],
        layout.env,
        `${checked.systemRoot}\\System32`,
      );
      if (result.exitCode !== 0) {
        throw new Error(`process table query exited with ${String(result.exitCode)}`);
      }
      return result.stdout;
    },
  };
}
