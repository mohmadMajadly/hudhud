// The CLI argv per option row of plan §2.4 and §2.5 (ADR-0011 §3).

import { InvalidOptionsError } from '@hudhud/core';
import { parseFlag } from '@hudhud/core/process';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildArgv, checkExtraArgs, RESERVED_FLAGS, type LaunchSpec } from '../../src/argv.js';
import {
  resolveConnectOptions,
  resolveConnectSessionOptions,
  resolveSessionOptions,
  type EffectiveSessionOptions,
} from '../../src/options.js';

const SESSION_ID = '0b7c4a2e-3f1d-4c8b-9a6e-2d5f8c1b7e40';
const OTHER_ID = '5d2f1e4a-8b3c-4d6e-9f0a-1b2c3d4e5f60';
const CREATE: LaunchSpec = { mode: 'create', sessionId: SESSION_ID };

const BASE = [
  '--output-format=stream-json',
  '--input-format=stream-json',
  '--verbose',
  '--setting-sources=user',
  '--permission-mode=default',
  `--session-id=${SESSION_ID}`,
];

function argvFor(options: unknown, connect?: unknown, launch = CREATE): string[] {
  return buildArgv(
    resolveConnectOptions(connect).effective,
    resolveSessionOptions(options).effective,
    launch,
  );
}

const handler = (): Promise<unknown> => Promise.resolve({ behavior: 'allow' });

describe('argv per option row (plan §2.4, §2.5)', () => {
  it('passes the always-on flags with default options', () => {
    expect(argvFor(undefined)).toEqual(BASE);
  });

  it.each<[string, unknown, unknown, readonly string[]]>([
    [
      'permissionMode',
      { permissionMode: 'acceptEdits' },
      undefined,
      ['--permission-mode=acceptEdits'],
    ],
    ['permissionMode', { permissionMode: 'plan' }, undefined, ['--permission-mode=plan']],
    ['permissionMode', { permissionMode: 'dontAsk' }, undefined, ['--permission-mode=dontAsk']],
    ['permissionMode', { permissionMode: 'auto' }, undefined, ['--permission-mode=auto']],
    [
      'dangerouslyAllowBypassPermissions',
      { permissionMode: 'bypassPermissions', dangerouslyAllowBypassPermissions: true },
      undefined,
      ['--permission-mode=bypassPermissions', '+--allow-dangerously-skip-permissions'],
    ],
    ['onPermission', { onPermission: handler }, undefined, ['+--permission-prompt-tool=stdio']],
    ['workspaceTrust none', { workspaceTrust: 'none' }, undefined, ['--setting-sources=user']],
    [
      'workspaceTrust full',
      { workspaceTrust: 'full' },
      undefined,
      ['--setting-sources=user,project,local'],
    ],
    [
      'claudeCode.settingSources',
      { claudeCode: { settingSources: ['project', 'user'] } },
      undefined,
      ['--setting-sources=project,user'],
    ],
    [
      'claudeCode.settingSources empty',
      { claudeCode: { settingSources: [] } },
      undefined,
      ['--setting-sources='],
    ],
    ['claudeCode.bare', undefined, { claudeCode: { bare: true } }, ['+--bare']],
    [
      'claudeCode.model',
      { claudeCode: { model: 'claude-opus-x' } },
      undefined,
      ['+--model=claude-opus-x'],
    ],
    ['claudeCode.maxTurns', { claudeCode: { maxTurns: 7 } }, undefined, ['+--max-turns=7']],
    [
      'claudeCode.includePartialMessages',
      { claudeCode: { includePartialMessages: true } },
      undefined,
      ['+--include-partial-messages'],
    ],
    [
      'claudeCode.allowedTools',
      { claudeCode: { allowedTools: ['Read', 'Bash(git log:*)'] } },
      undefined,
      ['+--allowed-tools=Read,Bash(git log:*)'],
    ],
    [
      'claudeCode.disallowedTools',
      { claudeCode: { disallowedTools: ['WebFetch'] } },
      undefined,
      ['+--disallowed-tools=WebFetch'],
    ],
    [
      'claudeCode.additionalDirectories',
      { claudeCode: { additionalDirectories: ['/a', '-b', 'c,d'] } },
      undefined,
      ['+--add-dir=/a', '+--add-dir=-b', '+--add-dir=c,d'],
    ],
    [
      'claudeCode.appendSystemPrompt',
      { claudeCode: { appendSystemPrompt: '--dangerously-skip-permissions\nbe nice' } },
      undefined,
      ['+--append-system-prompt=--dangerously-skip-permissions\nbe nice'],
    ],
  ])('%s', (_row, options, connect, changes) => {
    const expected = [...BASE];
    for (const change of changes) {
      if (change.startsWith('+')) {
        expected.push(change.slice(1));
      } else {
        const name = change.slice(0, change.indexOf('='));
        const index = expected.findIndex((e) => e.startsWith(`${name}=`));
        expected[index] = change;
      }
    }
    expect(argvFor(options, connect)).toEqual(expected);
  });

  it.each([
    ['autoUpdate', { autoUpdate: 'harness-default' }],
    ['nonessentialTraffic', { nonessentialTraffic: 'harness-default' }],
    ['env', { env: 'inherit' }],
    ['projectCredentialEnv', { workspaceTrust: 'full', projectCredentialEnv: 'allow' }],
    ['dangerouslyAllowConfigWrites', { dangerouslyAllowConfigWrites: true }],
    ['onAuthFailure', { onAuthFailure: 'harness-retry' }],
    ['onOversizedFrame', { onOversizedFrame: 'skip' }],
    ['maxFrameBytes', { maxFrameBytes: 2_097_152 }],
    ['firstFrameTimeoutMs', { firstFrameTimeoutMs: 5000 }],
    ['termination', { termination: { eofGraceMs: 3000 } }],
    [
      'trace',
      { trace: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' } },
    ],
    ['backgroundWaitCeilingMs', { claudeCode: { backgroundWaitCeilingMs: 5000 } }],
    ['events', { events: { maxEvents: 1 } }],
  ])('%s does not change argv', (_row, options) => {
    const expected =
      _row === 'projectCredentialEnv'
        ? BASE.map((e) =>
            e === '--setting-sources=user' ? '--setting-sources=user,project,local' : e,
          )
        : BASE;
    expect(argvFor(options)).toEqual(expected);
  });

  it.each([
    ['binaryVerification', { binaryVerification: 'strict' }],
    ['configDir', { claudeCode: { configDir: '/cfg' } }],
    ['dangerouslyAllowRawControl', { claudeCode: { dangerouslyAllowRawControl: true } }],
    ['binaryPath', { binaryPath: '/opt/claude' }],
  ])('connect option %s does not change argv', (_row, connect) => {
    expect(argvFor(undefined, connect)).toEqual(BASE);
  });

  it('orders every optional flag as in plan §2.5', () => {
    const resolved = resolveConnectSessionOptions({
      permissionMode: 'bypassPermissions',
      dangerouslyAllowBypassPermissions: true,
      onPermission: handler,
      claudeCode: {
        bare: true,
        model: 'm',
        maxTurns: 2,
        includePartialMessages: true,
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
        additionalDirectories: ['/x'],
        appendSystemPrompt: 'p',
      },
    });
    expect(buildArgv(resolved.connect, resolved.session, CREATE)).toEqual([
      '--output-format=stream-json',
      '--input-format=stream-json',
      '--verbose',
      '--setting-sources=user',
      '--permission-mode=bypassPermissions',
      `--session-id=${SESSION_ID}`,
      '--permission-prompt-tool=stdio',
      '--allow-dangerously-skip-permissions',
      '--bare',
      '--model=m',
      '--max-turns=2',
      '--include-partial-messages',
      '--allowed-tools=Read',
      '--disallowed-tools=Bash',
      '--add-dir=/x',
      '--append-system-prompt=p',
    ]);
  });
});

describe('launch modes', () => {
  it('resumes with --resume', () => {
    expect(argvFor(undefined, undefined, { mode: 'resume', resumeId: OTHER_ID })).toEqual([
      ...BASE.slice(0, 5),
      `--resume=${OTHER_ID}`,
    ]);
  });

  it('forks with --resume, --fork-session and the new --session-id', () => {
    expect(
      argvFor(undefined, undefined, { mode: 'fork', resumeId: OTHER_ID, sessionId: SESSION_ID }),
    ).toEqual([
      ...BASE.slice(0, 5),
      `--resume=${OTHER_ID}`,
      '--fork-session',
      `--session-id=${SESSION_ID}`,
    ]);
  });

  it.each<[LaunchSpec, string]>([
    [{ mode: 'create', sessionId: 'not-a-uuid' }, 'sessionId'],
    [{ mode: 'resume', resumeId: '--dangerously-skip-permissions' }, 'resumeId'],
    [{ mode: 'fork', resumeId: OTHER_ID, sessionId: `${SESSION_ID} ` }, 'sessionId'],
    [{ mode: 'fork', resumeId: 'title', sessionId: SESSION_ID }, 'resumeId'],
  ])('refuses non-UUID ids %j', (launch, path) => {
    expect(() => argvFor(undefined, undefined, launch)).toThrow(InvalidOptionsError);
    try {
      argvFor(undefined, undefined, launch);
    } catch (e) {
      expect((e as InvalidOptionsError).details).toMatchObject({ path, rule: 'session-id' });
    }
  });
});

describe('unvalidated input', () => {
  it('maps a value that cannot be an argv element to InvalidOptionsError', () => {
    const effective = resolveSessionOptions(undefined).effective;
    const broken: EffectiveSessionOptions = {
      ...effective,
      claudeCode: { ...effective.claudeCode, model: 'a\0b' },
    };
    let error: unknown;
    try {
      buildArgv({ bare: false }, broken, CREATE);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidOptionsError);
    expect((error as InvalidOptionsError).details).toEqual({ path: 'model', rule: 'argv' });
    expect((error as InvalidOptionsError).message).toContain('NUL');
  });
});

describe('raw extraArgs (plan §2.6, L4)', () => {
  it.each([
    '--permission-mode=bypassPermissions',
    '--permission-mode',
    '--dangerously-skip-permissions',
    '--project-config-root=/tmp/x',
    '--projectConfigRoot',
    '--allowedTools=Bash',
    '--allowed-tools=Bash',
    '--ALLOWED_TOOLS=Bash',
    '--setting-sources=user,project',
    '--settings={}',
    '--session-id=x',
    '--resume',
    '--continue',
    '-c',
    '-r',
    '-p',
    '--print',
    '--system-prompt=x',
    '--add-dir=/',
    '--no-verbose',
    '--perm',
    '--',
  ])('refuses %s', (arg) => {
    let error: unknown;
    try {
      checkExtraArgs(['--debug', arg]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidOptionsError);
    expect((error as InvalidOptionsError).details).toMatchObject({ path: 'raw.extraArgs[1]' });
  });

  it('names the reserved flag', () => {
    try {
      checkExtraArgs(['--project-config-root=/x']);
    } catch (e) {
      expect((e as InvalidOptionsError).details).toEqual({
        path: 'raw.extraArgs[0]',
        rule: 'reserved-flag',
        flag: 'project-config-root',
      });
    }
    expect.assertions(1);
  });

  it('passes other flags', () => {
    expect(() => {
      checkExtraArgs(['--debug', '--mcp-config=/x.json', 'value']);
    }).not.toThrow();
  });

  it('reserves every flag hudhud passes', () => {
    const resolved = resolveConnectSessionOptions({
      permissionMode: 'bypassPermissions',
      dangerouslyAllowBypassPermissions: true,
      onPermission: handler,
      claudeCode: {
        bare: true,
        model: 'm',
        maxTurns: 2,
        includePartialMessages: true,
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
        additionalDirectories: ['/x'],
        appendSystemPrompt: 'p',
      },
    });
    const all = [
      ...buildArgv(resolved.connect, resolved.session, CREATE),
      ...buildArgv(resolved.connect, resolved.session, {
        mode: 'fork',
        resumeId: OTHER_ID,
        sessionId: SESSION_ID,
      }),
    ];
    for (const arg of all) {
      expect(() => {
        checkExtraArgs([arg]);
      }).toThrow(InvalidOptionsError);
    }
    expect(RESERVED_FLAGS).toContain('dangerously-skip-permissions');
  });

  it('rethrows non-argv failures unchanged', () => {
    expect(() => {
      checkExtraArgs(null as unknown as string[]);
    }).toThrow(TypeError);
  });
});

describe('no option value can inject a flag (property)', () => {
  // Arbitrary strings, biased toward flag-looking and separator content.
  const nasty = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 40 }),
    fc.constantFrom(
      '--dangerously-skip-permissions',
      '-p',
      '--permission-mode=bypassPermissions',
      'a --bare',
      'x\n--verbose',
      '=',
      ',',
      ' ',
      '"--quoted"',
      '--',
    ),
  );
  const rule = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 20 }),
    fc.constantFrom('Read', 'Bash(git:*)', 'a,b', '-x'),
  );

  const optionsArb = fc.record(
    {
      permissionMode: fc.constantFrom('default', 'acceptEdits', 'plan', 'dontAsk', 'auto'),
      workspaceTrust: fc.constantFrom('none', 'full'),
      claudeCode: fc.record(
        {
          model: nasty,
          maxTurns: fc.integer({ min: -5, max: 100 }),
          includePartialMessages: fc.boolean(),
          appendSystemPrompt: nasty,
          allowedTools: fc.array(rule, { maxLength: 4 }),
          disallowedTools: fc.array(rule, { maxLength: 4 }),
          additionalDirectories: fc.array(nasty, { maxLength: 4 }),
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: [] },
  );

  const KNOWN = new Set([
    'output-format',
    'input-format',
    'verbose',
    'setting-sources',
    'permission-mode',
    'session-id',
    'permission-prompt-tool',
    'bare',
    'model',
    'max-turns',
    'include-partial-messages',
    'allowed-tools',
    'disallowed-tools',
    'add-dir',
    'append-system-prompt',
  ]);

  it('every element is one well-formed --flag[=value] that parses back to the option value', () => {
    fc.assert(
      fc.property(optionsArb, fc.boolean(), (options, bare) => {
        let effective: EffectiveSessionOptions;
        try {
          effective = resolveSessionOptions(options).effective;
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidOptionsError);
          return;
        }
        const argv = buildArgv({ bare }, effective, CREATE);
        const parsed = argv.map((element) => parseFlag(element));
        for (const p of parsed) {
          expect(p).toBeDefined();
          expect(KNOWN.has(p?.name ?? '')).toBe(true);
        }
        const values = (name: string): (string | undefined)[] =>
          parsed.filter((p) => p?.name === name).map((p) => p?.value);
        const cc = effective.claudeCode;
        expect(values('model')).toEqual(cc.model === null ? [] : [cc.model]);
        expect(values('append-system-prompt')).toEqual(
          cc.appendSystemPrompt === null ? [] : [cc.appendSystemPrompt],
        );
        expect(values('add-dir')).toEqual(cc.additionalDirectories);
        expect(values('max-turns')).toEqual(cc.maxTurns === null ? [] : [String(cc.maxTurns)]);
        expect(values('permission-mode')).toEqual([effective.permissionMode]);
        expect(values('verbose')).toEqual([undefined]);
        expect(values('bare')).toEqual(bare ? [undefined] : []);
        // Exactly one element per flag hudhud passes; repeated only for --add-dir.
        expect(argv.length).toBe(
          6 +
            (bare ? 1 : 0) +
            (cc.model === null ? 0 : 1) +
            (cc.maxTurns === null ? 0 : 1) +
            (cc.includePartialMessages ? 1 : 0) +
            (cc.allowedTools.length > 0 ? 1 : 0) +
            (cc.disallowedTools.length > 0 ? 1 : 0) +
            cc.additionalDirectories.length +
            (cc.appendSystemPrompt === null ? 0 : 1),
        );
      }),
      { numRuns: 300 },
    );
  });
});
