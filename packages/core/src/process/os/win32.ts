/**
 * Windows syscall adapters (plan §1.7, §4.7, §4.8): the CIM process-table
 * query and the best-effort `taskkill` tree kill (ADR-0009).
 *
 * @remarks
 * Both run a System32 binary by absolute path under `%SystemRoot%`, with
 * `shell: false`, `windowsHide: true`, not detached, stdin and stderr
 * ignored, and an explicit environment: `SystemRoot`, a `PATH` of the
 * System32 directories only, and for PowerShell a `PSModulePath` of the
 * in-box modules only, `WINDIR` and `USERPROFILE` equal to `SystemRoot`
 * (PowerShell aborts with an empty `USERPROFILE`), `TEMP` and `TMP` equal to
 * `%SystemRoot%\Temp` (with an empty `TEMP` PowerShell falls into
 * ConstrainedLanguage at random), and every other
 * variable libuv would otherwise copy from the host (see
 * `WIN32_REQUIRED_ENV_NAMES` in `spawn.ts`) set to the empty string.
 *
 * `%SystemRoot%` is read from the host environment when a call is made (not
 * when the adapter is created) and must be a plain absolute drive path
 * (`C:\Windows`): no `..`, no UNC or device prefix, no forbidden characters.
 * Anything else throws instead of running a binary from an unexpected place.
 *
 * Imports only Node built-ins and `os/types.ts` (rule `os-adapters-leaf`), so
 * the small command runner repeats the one in `os/darwin.ts` on purpose.
 * Coverage is scoped to Windows hosts (`vitest.os.config.ts`).
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

import type { TaskkillResult, Win32CimTableCalls, Win32TerminateCalls } from './types.js';

/** A plain absolute drive path: `X:\segment[\segment...]`, no forbidden characters. */
const PLAIN_DRIVE_PATH = /^[A-Za-z]:(?:\\[^\\/:*?"<>|\p{Cc}]+)+$/u;

/**
 * The validated `%SystemRoot%` of `env` (case-insensitive name, as Windows
 * treats it).
 *
 * @internal
 */
export function systemRootOf(env: Readonly<Record<string, string | undefined>>): string {
  const name = Object.keys(env).find((key) => key.toUpperCase() === 'SYSTEMROOT');
  const value = name === undefined ? undefined : env[name];
  if (
    value === undefined ||
    !PLAIN_DRIVE_PATH.test(value) ||
    value.split('\\').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('%SystemRoot% is missing or not a plain absolute drive path');
  }
  return value;
}

/** The absolute paths and environment used for one `%SystemRoot%`. */
export interface System32Layout {
  readonly powershell: string;
  readonly taskkill: string;
  readonly env: Readonly<Record<string, string>>;
}

/** @internal */
export function system32Layout(systemRoot: string): System32Layout {
  const system32 = `${systemRoot}\\System32`;
  const psHome = `${system32}\\WindowsPowerShell\\v1.0`;
  return {
    powershell: `${psHome}\\powershell.exe`,
    taskkill: `${system32}\\taskkill.exe`,
    env: {
      SystemRoot: systemRoot,
      PATH: `${system32};${systemRoot};${system32}\\Wbem;${psHome}`,
      PSModulePath: `${psHome}\\Modules`,
      // Every libuv-required variable is set, so libuv copies none from the
      // host (WIN32_REQUIRED_ENV_NAMES in spawn.ts). PowerShell 5.1 aborts
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
 * compressed JSON array in UTF-8.
 */
export const CIM_SCRIPT: string = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
  '  $t = if ($null -eq $_.CreationDate) { [string]::Empty } else {',
  '    $_.CreationDate.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) }',
  '  [pscustomobject]@{ p = [int64]$_.ProcessId; pp = [int64]$_.ParentProcessId; t = $t; n = $_.Name }',
  '})',
  'ConvertTo-Json -Compress -InputObject $rows',
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

const DEFAULT_LIMITS: CommandLimits = Object.freeze({
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
) => Promise<CommandResult>;

/**
 * Runs `file` with `args` and `env`: `shell: false`, `windowsHide`, not
 * detached, stdin and stderr ignored. Resolves with the exit code (`null`
 * when the process ended by a signal) and stdout; rejects on a spawn error,
 * the timeout (the command is then ended through its own handle) or stdout
 * beyond the cap.
 *
 * @internal
 */
export function runCommand(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  limits: CommandLimits = DEFAULT_LIMITS,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      detached: false,
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

/** Options of the Windows adapters; production uses the defaults. */
export interface Win32AdapterOptions {
  /** The environment `%SystemRoot%` is read from; `process.env` by default. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /** The command runner; {@link runCommand} by default. */
  readonly run?: CommandRunner;
}

/**
 * The Windows process table (contract on {@link Win32CimTableCalls}).
 * Rejects when PowerShell exits with a non-zero code.
 *
 * @internal
 */
export function createWin32CimTableCalls(options: Win32AdapterOptions = {}): Win32CimTableCalls {
  const run = options.run ?? runCommand;
  return {
    source: 'win32-cim',
    async queryProcesses() {
      const layout = system32Layout(systemRootOf(options.hostEnv ?? process.env));
      const result = await run(layout.powershell, [...POWERSHELL_ARGS, CIM_SCRIPT], layout.env);
      if (result.exitCode !== 0) {
        throw new Error(`process table query exited with ${String(result.exitCode)}`);
      }
      return result.stdout;
    },
  };
}

/**
 * The best-effort tree kill (contract on {@link Win32TerminateCalls}):
 * `taskkill /T /F /PID <pid>`. Callers pass only a pid whose identity they
 * verified; `pid` must be a safe integer `>= 1` (`RangeError` otherwise).
 *
 * @internal
 */
export function createWin32TerminateCalls(options: Win32AdapterOptions = {}): Win32TerminateCalls {
  const run = options.run ?? runCommand;
  return {
    async taskkillTree(pid): Promise<TaskkillResult> {
      if (!Number.isSafeInteger(pid) || pid < 1) {
        throw new RangeError(`pid must be a safe integer >= 1, got ${String(pid)}`);
      }
      const layout = system32Layout(systemRootOf(options.hostEnv ?? process.env));
      const result = await run(layout.taskkill, ['/T', '/F', '/PID', String(pid)], layout.env);
      return { exitCode: result.exitCode };
    },
  };
}
