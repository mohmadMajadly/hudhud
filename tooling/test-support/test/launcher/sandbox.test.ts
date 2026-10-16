import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { childEnv, DARWIN_CHILD_SET_ENV_NAMES } from '@hudhudjs/core/process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FAKE_API_KEY } from '../../src/launcher/env.js';
import { SandboxRefusedError } from '../../src/launcher/errors.js';
import {
  assertKeepsIsolation,
  assertSocketRoom,
  checkTestRoot,
  createSandbox,
  DARWIN_TEST_TEMP_BASE,
  exactLaunch,
  UNREAD_ENV_NAMES,
  launchArgv,
  MAX_SOCKET_PATH_BYTES,
  realHomes,
  resolveTestRoot,
  STREAM_ARGS,
  STRICTER_ADDITIONS,
  testTempBase,
  worstCaseSocketPath,
} from '../../src/launcher/sandbox.js';
import type { Sandbox } from '../../src/launcher/sandbox.js';
import { RecordingSession } from '../../src/fixtures/session.js';
import { makeFakeCli, oneSpellingPerName, scopedPolicy } from './fake-cli.js';
import type { FakeCli } from './fake-cli.js';

const MOCK = { url: 'http://127.0.0.1:47311' };

let fake: FakeCli;
let root = '';

beforeAll(async () => {
  fake = await makeFakeCli();
}, 120_000);

afterAll(async () => {
  await fake.dispose();
});

beforeEach(async () => {
  root = await mkdtemp(path.join(testTempBase(process.platform, tmpdir()), 'hudhud-sandbox-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function refusal(promise: Promise<unknown>): Promise<SandboxRefusedError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SandboxRefusedError);
  return error as SandboxRefusedError;
}

describe('resolveTestRoot', () => {
  it('prefers HUDHUD_TEST_ROOT, then RUNNER_TEMP, then the temp directory', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(resolveTestRoot({ HUDHUD_TEST_ROOT: '/a', RUNNER_TEMP: '/b' }, '/c', platform)).toBe(
        '/a',
      );
      expect(resolveTestRoot({ HUDHUD_TEST_ROOT: '', RUNNER_TEMP: '/b' }, '/c', platform)).toBe(
        '/b',
      );
      expect(resolveTestRoot({}, '/c', platform)).toBe('/c');
    }
  });

  it('on macOS prefers HUDHUD_TEST_ROOT, then /private/tmp: never RUNNER_TEMP or $TMPDIR', () => {
    const tmpdirOfMacos = '/var/folders/nj/vtw8zd2j31d1gdrtntc5y4600000gn/T';
    const ci = { RUNNER_TEMP: '/Users/runner/work/_temp' };
    expect(resolveTestRoot({ ...ci, HUDHUD_TEST_ROOT: '/a' }, tmpdirOfMacos, 'darwin')).toBe('/a');
    expect(resolveTestRoot({ ...ci, HUDHUD_TEST_ROOT: '' }, tmpdirOfMacos, 'darwin')).toBe(
      '/private/tmp',
    );
    expect(resolveTestRoot({}, tmpdirOfMacos, 'darwin')).toBe(DARWIN_TEST_TEMP_BASE);
    expect(resolveTestRoot({}, tmpdir())).toBe(testTempBase(process.platform, tmpdir()));
  });
});

describe('testTempBase', () => {
  it('is /private/tmp on macOS, the temp directory elsewhere', () => {
    expect(testTempBase('darwin', '/var/folders/x/T')).toBe('/private/tmp');
    expect(testTempBase('linux', '/tmp')).toBe('/tmp');
    expect(testTempBase('win32', 'C:\\T')).toBe('C:\\T');
  });

  it('leaves room for the CLI socket below two macOS test directories, where $TMPDIR does not', () => {
    // A test directory (mkdtemp), the run directory (mkdtemp) and its tmp,
    // with the longest names the tests use: the failing macOS CI paths.
    const below = (base: string): string =>
      path.posix.join(base, 'hudhud-recorder-XXXXXX', 'hudhud-launch-XXXXXX', 'tmp');
    const macosTmpdir = '/var/folders/nj/vtw8zd2j31d1gdrtntc5y4600000gn/T';
    expect(() => {
      assertSocketRoom('darwin', below(macosTmpdir));
    }).toThrow(/fall back to \/tmp/);
    expect(() => {
      assertSocketRoom('darwin', below(testTempBase('darwin', macosTmpdir)));
    }).not.toThrow();
  });
});

describe('checkTestRoot', () => {
  it('uses the real path on macOS and the resolved path as given elsewhere', () => {
    const real = realpathSync.native(root);
    expect(checkTestRoot(root, 'darwin')).toBe(real);
    const dotted = path.join(root, '.');
    expect(checkTestRoot(dotted, 'linux')).toBe(path.resolve(dotted));
    expect(checkTestRoot(dotted, 'win32')).toBe(path.resolve(dotted));
  });
});

describe('realHomes', () => {
  it('collects the environment and account homes', () => {
    const homes = realHomes({ HOME: '/h1', USERPROFILE: '' }, () => '/h2');
    expect(homes).toContain(os.homedir());
    expect(homes).toContain('/h1');
    expect(homes).toContain('/h2');
    expect(homes).not.toContain('');
  });

  it('tolerates a missing account entry', () => {
    const homes = realHomes({}, () => {
      throw new Error('no passwd entry');
    });
    expect(homes).toEqual([os.homedir()]);
  });
});

describe('launchArgv', () => {
  it('appends the stream flags, empty setting sources and the default permission mode', () => {
    expect(launchArgv({ args: ['--model=x'] })).toEqual([
      '--model=x',
      ...STREAM_ARGS,
      '--setting-sources=',
      '--permission-mode=default',
    ]);
    expect(launchArgv({ settingSources: 'user,local', permissionMode: 'plan' }).slice(-2)).toEqual([
      '--setting-sources=user,local',
      '--permission-mode=plan',
    ]);
  });

  it.each([
    [{ args: ['--setting-sources=project'] }],
    [{ args: ['--setting-sources'] }],
    [{ args: ['--permission-mode=bypassPermissions'] }],
    [{ args: ['a\0b'] }],
    [{ settingSources: 'project;user' }],
    [{ permissionMode: 'x y' }],
  ])('refuses %j', (options) => {
    expect(() => launchArgv(options)).toThrow(SandboxRefusedError);
  });
});

/** `env` without `names`. */
function without(
  env: Readonly<Record<string, string>>,
  ...names: string[]
): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
}

describe('exactLaunch', () => {
  const SANDBOX = {
    HOME: '/s/home',
    CLAUDE_CONFIG_DIR: '/s/cfg',
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    NO_PROXY: '127.0.0.1',
    no_proxy: '127.0.0.1',
    LANG: 'C.UTF-8',
  };
  const exact = (env: Record<string, string>, argv: string[] = ['--a']) => ({
    exact: { argv, env },
  });

  it('passes the argv as given and the environment through the spawn layer', () => {
    const product = { ...SANDBOX, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
    expect(exactLaunch(exact(product), SANDBOX, 'linux')).toEqual({
      argv: ['--a'],
      env: product,
    });
    // Windows: one variable per name whatever the spelling; the required
    // variables the map lacks are passed empty (core childEnv).
    const win = without(product, 'no_proxy');
    const spawned = exactLaunch(exact(win), SANDBOX, 'win32');
    expect(spawned.env['NO_PROXY']).toBe('127.0.0.1');
    expect(spawned.env['USERNAME']).toBe('');
    expect(spawned.env['SYSTEMROOT']).toBe('');
  });

  it('refuses a missing exact launch, mixed options and NUL', () => {
    expect(() => exactLaunch({}, SANDBOX, 'linux')).toThrow(/no exact launch/u);
    expect(() =>
      exactLaunch({ ...exact(SANDBOX), args: ['--x'], env: {} }, SANDBOX, 'linux'),
    ).toThrow(/takes no args, env/u);
    expect(() => exactLaunch(exact(SANDBOX, ['a\0b']), SANDBOX, 'linux')).toThrow(/NUL/u);
  });

  it('lets the launch leave out only what the platform never reads', () => {
    const withTemp = { ...SANDBOX, TEMP: '/s/tmp', TMPDIR: '/s/tmp' };
    const noTemp = without(withTemp, 'TEMP');
    expect(exactLaunch(exact(noTemp), withTemp, 'linux').env).not.toHaveProperty('TEMP');
    const noTmpdir = without(withTemp, 'TMPDIR');
    expect(() => exactLaunch(exact(noTmpdir), withTemp, 'linux')).toThrow(/changes TMPDIR/u);
    const winKept = without(withTemp, 'no_proxy', 'HOME', 'TMPDIR');
    expect(exactLaunch(exact(winKept), withTemp, 'win32').env).not.toHaveProperty('HOME');
    expect(UNREAD_ENV_NAMES).toEqual({ posix: ['TMP', 'TEMP'], win32: ['HOME', 'TMPDIR'] });
  });

  it('refuses a dropped, changed or added protected variable, compared as the OS does', () => {
    const noHome = without(SANDBOX, 'HOME');
    expect(() => exactLaunch(exact(noHome), SANDBOX, 'linux')).toThrow(/changes HOME.*dropped/u);
    expect(() =>
      exactLaunch(exact({ ...SANDBOX, CLAUDE_CONFIG_DIR: '/real/.claude' }), SANDBOX, 'linux'),
    ).toThrow(/changes CLAUDE_CONFIG_DIR.*changed or added/u);
    expect(() =>
      exactLaunch(exact({ ...SANDBOX, ANTHROPIC_AUTH_TOKEN: 'x' }), SANDBOX, 'linux'),
    ).toThrow(/changes ANTHROPIC_AUTH_TOKEN/u);
    // POSIX names are exact: dropping the lower-case spelling drops a variable.
    const oneSpelling = without(SANDBOX, 'no_proxy');
    expect(() => exactLaunch(exact(oneSpelling), SANDBOX, 'linux')).toThrow(/changes no_proxy/u);
    expect(() =>
      exactLaunch(exact({ ...oneSpelling, home: '/elsewhere' }), SANDBOX, 'win32'),
    ).toThrow(/names home twice in different case/u);
    const lowerHome = without(oneSpelling, 'HOME');
    expect(() =>
      exactLaunch(exact({ ...lowerHome, home: '/elsewhere' }), SANDBOX, 'win32'),
    ).toThrow(/changes HOME.*changed/u);
  });
});

describe('assertKeepsIsolation', () => {
  const SANDBOX = { HOME: '/s/home', ANTHROPIC_API_KEY: FAKE_API_KEY, LANG: 'C.UTF-8' };

  it('lets a caller name further variables that may be left out, in any case', () => {
    const noKey = without(SANDBOX, 'ANTHROPIC_API_KEY');
    expect(() => {
      assertKeepsIsolation(noKey, SANDBOX, 'linux');
    }).toThrow(/changes ANTHROPIC_API_KEY.*dropped/u);
    expect(() => {
      assertKeepsIsolation(noKey, SANDBOX, 'linux', { mayDrop: ['anthropic_api_key'] });
    }).not.toThrow();
    // Only left out: a changed value is still refused.
    expect(() => {
      assertKeepsIsolation({ ...SANDBOX, ANTHROPIC_API_KEY: 'x' }, SANDBOX, 'win32', {
        mayDrop: ['ANTHROPIC_API_KEY'],
      });
    }).toThrow(/changes ANTHROPIC_API_KEY.*changed/u);
    // Unprotected variables may differ.
    expect(() => {
      assertKeepsIsolation(without(SANDBOX, 'LANG'), without(SANDBOX, 'LANG'), 'linux');
    }).not.toThrow();
  });

  it('lets a launch add only the stricter switches the sandbox left out, with their value', () => {
    const name = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
    expect(STRICTER_ADDITIONS).toEqual({ [name]: '1' });
    const stricter = { mayAdd: STRICTER_ADDITIONS };
    expect(() => {
      assertKeepsIsolation({ ...SANDBOX, [name]: '1' }, SANDBOX, 'linux');
    }).toThrow(/changes CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.*added/u);
    expect(() => {
      assertKeepsIsolation({ ...SANDBOX, [name]: '1' }, SANDBOX, 'linux', stricter);
    }).not.toThrow();
    expect(() => {
      assertKeepsIsolation({ ...SANDBOX, [name.toLowerCase()]: '1' }, SANDBOX, 'win32', stricter);
    }).not.toThrow();
    expect(() => {
      assertKeepsIsolation({ ...SANDBOX, [name]: '0' }, SANDBOX, 'linux', stricter);
    }).toThrow(/changes CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC/u);
    // A value the sandbox pins is never replaced, not even by the allowed one.
    expect(() => {
      assertKeepsIsolation({ ...SANDBOX, [name]: '1' }, { ...SANDBOX, [name]: 'yes' }, 'linux', {
        mayAdd: STRICTER_ADDITIONS,
      });
    }).toThrow(/changes CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.*changed/u);
  });
});

describe('assertSocketRoom', () => {
  it('refuses a POSIX temp directory too long for the CLI socket', () => {
    const long = `/${'x'.repeat(MAX_SOCKET_PATH_BYTES)}`;
    expect(Buffer.byteLength(worstCaseSocketPath('/t'))).toBeLessThan(MAX_SOCKET_PATH_BYTES);
    expect(() => {
      assertSocketRoom('linux', '/t');
    }).not.toThrow();
    expect(() => {
      assertSocketRoom('linux', long);
    }).toThrow(/fall back to \/tmp/);
    expect(() => {
      assertSocketRoom('win32', long);
    }).not.toThrow();
  });
});

describe('createSandbox refusals', () => {
  it('refuses a relative, missing or non-directory test root', async () => {
    expect(
      (await refusal(createSandbox({ cli: fake.cli, mock: MOCK, testRoot: 'rel' }))).code,
    ).toBe('test-root');
    expect(
      (
        await refusal(
          createSandbox({ cli: fake.cli, mock: MOCK, testRoot: path.join(root, 'missing') }),
        )
      ).code,
    ).toBe('test-root');
    const file = path.join(root, 'file');
    await writeFile(file, '');
    expect((await refusal(createSandbox({ cli: fake.cli, mock: MOCK, testRoot: file }))).code).toBe(
      'test-root',
    );
  });

  it('refuses, with the real policy, a test root below a planted .claude directory', async () => {
    const testRoot = path.join(root, 'inner');
    await mkdir(path.join(root, '.claude'));
    await mkdir(testRoot);
    const error = await refusal(createSandbox({ cli: fake.cli, mock: MOCK, testRoot }));
    expect(error.code).toBe('forbidden-ancestor');
    expect(error.message).toContain(`${root} contains .claude`);
    expect(error.message).toContain('HUDHUD_TEST_ROOT');
    expect(await readdir(testRoot)).toEqual([]);
  });

  it('refuses, with the real policy, a default test root that lies under the real home', async () => {
    const tmp = path.resolve(resolveTestRoot(process.env, tmpdir(), process.platform));
    const home = path.resolve(os.homedir());
    const underHome = tmp.toLowerCase().startsWith(home.toLowerCase() + path.sep);
    const attempt = createSandbox({ cli: fake.cli, mock: MOCK });
    if (underHome) {
      const error = await refusal(attempt);
      expect(error.message).toContain('is the real home directory');
    } else {
      const outcome = await attempt.then(
        async (sandbox) => {
          await sandbox.dispose();
          return 'created';
        },
        (error: unknown) => (error instanceof SandboxRefusedError ? error.code : 'other'),
      );
      expect(['created', 'forbidden-ancestor']).toContain(outcome);
    }
  });

  it('removes the run directory when the run directory itself is refused', async () => {
    const policy = scopedPolicy(root);
    const error = await refusal(
      createSandbox({
        cli: fake.cli,
        mock: MOCK,
        testRoot: root,
        ancestorPolicy: {
          homes: [],
          probe: {
            exists: (file) => path.basename(path.dirname(file)).startsWith('hudhud-run-'),
            realpath: (dir) => policy.probe.realpath(dir),
          },
        },
      }),
    );
    expect(error.code).toBe('forbidden-ancestor');
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a CLI that resolvePinnedCli did not issue', async () => {
    const forged = { ...fake.cli };
    const error = await refusal(createSandbox({ cli: forged, mock: MOCK, testRoot: root }));
    expect(error.code).toBe('binary');
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a bad name and a non-loopback mock', async () => {
    const base = { cli: fake.cli, testRoot: root, ancestorPolicy: scopedPolicy(root) };
    expect((await refusal(createSandbox({ ...base, mock: MOCK, name: 'a/b' }))).code).toBe(
      'unsafe-option',
    );
    expect(
      (await refusal(createSandbox({ ...base, mock: { url: 'http://10.0.0.1:1' } }))).code,
    ).toBe('mock');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('launching the pinned binary', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox({
      cli: fake.cli,
      mock: MOCK,
      testRoot: root,
      name: 'launch',
      ancestorPolicy: scopedPolicy(root),
      env: { FAKE_CLI_MODE: 'dump' },
      gitBashPath: process.platform === 'win32' ? 'C:\\Git\\bin\\bash.exe' : null,
    });
  });

  afterEach(async () => {
    await sandbox.dispose();
  });

  it('creates the redirected directories inside the run directory', () => {
    const { dirs } = sandbox;
    expect(path.basename(dirs.root)).toMatch(/^hudhud-launch-/);
    for (const dir of [dirs.cfg, dirs.home, dirs.appData, dirs.localAppData, dirs.tmp, dirs.work]) {
      expect(existsSync(dir)).toBe(true);
      expect(dir.startsWith(dirs.root + path.sep)).toBe(true);
    }
    expect(sandbox.env['ANTHROPIC_API_KEY']).toBe(FAKE_API_KEY);
    expect(sandbox.mockUrl).toBe(MOCK.url);
    expect(sandbox.platform).toBe(process.platform);
  });

  it('spawns only the verified binary with the explicit environment, flags and cwd', async () => {
    const session = await RecordingSession.start(sandbox, {
      args: [fake.script],
      env: { EXTRA_FLAG: '1' },
    });
    const dump = await session.waitType('dump', undefined, 30_000);
    await session.stop(10_000);
    const v = dump.v as { argv: string[]; env: Record<string, string>; cwd: string };
    expect(v.argv).toEqual([...STREAM_ARGS, '--setting-sources=', '--permission-mode=default']);
    expect(path.resolve(v.cwd).toLowerCase()).toBe(path.resolve(sandbox.dirs.work).toLowerCase());
    const expected = { ...sandbox.env, EXTRA_FLAG: '1' };
    // Names compare as the OS does: case-insensitively on Windows (one
    // variable per name), exactly on POSIX (`HTTPS_PROXY` and `https_proxy`
    // are two variables there, and the sandbox sets both).
    const fold = (k: string): string => (process.platform === 'win32' ? k.toUpperCase() : k);
    // On darwin the child's CoreFoundation sets these itself at startup
    // (core DARWIN_CHILD_SET_ENV_NAMES); only they may appear beyond the map.
    const childSet = process.platform === 'darwin' ? DARWIN_CHILD_SET_ENV_NAMES : [];
    const childKeys = Object.keys(v.env)
      .filter((k) => !(childSet.includes(k) && !Object.hasOwn(expected, k)))
      .map(fold)
      .sort();
    const expectedKeys = [...new Set(Object.keys(expected).map(fold))].sort();
    expect(childKeys).toEqual(expectedKeys);
    expect(v.env['ANTHROPIC_API_KEY']).toBe(FAKE_API_KEY);
    expect(v.env['ANTHROPIC_BASE_URL']).toBe(MOCK.url);
    expect(v.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
    expect(session.process.argv[0]).toBe(fake.script);
    expect(session.process.pid).toBeGreaterThan(0);
    expect(session.process.env['EXTRA_FLAG']).toBe('1');
  }, 60_000);

  it('spawns an exact (product-built) launch as given, through the spawn layer', async () => {
    const env = {
      ...oneSpellingPerName(sandbox.env),
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    };
    const session = await RecordingSession.start(sandbox, {
      exact: { argv: [fake.script, '--output-format=stream-json', '--verbose'], env },
    });
    const dump = await session.waitType('dump', undefined, 30_000);
    await session.stop(10_000);
    const v = dump.v as { argv: string[]; env: Record<string, string> };
    expect(v.argv).toEqual(['--output-format=stream-json', '--verbose']);
    expect(v.env['CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS']).toBe('1');
    expect(v.env['ANTHROPIC_API_KEY']).toBe(FAKE_API_KEY);
    expect(session.process.env).toEqual(
      childEnv(env, process.platform === 'win32' ? 'win32' : 'posix'),
    );
  }, 60_000);

  it('refuses an exact launch that would undo the sandbox', async () => {
    const rest = without(oneSpellingPerName(sandbox.env), 'ANTHROPIC_BASE_URL');
    await expect(sandbox.launch({ exact: { argv: [fake.script], env: rest } })).rejects.toThrow(
      /changes ANTHROPIC_BASE_URL/u,
    );
  });

  it('refuses protected variables at launch', async () => {
    await expect(
      sandbox.launch({ args: [fake.script], env: { ANTHROPIC_BASE_URL: 'http://x' } }),
    ).rejects.toThrow(SandboxRefusedError);
  });

  it('rejects when the spawn fails', async () => {
    await rm(sandbox.dirs.work, { recursive: true });
    await expect(sandbox.launch({ args: [fake.script] })).rejects.toThrow();
  });

  it('disposes of the run directory', async () => {
    await sandbox.dispose();
    expect(existsSync(sandbox.dirs.root)).toBe(false);
  });
});

describe('sandbox defaults', () => {
  it('locates Git Bash by default, honours null and keeps the nonessential variable on', async () => {
    const base = { cli: fake.cli, mock: MOCK, testRoot: root, ancestorPolicy: scopedPolicy(root) };
    const byDefault = await createSandbox(base);
    const none = await createSandbox({
      ...base,
      gitBashPath: null,
      nonessentialTraffic: 'allowed',
      credential: 'fake-auth-token',
    });
    try {
      expect(byDefault.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
      expect(byDefault.env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
      expect(none.env['ANTHROPIC_AUTH_TOKEN']).toMatch(/^sk-ant-fake-hudhud-/);
      expect(none.env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(none.env['CLAUDE_CODE_GIT_BASH_PATH']).toBeUndefined();
      expect(none.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBeUndefined();
      expect(path.basename(byDefault.dirs.root)).toMatch(/^hudhud-run-/);
    } finally {
      await byDefault.dispose();
      await none.dispose();
    }
  });
});
