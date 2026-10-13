import { describe, expect, it } from 'vitest';

import {
  buildSandboxEnv,
  checkMockUrl,
  defaultGitBashPath,
  FAKE_API_KEY,
  FAKE_AUTH_TOKEN,
  isProtectedEnvName,
  redactEnv,
  windowsSystemRoot,
} from '../../src/launcher/env.js';
import type { SandboxDirs } from '../../src/launcher/env.js';
import { SandboxRefusedError } from '../../src/launcher/errors.js';

const POSIX_DIRS: SandboxDirs = {
  root: '/t/run',
  cfg: '/t/run/cfg',
  home: '/t/run/home',
  appData: '/t/run/home/AppData/Roaming',
  localAppData: '/t/run/home/AppData/Local',
  tmp: '/t/run/tmp',
  work: '/t/run/work',
};

const WIN_DIRS: SandboxDirs = {
  root: 'D:\\t\\run',
  cfg: 'D:\\t\\run\\cfg',
  home: 'D:\\t\\run\\home',
  appData: 'D:\\t\\run\\home\\AppData\\Roaming',
  localAppData: 'D:\\t\\run\\home\\AppData\\Local',
  tmp: 'D:\\t\\run\\tmp',
  work: 'D:\\t\\run\\work',
};

const MOCK = 'http://127.0.0.1:47311';

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof SandboxRefusedError) return error.code;
    throw error;
  }
  return undefined;
}

describe('buildSandboxEnv', () => {
  it('builds the complete POSIX environment and nothing else', () => {
    const env = buildSandboxEnv({
      platform: 'linux',
      dirs: POSIX_DIRS,
      mockUrl: MOCK,
      hostEnv: { SECRET: 'x' },
    });
    expect(env).toEqual({
      CLAUDE_CONFIG_DIR: '/t/run/cfg',
      CLAUDE_CODE_TMPDIR: '/t/run/tmp',
      TMPDIR: '/t/run/tmp',
      TMP: '/t/run/tmp',
      TEMP: '/t/run/tmp',
      HOME: '/t/run/home',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_BASE_URL: MOCK,
      ANTHROPIC_API_KEY: FAKE_API_KEY,
      HTTPS_PROXY: MOCK,
      HTTP_PROXY: MOCK,
      https_proxy: MOCK,
      http_proxy: MOCK,
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
    });
  });

  it('builds the Windows environment with redirected profile folders and Git Bash', () => {
    const env = buildSandboxEnv({
      platform: 'win32',
      dirs: WIN_DIRS,
      mockUrl: `${MOCK}/`,
      hostEnv: { SystemRoot: 'E:\\Win', USERPROFILE: 'C:\\Users\\default', APPDATA: 'C:\\real' },
      gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
    });
    expect(env).toMatchObject({
      USERPROFILE: WIN_DIRS.home,
      HOME: WIN_DIRS.home,
      APPDATA: WIN_DIRS.appData,
      LOCALAPPDATA: WIN_DIRS.localAppData,
      TEMP: WIN_DIRS.tmp,
      CLAUDE_CONFIG_DIR: WIN_DIRS.cfg,
      PATH: 'E:\\Win\\System32;E:\\Win;E:\\Win\\System32\\WindowsPowerShell\\v1.0',
      SYSTEMROOT: 'E:\\Win',
      WINDIR: 'E:\\Win',
      COMSPEC: 'E:\\Win\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemDrive: 'E:',
      HOMEDRIVE: 'D:',
      HOMEPATH: '\\t\\run\\home',
      USERNAME: 'hudhud-sandbox',
      USERDOMAIN: 'hudhud-sandbox',
      LOGONSERVER: '\\\\hudhud-sandbox',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      ANTHROPIC_BASE_URL: MOCK,
    });
    expect(Object.values(env)).not.toContain('C:\\Users\\default');
    expect(env['LANG']).toBeUndefined();
  });

  it('omits Git Bash when none is given and refuses a relative one', () => {
    const base = { platform: 'win32' as const, dirs: WIN_DIRS, mockUrl: MOCK, hostEnv: {} };
    expect(buildSandboxEnv(base)['CLAUDE_CODE_GIT_BASH_PATH']).toBeUndefined();
    expect(code(() => buildSandboxEnv({ ...base, gitBashPath: 'bash.exe' }))).toBe('unsafe-option');
  });

  it('adds caller variables but refuses protected or malformed ones', () => {
    const base = { platform: 'linux' as const, dirs: POSIX_DIRS, mockUrl: MOCK, hostEnv: {} };
    expect(
      buildSandboxEnv({ ...base, extra: { CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' } }),
    ).toMatchObject({
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
    });
    for (const name of [
      'ANTHROPIC_BASE_URL',
      'https_proxy',
      'Home',
      'CLAUDE_CONFIG_DIR',
      'NODE_OPTIONS',
    ]) {
      expect(code(() => buildSandboxEnv({ ...base, extra: { [name]: 'x' } }))).toBe(
        'unsafe-option',
      );
    }
    expect(code(() => buildSandboxEnv({ ...base, extra: { '1BAD': 'x' } }))).toBe('unsafe-option');
    expect(code(() => buildSandboxEnv({ ...base, extra: { GOOD: 'a\0b' } }))).toBe('unsafe-option');
  });

  it('drops only the nonessential variable for the trap test, keeping the trap', () => {
    const env = buildSandboxEnv({
      platform: 'linux',
      dirs: POSIX_DIRS,
      mockUrl: MOCK,
      hostEnv: {},
      nonessentialTraffic: 'allowed',
    });
    expect(env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBeUndefined();
    expect(env['HTTPS_PROXY']).toBe(MOCK);
    expect(
      buildSandboxEnv({
        platform: 'linux',
        dirs: POSIX_DIRS,
        mockUrl: MOCK,
        hostEnv: {},
        nonessentialTraffic: 'disabled',
      })['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'],
    ).toBe('1');
  });

  it('passes the fake auth token instead of the key only through the test-only option', () => {
    const base = { platform: 'linux' as const, dirs: POSIX_DIRS, mockUrl: MOCK, hostEnv: {} };
    const token = buildSandboxEnv({ ...base, credential: 'fake-auth-token' });
    expect(token['ANTHROPIC_AUTH_TOKEN']).toBe(FAKE_AUTH_TOKEN);
    expect(token['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(token['ANTHROPIC_BASE_URL']).toBe(MOCK);
    expect(token['HTTPS_PROXY']).toBe(MOCK);
    for (const credential of [undefined, 'api-key'] as const) {
      const key = buildSandboxEnv({ ...base, credential });
      expect(key['ANTHROPIC_API_KEY']).toBe(FAKE_API_KEY);
      expect(key['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    }
    // The protected-name rule is not loosened: no caller sets the token.
    expect(() =>
      buildSandboxEnv({ ...base, extra: { ANTHROPIC_AUTH_TOKEN: FAKE_AUTH_TOKEN } }),
    ).toThrow(SandboxRefusedError);
    expect(() =>
      buildSandboxEnv({
        ...base,
        credential: 'fake-auth-token',
        extra: { ANTHROPIC_API_KEY: FAKE_API_KEY },
      }),
    ).toThrow(SandboxRefusedError);
    // The one fake-key shape the privacy gate allows.
    expect(FAKE_AUTH_TOKEN).toMatch(/^sk-ant-fake-hudhud-[A-Za-z0-9]+$/);
    expect(redactEnv(token)['ANTHROPIC_AUTH_TOKEN']).toBe('<redacted>');
  });
});

describe('checkMockUrl', () => {
  it('accepts exactly http://127.0.0.1:<port>', () => {
    expect(checkMockUrl(MOCK)).toBe('127.0.0.1');
  });

  it.each([
    'not a url',
    'https://127.0.0.1:1',
    'http://localhost:1',
    'http://api.anthropic.com:80',
    'http://127.0.0.1',
    'http://u:p@127.0.0.1:1',
    'http://u@127.0.0.1:1',
    'http://127.0.0.1:1/v1',
    'http://127.0.0.1:1/?a=1',
    'http://127.0.0.1:1/#x',
  ])('refuses %s', (url) => {
    expect(code(() => checkMockUrl(url))).toBe('mock');
  });
});

describe('helpers', () => {
  it('validates the Windows system root', () => {
    expect(windowsSystemRoot({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows');
    expect(windowsSystemRoot({ SYSTEMROOT: 'D:\\W' })).toBe('D:\\W');
    expect(windowsSystemRoot({ SystemRoot: 'relative' })).toBe('C:\\Windows');
    expect(windowsSystemRoot({ SystemRoot: 'C:\\x;y' })).toBe('C:\\Windows');
    expect(windowsSystemRoot({})).toBe('C:\\Windows');
  });

  it('finds Git Bash under Program Files only when it exists', () => {
    const seen: string[] = [];
    const exists = (file: string): boolean => {
      seen.push(file);
      return true;
    };
    expect(defaultGitBashPath({ ProgramFiles: 'D:\\Apps' }, exists)).toBe(
      'D:\\Apps\\Git\\bin\\bash.exe',
    );
    expect(defaultGitBashPath({ PROGRAMFILES: 'E:\\P' }, exists)).toBe('E:\\P\\Git\\bin\\bash.exe');
    expect(defaultGitBashPath({ ProgramFiles: 'bad;' }, exists)).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    );
    expect(defaultGitBashPath({}, () => false)).toBeUndefined();
    expect(seen).toHaveLength(3);
  });

  it('classifies protected names', () => {
    expect(isProtectedEnvName('anthropic_api_key')).toBe(true);
    expect(isProtectedEnvName('CLAUDE_CODE_USE_BEDROCK')).toBe(true);
    expect(isProtectedEnvName('AWS_REGION')).toBe(true);
    expect(isProtectedEnvName('FAKE_CLI_MODE')).toBe(false);
  });

  it('redacts credential-like variables', () => {
    expect(redactEnv({ ANTHROPIC_API_KEY: FAKE_API_KEY, HOME: '/h', X_TOKEN: 't' })).toEqual({
      ANTHROPIC_API_KEY: '<redacted>',
      HOME: '/h',
      X_TOKEN: '<redacted>',
    });
  });
});
