/**
 * The Claude Code security posture entries (plan §1.9, §2.4; ADR-0012 §5,
 * §7; K19, K23).
 *
 * @remarks
 * {@link claudePostureEntries} lists every security-relevant setting of
 * plan §2.4: the `posture` fields of the effective connect and session
 * options (resolved in `options.ts`), `managedPolicy`, and the names of the
 * `/raw` spawn extras. The neutral `buildPosture` of `@hudhud/core` turns
 * them into the `SecurityPosture`, computing `deviates` by deep JSON
 * equality, so no weakened default is silent.
 *
 * `managedPolicy` (K23): any custom `ANTHROPIC_BASE_URL` makes the CLI skip
 * the fetch of organization-managed policy, and a third-party provider
 * (`CLAUDE_CODE_USE_*`) makes it inapplicable (07 §3). A base URL can come
 * from the child environment, from the options that name variables, or from
 * the `env` of the user settings file, which the CLI always loads. That file
 * is read here, read-only, by {@link scanUserSettingsEnv}: only booleans
 * leave the parser, no value is logged, stored or returned, and the file is
 * never written (R6). Errors carry no path and no content.
 *
 * Values in the entries are kinds and names, never environment values,
 * argument values or paths.
 */

import { open } from 'node:fs/promises';
import path from 'node:path';

import type { EnvMap } from '@hudhud/core';
import type { ProcessPlatform } from '@hudhud/core/process';
import { ownObject, parseJsonLine } from '@hudhud/core/protocol';

import type {
  EffectiveConnectOptions,
  EffectiveSessionOptions,
  PostureField,
} from './options-types.js';

// ---- managed policy -------------------------------------------------------------

/**
 * Whether the CLI fetches organization-managed policy (ADR-0012 §5).
 *
 * - `'fetched-if-eligible'`: no custom base URL and no third-party provider
 *   seen; the CLI fetches it when the account is eligible.
 * - `'not-fetched-custom-base-url'`: `ANTHROPIC_BASE_URL` is set.
 * - `'not-applicable-third-party-provider'`: a `CLAUDE_CODE_USE_*` switch is on.
 * - `'unknown-raw-settings'`: the `/raw` `extraArgs` pass `--settings`, whose
 *   content hudhud does not read, so a base URL in it cannot be ruled out.
 * - `'unknown-project-settings-unreadable'`: under `projectCredentialEnv:
 *   'allow'` a project or local settings file the CLI may apply could not be
 *   read or parsed by the guard's scan, so a base URL in it cannot be ruled
 *   out (lead review of W5-T1, Q6: fail safe, never `'fetched-if-eligible'`).
 * - `'unknown-user-settings-unreadable'`: the user settings file exists but
 *   could not be read or parsed, so a base URL in it cannot be ruled out.
 *
 * Precedence: a known custom base URL, then a known third-party provider
 * (both decide the fetch whatever else is configured), then the unknowns:
 * raw `--settings` (a file the application handed the CLI past hudhud),
 * then unreadable project settings (repository content, the redirection
 * vector of C3, so the more security-relevant unknown), then the unreadable
 * user settings file (the user's own configuration).
 * The user settings file is `<config dir>/settings.json` only: that is the
 * one user-scope file whose `env` the CLI applies (plan §1.9, 08).
 */
export type ManagedPolicy =
  | 'fetched-if-eligible'
  | 'not-fetched-custom-base-url'
  | 'not-applicable-third-party-provider'
  | 'unknown-raw-settings'
  | 'unknown-project-settings-unreadable'
  | 'unknown-user-settings-unreadable';

/** Default of the `managedPolicy` entry. */
export const MANAGED_POLICY_DEFAULT: ManagedPolicy = 'fetched-if-eligible';

/**
 * What the parse of the user settings file found. Booleans only: no name
 * beyond the fixed ones, no value and no path leaves the parser (K23).
 */
export interface UserSettingsEnvScan {
  /** The file exists. */
  readonly present: boolean;
  /** The file was read and parsed as a JSON object (`true` when absent). */
  readonly readable: boolean;
  /** Its `env` sets `ANTHROPIC_BASE_URL` to a non-blank value. */
  readonly customBaseUrl: boolean;
  /** Its `env` turns a `CLAUDE_CODE_USE_*` switch on. */
  readonly thirdPartyProvider: boolean;
}

const ABSENT: UserSettingsEnvScan = Object.freeze({
  present: false,
  readable: true,
  customBaseUrl: false,
  thirdPartyProvider: false,
});

const UNREADABLE: UserSettingsEnvScan = Object.freeze({
  present: true,
  readable: false,
  customBaseUrl: false,
  thirdPartyProvider: false,
});

const BASE_URL = 'ANTHROPIC_BASE_URL';
const PROVIDER_PREFIX = 'CLAUDE_CODE_USE_';

/** The name as the OS compares it (win32 names are case-insensitive). */
function fold(name: string, platform: ProcessPlatform): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

/**
 * A settings `env` value as the CLI would put it into its environment:
 * strings as they are, numbers and booleans as text, anything else unset.
 */
function settingValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** The CLI's reading of a boolean switch. */
function isTruthy(value: string): boolean {
  return /^(1|true|yes|on)$/i.test(value.trim());
}

interface EnvFlags {
  readonly customBaseUrl: boolean;
  readonly thirdPartyProvider: boolean;
}

/** The two flags of a list of variables; the values never leave this function. */
function envFlags(
  entries: Iterable<readonly [string, unknown]>,
  platform: ProcessPlatform,
): EnvFlags {
  let customBaseUrl = false;
  let thirdPartyProvider = false;
  for (const [name, raw] of entries) {
    const value = settingValue(raw);
    if (value === undefined) continue;
    const key = fold(name, platform);
    if (key === BASE_URL && value.trim() !== '') customBaseUrl = true;
    if (key.startsWith(PROVIDER_PREFIX) && isTruthy(value)) thirdPartyProvider = true;
  }
  return { customBaseUrl, thirdPartyProvider };
}

/**
 * What the project credential guard found in the project and local settings
 * when `projectCredentialEnv: 'allow'` let the session run with them (W3-Z
 * ruling 3). Booleans only; built by {@link projectSettingsFlagsOf} from the
 * variable names of the guard's findings.
 */
export interface ProjectSettingsEnvFlags {
  /** A scanned project or local settings file sets `ANTHROPIC_BASE_URL`. */
  readonly customBaseUrl: boolean;
  /** A scanned project or local settings file names a `CLAUDE_CODE_USE_*` switch. */
  readonly thirdPartyProvider: boolean;
  /** Every scanned file could be read and parsed (none is unparseable). */
  readonly readable: boolean;
}

/**
 * The managed-policy flags of the variable names the guard found in project
 * and local settings. Names only (the guard never keeps values), compared
 * case-insensitively; a named provider switch counts as on (its value is not
 * known), which can only make the posture more cautious. `unreadable`: the
 * scan found a file it could not evaluate.
 */
export function projectSettingsFlagsOf(
  names: readonly string[],
  unreadable = false,
): ProjectSettingsEnvFlags {
  const upper = names.map((name) => name.toUpperCase());
  return Object.freeze({
    customBaseUrl: upper.includes(BASE_URL),
    thirdPartyProvider: upper.some((name) => name.startsWith(PROVIDER_PREFIX)),
    readable: !unreadable,
  });
}

/** Input of {@link managedPolicyOf}. */
export interface ManagedPolicyInput {
  /** The environment the CLI runs with (see {@link ClaudePostureInput.env}). */
  readonly env: EnvMap;
  /** Variables the options name explicitly (env map, `env.add`, `/raw` `extraEnv`). */
  readonly named: readonly Readonly<Record<string, string>>[];
  readonly userSettings: UserSettingsEnvScan;
  /** Guard findings in project and local settings under `'allow'`; absent when none apply. */
  readonly projectSettings?: ProjectSettingsEnvFlags;
  /** The `/raw` `extraArgs` pass `--settings` (content not read by hudhud). */
  readonly rawSettings?: boolean;
  readonly platform: ProcessPlatform;
}

/**
 * The managed-policy state (K23). A custom base URL from any source wins,
 * then a third-party provider, then raw `--settings`, then unreadable
 * project settings, then an unreadable user settings file (see
 * {@link ManagedPolicy} for the order's reasons).
 */
export function managedPolicyOf(input: ManagedPolicyInput): ManagedPolicy {
  const sources: EnvFlags[] = [
    envFlags(Object.entries(input.env), input.platform),
    ...input.named.map((variables) => envFlags(Object.entries(variables), input.platform)),
    input.userSettings,
    ...(input.projectSettings === undefined ? [] : [input.projectSettings]),
  ];
  if (sources.some((flags) => flags.customBaseUrl)) return 'not-fetched-custom-base-url';
  if (sources.some((flags) => flags.thirdPartyProvider)) {
    return 'not-applicable-third-party-provider';
  }
  if (input.rawSettings === true) return 'unknown-raw-settings';
  if (input.projectSettings?.readable === false) return 'unknown-project-settings-unreadable';
  if (!input.userSettings.readable) return 'unknown-user-settings-unreadable';
  return 'fetched-if-eligible';
}

// ---- the user settings file (K23) ------------------------------------------------

/** Largest user settings file parsed; a larger one counts as unreadable. */
export const USER_SETTINGS_MAX_BYTES = 2_097_152;

/**
 * Read-only access to one file, injected so that tests never touch a real
 * user config.
 */
export interface SettingsFileReader {
  /**
   * The first `limit` bytes of the file at `filePath` (fewer when the file is
   * shorter), or `'absent'` when it does not exist. Never writes, never
   * creates. Rejects on any other failure.
   */
  readPrefix(filePath: string, limit: number): Promise<Uint8Array | 'absent'>;
}

/** The `code` of a Node.js system error; `undefined` for anything else. */
function errorCode(error: unknown): unknown {
  return Reflect.get(Object(error), 'code');
}

/** {@link SettingsFileReader} on the real file system: opens read-only (`'r'`). */
export const nodeSettingsFileReader: SettingsFileReader = {
  async readPrefix(filePath, limit) {
    let handle;
    try {
      handle = await open(filePath, 'r');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
      throw error;
    }
    try {
      const buffer = new Uint8Array(limit);
      let total = 0;
      while (total < limit) {
        const { bytesRead } = await handle.read(buffer, total, limit - total, null);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      return buffer.subarray(0, total);
    } finally {
      await handle.close();
    }
  },
};

/**
 * The user's Claude Code config directory as the CLI resolves it: the
 * `configDir` option, else a non-empty `CLAUDE_CONFIG_DIR` in the CLI's
 * environment, else `<home>/.claude` (plan §1.9).
 */
export function userConfigDir(input: {
  readonly configDir: string | null;
  readonly env: EnvMap;
  readonly homedir: string;
  readonly platform: ProcessPlatform;
}): string {
  if (input.configDir !== null) return input.configDir;
  for (const [name, value] of Object.entries(input.env)) {
    if (fold(name, input.platform) === 'CLAUDE_CONFIG_DIR' && value !== undefined && value !== '') {
      return value;
    }
  }
  return (input.platform === 'win32' ? path.win32 : path.posix).join(input.homedir, '.claude');
}

/** Dependencies of {@link scanUserSettingsEnv}. */
export interface UserSettingsScanDeps {
  /** Resolves the user's config directory (see {@link userConfigDir}). */
  readonly configDir: () => string;
  readonly reader: SettingsFileReader;
  readonly platform: ProcessPlatform;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Parses `<config dir>/settings.json` read-only for the posture-relevant
 * `env` keys (K23): `ANTHROPIC_BASE_URL` and the `CLAUDE_CODE_USE_*`
 * switches. Never throws; returns booleans only.
 *
 * @remarks
 * A missing file is `present: false`. A file that cannot be read, is larger
 * than {@link USER_SETTINGS_MAX_BYTES}, is not UTF-8, or is not a JSON
 * object is `readable: false`. An `env` that is not an object contributes
 * nothing.
 */
export async function scanUserSettingsEnv(
  deps: UserSettingsScanDeps,
): Promise<UserSettingsEnvScan> {
  let bytes: Uint8Array | 'absent';
  try {
    const file = (deps.platform === 'win32' ? path.win32 : path.posix).join(
      deps.configDir(),
      'settings.json',
    );
    bytes = await deps.reader.readPrefix(file, USER_SETTINGS_MAX_BYTES + 1);
  } catch {
    return UNREADABLE;
  }
  if (bytes === 'absent') return ABSENT;
  if (bytes.length > USER_SETTINGS_MAX_BYTES) return UNREADABLE;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return UNREADABLE;
  }
  const parsed = parseJsonLine(text);
  if (!parsed.ok) return UNREADABLE;
  const env = ownObject(parsed.value, 'env') ?? {};
  const flags = envFlags(Object.entries(env), deps.platform);
  return Object.freeze({
    present: true,
    readable: true,
    customBaseUrl: flags.customBaseUrl,
    thirdPartyProvider: flags.thirdPartyProvider,
  });
}

// ---- the entries -------------------------------------------------------------------

/** The `/raw` spawn extras of a session (plan §2.6). */
export interface RawPostureInput {
  readonly extraArgs?: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/** Input of {@link claudePostureEntries}. */
export interface ClaudePostureInput {
  readonly connect: EffectiveConnectOptions;
  /** Absent for the posture of the Harness at connect. */
  readonly session?: EffectiveSessionOptions;
  /**
   * The environment the CLI runs with: the session's child environment, or,
   * at connect, the parent environment (the default `'harness'` preset
   * passes every `ANTHROPIC_*` and `CLAUDE_*` variable on). Only scanned for
   * the managed-policy flags; no value is kept.
   */
  readonly env: EnvMap;
  /** From {@link scanUserSettingsEnv}. */
  readonly userSettings: UserSettingsEnvScan;
  /**
   * From {@link projectSettingsFlagsOf} over the guard's findings when the
   * session runs with `projectCredentialEnv: 'allow'` (wired by the adapter
   * assembly); absent otherwise.
   */
  readonly projectSettings?: ProjectSettingsEnvFlags;
  readonly raw?: RawPostureInput;
  readonly platform: ProcessPlatform;
}

const sortedNames = (names: Iterable<string>): string[] => [...new Set(names)].sort();

/** Flag names of `extraArgs`: the part before any `=`; non-flag entries are values and omitted. */
function flagNames(args: readonly string[]): string[] {
  return sortedNames(
    args.filter((arg) => arg.startsWith('-')).map((arg) => arg.replace(/=.*$/su, '')),
  );
}

/** Variables an option names explicitly, with their values (kept internal). */
function namedVariables(input: ClaudePostureInput): Readonly<Record<string, string>>[] {
  const named: Readonly<Record<string, string>>[] = [];
  const env = input.session?.env;
  if (env !== undefined) named.push(env.form === 'map' ? env.variables : env.add);
  if (input.raw?.extraEnv !== undefined) named.push(input.raw.extraEnv);
  return named;
}

/**
 * Every security-relevant setting of the Harness (without `session`) or of
 * a session, as inputs of the neutral `buildPosture` (plan §2.4).
 *
 * @remarks
 * Order: connect options, session options, `managedPolicy`, `raw.extraArgs`,
 * `raw.extraEnv`. Values are kinds and names only.
 */
export function claudePostureEntries(input: ClaudePostureInput): readonly PostureField[] {
  const managedPolicy = managedPolicyOf({
    env: input.env,
    named: namedVariables(input),
    userSettings: input.userSettings,
    ...(input.projectSettings === undefined ? {} : { projectSettings: input.projectSettings }),
    rawSettings: flagNames(input.raw?.extraArgs ?? []).includes('--settings'),
    platform: input.platform,
  });
  return [
    ...input.connect.posture,
    ...(input.session?.posture ?? []),
    { setting: 'managedPolicy', value: managedPolicy, defaultValue: MANAGED_POLICY_DEFAULT },
    {
      setting: 'raw.extraArgs',
      value: flagNames(input.raw?.extraArgs ?? []),
      defaultValue: [],
    },
    {
      setting: 'raw.extraEnv',
      value: sortedNames(Object.keys(input.raw?.extraEnv ?? {})),
      defaultValue: [],
    },
  ];
}
