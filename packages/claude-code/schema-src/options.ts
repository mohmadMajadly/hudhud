// Options of the Claude Code adapter (plan §2.3, §2.4): source of
// schemas/options.schema.json and of the validators generated into
// src/generated/validators.gen.ts. Strict (ADR-0005 §7): every object refuses
// unknown keys, so a misspelt security option can never be ignored silently.
//
// The schemas describe the JSON part of the options. Host values are outside
// the language-neutral contract and are checked by src/options.ts before the
// generated validator runs: `signal` (an AbortSignal), `onPermission` (a
// function) and `events.signal`.

import Type, { type TProperties, type TSchema, type TUnsafe } from 'typebox';

import { list, type SchemaSource, type ValidatorExport } from '../../core/schema-src/common.js';

const closed = { additionalProperties: false } as const;

/** An object that refuses unknown keys. */
function strict<Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, closed);
}

/** Inclusive integer range. */
function integer(minimum: number, maximum: number) {
  return Type.Integer({ minimum, maximum });
}

const MIB = 1_048_576;

/** Frame caps: 1 MiB to 1 GiB (plan §2.3). */
export const FrameBytes = integer(MIB, 1024 * MIB);

/** Timeouts and grace periods: 1 s to 24 h (plan §2.3). */
export const TimeoutMs = integer(1000, 86_400_000);

/** A path or other free-form value: never empty. */
const NonEmpty = Type.String({ minLength: 1 });

export const PermissionMode = Type.Enum([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'auto',
  'bypassPermissions',
]);

export const WorkspaceTrust = Type.Enum(['none', 'context', 'full']);

export const SettingSource = Type.Enum(['user', 'project', 'local']);

/**
 * A portable environment variable name, plus the `(x86)` suffix of the
 * Windows `ProgramFiles(x86)` family.
 */
export const ENV_NAME_PATTERN = String.raw`^[A-Za-z_][A-Za-z0-9_]*(\(x86\))?$`;

export const EnvName = Type.String({ pattern: ENV_NAME_PATTERN });

/** Variables by name; values are checked for NUL and lone surrogates in code. */
function envVariables(names: Record<string, unknown>): TUnsafe<Readonly<Record<string, string>>> {
  return Type.Unsafe<Readonly<Record<string, string>>>({
    type: 'object',
    propertyNames: names,
    additionalProperties: { type: 'string' },
  });
}

/**
 * The explicit map form: exactly these variables. An object with an own
 * `preset` key is the object form instead, so a map cannot name a variable
 * `preset`.
 */
export const EnvMap = envVariables({ pattern: ENV_NAME_PATTERN, not: { const: 'preset' } });

export const EnvPreset = Type.Enum(['harness', 'inherit']);

/** The object form (K19): the preset, then `remove`, then `add`. */
export const EnvObjectForm = strict({
  preset: EnvPreset,
  add: Type.Optional(envVariables({ pattern: ENV_NAME_PATTERN })),
  remove: Type.Optional(list(EnvName, { uniqueItems: true })),
});

export const EnvOption = Type.Union([EnvPreset, EnvMap, EnvObjectForm]);

export const Termination = strict({
  interruptWaitMs: Type.Optional(TimeoutMs),
  eofGraceMs: Type.Optional(TimeoutMs),
  termGraceMs: Type.Optional(TimeoutMs),
  taskkillGraceMs: Type.Optional(TimeoutMs),
});

/**
 * W3C Trace Context `traceparent`, lower-case hex: version (not `ff`),
 * trace id and parent id (neither all zeros), flags.
 */
export const TRACEPARENT_PATTERN =
  '^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$';

export const Trace = strict({
  traceparent: Type.String({ pattern: TRACEPARENT_PATTERN }),
  // W3C: at most 512 characters of printable ASCII.
  tracestate: Type.Optional(Type.String({ maxLength: 512, pattern: '^[\\x20-\\x7e]*$' })),
});

export const SubscriberOptionsData = strict({
  maxEvents: Type.Optional(integer(1, Number.MAX_SAFE_INTEGER)),
  maxBytes: Type.Optional(integer(1, Number.MAX_SAFE_INTEGER)),
  overflow: Type.Optional(Type.Enum(['error', 'drop-oldest-with-gap-marker', 'block'])),
});

const claudeCodeSessionProperties = {
  settingSources: Type.Optional(list(SettingSource, { uniqueItems: true })),
  model: Type.Optional(NonEmpty),
  allowedTools: Type.Optional(list(Type.String())),
  disallowedTools: Type.Optional(list(Type.String())),
  additionalDirectories: Type.Optional(list(NonEmpty)),
  maxTurns: Type.Optional(integer(1, 2_147_483_647)),
  includePartialMessages: Type.Optional(Type.Boolean()),
  appendSystemPrompt: Type.Optional(Type.String()),
  backgroundWaitCeilingMs: Type.Optional(TimeoutMs),
};

export const ClaudeCodeSessionOptions = strict(claudeCodeSessionProperties);

/** sha256 digests by CLI version, then by platform (K8). */
export const BinaryDigests = Type.Unsafe<
  Readonly<Record<string, Readonly<Record<string, string>>>>
>({
  type: 'object',
  propertyNames: { pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$' },
  additionalProperties: {
    type: 'object',
    propertyNames: { pattern: '^[a-z0-9]+-[a-z0-9]+(-[a-z0-9]+)?$' },
    additionalProperties: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
});

const claudeCodeConnectProperties = {
  configDir: Type.Optional(NonEmpty),
  bare: Type.Optional(Type.Boolean()),
  binaryDigests: Type.Optional(BinaryDigests),
  dangerouslyAllowRawControl: Type.Optional(Type.Boolean()),
  dangerouslyAllowKnownBrokenVersion: Type.Optional(Type.Boolean()),
};

export const ClaudeCodeConnectOptions = strict(claudeCodeConnectProperties);

const connectProperties = {
  backend: Type.Optional(Type.Literal('native')),
  binaryPath: Type.Optional(NonEmpty),
  binaryVerification: Type.Optional(Type.Enum(['advisory', 'strict'])),
};

export const ConnectOptions = strict({
  ...connectProperties,
  claudeCode: Type.Optional(ClaudeCodeConnectOptions),
});

const sessionProperties = {
  cwd: Type.Optional(NonEmpty),
  permissionMode: Type.Optional(PermissionMode),
  dangerouslyAllowBypassPermissions: Type.Optional(Type.Boolean()),
  workspaceTrust: Type.Optional(WorkspaceTrust),
  projectCredentialEnv: Type.Optional(Type.Enum(['refuse', 'allow'])),
  env: Type.Optional(EnvOption),
  autoUpdate: Type.Optional(Type.Enum(['disabled', 'harness-default'])),
  nonessentialTraffic: Type.Optional(Type.Enum(['disabled', 'harness-default'])),
  dangerouslyAllowConfigWrites: Type.Optional(Type.Boolean()),
  onAuthFailure: Type.Optional(Type.Enum(['fail-fast', 'harness-retry'])),
  onOversizedFrame: Type.Optional(Type.Enum(['fail', 'skip'])),
  maxFrameBytes: Type.Optional(FrameBytes),
  maxOutboundFrameBytes: Type.Optional(FrameBytes),
  firstFrameTimeoutMs: Type.Optional(TimeoutMs),
  idleStallMs: Type.Optional(TimeoutMs),
  closeTimeoutMs: Type.Optional(TimeoutMs),
  termination: Type.Optional(Termination),
  trace: Type.Optional(Trace),
  events: Type.Optional(SubscriberOptionsData),
};

export const SessionOptions = strict({
  ...sessionProperties,
  claudeCode: Type.Optional(ClaudeCodeSessionOptions),
});

export const ResumeOptions = strict({
  ...sessionProperties,
  claudeCode: Type.Optional(ClaudeCodeSessionOptions),
  fork: Type.Optional(Type.Boolean()),
});

/** `session()`: connect and session options in one object, `claudeCode` merged. */
export const ConnectSessionOptions = strict({
  ...connectProperties,
  ...sessionProperties,
  claudeCode: Type.Optional(
    strict({ ...claudeCodeConnectProperties, ...claudeCodeSessionProperties }),
  ),
});

const defs: Readonly<Record<string, TSchema>> = {
  FrameBytes,
  TimeoutMs,
  PermissionMode,
  WorkspaceTrust,
  SettingSource,
  EnvName,
  EnvMap,
  EnvPreset,
  EnvObjectForm,
  EnvOption,
  Termination,
  Trace,
  SubscriberOptionsData,
  ClaudeCodeSessionOptions,
  BinaryDigests,
  ClaudeCodeConnectOptions,
  ConnectOptions,
  SessionOptions,
  ResumeOptions,
  ConnectSessionOptions,
};

const file = 'options.schema.json';
const TYPES = '../options-types.js';

function optionsValidator(def: string, typeName: string): ValidatorExport {
  return { name: `validate${def}`, schema: file, def, type: { from: TYPES, name: typeName } };
}

export const schemaSource: SchemaSource = {
  documents: [
    {
      file,
      title: 'hudhud Claude Code adapter options',
      description:
        'Strict: unknown keys are refused. Describes the JSON part of the options; the host values signal, onPermission and events.signal are checked by the adapter.',
      root: 'ConnectSessionOptions',
      defs,
    },
  ],
  data: [],
  validators: [
    optionsValidator('ConnectOptions', 'ConnectOptionsData'),
    optionsValidator('SessionOptions', 'SessionOptionsData'),
    optionsValidator('ResumeOptions', 'ResumeOptionsData'),
    optionsValidator('ConnectSessionOptions', 'ConnectSessionOptionsData'),
  ],
};
