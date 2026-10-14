/**
 * Options of the Claude Code adapter: strict validation, cross-field rules
 * and default resolution into JSON `EffectiveOptions` (plan §2.3, §2.4;
 * ADR-0003, ADR-0005 §7, ADR-0012). The types live in `options-types.ts`
 * and are re-exported here.
 *
 * @remarks
 * Validation runs in three steps and stops at the first problem:
 *
 * 1. Host values are taken out and type-checked: `signal`, `onPermission`,
 *    `events.signal`. The rest is copied into plain JSON; anything that is
 *    not JSON (functions, class instances, non-finite numbers, cycles) is
 *    refused, and so is every string with a NUL or a lone UTF-16 surrogate
 *    (no option string can be valid with either: they end in argv, the
 *    environment or a path). A property whose value is `undefined` counts as
 *    absent.
 * 2. The copy is checked by the validator generated from
 *    `schemas/options.schema.json` (unknown keys are refused at every level).
 * 3. Cross-field rules (plan §2.3).
 *
 * Every failure is an `InvalidOptionsError` with `details.path` and
 * `details.rule`, except `workspaceTrust: 'context'` and
 * `backend: 'agent-sdk'`, which are `CapabilityUnsupportedError`.
 *
 * The effective options are plain JSON and carry the `posture` fields of
 * every security-relevant setting (plan §2.4), so no non-default security
 * setting can be dropped on its way to `securityPosture`.
 */

import {
  CapabilityUnsupportedError,
  InvalidOptionsError,
  type JsonObject,
  type JsonValue,
} from '@hudhud/core';

import { envNameIsPinned, isCredentialOrRoutingEnvName } from './env.js';
import {
  validateConnectOptions,
  validateConnectSessionOptions,
  validateResumeOptions,
  validateSessionOptions,
  type SchemaCheck,
} from './generated/validators.gen.js';
import type {
  ConnectOptionsData,
  EffectiveConnectOptions,
  EffectiveEnv,
  EffectiveSessionOptions,
  EnvOption,
  PermissionCallback,
  PostureField,
  SessionHostValues,
  SessionOptionsData,
  SettingSource,
  WorkspaceTrust,
} from './options-types.js';
import { ruleProblem, ruleProblemText } from './rules.js';

export type {
  ClaudeCodeConnectOptions,
  ClaudeCodeSessionOptions,
  ConnectOptions,
  ConnectOptionsData,
  ConnectSessionOptionsData,
  EffectiveConnectOptions,
  EffectiveEnv,
  EffectiveSessionOptions,
  EnvOption,
  PermissionCallback,
  PermissionMode,
  PostureField,
  ResumeOptions,
  ResumeOptionsData,
  SessionHostValues,
  SessionOptions,
  SessionOptionsData,
  SettingSource,
  SubscriberOptionsData,
  WorkspaceTrust,
} from './options-types.js';

/** Defaults of plan §2.4. */
export const OPTION_DEFAULTS = {
  binaryVerification: 'advisory',
  permissionMode: 'default',
  workspaceTrust: 'none',
  env: 'harness',
  autoUpdate: 'disabled',
  nonessentialTraffic: 'disabled',
  onAuthFailure: 'fail-fast',
  onOversizedFrame: 'fail',
  maxFrameBytes: 67_108_864,
  maxOutboundFrameBytes: 33_554_432,
  firstFrameTimeoutMs: 60_000,
  idleStallMs: 300_000,
  closeTimeoutMs: 30_000,
  interruptWaitMs: 1000,
  eofGraceMs: 2000,
  termGraceMs: 5000,
  taskkillGraceMs: 2000,
  backgroundWaitCeilingMs: 600_000,
  maxEvents: 10_000,
  maxBytes: 67_108_864,
  overflow: 'error',
} as const;

const SOURCES_BY_TRUST = {
  none: ['user'],
  full: ['user', 'project', 'local'],
} as const satisfies Record<'none' | 'full', readonly SettingSource[]>;

// ---- errors ----------------------------------------------------------------------

/** Rules named in `details.rule` of an `InvalidOptionsError`. */
export type OptionRule =
  | 'not-an-object'
  | 'not-json'
  | 'string'
  | 'host-value'
  | 'schema'
  | 'trust-and-sources'
  | 'bypass-permissions'
  | 'project-credential-env'
  | 'tool-rule'
  | 'env-pinned'
  | 'session-id';

function invalid(
  path: string,
  rule: OptionRule,
  message: string,
  extra: JsonObject = {},
): InvalidOptionsError {
  return new InvalidOptionsError(message, { details: { ...extra, path, rule } });
}

/** `a.b[2]` for display; the root is `options`. */
function display(path: string): string {
  return path === '' ? 'options' : `options.${path}`;
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${String(key)}]`;
  return path === '' ? key : `${path}.${key}`;
}

/** Converts an Ajv instance path (JSON Pointer) to the dotted form. */
export function pointerToPath(pointer: string): string {
  let path = '';
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    path = join(path, /^(0|[1-9][0-9]*)$/.test(token) ? Number(token) : token);
  }
  return path;
}

// ---- step 1: host values and the JSON copy ----------------------------------------

const MAX_DEPTH = 16;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A plain JSON copy; `undefined` properties are dropped. Refuses non-JSON
 * values and strings with NUL or lone surrogates.
 */
function toJson(value: unknown, path: string, depth: number): JsonValue {
  if (depth > MAX_DEPTH) {
    throw invalid(path, 'not-json', `${display(path)} is nested too deeply`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.includes('\0') || !value.isWellFormed()) {
      throw invalid(
        path,
        'string',
        `${display(path)} contains a NUL character or a lone UTF-16 surrogate`,
      );
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    const out: JsonValue[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (!Object.hasOwn(items, i) || items[i] === undefined) {
        throw invalid(join(path, i), 'not-json', `${display(join(path, i))} is undefined`);
      }
      out.push(toJson(items[i], join(path, i), depth + 1));
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out = new Map<string, JsonValue>();
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out.set(key, toJson(item, join(path, key), depth + 1));
    }
    return Object.fromEntries(out);
  }
  throw invalid(path, 'not-json', `${display(path)} is not a JSON value`);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

interface Extracted {
  readonly json: JsonObject;
  readonly host: SessionHostValues;
}

/** Splits the host values off and copies the rest into plain JSON. */
function extract(input: unknown): Extracted {
  if (input === undefined) return { json: {}, host: {} };
  if (!isPlainObject(input)) {
    throw invalid('', 'not-an-object', 'options must be a plain object');
  }
  const { signal, onPermission, events, ...rest } = input;
  let host: SessionHostValues = {};
  if (signal !== undefined) {
    if (!isAbortSignal(signal))
      throw invalid('signal', 'host-value', 'options.signal must be an AbortSignal');
    host = { ...host, signal };
  }
  if (onPermission !== undefined) {
    if (typeof onPermission !== 'function') {
      throw invalid('onPermission', 'host-value', 'options.onPermission must be a function');
    }
    host = { ...host, onPermission: onPermission as PermissionCallback };
  }
  let jsonInput: Readonly<Record<string, unknown>> = rest;
  if (isPlainObject(events)) {
    const { signal: eventsSignal, ...eventsRest } = events;
    if (eventsSignal !== undefined) {
      if (!isAbortSignal(eventsSignal)) {
        throw invalid(
          'events.signal',
          'host-value',
          'options.events.signal must be an AbortSignal',
        );
      }
      host = { ...host, eventsSignal };
    }
    jsonInput = { ...rest, events: eventsRest };
  } else if (events !== undefined) {
    jsonInput = { ...rest, events };
  }
  // A plain object input always converts to a JSON object.
  return { json: toJson(jsonInput, '', 0) as JsonObject, host };
}

// ---- step 2: the generated validator ----------------------------------------------

function checkSchema<T>(json: JsonObject, validate: (value: unknown) => SchemaCheck<T>): T {
  const result = validate(json);
  if (result.ok) return result.value;
  const { instancePath, schemaPath, keyword } = result.issue;
  const path = pointerToPath(instancePath);
  const what =
    keyword === 'additionalProperties'
      ? 'has an unknown key'
      : keyword === 'required'
        ? 'is missing a required key'
        : `fails the schema keyword "${keyword}"`;
  throw invalid(path, 'schema', `${display(path)} ${what} (see options.schema.json)`, {
    keyword,
    schemaPath,
  });
}

// ---- step 3: cross-field rules and defaults ----------------------------------------

function checkBackend(json: JsonObject): void {
  if (json['backend'] === 'agent-sdk') {
    throw new CapabilityUnsupportedError('backend "agent-sdk" is not supported in v1', {
      details: { path: 'backend', capability: 'backend.agent-sdk' },
    });
  }
}

function checkRules(list: readonly string[] | undefined, path: string): readonly string[] {
  const rules = list ?? [];
  rules.forEach((rule, index) => {
    const problem = ruleProblem(rule);
    if (problem !== undefined) {
      const at = join(path, index);
      throw invalid(at, 'tool-rule', `${display(at)} ${ruleProblemText(problem)}`, {
        problem,
      });
    }
  });
  return rules;
}

function checkPinned(names: readonly string[], path: string): void {
  for (const name of names) {
    if (envNameIsPinned(name)) {
      throw invalid(
        path,
        'env-pinned',
        `${display(path)} names ${JSON.stringify(name)}, which hudhud sets itself; use the matching option instead`,
        { name },
      );
    }
  }
}

function resolveEnv(env: EnvOption | undefined): EffectiveEnv {
  if (env === undefined || env === 'harness' || env === 'inherit') {
    return { form: 'preset', preset: env ?? 'harness', add: {}, remove: [] };
  }
  // After the schema, an own `preset` key means the object form.
  if (Object.hasOwn(env, 'preset')) {
    const form = env as Extract<EnvOption, { readonly preset: unknown }>;
    const add = form.add ?? {};
    const remove = form.remove ?? [];
    checkPinned(Object.keys(add), 'env.add');
    checkPinned(remove, 'env.remove');
    const unchanged = Object.keys(add).length === 0 && remove.length === 0;
    return { form: unchanged ? 'preset' : 'object', preset: form.preset, add, remove };
  }
  const variables = env as Readonly<Record<string, string>>;
  checkPinned(Object.keys(variables), 'env');
  return { form: 'map', variables };
}

const sortedNames = (names: Iterable<string>): string[] => [...new Set(names)].sort();

function envPosture(env: EffectiveEnv): PostureField[] {
  let value: JsonValue;
  let named: string[];
  if (env.form === 'map') {
    named = Object.keys(env.variables);
    value = { form: 'map', names: sortedNames(named) };
  } else if (env.form === 'preset') {
    value = env.preset;
    named = [];
  } else {
    named = Object.keys(env.add);
    value = {
      form: 'object',
      preset: env.preset,
      add: sortedNames(named),
      remove: sortedNames(env.remove),
    };
  }
  return [
    { setting: 'env', value, defaultValue: OPTION_DEFAULTS.env },
    {
      setting: 'env.credentialAndRoutingVariables',
      value: sortedNames(named.filter(isCredentialOrRoutingEnvName)),
      defaultValue: [],
    },
  ];
}

/** The order in which `--setting-sources` lists the sources (lead ruling F3). */
const SETTING_SOURCE_ORDER: readonly SettingSource[] = ['user', 'project', 'local'];

/** The given sources in canonical order (`user,project,local`), each once. */
function canonicalSources(sources: readonly SettingSource[]): readonly SettingSource[] {
  return SETTING_SOURCE_ORDER.filter((source) => sources.includes(source));
}

/** `workspaceTrust` that the given sources amount to, or `null` for any other set. */
function trustOf(sources: readonly SettingSource[]): WorkspaceTrust | null {
  const set = new Set(sources);
  if (set.size === 1 && set.has('user')) return 'none';
  if (set.size === 3) return 'full';
  return null;
}

function resolveSession(
  data: SessionOptionsData,
  host: SessionHostValues,
): EffectiveSessionOptions {
  const cc = data.claudeCode ?? {};

  if (data.workspaceTrust !== undefined && cc.settingSources !== undefined) {
    throw invalid(
      'workspaceTrust',
      'trust-and-sources',
      'options.workspaceTrust and options.claudeCode.settingSources are both set; set one of them',
    );
  }
  if (data.workspaceTrust === 'context') {
    throw new CapabilityUnsupportedError(
      'workspaceTrust "context" is not supported in v1 (ADR-0012 §2)',
      { details: { path: 'workspaceTrust', capability: 'workspaceTrust.context' } },
    );
  }
  const permissionMode = data.permissionMode ?? OPTION_DEFAULTS.permissionMode;
  const bypass = data.dangerouslyAllowBypassPermissions ?? false;
  if (permissionMode === 'bypassPermissions' && !bypass) {
    throw invalid(
      'permissionMode',
      'bypass-permissions',
      'options.permissionMode "bypassPermissions" requires options.dangerouslyAllowBypassPermissions: true',
    );
  }
  // The flag authorizes bypass for the whole session: as the initial mode or
  // through a later setPermissionMode('bypassPermissions') (lead ruling F2),
  // so it is valid with any initial mode.

  const trust = data.workspaceTrust ?? OPTION_DEFAULTS.workspaceTrust;
  // Canonical order and no duplicates, whatever order the option lists.
  const settingSources: readonly SettingSource[] = canonicalSources(
    cc.settingSources ?? SOURCES_BY_TRUST[trust],
  );
  const settingSourcesFrom =
    cc.settingSources === undefined ? 'workspaceTrust' : 'claudeCode.settingSources';
  const projectSources = settingSources.includes('project') || settingSources.includes('local');
  if (data.projectCredentialEnv !== undefined && !projectSources) {
    throw invalid(
      'projectCredentialEnv',
      'project-credential-env',
      'options.projectCredentialEnv applies only when the setting sources include "project" or "local"',
    );
  }
  const projectCredentialEnv = projectSources ? (data.projectCredentialEnv ?? 'refuse') : null;

  const allowedTools = checkRules(cc.allowedTools, 'claudeCode.allowedTools');
  const disallowedTools = checkRules(cc.disallowedTools, 'claudeCode.disallowedTools');
  const env = resolveEnv(data.env);

  const autoUpdate = data.autoUpdate ?? OPTION_DEFAULTS.autoUpdate;
  const nonessentialTraffic = data.nonessentialTraffic ?? OPTION_DEFAULTS.nonessentialTraffic;
  const dangerouslyAllowConfigWrites = data.dangerouslyAllowConfigWrites ?? false;
  const permissionPrompting = host.onPermission === undefined ? 'none' : 'stdio';
  const additionalDirectories = cc.additionalDirectories ?? [];
  const t = data.termination ?? {};
  const ev = data.events ?? {};

  const posture: PostureField[] = [
    { setting: 'permissionMode', value: permissionMode, defaultValue: 'default' },
    { setting: 'dangerouslyAllowBypassPermissions', value: bypass, defaultValue: false },
    { setting: 'permissionPrompting', value: permissionPrompting, defaultValue: 'none' },
    {
      setting: 'workspaceTrust',
      value: data.workspaceTrust ?? trustOf(settingSources),
      defaultValue: 'none',
    },
    { setting: 'claudeCode.settingSources', value: settingSources, defaultValue: ['user'] },
    {
      setting: 'projectCredentialEnv',
      value: projectCredentialEnv,
      defaultValue: projectSources ? 'refuse' : null,
    },
    ...envPosture(env),
    { setting: 'autoUpdate', value: autoUpdate, defaultValue: 'disabled' },
    { setting: 'nonessentialTraffic', value: nonessentialTraffic, defaultValue: 'disabled' },
    {
      setting: 'dangerouslyAllowConfigWrites',
      value: dangerouslyAllowConfigWrites,
      defaultValue: false,
    },
    { setting: 'claudeCode.allowedTools', value: allowedTools, defaultValue: [] },
    { setting: 'claudeCode.disallowedTools', value: disallowedTools, defaultValue: [] },
    { setting: 'claudeCode.additionalDirectories', value: additionalDirectories, defaultValue: [] },
    // Fixed in v1 (plan §2.4): listed so the posture states them.
    { setting: 'initialize.workspaceTrust', value: 'never-sent', defaultValue: 'never-sent' },
    { setting: 'permissionSuggestions', value: 'never-applied', defaultValue: 'never-applied' },
  ];

  return {
    cwd: data.cwd ?? null,
    permissionMode,
    dangerouslyAllowBypassPermissions: bypass,
    permissionPrompting,
    settingSources,
    settingSourcesFrom,
    projectCredentialEnv,
    env,
    autoUpdate,
    nonessentialTraffic,
    dangerouslyAllowConfigWrites,
    onAuthFailure: data.onAuthFailure ?? OPTION_DEFAULTS.onAuthFailure,
    onOversizedFrame: data.onOversizedFrame ?? OPTION_DEFAULTS.onOversizedFrame,
    maxFrameBytes: data.maxFrameBytes ?? OPTION_DEFAULTS.maxFrameBytes,
    maxOutboundFrameBytes: data.maxOutboundFrameBytes ?? OPTION_DEFAULTS.maxOutboundFrameBytes,
    firstFrameTimeoutMs: data.firstFrameTimeoutMs ?? OPTION_DEFAULTS.firstFrameTimeoutMs,
    idleStallMs: data.idleStallMs ?? OPTION_DEFAULTS.idleStallMs,
    closeTimeoutMs: data.closeTimeoutMs ?? OPTION_DEFAULTS.closeTimeoutMs,
    termination: {
      interruptWaitMs: t.interruptWaitMs ?? OPTION_DEFAULTS.interruptWaitMs,
      eofGraceMs: t.eofGraceMs ?? OPTION_DEFAULTS.eofGraceMs,
      termGraceMs: t.termGraceMs ?? OPTION_DEFAULTS.termGraceMs,
      taskkillGraceMs: t.taskkillGraceMs ?? OPTION_DEFAULTS.taskkillGraceMs,
    },
    trace:
      data.trace === undefined
        ? null
        : { traceparent: data.trace.traceparent, tracestate: data.trace.tracestate ?? null },
    claudeCode: {
      model: cc.model ?? null,
      allowedTools,
      disallowedTools,
      additionalDirectories,
      maxTurns: cc.maxTurns ?? null,
      includePartialMessages: cc.includePartialMessages ?? false,
      appendSystemPrompt: cc.appendSystemPrompt ?? null,
      backgroundWaitCeilingMs:
        cc.backgroundWaitCeilingMs ?? OPTION_DEFAULTS.backgroundWaitCeilingMs,
    },
    events: {
      maxEvents: ev.maxEvents ?? OPTION_DEFAULTS.maxEvents,
      maxBytes: ev.maxBytes ?? OPTION_DEFAULTS.maxBytes,
      overflow: ev.overflow ?? OPTION_DEFAULTS.overflow,
    },
    posture,
  };
}

function resolveConnect(data: ConnectOptionsData): EffectiveConnectOptions {
  const cc = data.claudeCode ?? {};
  const binaryVerification = data.binaryVerification ?? OPTION_DEFAULTS.binaryVerification;
  const configDir = cc.configDir ?? null;
  const bare = cc.bare ?? false;
  const dangerouslyAllowRawControl = cc.dangerouslyAllowRawControl ?? false;
  const dangerouslyAllowKnownBrokenVersion = cc.dangerouslyAllowKnownBrokenVersion ?? false;
  return {
    backend: 'native',
    binaryPath: data.binaryPath ?? null,
    binaryVerification,
    configDir,
    bare,
    binaryDigests: cc.binaryDigests ?? {},
    dangerouslyAllowRawControl,
    dangerouslyAllowKnownBrokenVersion,
    posture: [
      { setting: 'binaryVerification', value: binaryVerification, defaultValue: 'advisory' },
      // The kind only, never the path (plan §2.4).
      {
        setting: 'claudeCode.configDir',
        value: configDir === null ? 'user' : 'isolated',
        defaultValue: 'user',
      },
      { setting: 'claudeCode.bare', value: bare, defaultValue: false },
      {
        setting: 'claudeCode.dangerouslyAllowRawControl',
        value: dangerouslyAllowRawControl,
        defaultValue: false,
      },
      {
        setting: 'claudeCode.dangerouslyAllowKnownBrokenVersion',
        value: dangerouslyAllowKnownBrokenVersion,
        defaultValue: false,
      },
    ],
  };
}

// ---- entry points ------------------------------------------------------------------

/**
 * Validates `connect()` options and resolves their defaults.
 *
 * @throws `InvalidOptionsError`, `CapabilityUnsupportedError`
 */
export function resolveConnectOptions(input: unknown): {
  readonly effective: EffectiveConnectOptions;
  readonly signal?: AbortSignal;
} {
  const { json, host } = extract(input);
  if (host.onPermission !== undefined) {
    throw invalid('onPermission', 'schema', 'options.onPermission is a session option');
  }
  if (host.eventsSignal !== undefined) {
    throw invalid('events', 'schema', 'options.events is a session option');
  }
  checkBackend(json);
  const effective = resolveConnect(checkSchema(json, validateConnectOptions));
  return host.signal === undefined ? { effective } : { effective, signal: host.signal };
}

/**
 * Validates session options and resolves their defaults.
 *
 * @throws `InvalidOptionsError`, `CapabilityUnsupportedError`
 */
export function resolveSessionOptions(input: unknown): {
  readonly effective: EffectiveSessionOptions;
  readonly host: SessionHostValues;
} {
  const { json, host } = extract(input);
  return { effective: resolveSession(checkSchema(json, validateSessionOptions), host), host };
}

/**
 * Validates `sessions.resume()` options and resolves their defaults.
 *
 * @throws `InvalidOptionsError`, `CapabilityUnsupportedError`
 */
export function resolveResumeOptions(input: unknown): {
  readonly effective: EffectiveSessionOptions;
  readonly fork: boolean;
  readonly host: SessionHostValues;
} {
  const { json, host } = extract(input);
  const { fork, ...data } = checkSchema(json, validateResumeOptions);
  return { effective: resolveSession(data, host), fork: fork ?? false, host };
}

/**
 * Validates `session()` options (connect and session options in one object)
 * and resolves both sets of defaults.
 *
 * @throws `InvalidOptionsError`, `CapabilityUnsupportedError`
 */
export function resolveConnectSessionOptions(input: unknown): {
  readonly connect: EffectiveConnectOptions;
  readonly session: EffectiveSessionOptions;
  readonly host: SessionHostValues;
} {
  const { json, host } = extract(input);
  checkBackend(json);
  const data = checkSchema(json, validateConnectSessionOptions);
  const { backend, binaryPath, binaryVerification, claudeCode, ...sessionData } = data;
  const {
    configDir,
    bare,
    binaryDigests,
    dangerouslyAllowRawControl,
    dangerouslyAllowKnownBrokenVersion,
    ...ccSession
  } = claudeCode ?? {};
  const connectData: ConnectOptionsData = {
    ...(backend === undefined ? {} : { backend }),
    ...(binaryPath === undefined ? {} : { binaryPath }),
    ...(binaryVerification === undefined ? {} : { binaryVerification }),
    claudeCode: {
      ...(configDir === undefined ? {} : { configDir }),
      ...(bare === undefined ? {} : { bare }),
      ...(binaryDigests === undefined ? {} : { binaryDigests }),
      ...(dangerouslyAllowRawControl === undefined ? {} : { dangerouslyAllowRawControl }),
      ...(dangerouslyAllowKnownBrokenVersion === undefined
        ? {}
        : { dangerouslyAllowKnownBrokenVersion }),
    },
  };
  return {
    connect: resolveConnect(connectData),
    session: resolveSession({ ...sessionData, claudeCode: ccSession }, host),
    host,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks a session id for `--resume` or `--session-id`: a UUID (plan
 * decision, §2.3: titles are not addressable identities).
 *
 * @throws `InvalidOptionsError` rule `session-id`
 */
export function checkSessionId(id: unknown, path = 'sessionId'): string {
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw invalid(path, 'session-id', `${path} must be a session UUID`);
  }
  return id;
}
