/**
 * Gate item 7, CI (ADR-0014): darwin-arm64 is a mandatory runner; darwin-x64
 * is declared in `maxTested` only when it has run.
 *
 * Per runner the item proves which platform actually ran: macOS, the
 * architecture the workflow asked for, native (not translated by Rosetta),
 * and a pinned binary of that architecture. It records whether items 1-6
 * all passed here, which is what makes the platform eligible for
 * `maxTested` (W7-T4 decides; this run never edits the pin).
 */

import type { GateHost } from '../host.js';
import type { ItemRecorder } from '../report.js';

const UNAME = '/usr/bin/uname';
const SYSCTL = '/usr/sbin/sysctl';
const LIPO = '/usr/bin/lipo';
const SW_VERS = '/usr/bin/sw_vers';
const ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } as const;
const TIMEOUT_MS = 30_000;

/** The Mach-O architecture name of a Node.js `process.arch`. */
export function machArch(nodeArch: string): string {
  return nodeArch === 'x64' ? 'x86_64' : nodeArch;
}

/** Runner metadata from the harness environment (GitHub's image variables). */
export function runnerMetadata(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const key of ['ImageOS', 'ImageVersion', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT']) {
    const value = env[key];
    if (value !== undefined) metadata[key] = value;
  }
  return metadata;
}

/** Runs item 7. `earlierPassed` is true when items 1-6 all passed on this runner. */
export async function runnerItem(
  host: GateHost,
  expectArch: string,
  binary: string | undefined,
  earlierPassed: boolean,
  r: ItemRecorder,
): Promise<void> {
  const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();
  r.check('the runner is macOS', host.platform === 'darwin', host.platform);
  r.check(
    'Node.js runs on the requested architecture',
    host.arch === expectArch,
    `${host.arch}, requested ${expectArch}`,
  );
  const uname = await host.run(UNAME, ['-m'], { env: ENV, timeoutMs: TIMEOUT_MS });
  r.check(
    'the kernel reports the same architecture',
    text(uname.stdout) === machArch(expectArch),
    text(uname.stdout),
  );
  const translated = await host.run(SYSCTL, ['-n', 'sysctl.proc_translated'], {
    env: ENV,
    timeoutMs: TIMEOUT_MS,
  });
  r.check(
    'the harness is not translated by Rosetta',
    text(translated.stdout) !== '1',
    `proc_translated=${text(translated.stdout) || 'n/a'}`,
  );
  const archs =
    binary === undefined
      ? undefined
      : await host.run(LIPO, ['-archs', binary], { env: ENV, timeoutMs: TIMEOUT_MS });
  const binaryArchs = archs === undefined ? [] : text(archs.stdout).split(/\s+/);
  r.check(
    'the pinned binary is native for this runner',
    binaryArchs.includes(machArch(expectArch)),
    binaryArchs.join(' ') || 'no binary',
  );
  const versions = await host.run(SW_VERS, [], { env: ENV, timeoutMs: TIMEOUT_MS });
  r.note('swVers', text(versions.stdout));
  r.note('runner', runnerMetadata(host.env));
  r.note('node', host.nodeVersion);
  r.note('platform', `darwin-${host.arch}`);
  r.note('maxTestedEligible', earlierPassed);
}
