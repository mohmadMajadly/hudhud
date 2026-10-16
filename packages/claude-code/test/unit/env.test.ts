// The child environment per OS and per form of the `env` option (K19,
// ADR-0012 §4, plan §2.5).

import { InvalidOptionsError } from '@hudhudjs/core';
import { childEnv, WIN32_REQUIRED_ENV_NAMES, type ProcessPlatform } from '@hudhudjs/core/process';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildChildEnv,
  checkExtraEnv,
  envNameIsPinned,
  isCredentialOrRoutingEnvName,
  isHarnessAllowed,
  isNeverInherited,
  PINNED_ENV_NAMES,
  type ChildEnv,
} from '../../src/env.js';
import { resolveConnectOptions, resolveSessionOptions } from '../../src/options.js';

type Parent = Readonly<Record<string, string | undefined>>;

function child(
  options: unknown,
  parent: Parent,
  platform: ProcessPlatform,
  connect?: unknown,
): ChildEnv {
  return buildChildEnv(
    resolveSessionOptions(options).effective,
    resolveConnectOptions(connect).effective,
    parent,
    platform,
  );
}

/** What hudhud always sets with default options. */
const PINNED_DEFAULTS = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '600000',
  DISABLE_AUTOUPDATER: '1',
};

const POSIX_PARENT: Parent = {
  PATH: '/usr/bin',
  HOME: '/srv/u',
  USER: 'u',
  LOGNAME: 'u',
  SHELL: '/bin/bash',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
  LC_ALL: 'C',
  TERM: 'xterm',
  XDG_CONFIG_HOME: '/srv/u/.config',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value',
  ANTHROPIC_API_KEY: 'fake-key-xyz',
  HTTPS_PROXY: 'http://proxy:3128',
  https_proxy: 'http://proxy:3128',
  NO_PROXY: 'localhost',
  NODE_EXTRA_CA_CERTS: '/ca.pem',
  SSL_CERT_FILE: '/cert.pem',
  // Not passed by 'harness':
  GITHUB_TOKEN: 'ghp_secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  EDITOR: 'vim',
  claude_lower: 'x',
  // Never inherited:
  NODE_OPTIONS: '--require /evil.js',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_AGENT_SDK_VERSION: '0.3.0',
  // Always removed:
  CLAUDE_CODE_SDK_READS_SESSION_STATE: '1',
  TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  TRACESTATE: 'a=b',
  UNSET: undefined,
};

const WIN32_PARENT: Parent = {
  Path: 'C:\\Windows\\System32',
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  PATHEXT: '.COM;.EXE',
  SystemDrive: 'C:',
  TEMP: 'C:\\T',
  TMP: 'C:\\T',
  USERPROFILE: 'C:\\Profiles\\u',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Profiles\\u',
  APPDATA: 'C:\\Profiles\\u\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Profiles\\u\\AppData\\Local',
  ProgramData: 'C:\\ProgramData',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  claude_code_git_bash_path: 'C:\\Git\\bin\\bash.exe',
  Anthropic_Base_Url: 'http://localhost:1',
  https_proxy: 'http://proxy',
  // Passed: libuv would add them anyway (WIN32_REQUIRED_ENV_NAMES).
  USERNAME: 'u',
  USERDOMAIN: 'D',
  LOGONSERVER: '\\\\DC',
  // Not passed:
  OneDrive: 'C:\\Profiles\\u\\OneDrive',
  // Never inherited, in any case:
  node_options: '--require x',
  ClaudeCode: '1',
  claude_agent_sdk_x: '1',
};

describe("'harness' preset (allowlist by rule)", () => {
  it('passes the POSIX essentials, CLAUDE_*, ANTHROPIC_* and proxy variables', () => {
    const result = child(undefined, POSIX_PARENT, 'posix');
    expect(result.env).toEqual({
      ANTHROPIC_API_KEY: 'fake-key-xyz',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value',
      HOME: '/srv/u',
      HTTPS_PROXY: 'http://proxy:3128',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      LOGNAME: 'u',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      NO_PROXY: 'localhost',
      PATH: '/usr/bin',
      SHELL: '/bin/bash',
      SSL_CERT_FILE: '/cert.pem',
      TERM: 'xterm',
      TMPDIR: '/tmp',
      USER: 'u',
      XDG_CONFIG_HOME: '/srv/u/.config',
      https_proxy: 'http://proxy:3128',
      ...PINNED_DEFAULTS,
    });
    expect(result.dropped).toEqual([
      'AWS_SECRET_ACCESS_KEY',
      'CLAUDECODE',
      'CLAUDE_AGENT_SDK_VERSION',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SDK_READS_SESSION_STATE',
      'EDITOR',
      'GITHUB_TOKEN',
      'NODE_OPTIONS',
      'TRACEPARENT',
      'TRACESTATE',
      'claude_lower',
    ]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('passes the Windows essentials, matching names case-insensitively', () => {
    const result = child(undefined, WIN32_PARENT, 'win32');
    expect(result.env).toEqual({
      APPDATA: 'C:\\Profiles\\u\\AppData\\Roaming',
      Anthropic_Base_Url: 'http://localhost:1',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Profiles\\u',
      LOCALAPPDATA: 'C:\\Profiles\\u\\AppData\\Local',
      PATHEXT: '.COM;.EXE',
      Path: 'C:\\Windows\\System32',
      ProgramData: 'C:\\ProgramData',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      SystemDrive: 'C:',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\T',
      TMP: 'C:\\T',
      USERPROFILE: 'C:\\Profiles\\u',
      USERNAME: 'u',
      USERDOMAIN: 'D',
      LOGONSERVER: '\\\\DC',
      claude_code_git_bash_path: 'C:\\Git\\bin\\bash.exe',
      https_proxy: 'http://proxy',
      windir: 'C:\\Windows',
      ...PINNED_DEFAULTS,
    });
    expect(result.dropped).toEqual([
      'ClaudeCode',
      'OneDrive',
      'claude_agent_sdk_x',
      'node_options',
    ]);
    // Every variable libuv would inject is passed explicitly.
    expect(result.spawnInjected).toEqual([]);
  });

  it('passes every libuv-required variable on win32', () => {
    for (const name of WIN32_REQUIRED_ENV_NAMES) {
      expect(isHarnessAllowed(name, 'win32')).toBe(true);
      expect(isHarnessAllowed(name.toLowerCase(), 'win32')).toBe(true);
    }
  });

  it('applies the OS lists by platform', () => {
    expect(isHarnessAllowed('HOME', 'posix')).toBe(true);
    expect(isHarnessAllowed('HOME', 'win32')).toBe(false);
    expect(isHarnessAllowed('SystemRoot', 'win32')).toBe(true);
    expect(isHarnessAllowed('SYSTEMROOT', 'posix')).toBe(false);
    expect(isHarnessAllowed('Path', 'posix')).toBe(false);
    expect(isHarnessAllowed('claude_x', 'posix')).toBe(false);
    expect(isHarnessAllowed('claude_x', 'win32')).toBe(true);
    expect(isHarnessAllowed('AWS_REGION', 'posix')).toBe(false);
    expect(isHarnessAllowed('AWS_REGION', 'posix', ['AWS_'])).toBe(true);
    expect(isHarnessAllowed('CLAUDE_CODE_ENTRYPOINT', 'posix')).toBe(false);
  });

  it('passes provider families only when the switch is on', () => {
    const parent = {
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'p',
      GOOGLE_APPLICATION_CREDENTIALS: '/g.json',
      CLOUD_ML_REGION: 'us',
      AZURE_CLIENT_ID: 'az',
    };
    const off = child(undefined, { ...parent, CLAUDE_CODE_USE_BEDROCK: '0' }, 'posix');
    expect(
      Object.keys(off.env).filter((n) => !n.startsWith('CLAUDE_') && n !== 'DISABLE_AUTOUPDATER'),
    ).toEqual([]);

    const bedrock = child(undefined, { ...parent, CLAUDE_CODE_USE_BEDROCK: '1' }, 'posix');
    expect(bedrock.env).toMatchObject({ AWS_REGION: 'us-east-1', AWS_PROFILE: 'p' });
    expect(bedrock.dropped).toEqual([
      'AZURE_CLIENT_ID',
      'CLOUD_ML_REGION',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ]);

    const vertex = child(undefined, { ...parent, CLAUDE_CODE_USE_VERTEX: ' TRUE ' }, 'posix');
    expect(vertex.dropped).toEqual(['AWS_PROFILE', 'AWS_REGION', 'AZURE_CLIENT_ID']);

    const foundry = child(undefined, { ...parent, claude_code_use_foundry: 'yes' }, 'win32');
    expect(foundry.env).toMatchObject({ AZURE_CLIENT_ID: 'az' });
    expect(
      child(undefined, { ...parent, claude_code_use_foundry: 'yes' }, 'posix').env,
    ).not.toHaveProperty('AZURE_CLIENT_ID');

    const viaAdd = child(
      { env: { preset: 'harness', add: { CLAUDE_CODE_USE_BEDROCK: 'on' } } },
      parent,
      'posix',
    );
    expect(viaAdd.env).toMatchObject({ AWS_REGION: 'us-east-1', CLAUDE_CODE_USE_BEDROCK: 'on' });

    const removed = child(
      { env: { preset: 'harness', remove: ['CLAUDE_CODE_USE_BEDROCK'] } },
      { ...parent, CLAUDE_CODE_USE_BEDROCK: '1' },
      'posix',
    );
    expect(removed.env).not.toHaveProperty('AWS_REGION');
    expect(removed.env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
  });
});

describe("'inherit' preset", () => {
  it('passes everything except the never-inherited and always-removed variables', () => {
    const result = child({ env: 'inherit' }, POSIX_PARENT, 'posix');
    expect(result.env).toMatchObject({
      GITHUB_TOKEN: 'ghp_secret',
      EDITOR: 'vim',
      claude_lower: 'x',
    });
    for (const name of [
      'NODE_OPTIONS',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_AGENT_SDK_VERSION',
      'CLAUDE_CODE_SDK_READS_SESSION_STATE',
      'TRACEPARENT',
      'TRACESTATE',
      'UNSET',
    ]) {
      expect(result.env).not.toHaveProperty(name);
    }
    expect(result.dropped).toEqual([
      'CLAUDECODE',
      'CLAUDE_AGENT_SDK_VERSION',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SDK_READS_SESSION_STATE',
      'NODE_OPTIONS',
      'TRACEPARENT',
      'TRACESTATE',
    ]);
  });

  it('drops never-inherited names in any case on win32', () => {
    const result = child({ env: 'inherit' }, WIN32_PARENT, 'win32');
    expect(result.env).toMatchObject({ OneDrive: 'C:\\Profiles\\u\\OneDrive' });
    expect(result.dropped).toEqual(['ClaudeCode', 'claude_agent_sdk_x', 'node_options']);
  });

  it('overrides a pinned variable in any case on win32, leaving one entry', () => {
    const result = child(
      { env: 'inherit' },
      { disable_autoupdater: '0', Claude_Code_Emit_Session_State_Events: '0' },
      'win32',
    );
    expect(result.env).toEqual(PINNED_DEFAULTS);
    expect(result.dropped).toEqual([]);
  });
});

describe('explicit map', () => {
  it('passes exactly the map plus the pinned variables', () => {
    const result = child({ env: { PATH: '/bin', ANTHROPIC_API_KEY: 'k' } }, POSIX_PARENT, 'posix');
    expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'k', PATH: '/bin', ...PINNED_DEFAULTS });
    expect(result).toMatchObject({ dropped: [], added: [], removed: [], spawnInjected: [] });
  });

  it('reports the variables the spawn layer blanks on win32 when the map leaves them out', () => {
    const result = child({ env: { PATH: 'C:\\bin' } }, WIN32_PARENT, 'win32');
    expect(result.env).not.toHaveProperty('USERNAME');
    expect(result.spawnInjected).toEqual([
      'HOMEDRIVE',
      'HOMEPATH',
      'LOGONSERVER',
      'SYSTEMDRIVE',
      'SYSTEMROOT',
      'TEMP',
      'USERDOMAIN',
      'USERNAME',
      'USERPROFILE',
      'WINDIR',
    ]);
    // Whatever the parent holds (the spawn layer blanks them); never on POSIX.
    expect(
      child({ env: { A: '1' } }, { USERNAME: 'u', UNSET: undefined }, 'win32').spawnInjected,
    ).toEqual([...WIN32_REQUIRED_ENV_NAMES].sort());
    expect(child({ env: { A: '1' } }, {}, 'win32').spawnInjected).toEqual(
      [...WIN32_REQUIRED_ENV_NAMES].sort(),
    );
    expect(child({ env: { A: '1' } }, WIN32_PARENT, 'posix').spawnInjected).toEqual([]);
  });

  it('with the spawn layer, gives a win32 child exactly env plus blanks, never a parent value (ruling H)', () => {
    const name = fc.constantFrom(
      ...WIN32_REQUIRED_ENV_NAMES,
      'Path',
      'username',
      'SystemRoot',
      'APPDATA',
      'X_VAR',
      'ANTHROPIC_API_KEY',
      'NODE_OPTIONS',
    );
    const value = fc.string({ maxLength: 8 }).filter((text) => !text.includes('\0'));
    const form = fc.oneof(
      fc.constantFrom('harness', 'inherit'),
      fc.dictionary(fc.constantFrom('SYSTEMROOT', 'A', 'PATH', 'username'), value, {
        maxKeys: 4,
      }),
      fc.record({
        preset: fc.constantFrom('harness', 'inherit'),
        remove: fc.subarray([...WIN32_REQUIRED_ENV_NAMES]),
      }),
    );
    fc.assert(
      fc.property(fc.dictionary(name, value, { maxKeys: 12 }), form, (parent, env) => {
        let result: ChildEnv;
        try {
          result = child({ env }, parent, 'win32');
        } catch (error) {
          // Parent names that are one variable on win32 (`Path`, `PATH`).
          expect(error).toBeInstanceOf(InvalidOptionsError);
          return;
        }
        const composed = childEnv(result.env, 'win32');
        const given = new Map(
          Object.entries(result.env).map(([key, text]) => [key.toUpperCase(), text]),
        );
        for (const [key, text] of Object.entries(composed)) {
          if (given.has(key.toUpperCase())) {
            expect(text).toBe(given.get(key.toUpperCase()));
          } else {
            expect(text).toBe('');
            expect(result.spawnInjected).toContain(key);
          }
        }
        // Every name libuv would copy from the host is present: it copies nothing.
        const names = new Set(Object.keys(composed).map((key) => key.toUpperCase()));
        for (const required of WIN32_REQUIRED_ENV_NAMES) expect(names.has(required)).toBe(true);
        expect(Object.keys(composed)).toHaveLength(
          Object.keys(result.env).length + result.spawnInjected.length,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('reports a removed libuv-required variable on win32', () => {
    const result = child(
      { env: { preset: 'harness', remove: ['username'] } },
      WIN32_PARENT,
      'win32',
    );
    expect(result.env).not.toHaveProperty('USERNAME');
    expect(result.spawnInjected).toEqual(['USERNAME']);
  });

  it('refuses names that are one variable on win32 only', () => {
    expect(child({ env: { http_proxy: 'a', HTTP_PROXY: 'b' } }, {}, 'posix').env).toMatchObject({
      http_proxy: 'a',
      HTTP_PROXY: 'b',
    });
    const error = (() => {
      try {
        child({ env: { http_proxy: 'a', HTTP_PROXY: 'b' } }, {}, 'win32');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(InvalidOptionsError);
    expect((error as InvalidOptionsError).details).toEqual({
      path: 'env',
      rule: 'env-duplicate',
      names: ['http_proxy', 'HTTP_PROXY'],
    });
  });
});

describe('object form { preset, add, remove }', () => {
  it('applies the preset, then remove, then add, and reports names', () => {
    const result = child(
      {
        env: {
          preset: 'harness',
          remove: ['HTTPS_PROXY', 'NOT_THERE'],
          add: {
            HOME: '/sandbox',
            NODE_OPTIONS: '--max-old-space-size=4096',
            ANTHROPIC_BASE_URL: 'http://m',
          },
        },
      },
      POSIX_PARENT,
      'posix',
    );
    expect(result.env).toMatchObject({
      HOME: '/sandbox',
      NODE_OPTIONS: '--max-old-space-size=4096',
      ANTHROPIC_BASE_URL: 'http://m',
    });
    expect(result.env).not.toHaveProperty('HTTPS_PROXY');
    expect(result.added).toEqual(['ANTHROPIC_BASE_URL', 'HOME', 'NODE_OPTIONS']);
    expect(result.removed).toEqual(['HTTPS_PROXY', 'NOT_THERE']);
    expect(result.dropped).toContain('NODE_OPTIONS');
  });

  it('removes and replaces case-insensitively on win32', () => {
    const result = child(
      { env: { preset: 'inherit', remove: ['PATH'], add: { HTTPS_PROXY: 'http://new' } } },
      WIN32_PARENT,
      'win32',
    );
    expect(result.env).not.toHaveProperty('Path');
    expect(result.env).not.toHaveProperty('https_proxy');
    expect(result.env).toMatchObject({ HTTPS_PROXY: 'http://new' });
  });

  it('keeps case variants apart on POSIX', () => {
    const result = child(
      { env: { preset: 'inherit', remove: ['https_proxy'] } },
      POSIX_PARENT,
      'posix',
    );
    expect(result.env).toMatchObject({ HTTPS_PROXY: 'http://proxy:3128' });
    expect(result.env).not.toHaveProperty('https_proxy');
  });

  it.each([
    [{ preset: 'harness', add: { foo: '1', FOO: '2' } }, 'env.add'],
    [{ preset: 'harness', remove: ['foo', 'FOO'] }, 'env.remove'],
  ])('refuses %j on win32', (env, path) => {
    expect(() => child({ env }, {}, 'win32')).toThrow(InvalidOptionsError);
    try {
      child({ env }, {}, 'win32');
    } catch (e) {
      expect((e as InvalidOptionsError).details).toMatchObject({ path, rule: 'env-duplicate' });
    }
    expect(() => child({ env }, {}, 'posix')).not.toThrow();
  });

  it('keeps a __proto__ variable as an own entry', () => {
    const add = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
    const result = child({ env: { preset: 'harness', add } }, {}, 'posix');
    expect(Object.hasOwn(result.env, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.env)).toBe(Object.prototype);
    expect(result.env['__proto__']).toBe('x');
  });
});

describe('pinned and removed variables (plan §2.5)', () => {
  it('honours harness-default for autoUpdate and nonessentialTraffic', () => {
    const result = child(
      { env: 'inherit', autoUpdate: 'harness-default', nonessentialTraffic: 'harness-default' },
      { DISABLE_AUTOUPDATER: '0' },
      'posix',
    );
    expect(result.env).toEqual({
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '600000',
      DISABLE_AUTOUPDATER: '0',
    });
  });

  it('sets the background wait ceiling from the option', () => {
    expect(
      child({ claudeCode: { backgroundWaitCeilingMs: 1234 } }, {}, 'posix').env[
        'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS'
      ],
    ).toBe('1234');
  });

  it('sets CLAUDE_CONFIG_DIR only with configDir', () => {
    const parent = { CLAUDE_CONFIG_DIR: '/srv/u/.claude-work' };
    expect(child(undefined, parent, 'posix').env['CLAUDE_CONFIG_DIR']).toBe('/srv/u/.claude-work');
    const isolated = child(undefined, parent, 'posix', {
      claudeCode: { configDir: '/sandbox/cfg' },
    });
    expect(isolated.env['CLAUDE_CONFIG_DIR']).toBe('/sandbox/cfg');
    const win = child(undefined, { claude_config_dir: 'C:\\c' }, 'win32', {
      claudeCode: { configDir: 'D:\\cfg' },
    });
    expect(win.env).toMatchObject({ CLAUDE_CONFIG_DIR: 'D:\\cfg' });
    expect(win.env).not.toHaveProperty('claude_config_dir');
  });

  it('sets TRACEPARENT and TRACESTATE only from the trace option', () => {
    const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';
    const both = child(
      { env: 'inherit', trace: { traceparent, tracestate: 'k=v' } },
      POSIX_PARENT,
      'posix',
    );
    expect(both.env).toMatchObject({ TRACEPARENT: traceparent, TRACESTATE: 'k=v' });
    expect(both.dropped).not.toContain('TRACEPARENT');
    expect(both.dropped).not.toContain('TRACESTATE');
    const only = child({ env: 'inherit', trace: { traceparent } }, POSIX_PARENT, 'posix');
    expect(only.env['TRACEPARENT']).toBe(traceparent);
    expect(only.env).not.toHaveProperty('TRACESTATE');
    expect(only.dropped).toContain('TRACESTATE');
    const map = child({ env: { A: '1' }, trace: { traceparent } }, {}, 'posix');
    expect(map.env).toEqual({ A: '1', TRACEPARENT: traceparent, ...PINNED_DEFAULTS });
  });

  it('never sets CLAUDE_CODE_ENTRYPOINT itself', () => {
    for (const options of [undefined, { env: 'inherit' }, { env: { A: '1' } }]) {
      for (const platform of ['posix', 'win32'] as const) {
        expect(child(options, POSIX_PARENT, platform).env).not.toHaveProperty(
          'CLAUDE_CODE_ENTRYPOINT',
        );
      }
    }
  });

  it('returns names sorted and the env sorted by name', () => {
    const result = child({ env: 'inherit' }, { b: '1', a: '2', C: '3' }, 'posix');
    expect(Object.keys(result.env)).toEqual([...Object.keys(result.env)].sort());
  });
});

describe('name classifiers', () => {
  it('pins names case-insensitively', () => {
    for (const name of PINNED_ENV_NAMES) {
      expect(envNameIsPinned(name)).toBe(true);
      expect(envNameIsPinned(name.toLowerCase())).toBe(true);
    }
    expect(envNameIsPinned('CLAUDE_CODE_ENTRYPOINT')).toBe(false);
  });

  it('knows the never-inherited set', () => {
    expect(isNeverInherited('NODE_OPTIONS', 'posix')).toBe(true);
    expect(isNeverInherited('node_options', 'posix')).toBe(false);
    expect(isNeverInherited('node_options', 'win32')).toBe(true);
    expect(isNeverInherited('CLAUDE_AGENT_SDK_ANYTHING', 'posix')).toBe(true);
  });

  it.each([
    ['ANTHROPIC_BASE_URL', true],
    ['ANTHROPIC_FOUNDRY_RESOURCE', true],
    ['anthropic_model', true],
    ['CLAUDE_CODE_USE_BEDROCK', true],
    ['AWS_REGION', true],
    ['GOOGLE_CLOUD_PROJECT', true],
    ['CLOUD_ML_REGION', true],
    ['AZURE_TENANT_ID', true],
    ['HTTPS_PROXY', true],
    ['https_proxy', true],
    ['ALL_PROXY', true],
    ['NODE_EXTRA_CA_CERTS', true],
    ['NODE_TLS_REJECT_UNAUTHORIZED', true],
    ['NODE_OPTIONS', true],
    ['CLAUDE_CODE_ENTRYPOINT', true],
    ['GITHUB_TOKEN', true],
    ['CLAUDE_CODE_OAUTH_TOKEN', true],
    ['PATH', false],
    ['HOME', false],
    ['CLAUDE_CODE_MAX_RETRIES', false],
  ])('%s is credential or routing: %s', (name, expected) => {
    expect(isCredentialOrRoutingEnvName(name)).toBe(expected);
  });
});

describe('raw extraEnv', () => {
  it('refuses pinned names', () => {
    expect(() => {
      checkExtraEnv({ FOO: '1', ANTHROPIC_BASE_URL: 'x' });
    }).not.toThrow();
    expect(() => {
      checkExtraEnv({ disable_autoupdater: '0' });
    }).toThrow(InvalidOptionsError);
  });
});

describe('properties', () => {
  const name = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,12}$/);
  const value = fc.string({ maxLength: 16 });
  const parentArb = fc.dictionary(name, value, { maxKeys: 12 });
  const platformArb = fc.constantFrom<ProcessPlatform>('posix', 'win32');

  it('never passes a never-inherited variable unless the application adds it', () => {
    fc.assert(
      fc.property(
        parentArb,
        platformArb,
        fc.constantFrom('harness', 'inherit'),
        (extra, platform, preset) => {
          const parent = { ...extra, NODE_OPTIONS: 'x', CLAUDECODE: '1', CLAUDE_AGENT_SDK_Q: '1' };
          const result = child({ env: preset }, parent, platform);
          for (const key of Object.keys(result.env))
            expect(isNeverInherited(key, platform)).toBe(false);
        },
      ),
    );
  });

  it('always pins the session state events and never leaks values into the report', () => {
    fc.assert(
      fc.property(parentArb, platformArb, (parent, platform) => {
        const result = child({ env: 'inherit' }, parent, platform);
        expect(result.env['CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS']).toBe('1');
        for (const reported of [...result.dropped, ...result.added, ...result.removed]) {
          expect(Object.keys(parent)).toContain(reported);
        }
        if (platform === 'win32') {
          const folded = Object.keys(result.env).map((k) => k.toUpperCase());
          expect(new Set(folded).size).toBe(folded.length);
        }
      }),
    );
  });
});
