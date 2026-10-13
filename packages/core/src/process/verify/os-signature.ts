/**
 * The OS signature check of strict binary verification (ADR-0011 "Binary
 * provenance", K8, plan §1.8). It runs only under
 * `binaryVerification: 'strict'`; advisory verification never calls it.
 *
 * @remarks
 * Windows: `Get-AuthenticodeSignature` through
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo
 * -NoProfile -NonInteractive -Command <script> <path>`.
 *
 * - The executable is taken by absolute path under a validated
 *   `%SystemRoot%` (`systemRootFrom`, as for `taskkill.exe`), and its
 *   realpath must equal that path: a junction or link that redirects
 *   `System32` is refused, as is anything but a regular file.
 * - The binary path is never interpolated into script text. The script is a
 *   constant; the path is a separate argv entry. PowerShell appends the argv
 *   entries after `-Command <script>` to the command text, so the script ends
 *   in a line comment that makes the appended text inert, and the path is
 *   refused when it holds any line terminator (`\r`, `\n`, U+0085, U+2028,
 *   U+2029) or other control character (Windows file names cannot contain
 *   them). The script reads the path from the process command line
 *   (`[Environment]::GetCommandLineArgs()`, parsed by the same MSVCRT rules
 *   libuv quotes it with) and checks that the argument count is exactly the
 *   one this module passes.
 * - The cmdlet is called module-qualified, with `PSModulePath` limited to
 *   the in-box modules of `%SystemRoot%` (no user or application module can
 *   shadow it), `-NoProfile`, and the restricted environment of the process
 *   table query (`os/win32.ts`).
 * - Only the `Status` is written and parsed. `Valid` is the only pass; every
 *   other status, an unknown word, a non-zero exit, a timeout or a spawn
 *   failure fails the check.
 *
 * macOS: `/usr/bin/codesign --verify --strict <path>` by absolute path
 * (realpath-checked, SIP-protected), environment `LC_ALL=C` only. Exit code 0
 * is a pass; anything else fails.
 *
 * Other platforms have no OS signature check (`unsupported`); strict
 * verification then relies on the digest table alone (ADR-0011: the
 * manifest hash is the portable fallback).
 *
 * Not guaranteed: the signer. Only the OS verdict is read (`Valid` accepts
 * any trusted publisher); strict verification additionally requires a digest
 * match, which pins the exact file. The file can change after the check; the
 * caller binds the result to the file identity (`verify.ts`).
 *
 * @packageDocumentation
 */

import { lstat, realpath } from 'node:fs/promises';

import { system32Layout } from '../os/win32.js';
import { systemRootFrom } from '../taskkill.js';
import { runBoundedCommand, type BoundedCommand, type CommandOutcome } from './command.js';

/**
 * Upper bound on one signature check before the checker is killed.
 *
 * @public
 */
export const DEFAULT_SIGNATURE_TIMEOUT_MS = 60_000;

/** Bound on the checker's stdout; a status word is a few bytes. */
const MAX_SIGNATURE_OUTPUT_BYTES = 4096;

/**
 * Which OS signature check applies.
 *
 * @public
 */
export type SignaturePlatform = 'win32' | 'darwin' | 'other';

/**
 * The signature platform of a Node platform name.
 *
 * @public
 */
export function signaturePlatformOf(platform: NodeJS.Platform): SignaturePlatform {
  return platform === 'win32' || platform === 'darwin' ? platform : 'other';
}

/**
 * The values `Get-AuthenticodeSignature` reports in `Status`
 * (`System.Management.Automation.SignatureStatus`).
 *
 * @public
 */
export const AUTHENTICODE_STATUSES: readonly string[] = Object.freeze([
  'Valid',
  'UnknownError',
  'NotSigned',
  'HashMismatch',
  'NotTrusted',
  'NotSupportedFileFormat',
  'Incompatible',
]);

/**
 * Result of {@link checkOsSignature}.
 *
 * @public
 */
export type OsSignatureResult =
  | { readonly kind: 'valid'; readonly detail: string }
  | { readonly kind: 'invalid'; readonly detail: string }
  | { readonly kind: 'unsupported' };

/**
 * Filesystem calls used to check the checker's executable.
 *
 * @public
 */
export interface SignatureFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
}

/**
 * Dependencies of {@link checkOsSignature}.
 *
 * @public
 */
export interface SignatureDeps {
  readonly platform: SignaturePlatform;
  /** The host environment, read only for `SystemRoot` on Windows. */
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  readonly fs: SignatureFs;
  /** Runs the checker; {@link runBoundedCommand} in production. */
  readonly run: (command: BoundedCommand) => Promise<CommandOutcome>;
  /** Defaults to {@link DEFAULT_SIGNATURE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * The host's filesystem and command runner.
 *
 * @public
 */
export const nodeSignatureDeps: Pick<SignatureDeps, 'fs' | 'run'> = {
  fs: { realpath, lstat },
  run: (command) => runBoundedCommand(command),
};

/** The fixed PowerShell argv before the script. */
const POWERSHELL_ARGS: readonly string[] = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
]);

/**
 * The number of entries `GetCommandLineArgs` returns for this argv: the
 * executable, {@link POWERSHELL_ARGS}, the script and the path.
 */
const ARG_COUNT = 1 + POWERSHELL_ARGS.length + 2;

/**
 * The PowerShell script. Constant: it never contains the path. The final
 * line comment absorbs the argv text PowerShell appends after it.
 *
 * @public
 */
export const AUTHENTICODE_SCRIPT: string = [
  "$ErrorActionPreference = 'Stop'",
  '$a = [Environment]::GetCommandLineArgs()',
  `if ($a.Length -ne ${String(ARG_COUNT)}) { exit 3 }`,
  `$s = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $a[${String(ARG_COUNT - 1)}]`,
  '[Console]::Out.Write([string]$s.Status)',
  '#',
].join('\n');

/** Any control character (C0, DEL, C1) or Unicode line or paragraph separator. */
const UNSAFE_IN_ARGUMENT = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * The argv of the Windows check for `binaryPath`.
 *
 * @throws RangeError when the path holds a control character or line
 * terminator (it could end the script's line comment)
 * @public
 */
export function authenticodeArgv(binaryPath: string): readonly string[] {
  if (UNSAFE_IN_ARGUMENT.test(binaryPath)) {
    throw new RangeError('refusing a path with a control character or line terminator');
  }
  return [...POWERSHELL_ARGS, AUTHENTICODE_SCRIPT, binaryPath];
}

/**
 * Checks the checker's executable: its realpath must be `expected` itself
 * and a regular file.
 *
 * @returns `undefined` when it may run, else why it is refused
 */
async function checkedExecutable(
  fs: SignatureFs,
  expected: string,
  caseInsensitive: boolean,
): Promise<string | undefined> {
  let resolved: string;
  let regular: boolean;
  try {
    resolved = await fs.realpath(expected);
    const stats = await fs.lstat(resolved);
    regular = stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return 'not-found';
  }
  const same = caseInsensitive
    ? resolved.toLowerCase() === expected.toLowerCase()
    : resolved === expected;
  if (!same) return 'redirected';
  return regular ? undefined : 'not-regular-file';
}

function describeFailure(outcome: CommandOutcome): string {
  if (outcome.kind === 'exited') {
    return `exit ${outcome.exitCode === null ? (outcome.signal ?? 'unknown') : String(outcome.exitCode)}`;
  }
  if (outcome.kind === 'spawn-error') return `spawn failed: ${outcome.errno ?? 'unknown error'}`;
  return outcome.kind;
}

async function checkWindows(binaryPath: string, deps: SignatureDeps): Promise<OsSignatureResult> {
  const args = authenticodeArgv(binaryPath);
  const root = systemRootFrom(deps.hostEnv);
  if (!root.ok) return { kind: 'invalid', detail: `powershell unavailable: ${root.reason}` };
  const layout = system32Layout(root.root);
  const refusal = await checkedExecutable(deps.fs, layout.powershell, true);
  if (refusal !== undefined)
    return { kind: 'invalid', detail: `powershell unavailable: ${refusal}` };
  const outcome = await deps.run({
    file: layout.powershell,
    args,
    env: layout.env,
    cwd: `${root.root}\\System32`,
    platform: 'win32',
    timeoutMs: deps.timeoutMs ?? DEFAULT_SIGNATURE_TIMEOUT_MS,
    maxStdoutBytes: MAX_SIGNATURE_OUTPUT_BYTES,
  });
  if (outcome.kind !== 'exited' || outcome.exitCode !== 0) {
    return { kind: 'invalid', detail: `authenticode check failed: ${describeFailure(outcome)}` };
  }
  const status = outcome.stdout.trim();
  if (!AUTHENTICODE_STATUSES.includes(status)) {
    return { kind: 'invalid', detail: 'authenticode status unrecognized' };
  }
  return status === 'Valid'
    ? { kind: 'valid', detail: 'authenticode Valid' }
    : { kind: 'invalid', detail: `authenticode ${status}` };
}

/**
 * Absolute path of `codesign` on macOS.
 *
 * @public
 */
export const CODESIGN_PATH = '/usr/bin/codesign';

async function checkDarwin(binaryPath: string, deps: SignatureDeps): Promise<OsSignatureResult> {
  const refusal = await checkedExecutable(deps.fs, CODESIGN_PATH, false);
  if (refusal !== undefined) return { kind: 'invalid', detail: `codesign unavailable: ${refusal}` };
  const outcome = await deps.run({
    file: CODESIGN_PATH,
    args: ['--verify', '--strict', binaryPath],
    env: { LC_ALL: 'C' },
    cwd: '/',
    platform: 'posix',
    timeoutMs: deps.timeoutMs ?? DEFAULT_SIGNATURE_TIMEOUT_MS,
    maxStdoutBytes: MAX_SIGNATURE_OUTPUT_BYTES,
  });
  return outcome.kind === 'exited' && outcome.exitCode === 0
    ? { kind: 'valid', detail: 'codesign valid' }
    : { kind: 'invalid', detail: `codesign failed: ${describeFailure(outcome)}` };
}

/**
 * Runs the OS signature check of `deps.platform` on `binaryPath` (an
 * absolute realpath). See the module remarks.
 *
 * @throws RangeError for a Windows path with a control character
 * @public
 */
export async function checkOsSignature(
  binaryPath: string,
  deps: SignatureDeps,
): Promise<OsSignatureResult> {
  if (deps.platform === 'win32') return checkWindows(binaryPath, deps);
  if (deps.platform === 'darwin') return checkDarwin(binaryPath, deps);
  return { kind: 'unsupported' };
}
