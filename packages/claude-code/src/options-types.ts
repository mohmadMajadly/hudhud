/**
 * Types of the Claude Code adapter options (plan §2.3, §2.4): the public
 * option types, the JSON parts the generated validators check, and the
 * effective options. Types only; `options.ts` validates and resolves.
 *
 * @remarks
 * Kept apart from `options.ts` so that the generated validators and
 * `env.ts`, which `options.ts` imports, can name these types without an
 * import cycle.
 */

import type { JsonValue, SubscriberOptions } from '@hudhud/core';

// ---- public option types (plan §2.3) ------------------------------------------

/**
 * Permission modes offered in v1 (K11). `bypassPermissions` requires
 * `dangerouslyAllowBypassPermissions: true`.
 *
 * @public
 */
export type PermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto' | 'bypassPermissions';

/**
 * How far the workspace is trusted (ADR-0012 §2). `'context'` is not
 * supported in v1.
 *
 * @public
 */
export type WorkspaceTrust = 'none' | 'context' | 'full';

/**
 * A Claude Code setting source.
 *
 * @public
 */
export type SettingSource = 'user' | 'project' | 'local';

/**
 * The child environment (K19, ADR-0012 §4): a preset, an explicit map of
 * exactly these variables, or a preset with `remove` and then `add` applied.
 * A map cannot name a variable `preset`: an object with a `preset` key is
 * the object form.
 *
 * @public
 */
export type EnvOption =
  | 'harness'
  | 'inherit'
  | Readonly<Record<string, string>>
  | {
      readonly preset: 'harness' | 'inherit';
      readonly add?: Readonly<Record<string, string>>;
      readonly remove?: readonly string[];
    };

/**
 * The permission callback as far as option validation is concerned: a
 * function. Its full request and decision types are those of the core
 * `PermissionHandler`; any such handler is assignable to this type.
 *
 * @public
 */
export type PermissionCallback = (
  request: never,
  ctx: { readonly signal: AbortSignal },
) => Promise<unknown>;

/**
 * Options of `connect()`.
 *
 * @public
 */
export interface ConnectOptions {
  readonly backend?: 'native';
  readonly binaryPath?: string;
  /** K9; default `'advisory'`. */
  readonly binaryVerification?: 'advisory' | 'strict';
  readonly claudeCode?: ClaudeCodeConnectOptions;
  readonly signal?: AbortSignal;
}

/**
 * Claude Code specific options of `connect()`.
 *
 * @public
 */
export interface ClaudeCodeConnectOptions {
  /** An isolated config directory (`CLAUDE_CONFIG_DIR`); default the user's own. */
  readonly configDir?: string;
  readonly bare?: boolean;
  /** Extra sha256 digests by CLI version, then platform (K8). */
  readonly binaryDigests?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly dangerouslyAllowRawControl?: boolean;
}

/**
 * Options of a session.
 *
 * @public
 */
export interface SessionOptions {
  readonly cwd?: string;
  readonly permissionMode?: PermissionMode;
  readonly dangerouslyAllowBypassPermissions?: boolean;
  readonly onPermission?: PermissionCallback;
  readonly workspaceTrust?: WorkspaceTrust;
  readonly projectCredentialEnv?: 'refuse' | 'allow';
  readonly env?: EnvOption;
  readonly autoUpdate?: 'disabled' | 'harness-default';
  readonly nonessentialTraffic?: 'disabled' | 'harness-default';
  readonly dangerouslyAllowConfigWrites?: boolean;
  readonly onAuthFailure?: 'fail-fast' | 'harness-retry';
  readonly onOversizedFrame?: 'fail' | 'skip';
  readonly maxFrameBytes?: number;
  readonly maxOutboundFrameBytes?: number;
  readonly firstFrameTimeoutMs?: number;
  readonly idleStallMs?: number;
  readonly closeTimeoutMs?: number;
  readonly termination?: {
    readonly interruptWaitMs?: number;
    readonly eofGraceMs?: number;
    readonly termGraceMs?: number;
    readonly taskkillGraceMs?: number;
  };
  readonly trace?: { readonly traceparent: string; readonly tracestate?: string };
  readonly claudeCode?: ClaudeCodeSessionOptions;
  readonly events?: SubscriberOptions;
  readonly signal?: AbortSignal;
}

/**
 * Claude Code specific options of a session.
 *
 * @public
 */
export interface ClaudeCodeSessionOptions {
  readonly settingSources?: readonly SettingSource[];
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly additionalDirectories?: readonly string[];
  readonly maxTurns?: number;
  readonly includePartialMessages?: boolean;
  readonly appendSystemPrompt?: string;
  readonly backgroundWaitCeilingMs?: number;
}

/**
 * Options of `sessions.resume()`.
 *
 * @public
 */
export interface ResumeOptions extends SessionOptions {
  readonly fork?: boolean;
}

// ---- JSON parts checked by the generated validators ----------------------------

/** {@link SubscriberOptions} without its signal. */
export type SubscriberOptionsData = Omit<SubscriberOptions, 'signal'>;

/** The JSON part of {@link ConnectOptions}. */
export type ConnectOptionsData = Omit<ConnectOptions, 'signal'>;

/** The JSON part of {@link SessionOptions}. */
export type SessionOptionsData = Omit<SessionOptions, 'signal' | 'onPermission' | 'events'> & {
  readonly events?: SubscriberOptionsData;
};

/** The JSON part of {@link ResumeOptions}. */
export type ResumeOptionsData = SessionOptionsData & { readonly fork?: boolean };

/** The JSON part of `session()` options: connect and session options, `claudeCode` merged. */
export type ConnectSessionOptionsData = Omit<ConnectOptionsData, 'claudeCode'> &
  Omit<SessionOptionsData, 'claudeCode'> & {
    readonly claudeCode?: ClaudeCodeConnectOptions & ClaudeCodeSessionOptions;
  };

// ---- effective options ---------------------------------------------------------

/**
 * One security-relevant setting with its effective and default value
 * (plan §2.4). The posture builder adds `deviates` by deep JSON equality.
 * Values never carry secrets or environment values.
 */
export interface PostureField {
  readonly setting: string;
  readonly value: JsonValue;
  readonly defaultValue: JsonValue;
}

/** The environment option after validation. */
export type EffectiveEnv =
  | {
      /** `'preset'`: a preset string or an object form without changes. */
      readonly form: 'preset' | 'object';
      readonly preset: 'harness' | 'inherit';
      readonly add: Readonly<Record<string, string>>;
      readonly remove: readonly string[];
    }
  | { readonly form: 'map'; readonly variables: Readonly<Record<string, string>> };

/** {@link ConnectOptions} with every default resolved. JSON. */
export interface EffectiveConnectOptions {
  readonly backend: 'native';
  readonly binaryPath: string | null;
  readonly binaryVerification: 'advisory' | 'strict';
  readonly configDir: string | null;
  readonly bare: boolean;
  readonly binaryDigests: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly dangerouslyAllowRawControl: boolean;
  readonly posture: readonly PostureField[];
}

/** {@link SessionOptions} with every default resolved. JSON. */
export interface EffectiveSessionOptions {
  readonly cwd: string | null;
  readonly permissionMode: PermissionMode;
  readonly dangerouslyAllowBypassPermissions: boolean;
  /** `'stdio'` iff `onPermission` is set. */
  readonly permissionPrompting: 'stdio' | 'none';
  readonly settingSources: readonly SettingSource[];
  /** Which option the setting sources came from. */
  readonly settingSourcesFrom: 'workspaceTrust' | 'claudeCode.settingSources';
  /** `null` when the setting sources include neither `project` nor `local`. */
  readonly projectCredentialEnv: 'refuse' | 'allow' | null;
  readonly env: EffectiveEnv;
  readonly autoUpdate: 'disabled' | 'harness-default';
  readonly nonessentialTraffic: 'disabled' | 'harness-default';
  readonly dangerouslyAllowConfigWrites: boolean;
  readonly onAuthFailure: 'fail-fast' | 'harness-retry';
  readonly onOversizedFrame: 'fail' | 'skip';
  readonly maxFrameBytes: number;
  readonly maxOutboundFrameBytes: number;
  readonly firstFrameTimeoutMs: number;
  readonly idleStallMs: number;
  readonly closeTimeoutMs: number;
  readonly termination: {
    readonly interruptWaitMs: number;
    readonly eofGraceMs: number;
    readonly termGraceMs: number;
    readonly taskkillGraceMs: number;
  };
  readonly trace: { readonly traceparent: string; readonly tracestate: string | null } | null;
  readonly claudeCode: {
    readonly model: string | null;
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
    readonly additionalDirectories: readonly string[];
    readonly maxTurns: number | null;
    readonly includePartialMessages: boolean;
    readonly appendSystemPrompt: string | null;
    readonly backgroundWaitCeilingMs: number;
  };
  readonly events: {
    readonly maxEvents: number;
    readonly maxBytes: number;
    readonly overflow: 'error' | 'drop-oldest-with-gap-marker' | 'block';
  };
  readonly posture: readonly PostureField[];
}

/** Host values of a session, kept out of the JSON options. */
export interface SessionHostValues {
  readonly onPermission?: PermissionCallback;
  readonly signal?: AbortSignal;
  readonly eventsSignal?: AbortSignal;
}
