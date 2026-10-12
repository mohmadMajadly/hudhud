// Option validation, cross-field rules, defaults and posture fields
// (plan §2.3, §2.4; ADR-0012).

import { CapabilityUnsupportedError, InvalidOptionsError, type JsonObject } from '@hudhud/core';
import { describe, expect, it } from 'vitest';

import {
  checkSessionId,
  OPTION_DEFAULTS,
  pointerToPath,
  resolveConnectOptions,
  resolveConnectSessionOptions,
  resolveResumeOptions,
  resolveSessionOptions,
  type EffectiveSessionOptions,
  type PostureField,
} from '../../src/options.js';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function invalid(fn: () => unknown, path: string, rule: string): InvalidOptionsError {
  const error = thrown(fn);
  expect(error).toBeInstanceOf(InvalidOptionsError);
  const e = error as InvalidOptionsError;
  expect(e.code).toBe('INVALID_OPTIONS');
  expect(e.details).toMatchObject({ path, rule });
  return e;
}

function unsupported(fn: () => unknown, capability: string): void {
  const error = thrown(fn);
  expect(error).toBeInstanceOf(CapabilityUnsupportedError);
  expect((error as CapabilityUnsupportedError).details).toMatchObject({ capability });
}

const session = (input: unknown): EffectiveSessionOptions => resolveSessionOptions(input).effective;

function postureOf(fields: readonly PostureField[]): Record<string, PostureField> {
  return Object.fromEntries(fields.map((f) => [f.setting, f]));
}

function field(input: unknown, setting: string): PostureField {
  const found = postureOf(session(input).posture)[setting];
  if (found === undefined) throw new Error(`no posture field ${setting}`);
  return found;
}

/** Posture fields whose value differs from the default (deep JSON equality). */
function deviating(fields: readonly PostureField[]): string[] {
  return fields
    .filter((f) => JSON.stringify(f.value) !== JSON.stringify(f.defaultValue))
    .map((f) => f.setting);
}

const handler = (): Promise<unknown> => Promise.resolve({ behavior: 'deny', message: 'no' });

describe('defaults (plan §2.4)', () => {
  it('resolves every session default', () => {
    const effective = session(undefined);
    expect(effective).toEqual({
      cwd: null,
      permissionMode: 'default',
      dangerouslyAllowBypassPermissions: false,
      permissionPrompting: 'none',
      settingSources: ['user'],
      settingSourcesFrom: 'workspaceTrust',
      projectCredentialEnv: null,
      env: { form: 'preset', preset: 'harness', add: {}, remove: [] },
      autoUpdate: 'disabled',
      nonessentialTraffic: 'disabled',
      dangerouslyAllowConfigWrites: false,
      onAuthFailure: 'fail-fast',
      onOversizedFrame: 'fail',
      maxFrameBytes: 67_108_864,
      maxOutboundFrameBytes: 33_554_432,
      firstFrameTimeoutMs: 60_000,
      idleStallMs: 300_000,
      closeTimeoutMs: 30_000,
      termination: {
        interruptWaitMs: 1000,
        eofGraceMs: 2000,
        termGraceMs: 5000,
        taskkillGraceMs: 2000,
      },
      trace: null,
      claudeCode: {
        model: null,
        allowedTools: [],
        disallowedTools: [],
        additionalDirectories: [],
        maxTurns: null,
        includePartialMessages: false,
        appendSystemPrompt: null,
        backgroundWaitCeilingMs: 600_000,
      },
      events: { maxEvents: 10_000, maxBytes: 67_108_864, overflow: 'error' },
      posture: effective.posture,
    });
    expect(session({})).toEqual(effective);
    expect(deviating(effective.posture)).toEqual([]);
  });

  it('is plain JSON', () => {
    const effective = session({
      onPermission: handler,
      signal: new AbortController().signal,
      events: { signal: new AbortController().signal },
    });
    expect(JSON.parse(JSON.stringify(effective))).toEqual(effective);
  });

  it('resolves every connect default', () => {
    expect(resolveConnectOptions(undefined)).toEqual({
      effective: {
        backend: 'native',
        binaryPath: null,
        binaryVerification: 'advisory',
        configDir: null,
        bare: false,
        binaryDigests: {},
        dangerouslyAllowRawControl: false,
        posture: [
          { setting: 'binaryVerification', value: 'advisory', defaultValue: 'advisory' },
          { setting: 'claudeCode.configDir', value: 'user', defaultValue: 'user' },
          { setting: 'claudeCode.bare', value: false, defaultValue: false },
          {
            setting: 'claudeCode.dangerouslyAllowRawControl',
            value: false,
            defaultValue: false,
          },
        ],
      },
    });
  });

  it('keeps every given value', () => {
    const effective = session({
      cwd: '/work',
      onAuthFailure: 'harness-retry',
      onOversizedFrame: 'skip',
      maxFrameBytes: 1_048_576,
      maxOutboundFrameBytes: 1_073_741_824,
      firstFrameTimeoutMs: 1000,
      idleStallMs: 86_400_000,
      closeTimeoutMs: 5000,
      termination: {
        interruptWaitMs: 1500,
        eofGraceMs: 3000,
        termGraceMs: 4000,
        taskkillGraceMs: 6000,
      },
      trace: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        tracestate: 'a=b',
      },
      claudeCode: {
        model: 'claude-x',
        maxTurns: 3,
        includePartialMessages: true,
        appendSystemPrompt: 'be brief',
        backgroundWaitCeilingMs: 1000,
      },
      events: { maxEvents: 5, maxBytes: 1024, overflow: 'block' },
    });
    expect(effective).toMatchObject({
      cwd: '/work',
      onAuthFailure: 'harness-retry',
      onOversizedFrame: 'skip',
      maxFrameBytes: 1_048_576,
      maxOutboundFrameBytes: 1_073_741_824,
      firstFrameTimeoutMs: 1000,
      idleStallMs: 86_400_000,
      closeTimeoutMs: 5000,
      termination: {
        interruptWaitMs: 1500,
        eofGraceMs: 3000,
        termGraceMs: 4000,
        taskkillGraceMs: 6000,
      },
      trace: {
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        tracestate: 'a=b',
      },
      claudeCode: {
        model: 'claude-x',
        maxTurns: 3,
        includePartialMessages: true,
        appendSystemPrompt: 'be brief',
        backgroundWaitCeilingMs: 1000,
      },
      events: { maxEvents: 5, maxBytes: 1024, overflow: 'block' },
    });
    expect(
      session({ trace: { traceparent: '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00' } })
        .trace,
    ).toEqual({
      traceparent: '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00',
      tracestate: null,
    });
    // Not security settings: no posture deviation.
    expect(deviating(effective.posture)).toEqual([]);
  });

  it('exposes the documented default table', () => {
    expect(OPTION_DEFAULTS).toMatchObject({
      permissionMode: 'default',
      workspaceTrust: 'none',
      env: 'harness',
      autoUpdate: 'disabled',
      nonessentialTraffic: 'disabled',
    });
  });
});

describe('securityPosture membership (plan §2.4)', () => {
  it('lists every security-relevant session option', () => {
    expect(session(undefined).posture.map((f) => f.setting)).toEqual([
      'permissionMode',
      'dangerouslyAllowBypassPermissions',
      'permissionPrompting',
      'workspaceTrust',
      'claudeCode.settingSources',
      'projectCredentialEnv',
      'env',
      'env.credentialAndRoutingVariables',
      'autoUpdate',
      'nonessentialTraffic',
      'dangerouslyAllowConfigWrites',
      'claudeCode.allowedTools',
      'claudeCode.disallowedTools',
      'claudeCode.additionalDirectories',
      'initialize.workspaceTrust',
      'permissionSuggestions',
    ]);
  });

  it.each([
    ['permissionMode', { permissionMode: 'auto' }, 'auto'],
    ['permissionMode', { permissionMode: 'acceptEdits' }, 'acceptEdits'],
    [
      'dangerouslyAllowBypassPermissions',
      { permissionMode: 'bypassPermissions', dangerouslyAllowBypassPermissions: true },
      true,
    ],
    ['permissionPrompting', { onPermission: handler }, 'stdio'],
    ['workspaceTrust', { workspaceTrust: 'full' }, 'full'],
    ['claudeCode.settingSources', { workspaceTrust: 'full' }, ['user', 'project', 'local']],
    ['claudeCode.settingSources', { claudeCode: { settingSources: [] } }, []],
    ['projectCredentialEnv', { workspaceTrust: 'full', projectCredentialEnv: 'allow' }, 'allow'],
    ['env', { env: 'inherit' }, 'inherit'],
    ['env', { env: { A: '1', B: '2' } }, { form: 'map', names: ['A', 'B'] }],
    [
      'env',
      { env: { preset: 'harness', add: { Z: '1', A: '2' }, remove: ['Q', 'B'] } },
      { form: 'object', preset: 'harness', add: ['A', 'Z'], remove: ['B', 'Q'] },
    ],
    ['env', { env: { preset: 'inherit' } }, 'inherit'],
    [
      'env.credentialAndRoutingVariables',
      { env: { preset: 'harness', add: { ANTHROPIC_BASE_URL: 'http://x', FOO: '1' } } },
      ['ANTHROPIC_BASE_URL'],
    ],
    [
      'env.credentialAndRoutingVariables',
      { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'x', PATH: '/bin' } },
      ['AWS_REGION', 'CLAUDE_CODE_USE_BEDROCK'],
    ],
    ['autoUpdate', { autoUpdate: 'harness-default' }, 'harness-default'],
    ['nonessentialTraffic', { nonessentialTraffic: 'harness-default' }, 'harness-default'],
    ['dangerouslyAllowConfigWrites', { dangerouslyAllowConfigWrites: true }, true],
    ['claudeCode.allowedTools', { claudeCode: { allowedTools: ['Read'] } }, ['Read']],
    ['claudeCode.disallowedTools', { claudeCode: { disallowedTools: ['Bash'] } }, ['Bash']],
    [
      'claudeCode.additionalDirectories',
      { claudeCode: { additionalDirectories: ['/srv/data'] } },
      ['/srv/data'],
    ],
  ])('%s deviates for %j', (setting, input, value) => {
    const fields = session(input).posture;
    expect(postureOf(fields)[setting]?.value).toEqual(value);
    expect(deviating(fields)).toContain(setting);
  });

  it('derives workspaceTrust from explicit setting sources', () => {
    expect(field({ claudeCode: { settingSources: ['user'] } }, 'workspaceTrust').value).toBe(
      'none',
    );
    expect(
      field({ claudeCode: { settingSources: ['local', 'user', 'project'] } }, 'workspaceTrust')
        .value,
    ).toBe('full');
    expect(
      field({ claudeCode: { settingSources: ['user', 'project'] } }, 'workspaceTrust').value,
    ).toBeNull();
    expect(field({ claudeCode: { settingSources: [] } }, 'workspaceTrust').value).toBeNull();
    expect(deviating(session({ claudeCode: { settingSources: ['user'] } }).posture)).toEqual([]);
  });

  it('defaults projectCredentialEnv to refuse when project or local sources load', () => {
    expect(field({ workspaceTrust: 'full' }, 'projectCredentialEnv')).toEqual({
      setting: 'projectCredentialEnv',
      value: 'refuse',
      defaultValue: 'refuse',
    });
    expect(field({ claudeCode: { settingSources: ['local'] } }, 'projectCredentialEnv').value).toBe(
      'refuse',
    );
    expect(
      session({ claudeCode: { settingSources: ['project'] }, projectCredentialEnv: 'allow' })
        .projectCredentialEnv,
    ).toBe('allow');
    expect(field({}, 'projectCredentialEnv')).toEqual({
      setting: 'projectCredentialEnv',
      value: null,
      defaultValue: null,
    });
  });

  it('lists every security-relevant connect option', () => {
    const { effective } = resolveConnectOptions({
      binaryVerification: 'strict',
      claudeCode: { configDir: '/tmp/cfg', bare: true, dangerouslyAllowRawControl: true },
    });
    expect(effective.posture).toEqual([
      { setting: 'binaryVerification', value: 'strict', defaultValue: 'advisory' },
      // The kind only, never the path.
      { setting: 'claudeCode.configDir', value: 'isolated', defaultValue: 'user' },
      { setting: 'claudeCode.bare', value: true, defaultValue: false },
      { setting: 'claudeCode.dangerouslyAllowRawControl', value: true, defaultValue: false },
    ]);
    expect(JSON.stringify(effective.posture)).not.toContain('/tmp/cfg');
  });

  it('never puts an environment value into the posture', () => {
    const fields = session({
      env: { preset: 'inherit', add: { ANTHROPIC_API_KEY: 'fake-api-key-value' } },
    }).posture;
    expect(JSON.stringify(fields)).not.toContain('fake-api-key-value');
    const map = session({ env: { ANTHROPIC_AUTH_TOKEN: 'tok-secret-value' } }).posture;
    expect(JSON.stringify(map)).not.toContain('tok-secret-value');
  });
});

describe('strict validation (generated schema)', () => {
  it.each([
    [{ bogus: 1 }, ''],
    [{ claudeCode: { bogus: 1 } }, 'claudeCode'],
    [{ termination: { bogus: 1 } }, 'termination'],
    [
      { trace: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', x: 1 } },
      'trace',
    ],
    [{ events: { bogus: 1 } }, 'events'],
    [{ env: { preset: 'harness', bogus: {} } }, 'env'],
    [{ allowedTools: ['Read'] }, ''],
  ])('refuses the unknown key in %j', (input, path) => {
    const e = invalid(() => session(input), path, 'schema');
    expect(e.details).toMatchObject({ keyword: expect.any(String) as unknown });
  });

  it('names an unknown key in the message', () => {
    expect(invalid(() => session({ bogus: 1 }), '', 'schema').message).toBe(
      'options has an unknown key (see options.schema.json)',
    );
    expect(invalid(() => session({ trace: {} }), 'trace', 'schema').message).toBe(
      'options.trace is missing a required key (see options.schema.json)',
    );
    expect(invalid(() => session({ maxTurns: 1 }), '', 'schema').message).toContain('unknown key');
    expect(invalid(() => session({ idleStallMs: 999 }), 'idleStallMs', 'schema').message).toBe(
      'options.idleStallMs fails the schema keyword "minimum" (see options.schema.json)',
    );
  });

  it.each([
    ['maxFrameBytes', 1_048_575],
    ['maxFrameBytes', 1_073_741_825],
    ['maxOutboundFrameBytes', 1_048_575],
    ['maxOutboundFrameBytes', 1_073_741_825],
    ['firstFrameTimeoutMs', 999],
    ['firstFrameTimeoutMs', 86_400_001],
    ['idleStallMs', 999],
    ['closeTimeoutMs', 86_400_001],
    ['closeTimeoutMs', 1500.5],
  ])('refuses %s = %d', (key, value) => {
    invalid(() => session({ [key]: value }), key, 'schema');
  });

  it.each([
    [{ termination: { interruptWaitMs: 999 } }, 'termination.interruptWaitMs'],
    [{ termination: { taskkillGraceMs: 86_400_001 } }, 'termination.taskkillGraceMs'],
    [{ claudeCode: { backgroundWaitCeilingMs: 0 } }, 'claudeCode.backgroundWaitCeilingMs'],
    [{ claudeCode: { maxTurns: 0 } }, 'claudeCode.maxTurns'],
    [{ claudeCode: { maxTurns: 2_147_483_648 } }, 'claudeCode.maxTurns'],
    [{ claudeCode: { model: '' } }, 'claudeCode.model'],
    [{ claudeCode: { additionalDirectories: [''] } }, 'claudeCode.additionalDirectories[0]'],
    [{ claudeCode: { settingSources: ['user', 'user'] } }, 'claudeCode.settingSources'],
    [{ claudeCode: { settingSources: ['managed'] } }, 'claudeCode.settingSources[0]'],
    [{ events: { maxEvents: 0 } }, 'events.maxEvents'],
    [{ events: { overflow: 'drop' } }, 'events.overflow'],
    [{ events: 5 }, 'events'],
    [{ permissionMode: 'manual' }, 'permissionMode'],
    [{ workspaceTrust: 'partial' }, 'workspaceTrust'],
    [{ cwd: '' }, 'cwd'],
    [{ env: 'none' }, 'env'],
    [{ env: { 'BAD-NAME': '1' } }, 'env'],
    [{ env: { '1ABC': '1' } }, 'env'],
    [{ env: { A: 1 } }, 'env'],
    [{ env: { preset: 'everything' } }, 'env'],
    [{ env: { preset: 'harness', remove: ['A', 'A'] } }, 'env'],
    [{ env: { preset: 'harness', add: { 'A=B': 'x' } } }, 'env'],
    [{ trace: { traceparent: 'nope' } }, 'trace.traceparent'],
  ])('refuses %j', (input, path) => {
    invalid(() => session(input), path, 'schema');
  });

  it.each([
    '00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01',
    'ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    '00-00000000000000000000000000000000-b7ad6b7169203331-01',
    '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01',
    '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331',
    '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra',
  ])('refuses the traceparent %s (W3C format)', (traceparent) => {
    invalid(() => session({ trace: { traceparent } }), 'trace.traceparent', 'schema');
  });

  it('refuses a tracestate that is not short printable ASCII', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    invalid(
      () => session({ trace: { traceparent, tracestate: 'a=é' } }),
      'trace.tracestate',
      'schema',
    );
    invalid(
      () => session({ trace: { traceparent, tracestate: 'a'.repeat(513) } }),
      'trace.tracestate',
      'schema',
    );
  });

  it('accepts Windows (x86) variable names', () => {
    expect(session({ env: { 'ProgramFiles(x86)': 'C:\\PF' } }).env).toEqual({
      form: 'map',
      variables: { 'ProgramFiles(x86)': 'C:\\PF' },
    });
  });

  it('treats an object with a preset key as the object form, never as a map', () => {
    invalid(() => session({ env: { preset: 'harness', PATH: '/bin' } }), 'env', 'schema');
  });

  it('treats undefined properties as absent', () => {
    expect(
      session({ model: undefined, claudeCode: { model: undefined }, signal: undefined }),
    ).toEqual(session({}));
    expect(session({ events: undefined, onPermission: undefined })).toEqual(session({}));
  });

  it('copies the options: later mutation has no effect', () => {
    const tools = ['Read'];
    const effective = session({ claudeCode: { allowedTools: tools } });
    tools.push('Bash');
    expect(effective.claudeCode.allowedTools).toEqual(['Read']);
  });
});

describe('non-JSON input', () => {
  it.each([
    [null, ''],
    [[], ''],
    ['harness', ''],
    [new Map(), ''],
    [Object.create({ inherited: true }) as object, ''],
  ])('refuses %j as the options object', (input, path) => {
    invalid(() => session(input), path, 'not-an-object');
  });

  it('accepts a null-prototype options object', () => {
    const input = Object.assign(Object.create(null) as object, { permissionMode: 'plan' });
    expect(session(input).permissionMode).toBe('plan');
  });

  it.each([
    [{ claudeCode: { model: () => 'x' } }, 'claudeCode.model'],
    [{ claudeCode: { model: Symbol('x') } }, 'claudeCode.model'],
    [{ claudeCode: { maxTurns: 1n } }, 'claudeCode.maxTurns'],
    [{ claudeCode: { maxTurns: Number.NaN } }, 'claudeCode.maxTurns'],
    [{ idleStallMs: Number.POSITIVE_INFINITY }, 'idleStallMs'],
    [{ cwd: new Date(0) }, 'cwd'],
    [{ claudeCode: { allowedTools: ['Read', undefined] } }, 'claudeCode.allowedTools[1]'],
    // A sparse array has a hole.
    [{ claudeCode: { allowedTools: Array<string>(2) } }, 'claudeCode.allowedTools[0]'],
  ])('refuses %s', (input, path) => {
    invalid(() => session(input), path, 'not-json');
  });

  it('refuses cycles and deep nesting', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const error = thrown(() => session({ env: cyclic }));
    expect(error).toBeInstanceOf(InvalidOptionsError);
    const e = error as InvalidOptionsError;
    expect(e.details?.['rule']).toBe('not-json');
    expect(e.details?.['path']).toMatch(/^env(\.self)+$/);
    expect(e.message).toContain('nested too deeply');
  });

  it.each([
    [{ claudeCode: { model: 'a\0b' } }, 'claudeCode.model'],
    [{ claudeCode: { appendSystemPrompt: 'x\uD800' } }, 'claudeCode.appendSystemPrompt'],
    [{ env: { A: 'x\0' } }, 'env.A'],
    [{ env: { preset: 'harness', add: { A: '\uDC00' } } }, 'env.add.A'],
    [
      { claudeCode: { additionalDirectories: ['/a', '/b\0'] } },
      'claudeCode.additionalDirectories[1]',
    ],
    [{ cwd: '/w\0rk' }, 'cwd'],
  ])('refuses NUL and lone surrogates in %j', (input, path) => {
    invalid(() => session(input), path, 'string');
  });
});

describe('host values', () => {
  it('takes signal, onPermission and events.signal out of the JSON', () => {
    const signal = new AbortController().signal;
    const eventsSignal = new AbortController().signal;
    const { effective, host } = resolveSessionOptions({
      signal,
      onPermission: handler,
      events: { signal: eventsSignal, maxEvents: 7 },
    });
    expect(host).toEqual({ signal, onPermission: handler, eventsSignal });
    expect(effective.permissionPrompting).toBe('stdio');
    expect(effective.events.maxEvents).toBe(7);
  });

  it('refuses host values of the wrong kind', () => {
    invalid(() => session({ signal: {} }), 'signal', 'host-value');
    invalid(() => session({ onPermission: 'yes' }), 'onPermission', 'host-value');
    invalid(() => session({ events: { signal: true } }), 'events.signal', 'host-value');
  });

  it('refuses session-only host values in connect options', () => {
    invalid(() => resolveConnectOptions({ onPermission: handler }), 'onPermission', 'schema');
    invalid(
      () => resolveConnectOptions({ events: { signal: new AbortController().signal } }),
      'events',
      'schema',
    );
    invalid(() => resolveConnectOptions({ events: {} }), '', 'schema');
  });

  it('returns the connect signal', () => {
    const signal = new AbortController().signal;
    expect(resolveConnectOptions({ signal }).signal).toBe(signal);
    expect('signal' in resolveConnectOptions({})).toBe(false);
  });
});

describe('cross-field rules (plan §2.3)', () => {
  it('refuses workspaceTrust together with claudeCode.settingSources', () => {
    invalid(
      () => session({ workspaceTrust: 'none', claudeCode: { settingSources: ['user'] } }),
      'workspaceTrust',
      'trust-and-sources',
    );
  });

  it('maps workspaceTrust to setting sources', () => {
    expect(session({ workspaceTrust: 'none' }).settingSources).toEqual(['user']);
    expect(session({ workspaceTrust: 'full' }).settingSources).toEqual([
      'user',
      'project',
      'local',
    ]);
    const explicit = session({ claudeCode: { settingSources: ['project', 'user'] } });
    expect(explicit.settingSources).toEqual(['project', 'user']);
    expect(explicit.settingSourcesFrom).toBe('claudeCode.settingSources');
  });

  it('reports workspaceTrust "context" as unsupported', () => {
    unsupported(() => session({ workspaceTrust: 'context' }), 'workspaceTrust.context');
  });

  it('requires dangerouslyAllowBypassPermissions for bypassPermissions and vice versa', () => {
    invalid(
      () => session({ permissionMode: 'bypassPermissions' }),
      'permissionMode',
      'bypass-permissions',
    );
    invalid(
      () =>
        session({ permissionMode: 'bypassPermissions', dangerouslyAllowBypassPermissions: false }),
      'permissionMode',
      'bypass-permissions',
    );
    invalid(
      () => session({ dangerouslyAllowBypassPermissions: true }),
      'dangerouslyAllowBypassPermissions',
      'bypass-permissions',
    );
    invalid(
      () => session({ permissionMode: 'auto', dangerouslyAllowBypassPermissions: true }),
      'dangerouslyAllowBypassPermissions',
      'bypass-permissions',
    );
    expect(
      session({ permissionMode: 'bypassPermissions', dangerouslyAllowBypassPermissions: true })
        .dangerouslyAllowBypassPermissions,
    ).toBe(true);
  });

  it('refuses projectCredentialEnv when no project or local source loads', () => {
    invalid(
      () => session({ projectCredentialEnv: 'refuse' }),
      'projectCredentialEnv',
      'project-credential-env',
    );
    invalid(
      () => session({ workspaceTrust: 'none', projectCredentialEnv: 'allow' }),
      'projectCredentialEnv',
      'project-credential-env',
    );
    invalid(
      () => session({ claudeCode: { settingSources: ['user'] }, projectCredentialEnv: 'allow' }),
      'projectCredentialEnv',
      'project-credential-env',
    );
  });

  it.each([
    ['', 'empty'],
    ['Read,Write', 'separator'],
    ['Bash git', 'separator'],
    ['Bash(git', 'unbalanced-parentheses'],
    ['-Read', 'leading-dash'],
    ['Read\n', 'control-character'],
  ])('refuses the tool rule %j (%s)', (rule, problem) => {
    for (const key of ['allowedTools', 'disallowedTools'] as const) {
      const e = invalid(
        () => session({ claudeCode: { [key]: ['Read', rule] } }),
        `claudeCode.${key}[1]`,
        'tool-rule',
      );
      expect(e.details).toMatchObject({ problem });
    }
  });

  it('accepts parenthesized specifiers with spaces and commas', () => {
    expect(
      session({ claudeCode: { allowedTools: ['Bash(git log:*)', 'Read(a,b)', 'mcp__x'] } })
        .claudeCode.allowedTools,
    ).toEqual(['Bash(git log:*)', 'Read(a,b)', 'mcp__x']);
  });

  it.each([
    'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
    'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS',
    'DISABLE_AUTOUPDATER',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CONFIG_DIR',
    'TRACEPARENT',
    'TRACESTATE',
    'CLAUDE_CODE_SDK_READS_SESSION_STATE',
    'disable_autoupdater',
    'Traceparent',
  ])('refuses the pinned key %s in add, remove and an explicit map', (name) => {
    const add = invalid(
      () => session({ env: { preset: 'harness', add: { [name]: '0' } } }),
      'env.add',
      'env-pinned',
    );
    expect(add.details).toMatchObject({ name });
    invalid(
      () => session({ env: { preset: 'inherit', remove: [name] } }),
      'env.remove',
      'env-pinned',
    );
    invalid(() => session({ env: { [name]: '0' } }), 'env', 'env-pinned');
  });

  it('allows credential and routing variables in add, listed in the posture', () => {
    const effective = session({
      env: {
        preset: 'harness',
        add: { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_VERTEX: '1', HTTPS_PROXY: 'http://p' },
      },
    });
    expect(postureOf(effective.posture)['env.credentialAndRoutingVariables']?.value).toEqual([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_USE_VERTEX',
      'HTTPS_PROXY',
    ]);
  });
});

describe('backend', () => {
  it('reports agent-sdk as unsupported', () => {
    unsupported(() => resolveConnectOptions({ backend: 'agent-sdk' }), 'backend.agent-sdk');
    unsupported(() => resolveConnectSessionOptions({ backend: 'agent-sdk' }), 'backend.agent-sdk');
  });

  it('accepts native and refuses anything else', () => {
    expect(resolveConnectOptions({ backend: 'native' }).effective.backend).toBe('native');
    invalid(() => resolveConnectOptions({ backend: 'other' }), 'backend', 'schema');
  });

  it('validates connect values', () => {
    const digest = 'a'.repeat(64);
    const { effective } = resolveConnectOptions({
      binaryPath: '/opt/claude',
      claudeCode: {
        binaryDigests: { '2.1.296': { 'linux-x64': digest, 'linux-x64-musl': digest } },
      },
    });
    expect(effective.binaryPath).toBe('/opt/claude');
    expect(effective.binaryDigests).toEqual({
      '2.1.296': { 'linux-x64': digest, 'linux-x64-musl': digest },
    });
    invalid(
      () =>
        resolveConnectOptions({
          claudeCode: { binaryDigests: { '2.1.296': { 'linux-x64': 'A'.repeat(64) } } },
        }),
      'claudeCode.binaryDigests.2.1.296.linux-x64',
      'schema',
    );
    invalid(
      () => resolveConnectOptions({ claudeCode: { binaryDigests: { latest: {} } } }),
      'claudeCode.binaryDigests',
      'schema',
    );
    invalid(
      () => resolveConnectOptions({ binaryVerification: 'none' }),
      'binaryVerification',
      'schema',
    );
    invalid(() => resolveConnectOptions({ permissionMode: 'default' }), '', 'schema');
  });
});

describe('resume and session() options', () => {
  it('resolves fork', () => {
    expect(resolveResumeOptions(undefined).fork).toBe(false);
    const resumed = resolveResumeOptions({ fork: true, permissionMode: 'plan' });
    expect(resumed.fork).toBe(true);
    expect(resumed.effective.permissionMode).toBe('plan');
    invalid(() => resolveSessionOptions({ fork: true }), '', 'schema');
  });

  it('splits connect and session options, claudeCode merged', () => {
    const signal = new AbortController().signal;
    const resolved = resolveConnectSessionOptions({
      signal,
      backend: 'native',
      binaryPath: '/opt/claude',
      binaryVerification: 'strict',
      permissionMode: 'plan',
      onPermission: handler,
      claudeCode: {
        configDir: '/cfg',
        bare: true,
        binaryDigests: {},
        dangerouslyAllowRawControl: true,
        model: 'm',
        settingSources: ['user', 'local'],
      },
    });
    expect(resolved.connect).toEqual(
      resolveConnectOptions({
        backend: 'native',
        binaryPath: '/opt/claude',
        binaryVerification: 'strict',
        claudeCode: {
          configDir: '/cfg',
          bare: true,
          binaryDigests: {},
          dangerouslyAllowRawControl: true,
        },
      }).effective,
    );
    expect(resolved.session).toEqual(
      session({
        permissionMode: 'plan',
        onPermission: handler,
        claudeCode: { model: 'm', settingSources: ['user', 'local'] },
      }),
    );
    expect(resolved.host).toEqual({ signal, onPermission: handler });
  });

  it('resolves defaults for both halves', () => {
    const resolved = resolveConnectSessionOptions(undefined);
    expect(resolved.connect).toEqual(resolveConnectOptions(undefined).effective);
    expect(resolved.session).toEqual(session(undefined));
    invalid(
      () => resolveConnectSessionOptions({ claudeCode: { fork: true } }),
      'claudeCode',
      'schema',
    );
  });
});

describe('session ids', () => {
  it('accepts UUIDs only', () => {
    const id = '0b7c4a2e-3f1d-4c8b-9a6e-2d5f8c1b7e40';
    expect(checkSessionId(id)).toBe(id);
    expect(checkSessionId(id.toUpperCase(), 'resumeId')).toBe(id.toUpperCase());
    invalid(() => checkSessionId('my session'), 'sessionId', 'session-id');
    invalid(() => checkSessionId(`${id}\n`, 'resumeId'), 'resumeId', 'session-id');
    invalid(() => checkSessionId(`--${id}`), 'sessionId', 'session-id');
    invalid(() => checkSessionId(42), 'sessionId', 'session-id');
  });
});

describe('pointerToPath', () => {
  it('converts JSON Pointers to dotted paths', () => {
    expect(pointerToPath('')).toBe('');
    expect(pointerToPath('/claudeCode/allowedTools/2')).toBe('claudeCode.allowedTools[2]');
    expect(pointerToPath('/env/a~1b~0c')).toBe('env.a/b~c');
    expect(pointerToPath('/0/01')).toBe('[0].01');
  });
});

describe('error details', () => {
  it('carries path and rule as plain JSON', () => {
    const e = invalid(() => session({ bogus: true }), '', 'schema');
    const data = e.toData();
    expect(data.details).toMatchObject({ path: '', rule: 'schema' } satisfies JsonObject);
  });
});
