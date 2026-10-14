/**
 * The Claude Code adapter's registration, its host seam and the binary
 * pipeline shared by `connect` and every session (plan §1.8, §2.3, §3.1;
 * ADR-0004 §3, §4; ADR-0011; K4, K8, K9, K18).
 *
 * @remarks
 * Host seam: {@link ClaudeHost} is everything the adapter takes from the
 * machine it runs on (platform, environment, home and working directory,
 * file systems, the process spawner, the OS calls, the job addon, the clock
 * and the id source). {@link nodeHost} is the real host; unit tests pass a
 * fake one. The seam is internal: no custom spawner is public in v1 (K18).
 *
 * Binary pipeline (K4, K8, K9; W5 rulings 1 and 2), in order:
 *
 * 1. {@link verifyExecutable}: `verifyBinary` with the committed digest table
 *    plus the application's digests, the pinned publisher
 *    (`CLAUDE_CODE_PUBLISHER`) and the Harness's verification cache. Only
 *    definitive verdicts are cached; a transient one (a signature check that
 *    did not complete) runs again on the next attempt.
 * 2. {@link spawnableBinary}: `assertSpawnableOrReverify` before every spawn of
 *    the binary, the probe as each session: the identity is read again, and a
 *    changed file is resolved and verified once more (a legitimate update),
 *    never trusted unchecked (TOCTOU between verification and spawn).
 * 3. {@link probeBinary}: exactly one `claude --version` per verified file
 *    (in a hudhud-owned empty directory, explicit environment, `shell: false`,
 *    15 s), the version folded into the verdict (`settleProbedVersion`), strict
 *    mode refusing anything but `verified`, and the version policy: a version
 *    listed known-broken is refused with `HARNESS_VERSION_KNOWN_BROKEN`
 *    (`details.version`, `details.reason`: the committed reason, never harness
 *    output) unless `claudeCode.dangerouslyAllowKnownBrokenVersion` is set.
 *    `untested` is a warning only (the `compat` status).
 *
 * Errors of the process layer map to the public taxonomy here (plan §3.1):
 * messages and details name paths, versions and variable names, never
 * values.
 *
 * @packageDocumentation
 */

import { homedir } from 'node:os';
import process from 'node:process';

import {
  adapterApiVersion,
  BinaryProbeError,
  BinaryVerificationError,
  CwdInvalidError,
  CwdTooLongError,
  defineAdapter,
  HarnessVersionKnownBrokenError,
  InvalidOptionsError,
  SpawnError,
  type AdapterDefinition,
  type BinaryVerification,
  type CompatInfo,
  type EnvMap,
  type HudhudError,
  type JsonObject,
} from '@hudhud/core';
import {
  cryptoIds,
  hostExit,
  systemClock,
  type Clock,
  type HostExitHook,
  type IdSource,
} from '@hudhud/core/binding';
import {
  assertSpawnableOrReverify,
  BinaryChangedError,
  BinaryNotVerifiedError,
  CwdValidationError,
  loadHostJobAddon,
  osCallsFor,
  ProcessSpawnError,
  runVersionProbe,
  settleProbedVersion,
  signaturePlatformOf,
  spawnHarnessProcess,
  SpawnSpecError,
  verifyBinary,
  VersionProbeError,
  type CwdFs,
  type HarnessProcess,
  type IdentityFs,
  type JobAddonLoad,
  type OsCalls,
  type ProcessPlatform,
  type ResolvedExecutable,
  type SpawnSpec,
  type VerificationCache,
  type VerifiedBinary,
  type VerifyBinaryOptions,
  type VersionProbeOptions,
} from '@hudhud/core/process';

import {
  CLAUDE_CODE_COMPAT_POLICY,
  claudeCompatInfo,
  knownBrokenListing,
  windowOf,
  type CompatPolicy,
} from './compat.js';
import { nodeDiscoveryDeps, type DiscoveryDeps } from './discovery.js';
import { KNOWN_BINARIES } from './known-binaries.js';
import { nodeSettingsFileReader, type SettingsFileReader } from './posture.js';
import {
  CLAUDE_CODE_PUBLISHER,
  CLAUDE_VERSION_PROBE_ARGS,
  CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  parseClaudeVersion,
  type ClaudeKnownDigest,
} from './provenance.js';
import { nodeSettingsGuardFs, type SettingsGuardFs } from './settings-guard.js';

/**
 * The adapter's registration (ADR-0004 §3): refused at import when the core
 * implements another adapter API version.
 *
 * @internal
 */
export const CLAUDE_CODE_ADAPTER: AdapterDefinition = defineAdapter({
  name: 'claude-code',
  adapterApiVersion,
});

// ---- the host seam ------------------------------------------------------------------

/**
 * Everything the adapter takes from the host (see the module remarks).
 *
 * @internal
 */
export interface ClaudeHost {
  /** `process.platform`: the OS calls, the signature check and the digest table key. */
  readonly platform: NodeJS.Platform;
  /** `process.arch`: the digest table key. */
  readonly arch: NodeJS.Architecture;
  /** The parent environment of the CLI (read, never written). */
  readonly env: EnvMap;
  /** The user's home directory (the default config directory, K23). */
  readonly homedir: string;
  /** The host's working directory: the default `cwd`. */
  readonly cwd: string;
  readonly discovery: DiscoveryDeps;
  /** Seams of `verifyBinary`; the host's when absent. */
  readonly verify?: VerifyBinaryOptions['deps'];
  /** The identity reads before every spawn; the host's when absent. */
  readonly identityFs?: IdentityFs;
  /** Seams of the version probe (its runner and work directory); the host's when absent. */
  readonly probe?: Omit<NonNullable<VersionProbeOptions['deps']>, 'fs'>;
  /** The file system of `validateCwd`; the host's when absent. */
  readonly cwdFs?: CwdFs;
  readonly guardFs: SettingsGuardFs;
  readonly settingsReader: SettingsFileReader;
  /** The Windows job addon (K2, K17); never throws. */
  readonly loadJobAddon: () => JobAddonLoad;
  /** The OS calls of the ladders, the sweeps and the start-time reads. */
  readonly os: () => OsCalls;
  /** Starts the CLI (`spawnHarnessProcess`: `shell: false`, explicit env, three pipes). */
  readonly spawn: (spec: SpawnSpec) => Promise<HarnessProcess>;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** The host-exit hook (K22: no signal handlers); `null` for none. */
  readonly hostExit: HostExitHook | null;
  /** The tested window and the known-broken listings. */
  readonly compat: CompatPolicy;
  /** The committed digest table. */
  readonly knownBinaries: typeof KNOWN_BINARIES;
}

/**
 * The real host: Node's file systems and spawn, the host's OS calls and job
 * addon, the system clock, cryptographic ids and the one host-exit hook.
 *
 * @internal
 */
export function nodeHost(): ClaudeHost {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homedir: homedir(),
    cwd: process.cwd(),
    discovery: nodeDiscoveryDeps(),
    guardFs: nodeSettingsGuardFs(),
    settingsReader: nodeSettingsFileReader,
    loadJobAddon: loadHostJobAddon,
    os: () => osCallsFor(process.platform, process.pid),
    spawn: spawnHarnessProcess,
    clock: systemClock,
    ids: cryptoIds,
    hostExit,
    compat: CLAUDE_CODE_COMPAT_POLICY,
    knownBinaries: KNOWN_BINARIES,
  };
}

// ---- error mapping (plan §3.1) ---------------------------------------------------------

/** The verdict as error details: status, method, mode and the detail text. */
function verificationDetails(path: string, verification: BinaryVerification): JsonObject {
  return {
    path,
    status: verification.status,
    method: verification.method,
    mode: verification.mode,
    ...(verification.detail === undefined ? {} : { detail: verification.detail }),
    ...(verification.transient === true ? { transient: true } : {}),
  };
}

/**
 * `BINARY_VERIFICATION_FAILED` for a verdict strict mode refuses.
 *
 * @internal
 */
export function verificationError(
  binary: Pick<VerifiedBinary, 'path' | 'verification'>,
  cause?: unknown,
): BinaryVerificationError {
  const { verification } = binary;
  return new BinaryVerificationError(
    `Refusing to run ${binary.path}: binary verification ${verification.status}` +
      (verification.detail === undefined ? '.' : ` (${verification.detail}).`),
    { details: verificationDetails(binary.path, verification), cause },
  );
}

/** The binary changed while it was verified or before it ran. */
function changedError(error: BinaryChangedError, mode: 'advisory' | 'strict'): HudhudError {
  return verificationError(
    {
      path: error.path,
      verification: {
        status: 'failed',
        method: 'none',
        mode,
        detail: 'the binary changed while it was verified',
      },
    },
    error,
  );
}

/**
 * Maps the verification and spawn-gate errors of the process layer; anything
 * else is returned unchanged.
 *
 * @internal
 */
export function mapBinaryError(error: unknown, mode: 'advisory' | 'strict'): unknown {
  if (error instanceof BinaryNotVerifiedError) return verificationError(error, error);
  if (error instanceof BinaryChangedError) return changedError(error, mode);
  if (error instanceof VersionProbeError) {
    return new BinaryProbeError(`The version probe failed: ${error.reason}.`, {
      details: {
        reason: error.reason,
        ...(error.subject === undefined ? {} : { subject: error.subject }),
      },
      cause: error,
    });
  }
  return error;
}

/**
 * Maps `validateCwd`'s error to `CWD_INVALID` / `CWD_TOO_LONG`; anything else
 * is returned unchanged.
 *
 * @internal
 */
export function mapCwdError(error: unknown): unknown {
  if (!(error instanceof CwdValidationError)) return error;
  const details: JsonObject = {
    path: error.path,
    reason: error.reason,
    ...(error.resolved === undefined ? {} : { resolved: error.resolved }),
  };
  return error.code === 'CWD_TOO_LONG'
    ? new CwdTooLongError(error.message, { details, cause: error })
    : new CwdInvalidError(error.message, { details, cause: error });
}

/**
 * Maps a spawn failure: the OS refused (`SPAWN_FAILED`, `details.cause`), or
 * the spawn layer refused the spec before anything ran (an environment the
 * options produced that cannot be passed, `INVALID_OPTIONS`); anything else is
 * returned unchanged.
 *
 * @internal
 */
export function mapSpawnError(error: unknown): unknown {
  if (error instanceof ProcessSpawnError) {
    return new SpawnError(error.message, {
      details: {
        cause: error.reason,
        ...(error.errno === undefined ? {} : { errno: error.errno }),
      },
      cause: error,
    });
  }
  if (error instanceof SpawnSpecError) {
    return new InvalidOptionsError(
      `The CLI cannot be started with these options: ${error.message}`,
      {
        details: {
          path: 'env',
          rule: 'spawn-spec',
          problem: error.problem,
          subject: error.subject,
        },
        cause: error,
      },
    );
  }
  return error;
}

// ---- the binary pipeline -----------------------------------------------------------------

/**
 * What the binary pipeline works with: fixed for one Harness.
 *
 * @internal
 */
export interface BinaryContext {
  readonly host: ClaudeHost;
  readonly mode: 'advisory' | 'strict';
  readonly platform: ProcessPlatform;
  readonly digests: readonly ClaudeKnownDigest[];
  readonly cache: VerificationCache;
  /** The environment of the version probe. */
  readonly probeEnv: Readonly<Record<string, string>>;
  readonly allowKnownBroken: boolean;
}

/**
 * A verified and probed binary.
 *
 * @internal
 */
export interface ProbedBinary {
  /** The verdict with the probed version folded in. */
  readonly binary: VerifiedBinary;
  readonly version: string;
  readonly compat: CompatInfo;
}

/**
 * Verifies a resolved executable (step 1 of the module remarks).
 *
 * @throws `BinaryVerificationError` when the file changed during verification
 * @internal
 */
export async function verifyExecutable(
  ctx: BinaryContext,
  executable: ResolvedExecutable,
): Promise<VerifiedBinary> {
  const { host } = ctx;
  try {
    return await verifyBinary(executable, {
      mode: ctx.mode,
      digests: ctx.digests,
      platform: signaturePlatformOf(host.platform),
      publisher: CLAUDE_CODE_PUBLISHER,
      hostEnv: host.env,
      cache: ctx.cache,
      ...(host.verify === undefined ? {} : { deps: host.verify }),
    });
  } catch (error) {
    throw mapBinaryError(error, ctx.mode);
  }
}

/**
 * The gate before a spawn (step 2): the binary to spawn and whether it had to
 * be verified again.
 *
 * @throws `BinaryVerificationError`; whatever `reverify` throws
 * @internal
 */
export async function spawnableBinary(
  ctx: BinaryContext,
  binary: VerifiedBinary,
  reverify: () => Promise<VerifiedBinary>,
): Promise<{ readonly binary: VerifiedBinary; readonly reverified: boolean }> {
  try {
    return await assertSpawnableOrReverify(binary, reverify, ctx.host.identityFs);
  } catch (error) {
    throw mapBinaryError(error, ctx.mode);
  }
}

/** The version policy (ADR-0004 §4 amendment): a listed version is refused unless allowed. */
function checkVersionPolicy(ctx: BinaryContext, version: string): void {
  const listing = knownBrokenListing(version, ctx.host.compat);
  if (listing === undefined || ctx.allowKnownBroken) return;
  throw new HarnessVersionKnownBrokenError(
    `Claude Code ${version} is listed as known broken: ${listing.reason} ` +
      '(set claudeCode.dangerouslyAllowKnownBrokenVersion: true to run it anyway).',
    { details: { version, reason: listing.reason } },
  );
}

/**
 * Probes a spawnable binary (step 3): one `--version` run, the verdict
 * settled with the version, strict mode and the version policy applied.
 *
 * @throws `BinaryProbeError`, `BinaryVerificationError`,
 *   `HarnessVersionKnownBrokenError`
 * @internal
 */
export async function probeBinary(
  ctx: BinaryContext,
  binary: VerifiedBinary,
): Promise<ProbedBinary> {
  const { host } = ctx;
  let stdout: string;
  try {
    stdout = await runVersionProbe(binary, {
      args: CLAUDE_VERSION_PROBE_ARGS,
      env: ctx.probeEnv,
      platform: ctx.platform,
      timeoutMs: CLAUDE_VERSION_PROBE_TIMEOUT_MS,
      deps: {
        ...host.probe,
        ...(host.identityFs === undefined ? {} : { fs: host.identityFs }),
      },
    });
  } catch (error) {
    throw mapBinaryError(error, ctx.mode);
  }
  const version = parseClaudeVersion(stdout);
  if (version === undefined) {
    // The output itself is never copied into the error.
    throw new BinaryProbeError('The version probe printed no Claude Code version.', {
      details: { reason: 'unparseable-output' },
    });
  }
  const settled = settleProbedVersion(binary, version, ctx.digests);
  if (ctx.mode === 'strict' && settled.verification.status !== 'verified') {
    throw verificationError(settled);
  }
  checkVersionPolicy(ctx, version);
  return {
    binary: settled,
    version,
    compat: claudeCompatInfo(version, windowOf(host.compat)),
  };
}
