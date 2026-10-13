/**
 * The decisive Keychain probe of gate item 3 (research 10 §2.5; lead
 * decision C after gate run 2).
 *
 * The search-list probes show what `security(1)` would search, not whether
 * an item of the runner's login keychain is reachable. This probe settles
 * it with a canary:
 *
 * - It runs only on a throw-away GitHub-hosted runner (`CI=true` and
 *   `RUNNER_ENVIRONMENT=github-hosted` in the harness's own environment);
 *   anywhere else it is refused and writes nothing.
 * - It adds one generic password to the runner's own default (login)
 *   keychain under a unique, clearly labelled service name
 *   (`hudhud-gate-canary-<random>`) with a fake value.
 * - It looks the item up by service and account with the runner's own
 *   environment (the control: the item must be found), with the exact
 *   environment the CLI runs with (sandbox `HOME`), and with that plus
 *   `CFFIXED_USER_HOME`. The lookups never pass `-w` or `-g`, so no secret
 *   is ever printed, of the canary or of any other item.
 * - In a `finally` block it deletes the item by its exact service and
 *   account and verifies that a lookup no longer finds it.
 *
 * Verdict: `isolated` when the control finds the item and both sandbox
 * lookups answer "not found" (exit 44); `not-isolated` when a sandbox
 * lookup finds it; otherwise `inconclusive`.
 */

import type { RunResult } from '../host.js';
import type { Sandbox } from '../sandbox.js';
import { sandboxEnv } from '../sandbox.js';
import type { SessionContext } from '../session.js';

const SECURITY = '/usr/bin/security';
/** `errSecItemNotFound` as `security(1)` reports it. */
const NOT_FOUND = 44;
const ACCOUNT = 'hudhud-gate';
const LABEL = 'hudhud macOS gate canary (fake value, deleted by the gate)';
/** Not a credential: a fixed marker no harness accepts. */
export const CANARY_VALUE = 'hudhud-gate-canary-fake-value-not-a-secret';
const RUN_MS = 10_000;

/** Why the canary did not run, or what it saw. */
export type CanaryVerdict = 'isolated' | 'not-isolated' | 'inconclusive' | 'refused';

/** One lookup of the canary. */
export interface CanaryLookup {
  readonly env: string;
  readonly code: number | null;
  /** The item was found (exit 0). */
  readonly found: boolean;
}

/** The evidence of {@link keychainCanary}. */
export interface CanaryReport {
  readonly verdict: CanaryVerdict;
  readonly reason: string;
  readonly service?: string;
  readonly keychain?: string;
  readonly added?: { readonly code: number | null; readonly stderr: string };
  readonly lookups: readonly CanaryLookup[];
  readonly deleted?: { readonly code: number | null; readonly gone: boolean };
}

/** True only on a throw-away GitHub-hosted runner (the harness's own environment). */
export function canaryAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['CI'] === 'true' && env['RUNNER_ENVIRONMENT'] === 'github-hosted';
}

/**
 * The canary probe. `keychain` is the runner's default keychain as the
 * search-list probe printed it; it must lie inside the runner's `HOME`.
 */
export async function keychainCanary(
  context: SessionContext,
  sandbox: Sandbox,
  mockUrl: string,
  keychain: string | undefined,
): Promise<CanaryReport> {
  const { host } = context;
  if (!canaryAllowed(host.env)) {
    return {
      verdict: 'refused',
      reason: 'not a GitHub-hosted runner (CI=true and RUNNER_ENVIRONMENT=github-hosted)',
      lookups: [],
    };
  }
  const runnerHome = host.env['HOME'] ?? '';
  if (keychain === undefined || runnerHome === '' || !keychain.startsWith(`${runnerHome}/`)) {
    return {
      verdict: 'inconclusive',
      reason: 'no default keychain inside the runner HOME to write the canary to',
      lookups: [],
    };
  }
  const service = `hudhud-gate-canary-${host.uuid()}`;
  const runnerEnv = {
    PATH: '/usr/bin:/bin',
    HOME: runnerHome,
    USER: host.user,
    LOGNAME: host.user,
  };
  const cliEnv = sandboxEnv({ sandbox, mockUrl, user: host.user });
  const lookup = async (env: string, vars: Record<string, string>): Promise<CanaryLookup> => {
    // Attributes only: never -w or -g, so no secret is printed.
    const result = await host.run(
      SECURITY,
      ['find-generic-password', '-a', ACCOUNT, '-s', service],
      {
        env: vars,
        timeoutMs: RUN_MS,
      },
    );
    return { env, code: result.code, found: result.code === 0 };
  };
  let added: RunResult | undefined;
  const lookups: CanaryLookup[] = [];
  let deleted: CanaryReport['deleted'];
  try {
    added = await host.run(
      SECURITY,
      [
        'add-generic-password',
        '-a',
        ACCOUNT,
        '-s',
        service,
        '-l',
        LABEL,
        '-w',
        CANARY_VALUE,
        keychain,
      ],
      { env: runnerEnv, timeoutMs: RUN_MS },
    );
    if (added.code === 0) {
      lookups.push(await lookup('runner HOME (control)', runnerEnv));
      lookups.push(await lookup('CLI environment (sandbox HOME)', cliEnv));
      lookups.push(
        await lookup('CLI environment + CFFIXED_USER_HOME', {
          ...cliEnv,
          CFFIXED_USER_HOME: sandbox.home,
        }),
      );
    }
  } finally {
    const removed = await host.run(
      SECURITY,
      ['delete-generic-password', '-a', ACCOUNT, '-s', service, keychain],
      { env: runnerEnv, timeoutMs: RUN_MS },
    );
    const after = await lookup('runner HOME (after delete)', runnerEnv);
    deleted = { code: removed.code, gone: after.code === NOT_FOUND };
  }
  const base = {
    service,
    keychain,
    added: { code: added.code, stderr: added.stderr.trim().slice(0, 500) },
    lookups,
    deleted,
  };
  return { ...base, ...canaryVerdict(added.code, lookups) };
}

/** The verdict from the add result and the three lookups. */
export function canaryVerdict(
  addCode: number | null,
  lookups: readonly CanaryLookup[],
): { readonly verdict: CanaryVerdict; readonly reason: string } {
  if (addCode !== 0) return { verdict: 'inconclusive', reason: 'the canary could not be added' };
  const [control, ...sandboxed] = lookups;
  if (control?.found !== true) {
    return { verdict: 'inconclusive', reason: 'the control lookup did not find the canary' };
  }
  if (sandboxed.some((entry) => entry.found)) {
    return { verdict: 'not-isolated', reason: 'a lookup in the CLI environment found the canary' };
  }
  if (sandboxed.length === 2 && sandboxed.every((entry) => entry.code === NOT_FOUND)) {
    return {
      verdict: 'isolated',
      reason: 'the CLI environment cannot find an item of the runner login keychain',
    };
  }
  return { verdict: 'inconclusive', reason: 'a lookup in the CLI environment failed' };
}
