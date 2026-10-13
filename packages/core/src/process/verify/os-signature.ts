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
 * - The script writes the `Status` and, on a second line, the signer
 *   certificate's `Subject` (UTF-8 without BOM); nothing else is parsed.
 *   `Valid` is the only passing status; every other status, an unknown word,
 *   output without the second line, a non-zero exit, a timeout or a spawn
 *   failure fails the check.
 * - Publisher pinning (W3-Z ruling 9): a `Valid` signature passes only when
 *   the signer subject equals the pinned publisher subject
 *   ({@link PublisherPin.windowsSubject}) exactly; without a pin the check
 *   fails. `Valid` alone accepts any publisher whose chain ends in a trusted
 *   root. The subject is pinned, not the certificate thumbprint: the leaf
 *   certificate is re-issued (the one of the pinned 2.1.296 build is valid
 *   from 2026-10-08 to 2027-10-29), so a thumbprint pin would refuse an
 *   authentic build signed after a rotation, while the strict digest table
 *   already pins the exact file. The EV subject names the legal entity with
 *   its jurisdiction and registration number, which the CA validates before
 *   issuing.
 *
 * macOS: `/usr/bin/codesign --verify --strict <path>` by absolute path
 * (realpath-checked, SIP-protected), environment `LC_ALL=C` only. Exit code 0
 * is a pass; anything else fails. Pending the macOS gate (ADR-0014): the
 * Team ID pin. Until the gate has recorded the Team ID of the pinned darwin
 * builds, codesign's verdict is not bound to a publisher; strict mode on
 * darwin still needs a digest-table match, and the committed table has no
 * darwin entries before the gate.
 *
 * Other platforms have no OS signature check (`unsupported`); strict
 * verification then relies on the digest table alone (ADR-0011: the
 * manifest hash is the portable fallback).
 *
 * Not guaranteed: the file can change after the check; the caller binds the
 * result to the file identity (`verify.ts`).
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

/** Bound on the checker's stdout: a status word and one certificate subject. */
const MAX_SIGNATURE_OUTPUT_BYTES = 4096;

/** At most this many characters of a foreign signer subject go into a detail. */
const MAX_SIGNER_SHOWN = 256;

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
  | { readonly kind: 'valid'; readonly detail: string; readonly signer?: string }
  | { readonly kind: 'invalid'; readonly detail: string; readonly signer?: string }
  | { readonly kind: 'unsupported' };

/**
 * The publisher strict verification requires (W3-Z ruling 9). The adapter
 * supplies its harness's publisher from its committed table.
 *
 * @public
 */
export interface PublisherPin {
  /**
   * The exact `Subject` of the Authenticode signer certificate, as
   * `X509Certificate.Subject` formats it. Required for a passing check on
   * Windows.
   */
  readonly windowsSubject?: string;
  // darwin: the Team ID pin is added after the macOS gate (ADR-0014).
}

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
  /** The publisher to require; without a Windows subject the Windows check fails. */
  readonly publisher?: PublisherPin;
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
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '[Console]::Out.Write([string]$s.Status + "`n" + [string]$s.SignerCertificate.Subject)',
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
  const newline = outcome.stdout.indexOf('\n');
  const status = newline < 0 ? '' : outcome.stdout.slice(0, newline).trim();
  if (!AUTHENTICODE_STATUSES.includes(status)) {
    return { kind: 'invalid', detail: 'authenticode status unrecognized' };
  }
  if (status !== 'Valid') return { kind: 'invalid', detail: `authenticode ${status}` };
  const signer = outcome.stdout.slice(newline + 1);
  const pinned = deps.publisher?.windowsSubject;
  if (pinned === undefined) {
    return { kind: 'invalid', detail: 'authenticode Valid, but no publisher is pinned', signer };
  }
  if (signer !== pinned) {
    const shown = JSON.stringify(signer.slice(0, MAX_SIGNER_SHOWN));
    return {
      kind: 'invalid',
      detail: `authenticode Valid, but the signer is not the pinned publisher: ${shown}`,
      signer,
    };
  }
  return { kind: 'valid', detail: 'authenticode Valid, pinned publisher', signer };
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
