/**
 * Gate item 1, binary provenance (ADR-0014; ADR-0011 "Binary provenance").
 *
 * - darwin-arm64 and darwin-x64: npm integrity, extracted sha256 and size,
 *   and the Agent SDK `manifest.json` agree (`digests.ts`); recorded while
 *   the pin is `pendingGate`, verified against it afterwards.
 * - `/usr/bin/codesign --verify --strict` accepts the binary of this runner
 *   (the OS-signature-first path of strict mode), and it runs
 *   (`--version`) in the sandbox with no request reaching the trap.
 * - Quarantine: a quarantined copy of the signed binary, and a quarantined
 *   copy whose signature was removed, are launched; each outcome is mapped
 *   to a named launch cause. The unsigned copy must fail with a named
 *   launch-failure cause (otherwise the mapping is unproven).
 */

import path from 'node:path';

import { CliFetchError } from '../../../test-support/src/cli/errors.js';
import type { CliPin } from '../../../test-support/src/cli/pin.js';
import { classifyLaunch, type LaunchCause } from '../causes.js';
import { DARWIN_PLATFORMS, fetchGateBinary, type GateDigest } from '../digests.js';
import type { GateHost, RunResult } from '../host.js';
import type { ItemRecorder } from '../report.js';
import { createSandbox, sandboxEnv } from '../sandbox.js';
import { errorMessage } from './common.js';

const CODESIGN = '/usr/bin/codesign';
const XATTR = '/usr/bin/xattr';
const LAUNCH_TIMEOUT_MS = 60_000;
const TOOL_TIMEOUT_MS = 60_000;

/** Launch causes that name a Gatekeeper or code-signing refusal. */
const POLICY_FAILURES: ReadonlySet<LaunchCause> = new Set([
  'killed-at-launch',
  'launch-denied',
  'launch-hang',
]);

/** The fetch outcome of both darwin platforms. */
export interface PreparedBinaries {
  readonly digests: readonly GateDigest[];
  /** Platforms whose fetch or verification failed, with the reason. */
  readonly failures: Readonly<Record<string, string>>;
  /** The verified binary of this runner's platform, when it verified. */
  readonly hostBinary: string | undefined;
}

/**
 * Fetches and verifies both darwin binaries into `cacheRoot`; a failure of
 * one platform is recorded, never thrown.
 */
export async function prepareBinaries(
  host: GateHost,
  pin: CliPin,
  options: { readonly sdkVersion: string; readonly cacheRoot: string; readonly hostKey: string },
): Promise<PreparedBinaries> {
  const digests: GateDigest[] = [];
  const failures: Record<string, string> = {};
  let hostBinary: string | undefined;
  for (const platform of DARWIN_PLATFORMS) {
    try {
      const { digest, binaryPath } = await fetchGateBinary({
        pin,
        platform,
        sdkVersion: options.sdkVersion,
        cacheRoot: options.cacheRoot,
        hostPlatform: host.platform,
        registry: host.registry,
        now: () => new Date(host.now()),
      });
      digests.push(digest);
      if (platform === options.hostKey) hostBinary = binaryPath;
    } catch (error) {
      failures[platform] =
        error instanceof CliFetchError ? `[${error.code}] ${error.message}` : errorMessage(error);
    }
  }
  return { digests, failures, hostBinary };
}

/** The `com.apple.quarantine` value of a file downloaded by an unknown agent now. */
export function quarantineValue(nowMs: number): string {
  return `0083;${Math.floor(nowMs / 1000).toString(16)};hudhud-gate;`;
}

/** `Key=value` lines of `codesign -dv` output that identify the signer. */
export function signerLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter((line) =>
      /^(Identifier|Authority|TeamIdentifier|Timestamp|Runtime Version|Format)=/.test(line),
    );
}

function outcome(result: RunResult): Record<string, unknown> {
  return {
    code: result.code,
    signal: result.signal,
    error: result.error,
    stdout: new TextDecoder().decode(result.stdout).slice(0, 500),
    stderr: result.stderr.slice(0, 1000),
    cause: classifyLaunch(result),
  };
}

/** Runs item 1. */
export async function provenanceItem(
  host: GateHost,
  prepared: PreparedBinaries,
  version: string,
  r: ItemRecorder,
): Promise<void> {
  for (const digest of prepared.digests) {
    r.check(
      `${digest.platform}: npm integrity, binary sha256/size and ${digest.manifest.source} manifest agree`,
      true,
      `integrity ${digest.integrity}, sha256 ${digest.sha256}, size ${String(digest.size)}, pin: ${digest.pinStatus}`,
    );
  }
  for (const [platform, reason] of Object.entries(prepared.failures)) {
    r.check(`${platform}: npm integrity, binary sha256/size and SDK manifest agree`, false, reason);
  }
  r.note('digests', prepared.digests);
  const binary = prepared.hostBinary;
  r.check('binary of this runner verified', binary !== undefined, 'fetched and re-hashed');
  if (binary === undefined) return;

  const verify = await host.run(CODESIGN, ['--verify', '--strict', '--verbose=2', binary], {
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: TOOL_TIMEOUT_MS,
  });
  r.check('codesign --verify --strict accepts the binary', verify.code === 0, verify.stderr.trim());
  const display = await host.run(CODESIGN, ['-dv', '--verbose=4', binary], {
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: TOOL_TIMEOUT_MS,
  });
  r.note('signer', signerLines(display.stderr));

  const mock = await host.startMock();
  try {
    const sandbox = await createSandbox(host.fs, host.tmpdir);
    const env = sandboxEnv({ sandbox, mockUrl: mock.url, user: host.user });
    const launch = (file: string): Promise<RunResult> =>
      host.run(file, ['--version'], { env, cwd: sandbox.work, timeoutMs: LAUNCH_TIMEOUT_MS });

    const plain = await launch(binary);
    const printed = new TextDecoder().decode(plain.stdout).trim();
    r.check(
      'the binary runs in the sandbox and reports the pinned version',
      classifyLaunch(plain) === 'ok' && printed.startsWith(`${version} `),
      printed.slice(0, 200),
    );

    const quarantineDir = path.posix.join(sandbox.root, 'quarantine');
    await host.fs.mkdir(quarantineDir);
    const signed = path.posix.join(quarantineDir, 'signed', 'claude');
    const unsigned = path.posix.join(quarantineDir, 'unsigned', 'claude');
    await host.fs.mkdir(path.posix.dirname(signed));
    await host.fs.mkdir(path.posix.dirname(unsigned));
    await host.fs.copyFile(binary, signed);
    await host.fs.copyFile(binary, unsigned);
    const stripped = await host.run(CODESIGN, ['--remove-signature', unsigned], {
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    const strippedVerify = await host.run(CODESIGN, ['--verify', unsigned], {
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    r.check(
      'the signature of the test copy was removed',
      stripped.code === 0 && strippedVerify.code !== 0,
      `remove: ${String(stripped.code)}, verify after: ${String(strippedVerify.code)} ${strippedVerify.stderr.trim()}`,
    );
    const value = quarantineValue(host.now());
    for (const file of [signed, unsigned]) {
      const marked = await host.run(XATTR, ['-w', 'com.apple.quarantine', value, file], {
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: TOOL_TIMEOUT_MS,
      });
      r.check(
        `quarantine attribute set on ${path.posix.basename(path.posix.dirname(file))} copy`,
        marked.code === 0,
        marked.stderr.trim(),
      );
    }

    const signedRun = await launch(signed);
    const signedCause = classifyLaunch(signedRun);
    r.note('quarantinedSigned', outcome(signedRun));
    r.check(
      'quarantined signed binary: runs, or fails with a named launch cause',
      signedCause === 'ok' || POLICY_FAILURES.has(signedCause),
      signedCause,
    );
    const unsignedRun = await launch(unsigned);
    const unsignedCause = classifyLaunch(unsignedRun);
    r.note('quarantinedUnsigned', outcome(unsignedRun));
    r.check(
      'quarantined unsigned copy: refused with a named launch cause',
      POLICY_FAILURES.has(unsignedCause),
      unsignedCause,
    );
    r.check(
      'egress: no request reached the trap',
      mock.violations.length === 0,
      JSON.stringify(mock.violations),
    );
  } finally {
    await mock.close();
  }
}
