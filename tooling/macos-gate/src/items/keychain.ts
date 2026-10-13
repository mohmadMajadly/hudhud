/**
 * Gate item 3, Keychain (ADR-0014 item 3 as changed by amendment 5; research
 * 01 §5: credentials live in the macOS Keychain, keyed by config dir;
 * research 09 §4 and §8, research 10 §2).
 *
 * Gate run 1 showed CLI 2.1.296 calling `security(1)` even with an API key,
 * so the item records the Keychain access instead of requiring its absence
 * (the lead's ruling, ADR-0014 amendment 5). With API-key auth and an
 * isolated `CLAUDE_CONFIG_DIR` and `HOME`:
 *
 * - the first frame arrives within the first-frame watchdog, the key source
 *   is `ANTHROPIC_API_KEY` and the turn completes (a GUI prompt would stall
 *   it);
 * - the Keychain access is recorded: the CLI's tree is sampled from the
 *   spawn to the result and every `security` child is listed (live or
 *   zombie: macOS `ps` shows an exited, unreaped child as `(security)`); a
 *   run whose tree was never sampled recorded nothing and fails;
 * - the read-only search-list probes all ran, and the report states whether
 *   the `CFFIXED_USER_HOME` probe proves the search list isolated
 *   ({@link searchListIsolation}); isolation counts as possible only then;
 * - on a GitHub-hosted runner only, the canary probe of
 *   `keychain-canary.ts` writes a labelled fake item to the runner's login
 *   keychain, checks whether the CLI's environment can find it, and deletes
 *   it again (verified); elsewhere it is refused.
 *
 * A control run without any credential records whether the CLI then reaches
 * for the Keychain, and whether a stall would be named `keychain-access` by
 * the watchdog's classifier. An evidence-only run puts a `security` shim first
 * on `PATH` that records its argv and answers "not found" (exit 44) without
 * touching any keychain, so the report shows what the CLI asks for and
 * whether it resolves `security` through `PATH` at all.
 */

import path from 'node:path';

import { classifyStall, watchdogState } from '../causes.js';
import { keychainCanary } from './keychain-canary.js';
import type { ItemRecorder } from '../report.js';
import { commandName, recordLabel } from '../ps.js';
import { mockMarker, type Sandbox } from '../sandbox.js';
import { field, runScenario, type CliSession, type SessionContext } from '../session.js';
import {
  addBounded,
  initializeResponse,
  isSuccess,
  pollUntil,
  sessionEvidence,
  shellSnapshotReady,
  TURN_MS,
  WATCHDOG,
} from './common.js';

const CONTROL_MS = 45_000;
/** `errSecItemNotFound` as `security(1)` reports it. */
const SHIM_EXIT = 44;
const MAX_SHIM_CHARS = 8 * 1024;

/** One sighting of a `security` child. */
interface SecuritySighting {
  /** Milliseconds after the spawn. */
  readonly atMs: number;
  readonly pid: number;
  readonly name: string;
  readonly zombie: boolean;
}

/** What {@link sampleUntilResult} saw. */
export interface Sampled {
  /** Snapshots of the CLI's tree taken while it ran. */
  readonly samples: number;
  readonly names: ReadonlySet<string>;
  readonly securitySeen: boolean;
  readonly security: readonly SecuritySighting[];
}

/** Samples the tree while waiting for a result; returns every descendant seen. */
async function sampleUntilResult(
  context: SessionContext,
  session: CliSession,
  timeoutMs: number,
): Promise<Sampled> {
  const names = new Set<string>();
  const security = new Map<number, SecuritySighting>();
  const identity = session.identity;
  let samples = 0;
  await pollUntil(
    context.host,
    () => session.findKind('result') !== undefined || session.exit !== undefined,
    timeoutMs,
    async () => {
      if (identity === null || session.exit !== undefined) return;
      const tree = await context.ledger.tree(identity);
      samples += 1;
      for (const record of tree.descendants) {
        addBounded(names, recordLabel(record));
        if (commandName(record.name) === 'security' && !security.has(record.pid)) {
          security.set(record.pid, {
            atMs: context.host.now() - session.spawnedAt,
            pid: record.pid,
            name: record.name,
            zombie: record.zombie === true,
          });
        }
      }
    },
  );
  return { samples, names, securitySeen: security.size > 0, security: [...security.values()] };
}

/** The Keychain access of a sampled run, in one line. */
export function accessSummary(sampled: Sampled): string {
  const first = sampled.security[0];
  return first === undefined
    ? `no security(1) child in ${String(sampled.samples)} samples`
    : `security(1) seen ${String(sampled.security.length)}x, first at ${String(first.atMs)} ms after the spawn (${String(sampled.samples)} samples)`;
}

/** The shim's directory and log inside the sandbox. */
function shimPaths(sandbox: Sandbox): { readonly dir: string; readonly log: string } {
  return {
    dir: path.posix.join(sandbox.root, 'shim'),
    log: path.posix.join(sandbox.root, 'security-argv.log'),
  };
}

/** A POSIX sh `security` that appends `[arg]...` per call to `log` and exits 44. */
export function securityShim(log: string): string {
  const quoted = `'${log.replaceAll("'", "'\\''")}'`;
  return [
    '#!/bin/sh',
    `for a in "$@"; do printf '[%s]' "$a"; done >> ${quoted}`,
    `printf '\\n' >> ${quoted}`,
    `exit ${String(SHIM_EXIT)}`,
    '',
  ].join('\n');
}

const RUNNER_ENV = 'runner HOME';
const SANDBOX_ENV = 'sandbox HOME';
const CFFIXED_ENV = 'sandbox HOME + CFFIXED_USER_HOME';
const LIST_COMMAND = 'security list-keychains -d user';
const DEFAULT_COMMAND = 'security default-keychain -d user';

/** One read-only `security` query of the keychain search list. */
export interface SearchListProbe {
  readonly env: string;
  readonly command: string;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Evidence for the local-run mitigation (research 09): which keychains
 * `security(1)` would search for a child with the runner's own `HOME`, with
 * the sandbox `HOME`, and with the sandbox `HOME` plus `CFFIXED_USER_HOME`
 * (the CoreFoundation home override). Read-only: `list-keychains` and
 * `default-keychain` without `-s` only print.
 */
export async function probeSearchList(
  context: SessionContext,
  sandbox: Sandbox,
): Promise<SearchListProbe[]> {
  const base = { PATH: '/usr/bin:/bin', USER: context.host.user, LOGNAME: context.host.user };
  const envs: [string, Record<string, string>][] = [
    [RUNNER_ENV, { ...base, HOME: context.host.env['HOME'] ?? '' }],
    [SANDBOX_ENV, { ...base, HOME: sandbox.home }],
    [CFFIXED_ENV, { ...base, HOME: sandbox.home, CFFIXED_USER_HOME: sandbox.home }],
  ];
  const probes: SearchListProbe[] = [];
  for (const [label, env] of envs) {
    for (const args of [
      ['list-keychains', '-d', 'user'],
      ['default-keychain', '-d', 'user'],
    ]) {
      const result = await context.host.run('/usr/bin/security', args, { env, timeoutMs: 10_000 });
      probes.push({
        env: label,
        command: `security ${args.join(' ')}`,
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout).trim().slice(0, 2000),
        stderr: result.stderr.trim().slice(0, 2000),
      });
    }
  }
  return probes;
}

/** The search-list verdict of one probed environment. */
export type IsolationVerdict = 'isolated' | 'not-isolated' | 'inconclusive';

/** What {@link searchListIsolation} decided. */
export interface SearchListIsolation {
  /** Sandbox `HOME` plus `CFFIXED_USER_HOME`: the probe ADR-0014 item 3 names. */
  readonly cffixedUserHome: IsolationVerdict;
  /** Sandbox `HOME` alone, to show what `CFFIXED_USER_HOME` adds. */
  readonly homeAlone: IsolationVerdict;
  /** Isolation counts as possible only when the `CFFIXED_USER_HOME` probe proves it. */
  readonly proven: boolean;
  readonly scope: string;
}

/** What the verdict covers, and what it cannot. */
export const ISOLATION_SCOPE =
  'the user search list and default keychain of security(1) only; not an in-process Security framework call or an explicit keychain path';

/** The keychain paths `security list-keychains` or `default-keychain` printed, one quoted path per line. */
export function keychainPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
    .filter((line) => line !== '');
}

/**
 * The verdict for the probes of environment `env`.
 *
 * - `inconclusive`: the runner-`HOME` baseline did not list a keychain (an
 *   empty list elsewhere then proves nothing), or a probe of `env` is
 *   missing or did not run.
 * - `not-isolated`: a probe of `env` named a keychain outside `home`.
 * - `isolated`: both probes ran and every keychain they named lies inside
 *   `home` (an empty search list and "no default keychain" included).
 */
export function envIsolation(
  probes: readonly SearchListProbe[],
  env: string,
  home: string,
): IsolationVerdict {
  const baseline = probes.find(
    (probe) => probe.env === RUNNER_ENV && probe.command === LIST_COMMAND && probe.code === 0,
  );
  const own = probes.filter((probe) => probe.env === env);
  if (
    baseline === undefined ||
    keychainPaths(baseline.stdout).length === 0 ||
    own.length !== 2 ||
    own.some((probe) => probe.code === null)
  ) {
    return 'inconclusive';
  }
  const named = own
    .filter((probe) => probe.code === 0)
    .flatMap((probe) => keychainPaths(probe.stdout));
  return named.every((file) => file.startsWith(`${home}/`)) ? 'isolated' : 'not-isolated';
}

/** The isolation verdicts of the search-list probes for the sandbox `home`. */
export function searchListIsolation(
  probes: readonly SearchListProbe[],
  home: string,
): SearchListIsolation {
  const cffixedUserHome = envIsolation(probes, CFFIXED_ENV, home);
  return {
    cffixedUserHome,
    homeAlone: envIsolation(probes, SANDBOX_ENV, home),
    proven: cffixedUserHome === 'isolated',
    scope: ISOLATION_SCOPE,
  };
}

/** Runs item 3. */
export async function keychainItem(context: SessionContext, r: ItemRecorder): Promise<void> {
  r.note(
    'limitation',
    'Keychain access is detected through security(1) child processes sampled with /bin/ps (live or zombie); an in-process Security framework call by the CLI would not be visible (proxy accepted by the lead).',
  );
  const keyed = await runScenario(context, {}, async ({ session, sandbox, mock }) => {
    session.initialize();
    session.user(`${mockMarker('text')} gate item 3`);
    const sampled = await sampleUntilResult(context, session, TURN_MS);
    r.note('apiKeySession', {
      ...sessionEvidence(session),
      descendants: [...sampled.names],
      security: sampled.security,
    });
    const first = session.frames[0];
    const started = session.watchdogInput().startedAt;
    r.check(
      'API key: the first frame arrives within the first-frame watchdog',
      first !== undefined && first.at - started < WATCHDOG.firstFrameMs,
      first === undefined ? 'no frame' : `${String(first.at - started)} ms`,
    );
    const source = field(field(initializeResponse(session), 'account'), 'apiKeySource');
    r.check(
      'API key: apiKeySource is ANTHROPIC_API_KEY',
      source === 'ANTHROPIC_API_KEY',
      String(source),
    );
    r.check('API key: the turn completes', isSuccess(session.findKind('result')), 'result/success');
    // ADR-0014 item 3 (amendment 5): the access is recorded, not forbidden.
    r.check(
      'API key: Keychain access recorded (the tree was sampled from the spawn to the result)',
      sampled.samples > 0,
      accessSummary(sampled),
    );
    r.note(
      'keychainsDirInIsolatedHome',
      await context.host.fs.kind(path.posix.join(sandbox.home, 'Library', 'Keychains')),
    );
    const probes = await probeSearchList(context, sandbox);
    r.note('keychainSearchList', probes);
    const isolation = searchListIsolation(probes, sandbox.home);
    r.note('keychainIsolation', isolation);
    r.check(
      'search-list probes: every read-only query ran',
      probes.every((probe) => probe.code !== null),
      `CFFIXED_USER_HOME: ${isolation.cffixedUserHome}, HOME alone: ${isolation.homeAlone}; isolation ${isolation.proven ? 'proven' : 'not proven'} (${ISOLATION_SCOPE})`,
    );
    // The decisive probe (lead decision C): GitHub-hosted runners only.
    const defaultKeychain = probes.find(
      (probe) => probe.env === RUNNER_ENV && probe.command === DEFAULT_COMMAND && probe.code === 0,
    );
    const canary = await keychainCanary(
      context,
      sandbox,
      mock.url,
      keychainPaths(defaultKeychain?.stdout ?? '')[0],
    );
    r.note('keychainCanary', canary);
    r.check(
      'keychain canary: written only on a GitHub-hosted runner, and deleted again',
      canary.verdict === 'refused' || canary.deleted?.gone === true,
      `${canary.verdict}: ${canary.reason}`,
    );
  });
  r.check('API key run: no egress violation', keyed.violations === 0, String(keyed.violations));

  const control = await runScenario(context, { apiKey: false }, async ({ session, sandbox }) => {
    session.initialize();
    session.user(`${mockMarker('text')} gate item 3 control`);
    const sampled = await sampleUntilResult(context, session, CONTROL_MS);
    const state = watchdogState(session.watchdogInput(), WATCHDOG);
    const ended = session.findKind('result') !== undefined || session.exit !== undefined;
    const tree =
      session.identity === null || ended ? undefined : await context.ledger.tree(session.identity);
    const cause =
      tree === undefined
        ? undefined
        : classifyStall({
            descendants: tree.descendants,
            toolRunning: session.toolRunning,
            shellSnapshotReady: await shellSnapshotReady(context.host, sandbox),
          });
    r.note('controlSession', {
      ...sessionEvidence(session),
      descendants: [...sampled.names],
      securitySeen: sampled.securitySeen,
      security: sampled.security,
      watchdog: state,
      stallCause: cause,
    });
    r.check(
      'control (no credential): the CLI ends, or its stall is named',
      ended || (cause !== undefined && cause !== 'unknown'),
      ended ? 'ended' : `stall cause ${String(cause)}`,
    );
  });
  r.check('control run: no egress violation', control.violations === 0, String(control.violations));

  // Evidence only: what the CLI asks security(1) for, with the API key set.
  const shim = await runScenario(
    context,
    {
      pathPrefix: (sandbox) => shimPaths(sandbox).dir,
      prepare: async (sandbox) => {
        const { dir, log } = shimPaths(sandbox);
        await context.host.fs.mkdir(dir);
        const file = path.posix.join(dir, 'security');
        await context.host.fs.writeFile(file, securityShim(log));
        await context.host.run('/bin/chmod', ['700', file], {
          env: { PATH: '/usr/bin:/bin' },
          timeoutMs: 10_000,
        });
      },
    },
    async ({ session, sandbox }) => {
      session.initialize();
      session.user(`${mockMarker('text')} gate item 3 shim`);
      const sampled = await sampleUntilResult(context, session, TURN_MS);
      const log = await context.host.fs.readFile(shimPaths(sandbox).log).catch(() => undefined);
      r.note('securityShim', {
        invoked: log !== undefined,
        argv:
          log
            ?.slice(0, MAX_SHIM_CHARS)
            .split('\n')
            .filter((line) => line !== '') ?? [],
        securitySeen: sampled.securitySeen,
        security: sampled.security,
        result: session.findKind('result')?.value['subtype'],
      });
    },
  );
  r.note('shimShutdown', { violations: shim.violations, survivors: shim.shutdown.sweep.survivors });
  r.check(
    'nothing survives any run',
    keyed.shutdown.sweep.survivors.length +
      control.shutdown.sweep.survivors.length +
      shim.shutdown.sweep.survivors.length ===
      0,
    [
      ...keyed.shutdown.sweep.survivors,
      ...control.shutdown.sweep.survivors,
      ...shim.shutdown.sweep.survivors,
    ].join(', '),
  );
  r.check('shim run: no egress violation', shim.violations === 0, String(shim.violations));
}
