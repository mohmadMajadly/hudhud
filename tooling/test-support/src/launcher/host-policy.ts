/**
 * Where real-CLI runs may happen (W3-Z ruling 10, ADR-0013, ADR-0014).
 *
 * @remarks
 * macOS gate run 1 (research 09) showed the pinned CLI calling `security(1)`
 * on the login keychain even with `ANTHROPIC_API_KEY` set. On a developer's
 * own Mac that is the developer's real keychain, which no sandbox variable
 * isolates (unless the `CFFIXED_USER_HOME` probe of the next gate run proves
 * otherwise). So every real-CLI run (integration suites, fixture recordings,
 * the macOS gate) is refused on a macOS host unless it is a GitHub-hosted
 * runner (`CI=true` and `RUNNER_ENVIRONMENT=github-hosted`, a throw-away VM)
 * or the developer opts in explicitly with
 * `HUDHUD_ALLOW_LOCAL_MACOS_REAL_CLI=1`. Other platforms are not affected;
 * the fake CLI of the unit tests is not the real binary and is not refused.
 */

import process from 'node:process';

import { SandboxRefusedError } from './errors.js';

/** The explicit opt-in for real-CLI runs on a local macOS host. */
export const LOCAL_MACOS_OPT_IN = 'HUDHUD_ALLOW_LOCAL_MACOS_REAL_CLI';

/**
 * Why a real-CLI run is refused on this host, or `undefined` when it may
 * run.
 *
 * @remarks
 * `platform` is a test seam that can only make the policy stricter: the run
 * counts as a macOS run when EITHER the injected `platform` OR the real
 * `process.platform` (read at each call) is `darwin`. Tests can simulate a
 * Mac on any host; nothing can claim another platform on a real Mac.
 */
export function realCliHostRefusal(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (platform !== 'darwin' && process.platform !== 'darwin') return undefined;
  if (env['CI'] === 'true' && env['RUNNER_ENVIRONMENT'] === 'github-hosted') return undefined;
  if (env[LOCAL_MACOS_OPT_IN] === '1') return undefined;
  return (
    'refusing to run the real Claude Code CLI on a local macOS host: it calls security(1) on ' +
    'the login keychain even with an API key set (research 09), and no sandbox variable ' +
    'isolates that keychain. Real-CLI suites run on GitHub-hosted runners (CI=true, ' +
    `RUNNER_ENVIRONMENT=github-hosted). To accept the keychain access on this Mac, set ${LOCAL_MACOS_OPT_IN}=1.`
  );
}

/**
 * Refuses a real-CLI run on a local macOS host (see the module remarks).
 *
 * @throws SandboxRefusedError `host`.
 */
export function assertRealCliHostAllowed(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const refusal = realCliHostRefusal(platform, env);
  if (refusal !== undefined) throw new SandboxRefusedError('host', refusal);
}
