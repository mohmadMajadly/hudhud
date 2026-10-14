// Claude Code security posture (plan §1.9, §2.4, §4.2; ADR-0012 §5, §7;
// K19, K23): membership against the option schema, deviation flags for every
// security-weakening opt-in, managedPolicy, and the read-only, booleans-only
// parse of the user settings file. Tests never touch the real user config:
// the reader is injected, and the real reader only sees a temporary directory.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';

import type { SecurityPosture } from '../../../core/src/protocol/capabilities.js';
import {
  buildPosture,
  parsePosture,
  postureDeviations,
  serializePosture,
} from '../../../core/src/security/posture.js';
import {
  resolveConnectOptions,
  resolveSessionOptions,
  type EffectiveConnectOptions,
  type EffectiveSessionOptions,
} from '../../src/options.js';
import {
  claudePostureEntries,
  managedPolicyOf,
  nodeSettingsFileReader,
  projectSettingsFlagsOf,
  scanUserSettingsEnv,
  USER_SETTINGS_MAX_BYTES,
  userConfigDir,
  type ClaudePostureInput,
  type ProjectSettingsEnvFlags,
  type RawPostureInput,
  type SettingsFileReader,
  type UserSettingsEnvScan,
} from '../../src/posture.js';

const CLEAN: UserSettingsEnvScan = {
  present: false,
  readable: true,
  customBaseUrl: false,
  thirdPartyProvider: false,
};

interface Build {
  readonly connect?: unknown;
  readonly session?: unknown;
  readonly harnessOnly?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly userSettings?: UserSettingsEnvScan;
  readonly raw?: RawPostureInput;
  readonly projectSettings?: ProjectSettingsEnvFlags;
}

function effective(build: Build): {
  readonly connect: EffectiveConnectOptions;
  readonly session: EffectiveSessionOptions;
} {
  return {
    connect: resolveConnectOptions(build.connect).effective,
    session: resolveSessionOptions(build.session).effective,
  };
}

function posture(build: Build = {}): SecurityPosture {
  const { connect, session } = effective(build);
  const input: ClaudePostureInput = {
    connect,
    ...(build.harnessOnly === true ? {} : { session }),
    env: build.env ?? {},
    userSettings: build.userSettings ?? CLEAN,
    ...(build.raw === undefined ? {} : { raw: build.raw }),
    ...(build.projectSettings === undefined ? {} : { projectSettings: build.projectSettings }),
    platform: 'posix',
  };
  return buildPosture(claudePostureEntries(input));
}

function deviating(build: Build): string[] {
  return postureDeviations(posture(build)).map((entry) => entry.setting);
}

function valueOf(p: SecurityPosture, setting: string): unknown {
  return p.entries.find((entry) => entry.setting === setting)?.value;
}

// ---- membership (plan §2.4) ----------------------------------------------------------

/**
 * Every option of the schema and the host values, mapped to the posture
 * settings that report it, or `null` for "In securityPosture: no" (§2.4).
 * A new option fails the first test until it is classified here.
 */
const MEMBERSHIP: Readonly<Record<string, readonly string[] | null>> = {
  backend: null,
  binaryPath: null,
  binaryVerification: ['binaryVerification'],
  'claudeCode.configDir': ['claudeCode.configDir'],
  'claudeCode.bare': ['claudeCode.bare'],
  'claudeCode.binaryDigests': null,
  'claudeCode.dangerouslyAllowRawControl': ['claudeCode.dangerouslyAllowRawControl'],
  'claudeCode.dangerouslyAllowKnownBrokenVersion': [
    'claudeCode.dangerouslyAllowKnownBrokenVersion',
  ],
  cwd: null,
  permissionMode: ['permissionMode'],
  dangerouslyAllowBypassPermissions: ['dangerouslyAllowBypassPermissions'],
  onPermission: ['permissionPrompting'],
  workspaceTrust: ['workspaceTrust'],
  'claudeCode.settingSources': ['claudeCode.settingSources'],
  projectCredentialEnv: ['projectCredentialEnv'],
  env: ['env', 'env.credentialAndRoutingVariables', 'managedPolicy'],
  autoUpdate: ['autoUpdate'],
  nonessentialTraffic: ['nonessentialTraffic', 'managedPolicy'],
  dangerouslyAllowConfigWrites: ['dangerouslyAllowConfigWrites'],
  onAuthFailure: null,
  onOversizedFrame: null,
  maxFrameBytes: null,
  maxOutboundFrameBytes: null,
  firstFrameTimeoutMs: null,
  idleStallMs: null,
  closeTimeoutMs: null,
  termination: null,
  trace: null,
  'claudeCode.backgroundWaitCeilingMs': null,
  'claudeCode.allowedTools': ['claudeCode.allowedTools'],
  'claudeCode.disallowedTools': ['claudeCode.disallowedTools'],
  'claudeCode.additionalDirectories': ['claudeCode.additionalDirectories'],
  'claudeCode.model': null,
  'claudeCode.maxTurns': null,
  'claudeCode.includePartialMessages': null,
  'claudeCode.appendSystemPrompt': null,
  events: null,
  signal: null,
  fork: null,
};

/** Fixed and derived entries of §2.4 that no option sets. */
const FIXED = [
  'initialize.workspaceTrust',
  'permissionSuggestions',
  'raw.extraArgs',
  'raw.extraEnv',
];

const CONNECT_SETTINGS = [
  'binaryVerification',
  'claudeCode.configDir',
  'claudeCode.bare',
  'claudeCode.dangerouslyAllowRawControl',
  'claudeCode.dangerouslyAllowKnownBrokenVersion',
];

interface SchemaDef {
  readonly properties?: Readonly<Record<string, unknown>>;
}

function schemaOptionPaths(): string[] {
  const schemaFile = fileURLToPath(new URL('../../schemas/options.schema.json', import.meta.url));
  const defs = (
    JSON.parse(readFileSync(schemaFile, 'utf8')) as {
      readonly $defs: Readonly<Record<string, SchemaDef>>;
    }
  ).$defs;
  const keys = (name: string): string[] => Object.keys(defs[name]?.properties ?? {});
  const top = [
    ...keys('ConnectOptions'),
    ...keys('SessionOptions'),
    ...keys('ResumeOptions'),
  ].filter((key) => key !== 'claudeCode');
  const nested = [...keys('ClaudeCodeConnectOptions'), ...keys('ClaudeCodeSessionOptions')].map(
    (key) => `claudeCode.${key}`,
  );
  // Host values, kept out of the JSON schema (options.ts step 1).
  return [...new Set([...top, ...nested, 'onPermission', 'signal'])].sort();
}

describe('membership (plan §2.4)', () => {
  it('classifies every option of the schema', () => {
    expect(schemaOptionPaths().length).toBeGreaterThan(30);
    expect(Object.keys(MEMBERSHIP).sort()).toEqual(schemaOptionPaths());
  });

  it('lists exactly the "yes" rows of a session, each with value, default and deviates', () => {
    const p = posture();
    const expected = new Set([
      ...Object.values(MEMBERSHIP).flatMap((settings) => settings ?? []),
      ...FIXED,
    ]);
    expect(p.entries.map((entry) => entry.setting).sort()).toEqual([...expected].sort());
    for (const entry of p.entries) {
      expect(Object.keys(entry).sort()).toEqual(['defaultValue', 'deviates', 'setting', 'value']);
      expect(entry.deviates).toBe(false);
    }
  });

  it('lists nothing marked "no", whatever those options are set to', () => {
    const p = posture({
      connect: {
        backend: 'native',
        binaryPath: '/opt/claude',
        claudeCode: { binaryDigests: { '2.1.296': { 'linux-x64': 'a'.repeat(64) } } },
      },
      session: {
        cwd: '/work',
        onAuthFailure: 'harness-retry',
        onOversizedFrame: 'skip',
        maxFrameBytes: 2_000_000,
        maxOutboundFrameBytes: 2_000_000,
        firstFrameTimeoutMs: 5000,
        idleStallMs: 5000,
        closeTimeoutMs: 5000,
        termination: { interruptWaitMs: 1500 },
        trace: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
        events: { maxEvents: 5 },
        claudeCode: {
          model: 'opus',
          maxTurns: 3,
          includePartialMessages: true,
          appendSystemPrompt: 'be brief',
          backgroundWaitCeilingMs: 5000,
        },
      },
    });
    expect(postureDeviations(p)).toEqual([]);
    const text = serializePosture(p);
    for (const value of ['/opt/claude', '/work', 'opus', 'be brief', '0af7651916cd43dd']) {
      expect(text).not.toContain(value);
    }
  });

  it('lists the connect settings, managedPolicy and the raw names for the Harness', () => {
    const p = posture({ harnessOnly: true });
    expect(p.entries.map((entry) => entry.setting)).toEqual([
      ...CONNECT_SETTINGS,
      'managedPolicy',
      'raw.extraArgs',
      'raw.extraEnv',
    ]);
  });
});

// ---- no weakened default is silent (ADR-0012 §7) ----------------------------------------

describe('security-weakening opt-ins are flagged', () => {
  const cases: readonly (readonly [string, Build, readonly string[]])[] = [
    [
      'binaryVerification strict',
      { connect: { binaryVerification: 'strict' } },
      ['binaryVerification'],
    ],
    [
      'isolated configDir',
      { connect: { claudeCode: { configDir: '/cfg' } } },
      ['claudeCode.configDir'],
    ],
    ['bare', { connect: { claudeCode: { bare: true } } }, ['claudeCode.bare']],
    [
      'dangerouslyAllowRawControl',
      { connect: { claudeCode: { dangerouslyAllowRawControl: true } } },
      ['claudeCode.dangerouslyAllowRawControl'],
    ],
    [
      'dangerouslyAllowKnownBrokenVersion',
      { connect: { claudeCode: { dangerouslyAllowKnownBrokenVersion: true } } },
      ['claudeCode.dangerouslyAllowKnownBrokenVersion'],
    ],
    ['permissionMode auto', { session: { permissionMode: 'auto' } }, ['permissionMode']],
    [
      'dangerouslyAllowBypassPermissions',
      { session: { dangerouslyAllowBypassPermissions: true } },
      ['dangerouslyAllowBypassPermissions'],
    ],
    [
      'bypassPermissions',
      { session: { permissionMode: 'bypassPermissions', dangerouslyAllowBypassPermissions: true } },
      ['permissionMode', 'dangerouslyAllowBypassPermissions'],
    ],
    [
      'onPermission',
      { session: { onPermission: () => Promise.resolve({ behavior: 'deny', message: 'no' }) } },
      ['permissionPrompting'],
    ],
    [
      "workspaceTrust 'full'",
      { session: { workspaceTrust: 'full' } },
      ['workspaceTrust', 'claudeCode.settingSources'],
    ],
    [
      "projectCredentialEnv 'allow'",
      { session: { workspaceTrust: 'full', projectCredentialEnv: 'allow' } },
      ['workspaceTrust', 'claudeCode.settingSources', 'projectCredentialEnv'],
    ],
    [
      'settingSources with local',
      { session: { claudeCode: { settingSources: ['user', 'local'] } } },
      ['workspaceTrust', 'claudeCode.settingSources'],
    ],
    ["env 'inherit'", { session: { env: 'inherit' } }, ['env']],
    ["env { preset: 'inherit' }", { session: { env: { preset: 'inherit' } } }, ['env']],
    ['env map', { session: { env: { PATH: '/bin' } } }, ['env']],
    [
      'env add credential',
      { session: { env: { preset: 'harness', add: { ANTHROPIC_API_KEY: 'k' } } } },
      ['env', 'env.credentialAndRoutingVariables'],
    ],
    [
      'env add routing',
      { session: { env: { preset: 'harness', add: { ANTHROPIC_BASE_URL: 'http://h' } } } },
      ['env', 'env.credentialAndRoutingVariables', 'managedPolicy'],
    ],
    [
      'env map provider switch',
      { session: { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'r' } } },
      ['env', 'env.credentialAndRoutingVariables', 'managedPolicy'],
    ],
    [
      "autoUpdate 'harness-default'",
      { session: { autoUpdate: 'harness-default' } },
      ['autoUpdate'],
    ],
    [
      "nonessentialTraffic 'harness-default'",
      { session: { nonessentialTraffic: 'harness-default' } },
      ['nonessentialTraffic'],
    ],
    [
      'dangerouslyAllowConfigWrites',
      { session: { dangerouslyAllowConfigWrites: true } },
      ['dangerouslyAllowConfigWrites'],
    ],
    [
      'allowedTools',
      { session: { claudeCode: { allowedTools: ['Bash(ls)'] } } },
      ['claudeCode.allowedTools'],
    ],
    [
      'disallowedTools',
      { session: { claudeCode: { disallowedTools: ['Bash'] } } },
      ['claudeCode.disallowedTools'],
    ],
    [
      'additionalDirectories',
      { session: { claudeCode: { additionalDirectories: ['/x'] } } },
      ['claudeCode.additionalDirectories'],
    ],
    ['raw extraArgs', { raw: { extraArgs: ['--debug'] } }, ['raw.extraArgs']],
    ['raw extraEnv', { raw: { extraEnv: { FOO: 'bar' } } }, ['raw.extraEnv']],
    [
      'raw extraEnv base URL',
      { raw: { extraEnv: { ANTHROPIC_BASE_URL: 'http://h' } } },
      ['managedPolicy', 'raw.extraEnv'],
    ],
    [
      'custom base URL in the child env',
      { env: { ANTHROPIC_BASE_URL: 'http://h' } },
      ['managedPolicy'],
    ],
    [
      'custom base URL in the user settings',
      { userSettings: { ...CLEAN, present: true, customBaseUrl: true } },
      ['managedPolicy'],
    ],
  ];

  it.each(cases)('%s', (_name, build, expected) => {
    expect(deviating(build).sort()).toEqual([...expected].sort());
  });

  it('lists the credential and routing names added through env, by name', () => {
    const p = posture({
      session: {
        env: { preset: 'inherit', add: { ANTHROPIC_AUTH_TOKEN: 't', FOO: 'f' }, remove: ['BAR'] },
      },
    });
    expect(valueOf(p, 'env')).toEqual({
      form: 'object',
      preset: 'inherit',
      add: ['ANTHROPIC_AUTH_TOKEN', 'FOO'],
      remove: ['BAR'],
    });
    expect(valueOf(p, 'env.credentialAndRoutingVariables')).toEqual(['ANTHROPIC_AUTH_TOKEN']);
  });

  it('lists raw names only: flag names without values, variable names without values', () => {
    const p = posture({
      raw: {
        extraArgs: ['--mcp-config=SECRETVALUE', 'POSITIONALVALUE', '-x', '--debug', '--debug'],
        extraEnv: { ZED: 'SECRETVALUE', ALPHA: 'SECRETVALUE' },
      },
    });
    expect(valueOf(p, 'raw.extraArgs')).toEqual(['--debug', '--mcp-config', '-x']);
    expect(valueOf(p, 'raw.extraEnv')).toEqual(['ALPHA', 'ZED']);
    expect(serializePosture(p)).not.toMatch(/SECRETVALUE|POSITIONALVALUE/);
  });

  it('never carries an environment, argument or settings value', () => {
    const marker = fc.string({ minLength: 1, maxLength: 12 }).map((s) => `SECRET-${s}-SECRET`);
    fc.assert(
      fc.property(marker, (secret) => {
        const text = serializePosture(
          posture({
            connect: { claudeCode: { configDir: `/home/${secret}` } },
            session: {
              env: {
                preset: 'inherit',
                add: { ANTHROPIC_API_KEY: secret, ANTHROPIC_BASE_URL: secret },
              },
            },
            env: { ANTHROPIC_API_KEY: secret, CLAUDE_CONFIG_DIR: secret },
            raw: { extraArgs: [`--settings=${secret}`, secret], extraEnv: { X: secret } },
          }),
        );
        expect(text).not.toContain('SECRET');
      }),
      { numRuns: 50 },
    );
  });

  it('round-trips through JSON', () => {
    const p = posture({
      session: { workspaceTrust: 'full', projectCredentialEnv: 'allow', env: 'inherit' },
      env: { CLAUDE_CODE_USE_VERTEX: '1' },
    });
    const parsed = parsePosture(serializePosture(p));
    expect(parsed).toEqual({ ok: true, posture: p });
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

// ---- managedPolicy (K23) ----------------------------------------------------------------

describe('managedPolicyOf', () => {
  const base = { env: {}, named: [], userSettings: CLEAN, platform: 'posix' } as const;

  it('is fetched-if-eligible by default', () => {
    expect(managedPolicyOf(base)).toBe('fetched-if-eligible');
    expect(valueOf(posture(), 'managedPolicy')).toBe('fetched-if-eligible');
  });

  it('reports a custom base URL from the child env, the options or the user settings', () => {
    expect(managedPolicyOf({ ...base, env: { ANTHROPIC_BASE_URL: 'http://h' } })).toBe(
      'not-fetched-custom-base-url',
    );
    expect(managedPolicyOf({ ...base, named: [{}, { ANTHROPIC_BASE_URL: 'http://h' }] })).toBe(
      'not-fetched-custom-base-url',
    );
    expect(
      managedPolicyOf({ ...base, userSettings: { ...CLEAN, present: true, customBaseUrl: true } }),
    ).toBe('not-fetched-custom-base-url');
  });

  it('ignores blank and unset base URLs and other base URL variables', () => {
    expect(
      managedPolicyOf({
        ...base,
        env: { ANTHROPIC_BASE_URL: '  ', ANTHROPIC_BEDROCK_BASE_URL: 'http://h' },
      }),
    ).toBe('fetched-if-eligible');
    expect(
      managedPolicyOf({
        ...base,
        env: { ANTHROPIC_BASE_URL: undefined },
      }),
    ).toBe('fetched-if-eligible');
  });

  it('compares names as the OS does', () => {
    const env = { anthropic_base_url: 'http://h' };
    expect(managedPolicyOf({ ...base, env })).toBe('fetched-if-eligible');
    expect(managedPolicyOf({ ...base, env, platform: 'win32' })).toBe(
      'not-fetched-custom-base-url',
    );
  });

  it('reports a third-party provider switch that is on', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      expect(managedPolicyOf({ ...base, env: { CLAUDE_CODE_USE_FOUNDRY: value } })).toBe(
        'not-applicable-third-party-provider',
      );
    }
    for (const value of ['0', 'false', '', 'enabled']) {
      expect(managedPolicyOf({ ...base, env: { CLAUDE_CODE_USE_BEDROCK: value } })).toBe(
        'fetched-if-eligible',
      );
    }
    expect(
      managedPolicyOf({
        ...base,
        userSettings: { ...CLEAN, present: true, thirdPartyProvider: true },
      }),
    ).toBe('not-applicable-third-party-provider');
  });

  it('puts the base URL first, then the provider, then an unreadable settings file', () => {
    const unreadable = { ...CLEAN, present: true, readable: false };
    expect(
      managedPolicyOf({
        ...base,
        env: { ANTHROPIC_BASE_URL: 'http://h', CLAUDE_CODE_USE_VERTEX: '1' },
        userSettings: unreadable,
      }),
    ).toBe('not-fetched-custom-base-url');
    expect(
      managedPolicyOf({ ...base, env: { CLAUDE_CODE_USE_VERTEX: '1' }, userSettings: unreadable }),
    ).toBe('not-applicable-third-party-provider');
    expect(managedPolicyOf({ ...base, userSettings: unreadable })).toBe(
      'unknown-user-settings-unreadable',
    );
  });

  it('reports guard findings in project or local settings under allow (ruling 3)', () => {
    expect(projectSettingsFlagsOf([])).toEqual({ customBaseUrl: false, thirdPartyProvider: false });
    expect(projectSettingsFlagsOf(['anthropic_base_url', 'ANTHROPIC_API_KEY'])).toEqual({
      customBaseUrl: true,
      thirdPartyProvider: false,
    });
    expect(projectSettingsFlagsOf(['Claude_Code_Use_Bedrock'])).toEqual({
      customBaseUrl: false,
      thirdPartyProvider: true,
    });
    // Other credential or routing names are refused by the guard but do not
    // decide the managed-policy fetch.
    expect(projectSettingsFlagsOf(['ANTHROPIC_BEDROCK_BASE_URL', 'HTTPS_PROXY'])).toEqual({
      customBaseUrl: false,
      thirdPartyProvider: false,
    });
    expect(
      managedPolicyOf({ ...base, projectSettings: projectSettingsFlagsOf(['ANTHROPIC_BASE_URL']) }),
    ).toBe('not-fetched-custom-base-url');
    expect(
      managedPolicyOf({
        ...base,
        projectSettings: projectSettingsFlagsOf(['CLAUDE_CODE_USE_VERTEX']),
      }),
    ).toBe('not-applicable-third-party-provider');
    const p = posture({
      session: { workspaceTrust: 'full', projectCredentialEnv: 'allow' },
      projectSettings: projectSettingsFlagsOf(['ANTHROPIC_BASE_URL']),
    });
    expect(valueOf(p, 'managedPolicy')).toBe('not-fetched-custom-base-url');
    expect(valueOf(posture({ projectSettings: projectSettingsFlagsOf([]) }), 'managedPolicy')).toBe(
      'fetched-if-eligible',
    );
  });

  it('reports raw --settings as unknown, after the known causes (ruling 3)', () => {
    for (const extraArgs of [['--settings=/x.json'], ['--settings', '/x.json']]) {
      expect(valueOf(posture({ raw: { extraArgs } }), 'managedPolicy')).toBe(
        'unknown-raw-settings',
      );
    }
    // Not a --settings flag: a value, another flag, or a prefix of another name.
    for (const extraArgs of [['settings'], ['--setting-sources=user'], ['--settingsx=1']]) {
      expect(valueOf(posture({ raw: { extraArgs } }), 'managedPolicy')).toBe('fetched-if-eligible');
    }
    const unreadable = { ...CLEAN, present: true, readable: false };
    expect(managedPolicyOf({ ...base, rawSettings: true, userSettings: unreadable })).toBe(
      'unknown-raw-settings',
    );
    expect(
      managedPolicyOf({ ...base, rawSettings: true, env: { ANTHROPIC_BASE_URL: 'http://h' } }),
    ).toBe('not-fetched-custom-base-url');
    expect(
      managedPolicyOf({ ...base, rawSettings: true, env: { CLAUDE_CODE_USE_VERTEX: '1' } }),
    ).toBe('not-applicable-third-party-provider');
    expect(managedPolicyOf({ ...base, rawSettings: false })).toBe('fetched-if-eligible');
  });

  it('follows env remove: a removed base URL is not in the child env', () => {
    const p = posture({
      session: { env: { preset: 'harness', remove: ['ANTHROPIC_BASE_URL'] } },
      env: {},
    });
    expect(valueOf(p, 'managedPolicy')).toBe('fetched-if-eligible');
  });
});

// ---- the user settings file (K23) -------------------------------------------------------

/** An in-memory reader that records every call. */
function fakeReader(
  files: Readonly<Record<string, Uint8Array | string | Error>>,
): SettingsFileReader & { readonly calls: (readonly [string, number])[] } {
  const calls: (readonly [string, number])[] = [];
  return {
    calls,
    readPrefix(filePath, limit) {
      calls.push([filePath, limit]);
      const file = files[filePath];
      if (file === undefined) return Promise.resolve('absent');
      if (file instanceof Error) return Promise.reject(file);
      const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file;
      return Promise.resolve(bytes.subarray(0, limit));
    },
  };
}

const POSIX_FILE = '/cfg/settings.json';

async function scan(
  content: Uint8Array | string | Error | undefined,
  platform: 'posix' | 'win32' = 'posix',
): Promise<UserSettingsEnvScan> {
  const configDir = platform === 'win32' ? 'C:\\cfg' : '/cfg';
  const file = platform === 'win32' ? 'C:\\cfg\\settings.json' : POSIX_FILE;
  const reader = fakeReader(content === undefined ? {} : { [file]: content });
  const result = await scanUserSettingsEnv({ configDir: () => configDir, reader, platform });
  expect(reader.calls).toEqual([[file, USER_SETTINGS_MAX_BYTES + 1]]);
  return result;
}

describe('scanUserSettingsEnv', () => {
  it('reports an absent file as present: false, readable', async () => {
    expect(await scan(undefined)).toEqual(CLEAN);
  });

  it('finds the base URL and provider switches in env, booleans only', async () => {
    expect(await scan('{"env":{"ANTHROPIC_BASE_URL":"https://proxy.example"}}')).toEqual({
      present: true,
      readable: true,
      customBaseUrl: true,
      thirdPartyProvider: false,
    });
    expect(await scan('{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}')).toEqual({
      present: true,
      readable: true,
      customBaseUrl: false,
      thirdPartyProvider: true,
    });
    expect(await scan('{"env":{"CLAUDE_CODE_USE_VERTEX":true,"ANTHROPIC_BASE_URL":1}}')).toEqual({
      present: true,
      readable: true,
      customBaseUrl: true,
      thirdPartyProvider: true,
    });
  });

  it('ignores other keys, non-object env and non-scalar values', async () => {
    const none = { present: true, readable: true, customBaseUrl: false, thirdPartyProvider: false };
    expect(await scan('{}')).toEqual(none);
    expect(await scan('{"env":"ANTHROPIC_BASE_URL"}')).toEqual(none);
    expect(await scan('{"env":["ANTHROPIC_BASE_URL"]}')).toEqual(none);
    expect(
      await scan(
        '{"ANTHROPIC_BASE_URL":"x","env":{"ANTHROPIC_BASE_URL":null,"CLAUDE_CODE_USE_X":{}}}',
      ),
    ).toEqual(none);
    expect(await scan('{"env":{"__proto__":{"ANTHROPIC_BASE_URL":"x"}}}')).toEqual(none);
    expect(await scan('{"env":{"anthropic_base_url":"x"}}')).toEqual(none);
  });

  it('compares names case-insensitively on win32', async () => {
    expect((await scan('{"env":{"anthropic_base_url":"x"}}', 'win32')).customBaseUrl).toBe(true);
  });

  it('accepts a UTF-8 BOM', async () => {
    expect((await scan('\uFEFF{"env":{"ANTHROPIC_BASE_URL":"x"}}')).customBaseUrl).toBe(true);
  });

  it('reports unreadable, oversized, non-UTF-8 and non-object files as unreadable', async () => {
    const unreadable = {
      present: true,
      readable: false,
      customBaseUrl: false,
      thirdPartyProvider: false,
    };
    expect(await scan(new Error('EACCES'))).toEqual(unreadable);
    expect(await scan('{"env":')).toEqual(unreadable);
    expect(await scan('[]')).toEqual(unreadable);
    expect(await scan('"x"')).toEqual(unreadable);
    expect(await scan(new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual(unreadable);
    expect(await scan(`${'['.repeat(600)}${']'.repeat(600)}`)).toEqual(unreadable);
    const big = `{"env":{"ANTHROPIC_BASE_URL":"x"},"pad":"${'a'.repeat(USER_SETTINGS_MAX_BYTES)}"}`;
    expect(await scan(big)).toEqual(unreadable);
    const exact = `{"pad":"${'a'.repeat(USER_SETTINGS_MAX_BYTES - 10)}"}`;
    expect(new TextEncoder().encode(exact).length).toBe(USER_SETTINGS_MAX_BYTES);
    expect((await scan(exact)).readable).toBe(true);
  });

  it('reports a failing config dir resolver as unreadable', async () => {
    const reader = fakeReader({});
    const result = await scanUserSettingsEnv({
      configDir: () => {
        throw new Error('no home');
      },
      reader,
      platform: 'posix',
    });
    expect(result.readable).toBe(false);
    expect(reader.calls).toEqual([]);
  });

  it('returns booleans only: no input value appears in the output', async () => {
    const key = fc.oneof(
      fc.constantFrom('ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'),
      fc.string(),
    );
    const value = fc.oneof(
      fc.constantFrom('1', 'true', 'on'),
      fc.string({ minLength: 1 }).map((s) => `V4LUE${s}`),
    );
    await fc.assert(
      fc.asyncProperty(fc.dictionary(key, value), fc.jsonValue(), async (env, extra) => {
        const text = JSON.stringify({ env, extra });
        const result = await scan(text);
        expect(Object.keys(result).sort()).toEqual([
          'customBaseUrl',
          'present',
          'readable',
          'thirdPartyProvider',
        ]);
        for (const item of Object.values(result)) expect(typeof item).toBe('boolean');
        const out = JSON.stringify(result);
        expect(out).not.toContain('V4LUE');
        expect(out).not.toMatch(/ANTHROPIC|CLAUDE_CODE|cfg/);
      }),
      { numRuns: 200 },
    );
  });
});

describe('userConfigDir', () => {
  it('prefers the configDir option, then CLAUDE_CONFIG_DIR, then <home>/.claude', () => {
    const env = { CLAUDE_CONFIG_DIR: '/env-cfg' };
    expect(userConfigDir({ configDir: '/opt', env, homedir: '/h', platform: 'posix' })).toBe(
      '/opt',
    );
    expect(userConfigDir({ configDir: null, env, homedir: '/h', platform: 'posix' })).toBe(
      '/env-cfg',
    );
    expect(
      userConfigDir({
        configDir: null,
        env: { CLAUDE_CONFIG_DIR: '' },
        homedir: '/h',
        platform: 'posix',
      }),
    ).toBe('/h/.claude');
    expect(
      userConfigDir({
        configDir: null,
        env: { CLAUDE_CONFIG_DIR: undefined },
        homedir: '/h',
        platform: 'posix',
      }),
    ).toBe('/h/.claude');
    expect(
      userConfigDir({
        configDir: null,
        env: { claude_config_dir: '/x' },
        homedir: '/h',
        platform: 'posix',
      }),
    ).toBe('/h/.claude');
    expect(
      userConfigDir({
        configDir: null,
        env: { claude_config_dir: 'D:\\x' },
        homedir: 'E:\\profiles\\u',
        platform: 'win32',
      }),
    ).toBe('D:\\x');
    expect(
      userConfigDir({ configDir: null, env: {}, homedir: 'E:\\profiles\\u', platform: 'win32' }),
    ).toBe('E:\\profiles\\u\\.claude');
  });
});

// ---- the real reader, on a temporary directory only --------------------------------------

describe('nodeSettingsFileReader', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hudhud-posture-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a prefix of at most limit bytes, read-only', async () => {
    const file = path.join(dir, 'settings.json');
    writeFileSync(file, '{"env":{"ANTHROPIC_BASE_URL":"x"}}');
    const all = await nodeSettingsFileReader.readPrefix(file, 1000);
    expect(new TextDecoder().decode(all as Uint8Array)).toBe('{"env":{"ANTHROPIC_BASE_URL":"x"}}');
    const head = await nodeSettingsFileReader.readPrefix(file, 4);
    expect(new TextDecoder().decode(head as Uint8Array)).toBe('{"en');
    const scanned = await scanUserSettingsEnv({
      configDir: () => dir,
      reader: nodeSettingsFileReader,
      platform: process.platform === 'win32' ? 'win32' : 'posix',
    });
    expect(scanned.customBaseUrl).toBe(true);
  });

  it('reports a missing file or directory as absent and never creates it', async () => {
    const missing = path.join(dir, 'missing', 'settings.json');
    expect(await nodeSettingsFileReader.readPrefix(missing, 10)).toBe('absent');
    const notDir = path.join(dir, 'plain');
    writeFileSync(notDir, 'x');
    expect(await nodeSettingsFileReader.readPrefix(path.join(notDir, 'settings.json'), 10)).toBe(
      'absent',
    );
    expect(
      await scanUserSettingsEnv({
        configDir: () => path.join(dir, 'missing'),
        reader: nodeSettingsFileReader,
        platform: 'posix',
      }),
    ).toEqual(CLEAN);
    expect(await nodeSettingsFileReader.readPrefix(missing, 10)).toBe('absent');
  });

  it('rejects other failures, which the scan reports as unreadable', async () => {
    await expect(nodeSettingsFileReader.readPrefix(path.join(dir, 'a\0b'), 10)).rejects.toThrow();
    const sub = path.join(dir, 'is-a-dir');
    mkdirSync(path.join(sub, 'settings.json'), { recursive: true });
    await expect(
      nodeSettingsFileReader.readPrefix(path.join(sub, 'settings.json'), 10),
    ).rejects.toThrow();
    expect(
      await scanUserSettingsEnv({
        configDir: () => sub,
        reader: nodeSettingsFileReader,
        platform: 'posix',
      }),
    ).toEqual({ present: true, readable: false, customBaseUrl: false, thirdPartyProvider: false });
  });

  it.runIf(process.platform !== 'win32')(
    'follows a symlinked settings file for reading',
    async () => {
      const target = path.join(dir, 'target.json');
      writeFileSync(target, '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}');
      const linkDir = path.join(dir, 'linked');
      mkdirSync(linkDir);
      symlinkSync(target, path.join(linkDir, 'settings.json'));
      expect(
        (
          await scanUserSettingsEnv({
            configDir: () => linkDir,
            reader: nodeSettingsFileReader,
            platform: 'posix',
          })
        ).thirdPartyProvider,
      ).toBe(true);
    },
  );
});
