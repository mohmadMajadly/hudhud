import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FAKE_API_KEY } from '../../src/launcher/env.js';
import { SandboxRefusedError } from '../../src/launcher/errors.js';
import {
  assertSocketRoom,
  createSandbox,
  launchArgv,
  MAX_SOCKET_PATH_BYTES,
  realHomes,
  resolveTestRoot,
  STREAM_ARGS,
  worstCaseSocketPath,
} from '../../src/launcher/sandbox.js';
import type { Sandbox } from '../../src/launcher/sandbox.js';
import { RecordingSession } from '../../src/fixtures/session.js';
import { makeFakeCli, scopedPolicy } from './fake-cli.js';
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
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-sandbox-'));
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
    expect(resolveTestRoot({ HUDHUD_TEST_ROOT: '/a', RUNNER_TEMP: '/b' }, '/c')).toBe('/a');
    expect(resolveTestRoot({ HUDHUD_TEST_ROOT: '', RUNNER_TEMP: '/b' }, '/c')).toBe('/b');
    expect(resolveTestRoot({}, '/c')).toBe('/c');
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
    const tmp = path.resolve(resolveTestRoot(process.env, tmpdir()));
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
    const childKeys = Object.keys(v.env).map(fold).sort();
    const expectedKeys = [...new Set(Object.keys(expected).map(fold))].sort();
    expect(childKeys).toEqual(expectedKeys);
    expect(v.env['ANTHROPIC_API_KEY']).toBe(FAKE_API_KEY);
    expect(v.env['ANTHROPIC_BASE_URL']).toBe(MOCK.url);
    expect(v.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
    expect(session.process.argv[0]).toBe(fake.script);
    expect(session.process.pid).toBeGreaterThan(0);
    expect(session.process.env['EXTRA_FLAG']).toBe('1');
  }, 60_000);

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
    });
    try {
      expect(byDefault.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
      expect(none.env['CLAUDE_CODE_GIT_BASH_PATH']).toBeUndefined();
      expect(none.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBeUndefined();
      expect(path.basename(byDefault.dirs.root)).toMatch(/^hudhud-run-/);
    } finally {
      await byDefault.dispose();
      await none.dispose();
    }
  });
});
