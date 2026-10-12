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
 *    `CLAUDE_AGENT_SDK_*`): they would change how the CLI runs or make it
 *    believe it is nested, and an application that wants one adds it.
 * 2. Object form: `remove` names are deleted, then `add` entries are set.
 * 3. hudhud's pinned variables override in every form:
 *    `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`,
 *    `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `DISABLE_AUTOUPDATER=1` and
 *    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (unless the option is
 *    `'harness-default'`), `CLAUDE_CONFIG_DIR` (only with `configDir`),
 *    `TRACEPARENT`/`TRACESTATE` (only with `trace`). Always removed:
 *    `CLAUDE_CODE_SDK_READS_SESSION_STATE` (D11), and `TRACEPARENT`/
 *    `TRACESTATE` unless `trace` is set. hudhud never sets
 *    `CLAUDE_CODE_ENTRYPOINT` (ADR-0001 §4).
 *
 * On win32 names are case-insensitive, as the OS treats them: matching,
 * removal and overrides ignore case, and two option names that differ only
 * in case are refused. Dropped, added and removed variables are reported by
 * name, never by value. On win32 libuv would add some parent variables to
 * every child env that lacks them; the spawn layer blanks them instead (see
 * `spawnInjected`).
 */

import { InvalidOptionsError, isCredentialEnvName, type EnvMap } from '@hudhud/core';
import { WIN32_REQUIRED_ENV_NAMES, type ProcessPlatform } from '@hudhud/core/process';

import type { EffectiveConnectOptions, EffectiveSessionOptions } from './options-types.js';

/**
 * Variables hudhud sets or removes itself. Options can neither add nor
 * remove them (compared case-insensitively); each has its own option.
 * `CLAUDE_CODE_SDK_READS_SESSION_STATE` is always removed, so adding it
 * would be ignored silently: it is refused as well.
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
];

const PINNED = new Set(PINNED_ENV_NAMES);

/** Whether an option may not name `name` in `env` (any case, every OS). */
export function envNameIsPinned(name: string): boolean {
  return PINNED.has(name.toUpperCase());
}

const NEVER_INHERITED = new Set([
  'NODE_OPTIONS',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
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

// libuv adds each of WIN32_REQUIRED_ENV_NAMES (`@hudhud/core/process`) to a
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
  ].map((name) => name.toUpperCase()),
);
const WIN32_PREFIXES = [...COMMON_PREFIXES, 'PROGRAMFILES'];

/**
 * Provider families, passed on only when the provider switch is on in the
 * child environment (ADR-0012 §4).
 */
const PROVIDER_FAMILIES: readonly {
  readonly flag: string;
  readonly prefixes: readonly string[];
}[] = [
  { flag: 'CLAUDE_CODE_USE_BEDROCK', prefixes: ['AWS_'] },
  { flag: 'CLAUDE_CODE_USE_VERTEX', prefixes: ['GOOGLE_', 'CLOUD_ML_'] },
  { flag: 'CLAUDE_CODE_USE_FOUNDRY', prefixes: ['AZURE_'] },
];

/** The CLI's reading of a boolean switch. */
function isTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Whether the `'harness'` preset passes the parent variable `name` on: OS
 * essentials, `CLAUDE_*`, `ANTHROPIC_*`, proxy and CA variables, and the
 * provider families whose switch is on (`activeProviderPrefixes`).
 */
export function isHarnessAllowed(
  name: string,
  platform: ProcessPlatform,
  activeProviderPrefixes: readonly string[] = [],
): boolean {
  if (isNeverInherited(name, platform)) return false;
  const key = fold(name, platform);
  const exact = platform === 'win32' ? WIN32_EXACT : POSIX_EXACT;
  const prefixes = platform === 'win32' ? WIN32_PREFIXES : POSIX_PREFIXES;
  return (
    exact.has(key) ||
    prefixes.some((prefix) => key.startsWith(prefix)) ||
    activeProviderPrefixes.some((prefix) => key.startsWith(prefix))
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
 * markers, and every name the redaction treats as a secret. Any case.
 */
export function isCredentialOrRoutingEnvName(name: string): boolean {
  const key = name.toUpperCase();
  return (
    ROUTING_EXACT.has(key) ||
    ROUTING_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    isCredentialEnvName(name)
  );
}

/** The environment of the child, with what changed relative to the parent. */
export interface ChildEnv {
  /** Exactly the variables the child receives. */
  readonly env: Readonly<Record<string, string>>;
  /** Parent variables the preset or hudhud did not pass on (`env.dropped`). */
  readonly dropped: readonly string[];
  /** Names from `env.add` (`env.added`). */
  readonly added: readonly string[];
  /** Names from `env.remove` (`env.removed`). */
  readonly removed: readonly string[];
  /**
   * win32 only: names of `WIN32_REQUIRED_ENV_NAMES` missing from `env`.
   * libuv would copy them from the parent; the spawn layer (`childEnv` of
   * `@hudhud/core/process`) passes each as an empty string instead, so the
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
    dropped: sorted(dropped),
    added: sorted(added),
    removed: sorted(removed),
    spawnInjected:
      platform === 'win32'
        ? sorted(WIN32_REQUIRED_ENV_NAMES.filter((name) => table.spelling(name) === undefined))
        : [],
  };
}

/** Prefixes of the provider families whose switch is on in the child environment. */
function activeProviders(
  parentEntries: readonly (readonly [string, string])[],
  add: Readonly<Record<string, string>>,
  remove: readonly string[],
  platform: ProcessPlatform,
): string[] {
  const lookup = (flag: string): string | undefined => {
    for (const [name, value] of Object.entries(add)) {
      if (fold(name, platform) === flag) return value;
    }
    if (remove.some((name) => fold(name, platform) === flag)) return undefined;
    return parentEntries.find(([name]) => fold(name, platform) === flag)?.[1];
  };
  return PROVIDER_FAMILIES.filter((family) => isTruthy(lookup(family.flag))).flatMap(
    (family) => family.prefixes,
  );
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
