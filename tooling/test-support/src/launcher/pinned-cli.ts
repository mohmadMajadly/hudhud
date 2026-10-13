/**
 * The only binary the sandbox launcher runs: the pinned CLI in the
 * repository's cache, verified by {@link verifyPinnedCli} (plan §4.4, §4.6;
 * ADR-0013 §9).
 *
 * @remarks
 * Never `PATH`, never the user's install, never a download: a missing or
 * altered cache entry fails, and the message names `pnpm cli:fetch`. The
 * binary is hashed once per {@link resolvePinnedCli}; every launch re-checks
 * its file identity, size and mtime against that verification (§4.6 step 5)
 * and that it still lies under the cache root.
 */

import type { BigIntStats } from 'node:fs';
import { lstatSync } from 'node:fs';
import path from 'node:path';

import { sha256File } from '@hudhud/core/process';

import { CliFetchError } from '../cli/errors.js';
import { hostPlatform, libcFromReport, loadPin } from '../cli/pin.js';
import type { CliPin } from '../cli/pin.js';
import { verifyPinnedCli } from '../cli/pinned.js';
import type { CliBinary } from '../cli/pinned.js';
import { SandboxRefusedError } from './errors.js';
import { assertRealCliHostAllowed, realCliHostRefusal } from './host-policy.js';

/** A pinned binary verified in this process, with the file identity it had then. */
export interface VerifiedCli extends CliBinary {
  /** The cache root it was verified under. */
  readonly cacheRoot: string;
  /** Device, inode, size and mtime (ns) of the binary at verification. */
  readonly identity: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
  };
}

/** Where to find the pin and the cache. */
export interface PinnedCliOptions {
  /** Absolute repository root. */
  readonly repoRoot: string;
  /** Environment for `HUDHUD_CLI_CACHE` and `HUDHUD_CLI_LIBC`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Cache root; default `HUDHUD_CLI_CACHE`, else `<repoRoot>/.cache/claude-cli`. */
  readonly cacheRoot?: string | undefined;
  /** Pin file; default `<repoRoot>/tooling/cli-pin.json`. */
  readonly pinFile?: string | undefined;
  /** Pin platform key; default the host's (`win32-x64`, `linux-x64`, ...). */
  readonly platformKey?: string | undefined;
  /** Host OS for the cache mode checks; default `process.platform`. */
  readonly hostPlatform?: NodeJS.Platform | undefined;
}

/** The cache root used by `pnpm cli:fetch` and the launcher. */
export function defaultCacheRoot(
  repoRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env['HUDHUD_CLI_CACHE'];
  return path.resolve(
    repoRoot,
    configured === undefined || configured === '' ? '.cache/claude-cli' : configured,
  );
}

/** The host facts {@link hostPlatformKey} reads. */
export interface HostFacts {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The Node.js diagnostic report; read on Linux only (glibc or musl). */
  readonly report: () => unknown;
}

/** The facts of the running host. */
export const HOST_FACTS: HostFacts = {
  platform: process.platform,
  arch: process.arch,
  report: () => process.report.getReport(),
};

/** The host's pin platform key, as `pnpm cli:fetch` computes it. */
export function hostPlatformKey(
  env: Readonly<Record<string, string | undefined>>,
  host: HostFacts = HOST_FACTS,
): string {
  const libc = env['HUDHUD_CLI_LIBC'];
  return hostPlatform(
    host.platform,
    host.arch,
    libc === 'glibc' || libc === 'musl'
      ? libc
      : host.platform === 'linux'
        ? libcFromReport(host.report())
        : 'glibc',
  );
}

function identityOf(stats: BigIntStats): VerifiedCli['identity'] {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs };
}

/** Whether `file` lies strictly inside `root` (both resolved). */
export function isInside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The pin file of the options: the repository pin unless another is named. */
function pinFileOf(options: PinnedCliOptions): string {
  return options.pinFile ?? path.join(options.repoRoot, 'tooling', 'cli-pin.json');
}

/** sha256 of the running Node.js binary, read once per process. */
let standInDigest: Promise<string> | undefined;

function runningNodeDigest(): Promise<string> {
  standInDigest ??= sha256File(process.execPath).then((digest) => digest.sha256);
  return standInDigest;
}

/**
 * Refuses the real Claude Code CLI on a host where real-CLI runs are refused
 * (a local Mac, `host-policy.ts`, W3-Z ruling 10), keyed on what would run,
 * not on where the pin lives: default deny. The only binary allowed there
 * is the stand-in CLI of the unit tests, which is a copy of the running
 * Node.js binary, so a pin entry passes only when its pinned sha256 is the
 * sha256 of `process.execPath`; a pending entry (no digest) or any other
 * digest is presumed real. The host markers (`CI`, `RUNNER_ENVIRONMENT`,
 * the opt-in) are read from the real process environment, never from the
 * caller's `env`, which may be a constructed one.
 */
async function refuseRealCliHost(
  pin: CliPin,
  platformKey: string,
  hostPlatformName: NodeJS.Platform,
): Promise<void> {
  if (realCliHostRefusal(hostPlatformName, process.env) === undefined) return;
  const entry = pin.platforms.get(platformKey);
  if (entry !== undefined && !('pendingGate' in entry)) {
    if (entry.sha256 === (await runningNodeDigest())) return;
  }
  assertRealCliHostAllowed(hostPlatformName, process.env);
}

/** Every {@link VerifiedCli} issued by {@link resolvePinnedCli} in this process. */
const ISSUED = new WeakSet<VerifiedCli>();

/**
 * Loads the pin and re-verifies the cached binary of the host platform
 * (sha256, size, stamp). Never downloads.
 *
 * @throws CliFetchError when the pin is invalid or the cache does not hold
 *   a verifying copy (run `pnpm cli:fetch`).
 */
export async function resolvePinnedCli(options: PinnedCliOptions): Promise<VerifiedCli> {
  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(options.repoRoot, options.env);
  const pin = await loadPin(pinFileOf(options));
  const platform = options.platformKey ?? hostPlatformKey(options.env);
  const hostPlatformName = options.hostPlatform ?? process.platform;
  await refuseRealCliHost(pin, platform, hostPlatformName);
  const binary = await verifyPinnedCli({
    pin,
    platform,
    cacheRoot,
    hostPlatform: hostPlatformName,
  });
  const verified: VerifiedCli = Object.freeze({
    ...binary,
    cacheRoot,
    identity: Object.freeze(identityOf(lstatSync(binary.binaryPath, { bigint: true }))),
  });
  ISSUED.add(verified);
  return verified;
}

/**
 * Refuses a {@link VerifiedCli} that {@link resolvePinnedCli} did not issue
 * (a copy or a hand-made object could name any file).
 *
 * @throws SandboxRefusedError `binary`.
 */
export function assertIssuedCli(cli: VerifiedCli): void {
  if (!ISSUED.has(cli)) {
    throw new SandboxRefusedError(
      'binary',
      `${cli.binaryPath} was not verified by resolvePinnedCli in this process`,
    );
  }
}

/** Result of {@link probePinnedCli}. */
export type PinnedCliProbe =
  | { readonly available: true; readonly cli: VerifiedCli }
  | { readonly available: false; readonly reason: string };

/**
 * Like {@link resolvePinnedCli}, but reports a missing or unverifiable cache
 * entry, and a platform whose pin entry is pending its gate (the darwin
 * entries until the macOS gate passes, ADR-0014), instead of throwing, for
 * tests that run only when the pinned CLI was already fetched: they skip
 * with the reason. Other failures (an invalid pin) still throw.
 */
export async function probePinnedCli(options: PinnedCliOptions): Promise<PinnedCliProbe> {
  const platform = options.platformKey ?? hostPlatformKey(options.env);
  const pin = await loadPin(pinFileOf(options));
  const entry = pin.platforms.get(platform);
  if (entry !== undefined && 'pendingGate' in entry) {
    return {
      available: false,
      reason: `the pinned CLI for ${platform} is pending the macOS gate (ADR-0014 gate list, M1): no digests are pinned for it, so tests of the real binary do not run here until the gate passes`,
    };
  }
  try {
    return { available: true, cli: await resolvePinnedCli(options) };
  } catch (error) {
    if (error instanceof CliFetchError && error.code === 'cache-invalid') {
      return {
        available: false,
        reason: `pinned CLI not in the cache (${error.message}); run \`pnpm cli:fetch\` first`,
      };
    }
    throw error;
  }
}

/**
 * Re-checks a verified binary before a launch: still under its cache root,
 * still a regular file with the same device, inode, size and mtime.
 *
 * @throws SandboxRefusedError `binary` on any deviation.
 */
export function recheckPinnedCli(cli: VerifiedCli): void {
  if (!isInside(cli.cacheRoot, cli.binaryPath)) {
    throw new SandboxRefusedError('binary', `${cli.binaryPath} is not under ${cli.cacheRoot}`);
  }
  let stats: BigIntStats;
  try {
    stats = lstatSync(cli.binaryPath, { bigint: true });
  } catch (error) {
    throw new SandboxRefusedError('binary', `${cli.binaryPath}: gone since verification`, {
      cause: error,
    });
  }
  const now = identityOf(stats);
  if (
    !stats.isFile() ||
    now.dev !== cli.identity.dev ||
    now.ino !== cli.identity.ino ||
    now.size !== cli.identity.size ||
    now.mtimeNs !== cli.identity.mtimeNs
  ) {
    throw new SandboxRefusedError(
      'binary',
      `${cli.binaryPath}: changed since verification; re-run the verification`,
    );
  }
}
