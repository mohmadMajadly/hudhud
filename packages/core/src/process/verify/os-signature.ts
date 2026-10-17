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
 *   table query (`os/win32.ts`). It is the script's only cmdlet, so
 *   `Microsoft.PowerShell.Security` (a manifest and its binary) is the only
 *   module PowerShell loads; everything else is plain .NET. `New-Object`
 *   would also auto-load `Microsoft.PowerShell.Utility` and compile its
 *   script module (measured on Windows 11, PowerShell 5.1: about 100 ms of a
 *   400 ms check of a small file).
 * - Cost (measured): on a Windows 11 workstation one check takes about
 *   0.3 s to start PowerShell, 0.15 s to load the module and check a small
 *   file, and 0.5 s more for a 90 MB signed binary (node.exe). On
 *   GitHub-hosted `windows-2025` runners one check of a 21-byte unsigned
 *   file took 19 s, and 50 s while a second check ran; one of node.exe took
 *   about 24 s. PowerShell launches of the process table query on the same
 *   runners (with and without the `Get-CimInstance` module auto-load) took
 *   0.3 to 1.3 s, so the runner's cost was not in starting PowerShell.
 *   Those runner figures (CI run 38440814880) were taken while the script
 *   still called `New-Object`. Without it, the same runners took 398 ms for
 *   the unsigned file and 1152 ms and 1504 ms for node.exe (CI run
 *   38464474863): the runner's cost was the `Microsoft.PowerShell.Utility`
 *   auto-load that `New-Object` triggered, not the Security module or
 *   `Get-AuthenticodeSignature` (`WTGetSignatureInfo`, which also searches
 *   the system catalogs, then `WinVerifyTrust` unless that found a valid
 *   signature).
 * - Revocation: the cmdlet passes `fdwRevocationChecks = 0` and
 *   `dwProvFlags = 0` (PowerShell source, `InitWintrustDataStructFromFile`).
 *   Without `WTD_CACHE_ONLY_URL_RETRIEVAL`, `WinVerifyTrust` may fetch
 *   revocation data over the network for a signed file (WINTRUST_DATA
 *   documentation). This is kept: a revoked publisher certificate must fail.
 * - {@link DEFAULT_SIGNATURE_TIMEOUT_MS} is sized from these measurements;
 *   `verify.ts` caches the verdict per file identity, so one Harness checks
 *   a given binary once.
 * - The script writes the `Status` and, on a second line, the signer
 *   certificate's `Subject` (UTF-8 without BOM); nothing else is parsed.
 *   `Valid` is the only passing status; every other status, an unknown word,
 *   output without the second line, a non-zero exit, a timeout or a spawn
 *   failure fails the check. Another status is `invalid` (definitive); the
 *   rest are `inconclusive` ({@link OsSignatureResult}).
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
 * macOS: `/usr/bin/codesign --verify --strict -R <requirement> <path>` by
 * absolute path (realpath-checked, SIP-protected), environment `LC_ALL=C`
 * only. Exit code 0 is a pass; a non-zero exit code is `invalid` (codesign
 * exits 1 for a signature that does not verify and 3 for a valid signature
 * that does not satisfy the requirement); a timeout, a spawn failure, an exit
 * by signal or too much output is `inconclusive`.
 *
 * - Publisher pinning (macOS gate, research 11): the requirement
 *   ({@link codesignRequirement}) is the form of a Developer ID designated
 *   requirement: the chain ends in Apple's root (`anchor apple generic`),
 *   the intermediate is a Developer ID CA (OID 1.2.840.113635.100.6.2.6), the
 *   leaf is a Developer ID Application certificate (OID
 *   1.2.840.113635.100.6.1.13), and the leaf's organizational unit is the
 *   pinned Team ID ({@link PublisherPin.darwinTeamId}). Apple issues a Team
 *   ID to one developer account and writes it into every certificate of that
 *   team, so a valid signature by anyone else fails the requirement, as a
 *   different signer subject does on Windows. Without a pin the check fails
 *   without running codesign. The Team ID is pinned, not the leaf
 *   certificate, for the reason given for the Windows subject above.
 * - The requirement text is built only from a Team ID that is exactly 10
 *   upper-case letters or digits (Apple's format), so nothing of the pin can
 *   change the requirement's structure; any other value fails the check.
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
 * @remarks
 * A hang bound, not a latency budget: a check that is cut off fails closed,
 * so the bound must clear the slowest legitimate check. The slowest one
 * measured took 50 s (a small file on a GitHub-hosted Windows runner, while
 * the script still called `New-Object`, see the module remarks); 120 s leaves
 * more than twice that. Since `New-Object` was dropped the same runners took
 * at most 1.5 s (CI run 38464474863); the bound is kept as the hang guard,
 * since a check may also wait on a revocation fetch over the network. The verdict is cached
 * per file identity (`verify.ts`), so the bound is paid at most once per
 * binary and Harness.
 *
 * @public
 */
export const DEFAULT_SIGNATURE_TIMEOUT_MS = 120_000;

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
 * @remarks
 * `invalid` is a definitive verdict about the file: an Authenticode status
 * other than `Valid`, a missing or different publisher, a non-zero codesign
 * exit, or a checker that may not run (an unusable `SystemRoot`, a
 * redirected or missing PowerShell or codesign). `inconclusive` means the
 * check did not reach a verdict: the checker timed out, could not be
 * started, was ended by a signal, exited non-zero itself (PowerShell, as
 * opposed to a parsed status), or wrote more than its output cap or output
 * without the expected lines. Both fail the check; only `invalid` may be
 * cached (`verify.ts`).
 *
 * @public
 */
export type OsSignatureResult =
  | { readonly kind: 'valid'; readonly detail: string; readonly signer?: string }
  | { readonly kind: 'invalid'; readonly detail: string; readonly signer?: string }
  | { readonly kind: 'inconclusive'; readonly detail: string }
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
  /**
   * The Apple Developer Team ID of the signer (10 upper-case letters or
   * digits, the leaf certificate's organizational unit). Required for a
   * passing check on macOS.
   */
  readonly darwinTeamId?: string;
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
  /**
   * The publisher to require; without a Windows subject the Windows check
   * fails, without a Team ID the macOS check fails.
   */
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
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
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
    // PowerShell itself failed: no status was reported.
    return {
      kind: 'inconclusive',
      detail: `authenticode check failed: ${describeFailure(outcome)}`,
    };
  }
  const newline = outcome.stdout.indexOf('\n');
  const status = newline < 0 ? '' : outcome.stdout.slice(0, newline).trim();
  if (!AUTHENTICODE_STATUSES.includes(status)) {
    return { kind: 'inconclusive', detail: 'authenticode status unrecognized' };
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

/** Apple's Team ID format: 10 upper-case letters or digits. */
const TEAM_ID = /^[A-Z0-9]{10}$/;

/**
 * The code requirement the macOS check passes to codesign for `teamId`
 * (see the module remarks).
 *
 * @throws RangeError when `teamId` is not 10 upper-case letters or digits
 * @public
 */
export function codesignRequirement(teamId: string): string {
  if (!TEAM_ID.test(teamId)) {
    throw new RangeError('a Team ID is 10 upper-case letters or digits');
  }
  return [
    'anchor apple generic',
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    `certificate leaf[subject.OU] = "${teamId}"`,
  ].join(' and ');
}

async function checkDarwin(binaryPath: string, deps: SignatureDeps): Promise<OsSignatureResult> {
  const teamId = deps.publisher?.darwinTeamId;
  if (teamId === undefined) {
    return { kind: 'invalid', detail: 'codesign not run: no publisher Team ID is pinned' };
  }
  if (!TEAM_ID.test(teamId)) {
    return { kind: 'invalid', detail: 'codesign not run: the pinned Team ID is malformed' };
  }
  const refusal = await checkedExecutable(deps.fs, CODESIGN_PATH, false);
  if (refusal !== undefined) return { kind: 'invalid', detail: `codesign unavailable: ${refusal}` };
  const outcome = await deps.run({
    file: CODESIGN_PATH,
    // `-R` with a leading `=`: the argument is requirement text, not a file.
    args: ['--verify', '--strict', '-R', `=${codesignRequirement(teamId)}`, binaryPath],
    env: { LC_ALL: 'C' },
    cwd: '/',
    platform: 'posix',
    timeoutMs: deps.timeoutMs ?? DEFAULT_SIGNATURE_TIMEOUT_MS,
    maxStdoutBytes: MAX_SIGNATURE_OUTPUT_BYTES,
  });
  if (outcome.kind === 'exited' && outcome.exitCode === 0) {
    return { kind: 'valid', detail: `codesign valid, pinned Team ID ${teamId}` };
  }
  // A non-zero exit code is codesign's verdict; anything else is no verdict.
  const verdict = outcome.kind === 'exited' && outcome.exitCode !== null;
  return {
    kind: verdict ? 'invalid' : 'inconclusive',
    detail: `codesign failed: ${describeFailure(outcome)}`,
  };
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
