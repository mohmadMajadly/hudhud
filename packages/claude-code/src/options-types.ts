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

import type { JsonValue, PermissionHandler, SubscriberOptions } from '@hudhudjs/core';

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
 * How far the workspace is trusted (ADR-0012 §2): `'none'` loads the user's
 * own settings only, `'full'` also the repository's (`project` and `local`).
 * `'context'` is not supported in v1 (`CAPABILITY_UNSUPPORTED`).
 *
 * @public
 */
export type WorkspaceTrust = 'none' | 'context' | 'full';

/**
 * A Claude Code setting source: the user's settings, the repository's
 * shared settings, or its local settings.
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
      /** The preset to start from. */
      readonly preset: 'harness' | 'inherit';
      /** Variables to set, applied after `remove`. */
      readonly add?: Readonly<Record<string, string>>;
      /** Names to drop from the preset; no duplicates. */
      readonly remove?: readonly string[];
    };

/**
 * The permission callback as far as option validation is concerned: a
 * function. Its full request and decision types are those of the core
 * `PermissionHandler`; any such handler is assignable to this type. The public
 * option is typed `PermissionHandler` (plan §2.3); this type is internal.
 *
 * @internal
 */
export type PermissionCallback = (
  request: never,
  ctx: { readonly signal: AbortSignal },
) => Promise<unknown>;

/**
 * Options of `connect()`. Validated strictly: unknown keys, wrong types and
 * values out of range are refused with `INVALID_OPTIONS`.
 *
 * @public
 */
export interface ConnectOptions {
  /**
   * The backend. Default and only value in v1: `'native'` (the CLI over
   * stream-json); `'agent-sdk'` is refused with `CAPABILITY_UNSUPPORTED`.
   */
  readonly backend?: 'native';
  /**
   * The Claude Code binary to use; nothing else is tried. Default: discovery
   * (the native installer's launcher, then a hardened `PATH` lookup). Not
   * empty.
   */
  readonly binaryPath?: string;
  /**
   * Binary verification (K9). `'advisory'` (default) compares the binary's
   * SHA-256 with the tested builds and reports the result in
   * `binary.verification`, refusing nothing. `'strict'` first runs the
   * operating system's signature check (Windows and macOS), then the digest,
   * and fails `connect` with `BINARY_VERIFICATION_FAILED` unless the result
   * is `'verified'`. Listed in the security posture.
   */
  readonly binaryVerification?: 'advisory' | 'strict';
  /** Options specific to Claude Code. */
  readonly claudeCode?: ClaudeCodeConnectOptions;
  /**
   * Aborts `connect` with `ABORTED`; a running version probe is stopped at
   * once. Default: none.
   */
  readonly signal?: AbortSignal;
}

/**
 * Claude Code specific options of `connect()`.
 *
 * @public
 */
export interface ClaudeCodeConnectOptions {
  /**
   * Claude Code's config directory, passed as `CLAUDE_CONFIG_DIR`. Default:
   * the user's own. Not empty. Listed in the security posture (as
   * `'isolated'`, never the path).
   */
  readonly configDir?: string;
  /** Passes `--bare` to Claude Code. Default `false`. Listed in the security posture. */
  readonly bare?: boolean;
  /**
   * Extra trusted SHA-256 digests (64 lowercase hex characters) by Claude
   * Code version, then by platform such as `linux-arm64` (K8), in addition
   * to the tested builds. Default: none.
   */
  readonly binaryDigests?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Allows `controlRequest` and `writeFrame` of the raw tier
   * (`@hudhudjs/claude-code/raw`), which bypass hudhud's session machine.
   * Default `false`. Listed in the security posture.
   */
  readonly dangerouslyAllowRawControl?: boolean;
  /**
   * Runs a probed version listed in `CLAUDE_CODE_COMPAT.knownBroken` instead
   * of refusing it with `HARNESS_VERSION_KNOWN_BROKEN` (ADR-0004 §4
   * amendment); the `compat` status stays `known-broken`. Default `false`.
   * Listed in the security posture.
   */
  readonly dangerouslyAllowKnownBrokenVersion?: boolean;
}

/**
 * Options of a session. Validated strictly: unknown keys, wrong types and
 * values out of range are refused with `INVALID_OPTIONS`. Durations are in
 * milliseconds, sizes in bytes.
 *
 * @public
 */
export interface SessionOptions {
  /**
   * The working directory. Default `process.cwd()`. Resolved to its real
   * path and checked before the start (`CWD_INVALID`; on Windows also
   * `CWD_TOO_LONG`). Not empty.
   */
  readonly cwd?: string;
  /**
   * Claude Code's permission mode, always passed explicitly. Default
   * `'default'`. `'bypassPermissions'` needs
   * {@link SessionOptions.dangerouslyAllowBypassPermissions}. Listed in the
   * security posture.
   */
  readonly permissionMode?: PermissionMode;
  /**
   * Allows `'bypassPermissions'`, at the start and later through
   * `setPermissionMode`. Default `false`. Listed in the security posture.
   */
  readonly dangerouslyAllowBypassPermissions?: boolean;
  /**
   * Answers Claude Code's permission questions in the application. Default:
   * none (Claude Code decides by its mode and rules). Listed in the security
   * posture as `permissionPrompting`.
   */
  readonly onPermission?: PermissionHandler;
  /**
   * Which settings Claude Code loads. Default `'none'` (the user's own
   * settings only). Not together with `claudeCode.settingSources`. Listed in
   * the security posture.
   */
  readonly workspaceTrust?: WorkspaceTrust;
  /**
   * What happens when the repository's settings define credential variables
   * or an `apiKeyHelper`: `'refuse'` fails the start with
   * `PROJECT_CREDENTIAL_ENV`, `'allow'` runs anyway. Default `'refuse'`;
   * valid only when the sources include `project` or `local`. Listed in the
   * security posture.
   */
  readonly projectCredentialEnv?: 'refuse' | 'allow';
  /**
   * Claude Code's environment. Default `'harness'` (an allowlist). Names may
   * not be variables hudhud sets itself. Listed in the security posture.
   */
  readonly env?: EnvOption;
  /**
   * `'disabled'` (default) sets `DISABLE_AUTOUPDATER=1`;
   * `'harness-default'` leaves Claude Code's behaviour. Listed in the
   * security posture.
   */
  readonly autoUpdate?: 'disabled' | 'harness-default';
  /**
   * `'disabled'` (default) sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`;
   * `'harness-default'` leaves Claude Code's behaviour. Listed in the
   * security posture.
   */
  readonly nonessentialTraffic?: 'disabled' | 'harness-default';
  /**
   * Keeps permission updates that write Claude Code's settings files.
   * Default `false`: they are stripped. Listed in the security posture.
   */
  readonly dangerouslyAllowConfigWrites?: boolean;
  /**
   * `'fail-fast'` (default): a 401 for a static credential from the
   * environment (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`) fails the
   * session at once with `AUTHENTICATION_FAILED`; logins that can refresh
   * behave as `'harness-retry'`. `'harness-retry'` lets Claude Code retry.
   */
  readonly onAuthFailure?: 'fail-fast' | 'harness-retry';
  /**
   * An output line over {@link SessionOptions.maxFrameBytes}: `'fail'`
   * (default) ends the session with `OVERSIZED_FRAME`, `'skip'` drops the
   * line and reports it.
   */
  readonly onOversizedFrame?: 'fail' | 'skip';
  /**
   * Largest output line from Claude Code, in bytes. Default 67108864
   * (64 MiB); an integer from 1048576 (1 MiB) to 1073741824 (1 GiB).
   */
  readonly maxFrameBytes?: number;
  /**
   * Largest line hudhud writes to Claude Code, in bytes; a larger one fails
   * with `OUTBOUND_FRAME_TOO_LARGE`. Default 33554432 (32 MiB); an integer
   * from 1048576 (1 MiB) to 1073741824 (1 GiB).
   */
  readonly maxOutboundFrameBytes?: number;
  /**
   * Handshake deadline in milliseconds (`HANDSHAKE_TIMEOUT`). Default 60000;
   * an integer from 1000 to 86400000.
   */
  readonly firstFrameTimeoutMs?: number;
  /**
   * Silence in milliseconds before a `stalled` event. Default 300000; an
   * integer from 1000 to 86400000.
   */
  readonly idleStallMs?: number;
  /**
   * Deadline of `close()` in milliseconds, measured from the call; then the
   * abort ladder runs. Default 30000; an integer from 1000 to 86400000.
   */
  readonly closeTimeoutMs?: number;
  /**
   * Waits of the abort ladder, in milliseconds, each an integer from 1000 to
   * 86400000.
   */
  readonly termination?: {
    /** Wait for the answer to the interrupt. Default 1000. */
    readonly interruptWaitMs?: number;
    /** Wait after the end of input. Default 2000. */
    readonly eofGraceMs?: number;
    /** Linux and macOS: wait after `SIGTERM`. Default 5000. */
    readonly termGraceMs?: number;
    /** Windows without a job: wait after `taskkill`. Default 2000. */
    readonly taskkillGraceMs?: number;
  };
  /**
   * W3C trace context to propagate as `TRACEPARENT` and `TRACESTATE`.
   * Default: none, and both variables are removed from the environment.
   */
  readonly trace?: {
    /** Lowercase W3C `traceparent` (`00-<32 hex>-<16 hex>-<2 hex>`). */
    readonly traceparent: string;
    /** W3C `tracestate`: printable ASCII, at most 512 characters. */
    readonly tracestate?: string;
  };
  /** Options specific to Claude Code. */
  readonly claudeCode?: ClaudeCodeSessionOptions;
  /**
   * Defaults for this session's subscribers (`events()` and the iterators of
   * `send()`): 10000 events, 64 MiB, `'error'`. Its `signal` ends every
   * subscription of the session with `ABORTED`.
   */
  readonly events?: SubscriberOptions;
  /**
   * Aborts the start of the session with `ABORTED`. Once the session is
   * open it has no effect: use `close()` or dispose the session.
   */
  readonly signal?: AbortSignal;
}

/**
 * Claude Code specific options of a session.
 *
 * @public
 */
export interface ClaudeCodeSessionOptions {
  /**
   * The setting sources, passed as `--setting-sources`; no duplicates.
   * Default: from `workspaceTrust`. Not together with `workspaceTrust`.
   * Listed in the security posture.
   */
  readonly settingSources?: readonly SettingSource[];
  /** The model, passed as `--model`. Default: Claude Code's. Not empty. */
  readonly model?: string;
  /**
   * Tool rules passed as `--allowed-tools`. Default: none. A rule Claude Code
   * would split or misread is refused. Listed in the security posture.
   */
  readonly allowedTools?: readonly string[];
  /**
   * Tool rules passed as `--disallowed-tools`. Default: none. Listed in the
   * security posture.
   */
  readonly disallowedTools?: readonly string[];
  /**
   * Extra directories Claude Code may access, one `--add-dir` each. Default:
   * none. Not empty. Listed in the security posture.
   */
  readonly additionalDirectories?: readonly string[];
  /**
   * Passed as `--max-turns`; a turn that reaches it ends with outcome
   * `'max-turns'`. Default: none. An integer from 1 to 2147483647.
   */
  readonly maxTurns?: number;
  /** Streams `message.delta` events. Default `false`. */
  readonly includePartialMessages?: boolean;
  /** Appended to Claude Code's system prompt. Default: none. */
  readonly appendSystemPrompt?: string;
  /**
   * How long Claude Code waits for background tasks after its input ended,
   * in milliseconds (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). Default 600000;
   * an integer from 1000 to 86400000.
   */
  readonly backgroundWaitCeilingMs?: number;
}

/**
 * Options of `sessions.resume()`.
 *
 * @public
 */
export interface ResumeOptions extends SessionOptions {
  /** Continues the session under a new id instead of its own. Default `false`. */
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
  readonly dangerouslyAllowKnownBrokenVersion: boolean;
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
