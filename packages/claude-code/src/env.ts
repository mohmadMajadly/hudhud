/**
 * The child environment of the Claude Code CLI (K19, ADR-0012 §4, plan §2.5).
 *
 * @remarks
 * Order, in every form of the `env` option:
 *
 * 1. Base. `'harness'`: the parent variables allowed by {@link isHarnessAllowed}
 *    (an allowlist by rule). `'inherit'`: every parent variable. Explicit
 *    map: exactly the map. In both presets the variables of
 *    {@link isNeverInherited} are dropped (`NODE_OPTIONS`, `CLAUDECODE`,
 *    `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`,
 *    `CLAUDE_AGENT_SDK_*`, and since CLI 2.1.302 `CLAUDE_CODE_REMOTE`,
 *    `CLAUDE_CODE_ENVIRONMENT_KIND`, `CLAUDE_CODE_REMOTE_MCP_CONFIG`,
 *    `CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR`,
 *    `CLAUDE_CODE_SANDBOX_LEAVE_DENIES_TO_SRT_WIN`,
 *    `CLAUDE_CODE_CCR_WORKER_SOCKET`, and since CLI 2.1.310
 *    `CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT`,
 *    `CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK`): they would change how
 *    the CLI runs, load code or configuration, re-route traffic, weaken a
 *    protection or make the CLI believe it is nested, and an application that
 *    wants one adds it (the posture lists it).
 * 2. Object form: `remove` names are deleted, then `add` entries are set.
 * 3. hudhud's pinned variables override in every form:
 *    `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`,
 *    `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `DISABLE_AUTOUPDATER=1` and
 *    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (unless the option is
 *    `'harness-default'`), `CLAUDE_CONFIG_DIR` (only with `configDir`),
 *    `TRACEPARENT`/`TRACESTATE` (only with `trace`). Always removed:
 *    `CLAUDE_CODE_SDK_READS_SESSION_STATE` (D11),
 *    `CLAUDE_CODE_SDK_READS_STARTUP_MARKS` (CLI 2.1.310), and `TRACEPARENT`/
 *    `TRACESTATE` unless `trace` is set. hudhud never sets
 *    `CLAUDE_CODE_ENTRYPOINT` (ADR-0001 §4).
 *
 * On win32 names are case-insensitive, as the OS treats them: matching,
 * removal and overrides ignore case, and two option names that differ only
 * in case are refused. Dropped, added and removed variables are reported by
 * name, never by value. A variable is dropped when the parent holds it and
 * the child's final environment does not (compared as the OS compares
 * names): a parent variable that a preset filters out but `env.add` or a
 * hudhud pin sets again reaches the child, so it is not dropped (it is
 * reported as added, or it is hudhud's own value). On win32 libuv would add
 * some parent variables to every child env that lacks them; the spawn layer
 * blanks them instead (see `spawnInjected`).
 */

import { InvalidOptionsError, isCredentialEnvName, type EnvMap } from '@hudhudjs/core';
import { WIN32_REQUIRED_ENV_NAMES, type ProcessPlatform } from '@hudhudjs/core/process';

import type { EffectiveConnectOptions, EffectiveSessionOptions } from './options-types.js';
import { isProjectCredentialEnvName } from './settings-guard.js';

/**
 * Variables hudhud sets or removes itself. Options can neither add nor
 * remove them (compared case-insensitively); each has its own option.
 * `CLAUDE_CODE_SDK_READS_SESSION_STATE` and
 * `CLAUDE_CODE_SDK_READS_STARTUP_MARKS` are always removed, so adding one
 * would be ignored silently: they are refused as well. Both are switches the
 * Agent SDK sets for itself, and each changes the stream hudhud parses: the
 * first marks `session_state_changed` frames `sdk_host_only` (D11); with the
 * second, CLI 2.1.310 writes `keep_alive` lines carrying a `startup_mark`
 * before the `initialize` response (lead ruling, checklist 1.14).
 */
export const PINNED_ENV_NAMES: readonly string[] = [
  'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
  'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS',
  'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CONFIG_DIR',
  'TRACEPARENT',
  'TRACESTATE',
  'CLAUDE_CODE_SDK_READS_SESSION_STATE',
  'CLAUDE_CODE_SDK_READS_STARTUP_MARKS',
];

const PINNED = new Set(PINNED_ENV_NAMES);

/** Whether an option may not name `name` in `env` (any case, every OS). */
export function envNameIsPinned(name: string): boolean {
  return PINNED.has(name.toUpperCase());
}

/**
 * Parent variables no preset passes on. The rule (lead ruling on the CLI
 * 2.1.302 names, COMPAT-1, ADR-0012 §4; applied again to the 2.1.310 names,
 * fix/cli-2.1.310): a variable that loads code or
 * configuration, re-routes traffic or weakens a protection never arrives
 * silently from the parent environment; an application that wants one sets
 * it with `env.add` (or an explicit map), and the posture lists it
 * ({@link isCredentialOrRoutingEnvName}).
 */
const NEVER_INHERITED = new Set([
  'NODE_OPTIONS',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  // CLI 2.1.302 (static reading): `CLAUDE_CODE_REMOTE` and
  // `CLAUDE_CODE_ENVIRONMENT_KIND` switch on the remote and byoc code paths;
  // with both, `CLAUDE_CODE_REMOTE_MCP_CONFIG` names a file of MCP servers
  // the CLI loads.
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_ENVIRONMENT_KIND',
  'CLAUDE_CODE_REMOTE_MCP_CONFIG',
  // A desktop-host handoff: a plugin directory the CLI loads.
  'CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR',
  // Turns off the Windows sandbox check that Claude Code's own files stay
  // protected.
  'CLAUDE_CODE_SANDBOX_LEAVE_DENIES_TO_SRT_WIN',
  // A worker socket of the cloud runner: a route.
  'CLAUDE_CODE_CCR_WORKER_SOCKET',
  // CLI 2.1.310 (static reading): turns off the Bash check that asks before
  // a dangerous `rm` on a mounted drive, so fewer tool calls reach
  // `onPermission`.
  'CLAUDE_CODE_DISABLE_MOUNTED_DRIVE_RM_PROMPT',
  // Skips the workspace trust check of `claude ultrareview` (a subcommand
  // hudhud never runs; the rule keeps it explicit).
  'CLAUDE_CODE_DISABLE_ULTRAREVIEW_TRUST_CHECK',
]);
const NEVER_INHERITED_PREFIX = 'CLAUDE_AGENT_SDK_';

/** The name as the OS compares it. */
function fold(name: string, platform: ProcessPlatform): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

/** Parent variables that no preset passes on (ADR-0012 §4). */
export function isNeverInherited(name: string, platform: ProcessPlatform): boolean {
  const key = fold(name, platform);
  return NEVER_INHERITED.has(key) || key.startsWith(NEVER_INHERITED_PREFIX);
}

const COMMON_EXACT = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
];
const COMMON_PREFIXES = ['CLAUDE_', 'ANTHROPIC_'];

const POSIX_EXACT = new Set([
  ...COMMON_EXACT,
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
]);
const POSIX_PREFIXES = [...COMMON_PREFIXES, 'LC_', 'XDG_'];

// libuv adds each of WIN32_REQUIRED_ENV_NAMES (`@hudhudjs/core/process`) to a
// win32 child from the parent's own environment whenever the environment
// passed to spawn lacks it. The `'harness'` preset passes all of them
// explicitly (OS essentials the CLI and its tools need); when a form leaves
// one out (an explicit map, a `remove`), the spawn layer (`childEnv`) passes
// it as an empty string, so nothing reaches the child from the parent, and
// buildChildEnv reports it in `spawnInjected`. One list for both layers
// (lead ruling H).
const WIN32_EXACT = new Set(
  [
    ...COMMON_EXACT,
    ...WIN32_REQUIRED_ENV_NAMES,
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'SYSTEMDRIVE',
    'PATH',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    // PowerShell's module search path and its analysis cache file: paths,
    // not credentials, so the CLI's PowerShell tools see the modules the user
    // installed outside the default directories (review R2-6, ADR-0012 §4).
    'PSMODULEPATH',
    'PSMODULEANALYSISCACHEPATH',
  ].map((name) => name.toUpperCase()),
);
const WIN32_PREFIXES = [...COMMON_PREFIXES, 'PROGRAMFILES'];

/**
 * Provider families, passed on only when the provider switch is on in the
 * child environment (ADR-0012 §4). Each family holds the companion variables
 * the pinned CLI (2.1.296, static strings) reads for that provider beyond
 * `ANTHROPIC_*` (which `'harness'` passes anyway): Bedrock the AWS SDK's
 * `AWS_*`; Vertex the Google auth library's `GOOGLE_*` and `GCLOUD_*`
 * (`GCLOUD_PROJECT` next to `GOOGLE_CLOUD_PROJECT` in the project lookup),
 * `CLOUD_ML_*` (`CLOUD_ML_REGION`) and the CLI's own `VERTEX_*`
 * (`VERTEX_REGION_CLAUDE_*` per-model regions, `VERTEX_AUTH_HOSTS`,
 * `VERTEX_OAUTH_CREDENTIAL_KIND`); Foundry the Azure identity library's
 * `AZURE_*`. These are the user's own parent environment, not repository
 * input (review FX-A follow-up, lead ruling on Q3).
 *
 * The three further switches of 2.1.296 map the same way, from their client
 * construction code: Claude Platform on AWS (`CLAUDE_CODE_USE_ANTHROPIC_AWS`,
 * the `AnthropicAws` client: the AWS credential chain, `AWS_REGION` /
 * `AWS_DEFAULT_REGION`, a profile from `~/.aws/config`) and Bedrock Mantle
 * (`CLAUDE_CODE_USE_MANTLE`, the `AnthropicBedrockMantle` client:
 * `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_BEARER_TOKEN_BEDROCK` and the
 * same credential chain) read `AWS_*`; the CLI itself groups both with
 * Bedrock as its AWS providers. Claude Platform on Google Cloud
 * (`CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`, the `AnthropicGoogleCloud`
 * client) reads `GCLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT` and Google auth's
 * `GOOGLE_*`, not `CLOUD_ML_*` or `VERTEX_*`. Both Google providers also read
 * the lower-case `gcloud_project` and `google_cloud_project` (exact names).
 */
const PROVIDER_FAMILIES: readonly {
  readonly flag: string;
  readonly prefixes: readonly string[];
  /** Exact names, compared as the OS compares names. */
  readonly names: readonly string[];
}[] = [
  { flag: 'CLAUDE_CODE_USE_BEDROCK', prefixes: ['AWS_'], names: [] },
  { flag: 'CLAUDE_CODE_USE_ANTHROPIC_AWS', prefixes: ['AWS_'], names: [] },
  { flag: 'CLAUDE_CODE_USE_MANTLE', prefixes: ['AWS_'], names: [] },
  {
    flag: 'CLAUDE_CODE_USE_VERTEX',
    prefixes: ['GOOGLE_', 'GCLOUD_', 'CLOUD_ML_', 'VERTEX_'],
    names: ['gcloud_project', 'google_cloud_project'],
  },
  {
    flag: 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    prefixes: ['GOOGLE_', 'GCLOUD_'],
    names: ['gcloud_project', 'google_cloud_project'],
  },
  { flag: 'CLAUDE_CODE_USE_FOUNDRY', prefixes: ['AZURE_'], names: [] },
];

/** The provider variables the switches that are on let through. */
export interface ActiveProviders {
  readonly prefixes: readonly string[];
  readonly names: readonly string[];
}

const NO_PROVIDERS: ActiveProviders = { prefixes: [], names: [] };

/** The CLI's reading of a boolean switch. */
function isTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Whether the `'harness'` preset passes the parent variable `name` on: OS
 * essentials, `CLAUDE_*`, `ANTHROPIC_*`, proxy and CA variables, and the
 * provider families whose switch is on (`active`).
 */
export function isHarnessAllowed(
  name: string,
  platform: ProcessPlatform,
  active: ActiveProviders = NO_PROVIDERS,
): boolean {
  if (isNeverInherited(name, platform)) return false;
  const key = fold(name, platform);
  const exact = platform === 'win32' ? WIN32_EXACT : POSIX_EXACT;
  const prefixes = platform === 'win32' ? WIN32_PREFIXES : POSIX_PREFIXES;
  return (
    exact.has(key) ||
    prefixes.some((prefix) => key.startsWith(prefix)) ||
    active.prefixes.some((prefix) => key.startsWith(fold(prefix, platform))) ||
    active.names.some((known) => key === fold(known, platform))
  );
}

const ROUTING_EXACT = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_OPTIONS',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CONFIG_DIR',
]);
const ROUTING_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_CODE_USE_',
  'CLAUDE_AGENT_SDK_',
  'AWS_',
  'GOOGLE_',
  'CLOUD_ML_',
  'AZURE_',
];

/**
 * Whether a variable an application names explicitly (`env.add` or an
 * explicit map) is listed in `securityPosture` (K19): credentials, API
 * routing (`ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, provider families, proxies,
 * CA and TLS settings), runtime injection (`NODE_OPTIONS`) and nesting
 * markers, every never-inherited name ({@link isNeverInherited}: what loads
 * code or configuration, re-routes traffic or weakens a protection), every
 * name the redaction treats as a secret, and every name the project
 * credential guard refuses ({@link isProjectCredentialEnvName}), so the
 * lists cannot drift apart. Any case.
 */
export function isCredentialOrRoutingEnvName(name: string): boolean {
  const key = name.toUpperCase();
  return (
    ROUTING_EXACT.has(key) ||
    ROUTING_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    isNeverInherited(key, 'win32') ||
    isCredentialEnvName(name) ||
    isProjectCredentialEnvName(name)
  );
}

/** The environment of the child, with what changed relative to the parent. */
export interface ChildEnv {
  /** Exactly the variables the child receives. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Parent variables absent from `env` (`env.dropped`): the preset or hudhud
   * removed them and neither `env.add` nor a pin set them again. Never a
   * name `env` holds, in any case on win32.
   */
  readonly dropped: readonly string[];
  /** Names from `env.add` (`env.added`). */
  readonly added: readonly string[];
  /** Names from `env.remove` (`env.removed`). */
  readonly removed: readonly string[];
  /**
   * win32 only: names of `WIN32_REQUIRED_ENV_NAMES` missing from `env`.
   * libuv would copy them from the parent; the spawn layer (`childEnv` of
   * `@hudhudjs/core/process`) passes each as an empty string instead, so the
   * child's environment is `env` plus these names blank, whatever the
   * parent holds. A missing `SYSTEMROOT` is refused by the spawn layer.
   */
  readonly spawnInjected: readonly string[];
}

/** A name-keyed table that compares names as the OS does. */
class EnvTable {
  readonly #entries = new Map<string, { readonly name: string; readonly value: string }>();
  readonly #platform: ProcessPlatform;

  constructor(platform: ProcessPlatform) {
    this.#platform = platform;
  }

  /** The stored spelling of `name`, if present. */
  spelling(name: string): string | undefined {
    return this.#entries.get(fold(name, this.#platform))?.name;
  }

  set(name: string, value: string): void {
    this.#entries.set(fold(name, this.#platform), { name, value });
  }

  delete(name: string): boolean {
    return this.#entries.delete(fold(name, this.#platform));
  }

  toObject(): Readonly<Record<string, string>> {
    // Names are distinct, so the order is total.
    const entries = [...this.#entries.values()].sort((x, y) => (x.name < y.name ? -1 : 1));
    return Object.fromEntries(entries.map(({ name, value }) => [name, value]));
  }
}

/** Refuses two names that the OS would treat as one variable. */
function checkDistinct(names: readonly string[], path: string, platform: ProcessPlatform): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const other = seen.get(fold(name, platform));
    if (other !== undefined) {
      throw new InvalidOptionsError(
        `options.${path} names ${JSON.stringify(other)} and ${JSON.stringify(name)}, which are the same variable on ${platform}`,
        { details: { path, rule: 'env-duplicate', names: [other, name] } },
      );
    }
    seen.set(fold(name, platform), name);
  }
}

const sorted = (names: Iterable<string>): string[] => [...new Set(names)].sort();

/**
 * Builds the child environment from the effective options and the parent
 * environment. Pure: the parent is passed in.
 *
 * @throws `InvalidOptionsError` rule `env-duplicate` on win32 when option
 *   names differ only in case
 */
export function buildChildEnv(
  session: Pick<
    EffectiveSessionOptions,
    'env' | 'autoUpdate' | 'nonessentialTraffic' | 'trace' | 'claudeCode'
  >,
  connect: Pick<EffectiveConnectOptions, 'configDir'>,
  parent: EnvMap,
  platform: ProcessPlatform,
): ChildEnv {
  const table = new EnvTable(platform);
  const dropped: string[] = [];
  let added: string[] = [];
  let removed: string[] = [];
  const { env } = session;

  if (env.form === 'map') {
    checkDistinct(Object.keys(env.variables), 'env', platform);
    for (const [name, value] of Object.entries(env.variables)) table.set(name, value);
  } else {
    const addNames = Object.keys(env.add);
    checkDistinct(addNames, 'env.add', platform);
    checkDistinct(env.remove, 'env.remove', platform);
    const parentEntries = Object.entries(parent).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
    const providers = activeProviders(parentEntries, env.add, env.remove, platform);
    for (const [name, value] of parentEntries) {
      const passes =
        env.preset === 'inherit'
          ? !isNeverInherited(name, platform)
          : isHarnessAllowed(name, platform, providers);
      if (passes) table.set(name, value);
      else dropped.push(name);
    }
    for (const name of env.remove) table.delete(name);
    for (const [name, value] of Object.entries(env.add)) {
      table.delete(name);
      table.set(name, value);
    }
    added = addNames;
    removed = [...env.remove];
  }

  const drop = (name: string): void => {
    const spelling = table.spelling(name);
    if (spelling !== undefined) {
      table.delete(name);
      dropped.push(spelling);
    }
  };
  const pin = (name: string, value: string): void => {
    table.delete(name);
    table.set(name, value);
  };

  drop('CLAUDE_CODE_SDK_READS_SESSION_STATE');
  drop('CLAUDE_CODE_SDK_READS_STARTUP_MARKS');
  pin('CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS', '1');
  pin('CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', String(session.claudeCode.backgroundWaitCeilingMs));
  if (session.autoUpdate === 'disabled') pin('DISABLE_AUTOUPDATER', '1');
  if (session.nonessentialTraffic === 'disabled') {
    pin('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
  }
  if (connect.configDir !== null) pin('CLAUDE_CONFIG_DIR', connect.configDir);
  if (session.trace === null) {
    drop('TRACEPARENT');
    drop('TRACESTATE');
  } else {
    pin('TRACEPARENT', session.trace.traceparent);
    if (session.trace.tracestate === null) drop('TRACESTATE');
    else pin('TRACESTATE', session.trace.tracestate);
  }

  return {
    env: table.toObject(),
    // A name set again after it was dropped (a pin such as
    // DISABLE_AUTOUPDATER, or env.add) reaches the child: not dropped.
    dropped: sorted(dropped.filter((name) => table.spelling(name) === undefined)),
    added: sorted(added),
    removed: sorted(removed),
    spawnInjected:
      platform === 'win32'
        ? sorted(WIN32_REQUIRED_ENV_NAMES.filter((name) => table.spelling(name) === undefined))
        : [],
  };
}

/** The provider variables of the families whose switch is on in the child environment. */
function activeProviders(
  parentEntries: readonly (readonly [string, string])[],
  add: Readonly<Record<string, string>>,
  remove: readonly string[],
  platform: ProcessPlatform,
): ActiveProviders {
  const lookup = (flag: string): string | undefined => {
    for (const [name, value] of Object.entries(add)) {
      if (fold(name, platform) === flag) return value;
    }
    if (remove.some((name) => fold(name, platform) === flag)) return undefined;
    return parentEntries.find(([name]) => fold(name, platform) === flag)?.[1];
  };
  const on = PROVIDER_FAMILIES.filter((family) => isTruthy(lookup(family.flag)));
  return {
    prefixes: on.flatMap((family) => family.prefixes),
    names: on.flatMap((family) => family.names),
  };
}

/**
 * Checks `/raw` `extraEnv` (plan §2.6): it may not name pinned variables.
 *
 * @throws `InvalidOptionsError` rule `env-pinned`
 */
export function checkExtraEnv(extraEnv: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(extraEnv)) {
    if (envNameIsPinned(name)) {
      throw new InvalidOptionsError(
        `raw.extraEnv names ${JSON.stringify(name)}, which hudhud sets itself`,
        { details: { path: 'raw.extraEnv', rule: 'env-pinned', name } },
      );
    }
  }
}
