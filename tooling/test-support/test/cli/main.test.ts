import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runFetchCli } from '../../src/cli/main.js';
import type { FetchCliHost } from '../../src/cli/main.js';
import type { FakeRegistry } from './fake-registry.js';
import {
  fakeRegistry,
  json,
  manifestFor,
  pinDocument,
  release,
  serve,
  serveSdk,
} from './fake-registry.js';

const LINUX = release('linux-x64', '9.9.9');
const WIN = release('win32-x64', '9.9.9');
// The fake host is win32 on Windows and linux elsewhere (arch x64), so the
// default runs always target a platform the fake registry serves: macOS hosts
// would otherwise derive darwin-*, which this test's fake pin keeps
// pendingGate (the real pin has pinned darwin since the macOS gate).
const FAKE_PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';
const HOST_RELEASE = FAKE_PLATFORM === 'win32' ? WIN : LINUX;

let root = '';
let registry: FakeRegistry;
let out = '';
let err = '';
let summaries: { file: string; text: string }[] = [];
let written: { file: string; text: string }[] = [];
let removed: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-main-'));
  registry = fakeRegistry();
  serve(registry, LINUX);
  serve(registry, WIN);
  out = '';
  err = '';
  summaries = [];
  written = [];
  removed = [];
  const doc = pinDocument(LINUX, WIN) as { platforms: Record<string, unknown> };
  doc.platforms['darwin-arm64'] = {
    package: '@anthropic-ai/claude-code-darwin-arm64',
    file: 'claude',
    pendingGate: true,
  };
  await mkdir(path.join(root, 'tooling'));
  await writeFile(path.join(root, 'tooling', 'cli-pin.json'), JSON.stringify(doc));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

function host(
  argv: string[],
  env: Record<string, string> = {},
  overrides: Partial<FetchCliHost> = {},
): FetchCliHost {
  return {
    argv,
    env,
    repoRoot: root,
    fetch: registry.fetch,
    platform: FAKE_PLATFORM,
    arch: 'x64',
    report: () => ({ header: { glibcVersionRuntime: '2.36' } }),
    now: () => new Date('2026-10-12T03:00:00.000Z'),
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    appendFile: (file, text) => {
      summaries.push({ file, text });
      return Promise.resolve();
    },
    writeFile: (file, text) => {
      written.push({ file, text });
      return Promise.resolve();
    },
    removeFile: (file) => {
      removed.push(file);
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe('runFetchCli usage', () => {
  it('prints help', async () => {
    expect(await runFetchCli(host(['--help']))).toBe(0);
    expect(out).toContain('usage: fetch-cli');
  });

  it.each([[['--bogus']], [['positional']], [['--platform']]])(
    'rejects %j with exit 2',
    async (argv) => {
      expect(await runFetchCli(host(argv))).toBe(2);
      expect(err).toContain('usage: fetch-cli');
    },
  );

  it('rejects an unknown channel and --all with newest', async () => {
    expect(await runFetchCli(host([], { HUDHUD_CLI_CHANNEL: 'weird' }))).toBe(2);
    expect(err).toContain('unknown channel "weird"');
    expect(await runFetchCli(host(['--channel', 'newest', '--all']))).toBe(2);
    expect(err).toContain('--all applies to the pinned channel only');
    expect(registry.calls).toEqual([]);
  });

  it('rejects --version outside the newest channel and an invalid version', async () => {
    expect(await runFetchCli(host(['--version', '9.9.9']))).toBe(2);
    expect(err).toContain('--version applies to the newest channel only');
    expect(await runFetchCli(host(['--channel', 'newest', '--version', '../9']))).toBe(2);
    expect(err).toContain('not a SemVer version "../9"');
    expect(registry.calls).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe('runFetchCli pinned', () => {
  it('fetches the host platform into the default cache with the default pin', async () => {
    expect(await runFetchCli(host([], { HUDHUD_CLI_CHANNEL: '', HUDHUD_CLI_CACHE: '' }))).toBe(0);
    const binaryPath = path.join(
      root,
      '.cache',
      'claude-cli',
      '9.9.9',
      HOST_RELEASE.platform,
      HOST_RELEASE.file,
    );
    expect(out).toBe(
      `ok ${HOST_RELEASE.platform} 9.9.9 cache=fetched sha256=${HOST_RELEASE.sha256} size=${String(HOST_RELEASE.size)} path=${binaryPath}\n`,
    );
    expect(err).toBe('');
  });

  it('fetches every platform with digests (--all) and reuses the cache', async () => {
    const env = { HUDHUD_CLI_CACHE: 'elsewhere' };
    expect(await runFetchCli(host(['--all'], env))).toBe(0);
    expect(out.match(/cache=fetched/g)).toHaveLength(2);
    out = '';
    expect(await runFetchCli(host(['--all'], env))).toBe(0);
    expect(out.match(/cache=hit/g)).toHaveLength(2);
    expect(out).toContain(path.join(root, 'elsewhere', '9.9.9', 'win32-x64', 'claude.exe'));
  });

  it('honours --platform, --cache and --pin', async () => {
    const pinFile = path.join(root, 'other-pin.json');
    await writeFile(pinFile, JSON.stringify(pinDocument(WIN)));
    const argv = ['--platform', 'win32-x64', '--cache', path.join(root, 'c'), '--pin', pinFile];
    expect(await runFetchCli(host(argv))).toBe(0);
    expect(out).toContain(`ok win32-x64 9.9.9 cache=fetched sha256=${WIN.sha256}`);
  });

  it('reports fetch failures with their code and exits 1', async () => {
    expect(await runFetchCli(host(['--platform', 'darwin-arm64']))).toBe(1);
    expect(err).toContain('fetch-cli: [platform-unavailable]');
    err = '';
    expect(await runFetchCli(host([], {}, { platform: 'aix', arch: 'ppc64' }))).toBe(1);
    expect(err).toContain('[platform-unavailable] unsupported host platform aix-ppc64');
  });

  it('detects musl on Linux and honours the libc override', async () => {
    // The pin has no linux-*-musl entry and the Linux key fails on the second
    // pin, so the error names the platform key that was derived.
    const winOnly = path.join(root, 'win-only.json');
    await writeFile(winOnly, JSON.stringify(pinDocument(WIN)));
    const linux = { platform: 'linux' as const };
    const run = async (
      argv: string[],
      env: Record<string, string>,
      overrides: Partial<FetchCliHost>,
    ): Promise<string> => {
      err = '';
      expect(await runFetchCli(host(['--pin', winOnly, ...argv], env, overrides))).toBe(1);
      return err;
    };
    const musl = { ...linux, report: () => ({ header: {} }) };
    expect(await run([], {}, musl)).toContain('no pin entry for platform linux-x64-musl');
    expect(await run([], {}, linux)).toContain('no pin entry for platform linux-x64\n');
    expect(await run(['--libc', 'glibc'], {}, musl)).toContain('platform linux-x64\n');
    expect(await run([], { HUDHUD_CLI_LIBC: 'musl' }, linux)).toContain('linux-x64-musl');
    let reported = false;
    const watched = {
      platform: 'darwin' as const,
      report: () => {
        reported = true;
        return {};
      },
    };
    expect(await run([], {}, watched)).toContain('no pin entry for platform darwin-x64\n');
    expect(reported).toBe(false);
  });

  it('rejects an unknown libc', async () => {
    expect(await runFetchCli(host(['--libc', 'uclibc']))).toBe(2);
    expect(err).toContain('unknown libc "uclibc"');
  });

  it('reports other failures and exits 1', async () => {
    expect(await runFetchCli(host(['--pin', path.join(root, 'missing.json')]))).toBe(1);
    expect(err).toMatch(/fetch-cli: Error: ENOENT/);
  });
});

describe('runFetchCli newest', () => {
  const LATEST = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';

  beforeEach(() => {
    registry.routes.set(LATEST, json({ name: '@anthropic-ai/claude-code', version: '9.9.9' }));
    serveSdk(registry, '0.9.9', '9.9.9', manifestFor('9.9.9', LINUX, WIN));
  });

  it('prints the cross-check result', async () => {
    expect(await runFetchCli(host(['--channel', 'newest', '--platform', 'linux-x64']))).toBe(0);
    expect(out).toContain(
      'cross-check=verified @anthropic-ai/claude-agent-sdk@0.9.9 manifest.json',
    );
    out = '';
    serveSdk(registry, '0.9.10', '9.9.8');
    expect(await runFetchCli(host(['--channel', 'newest', '--platform', 'linux-x64']))).toBe(0);
    expect(out).toContain('cross-check=unavailable @anthropic-ai/claude-agent-sdk@0.9.10 (latest)');
  });

  it('records the integrity and writes the job summary', async () => {
    const env = {
      HUDHUD_CLI_CHANNEL: 'newest',
      GITHUB_STEP_SUMMARY: path.join(root, 'summary.md'),
    };
    expect(await runFetchCli(host([], env))).toBe(0);
    expect(out).toContain(
      `recorded ${HOST_RELEASE.pkg}@9.9.9 integrity=${HOST_RELEASE.integrity} at 2026-10-12T03:00:00.000Z`,
    );
    expect(out).toContain(
      `ok ${HOST_RELEASE.platform} 9.9.9 cache=fetched sha256=${HOST_RELEASE.sha256}`,
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.file).toBe(env.GITHUB_STEP_SUMMARY);
    expect(summaries[0]?.text).toContain(HOST_RELEASE.integrity);
  });

  it('fetches each --platform and skips the summary when none is configured', async () => {
    expect(
      await runFetchCli(
        host(['--channel', 'newest', '--platform', 'win32-x64'], { GITHUB_STEP_SUMMARY: '' }),
      ),
    ).toBe(0);
    expect(out).toContain('ok win32-x64 9.9.9');
    expect(summaries).toEqual([]);
  });

  it('resolves latest once, removes a stale run pin first and writes the new one', async () => {
    const argv = ['--channel', 'newest', '--platform', 'linux-x64', '--platform', 'win32-x64'];
    expect(await runFetchCli(host([...argv, '--cache', 'c']))).toBe(0);
    expect(registry.calls.filter((url) => url === LATEST)).toHaveLength(1);
    const pinFile = path.join(root, 'c', 'run-pin.json');
    expect(removed).toEqual([pinFile]);
    expect(written.map((item) => item.file)).toEqual([pinFile]);
    const doc = JSON.parse(written[0]?.text ?? '') as {
      version: string;
      platforms: Record<string, unknown>;
    };
    expect(doc.version).toBe('9.9.9');
    expect(Object.keys(doc.platforms)).toEqual(['linux-x64', 'win32-x64']);
    expect(out).toContain(`run-pin ${pinFile}\n`);
  });

  it('records an exact --version without reading latest (the dry run)', async () => {
    const old = release('linux-x64', '9.9.8');
    serve(registry, old);
    const argv = ['--channel', 'newest', '--version', '9.9.8', '--platform', 'linux-x64'];
    expect(await runFetchCli(host(argv))).toBe(0);
    expect(registry.calls).not.toContain(LATEST);
    expect(out).toContain(`recorded ${old.pkg}@9.9.8 integrity=${old.integrity}`);
    expect(out).toContain('cross-check=unavailable');
    expect(written[0]?.text).toContain('"version": "9.9.8"');
  });

  it('writes no run pin when a fetch fails', async () => {
    registry.routes.delete(LINUX.tarballUrl);
    expect(await runFetchCli(host(['--channel', 'newest', '--platform', 'linux-x64']))).toBe(1);
    expect(removed).toHaveLength(1);
    expect(written).toEqual([]);
  });
});
