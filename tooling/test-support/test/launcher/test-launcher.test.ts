import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SandboxRefusedError } from '../../src/launcher/errors.js';
import type { VerifiedCli } from '../../src/launcher/pinned-cli.js';
import {
  MAX_LINGER_MS,
  recheckTestLauncher,
  TEST_LAUNCHER_FILE,
  testLauncherSource,
  writeTestLauncher,
} from '../../src/launcher/test-launcher.js';
import type { TestLauncher } from '../../src/launcher/test-launcher.js';
import { makeFakeCli } from './fake-cli.js';
import type { FakeCli } from './fake-cli.js';

const POSIX = process.platform !== 'win32';
/** A `#!` path for launchers written on any host (a Windows host has no POSIX Node.js path). */
const NODE = '/usr/local/bin/node';

let fake: FakeCli;
let dir = '';

beforeAll(async () => {
  fake = await makeFakeCli();
}, 120_000);

afterAll(async () => {
  await fake.dispose();
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hudhud-launcher-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function refusalOf(action: () => unknown): SandboxRefusedError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxRefusedError);
    return error as SandboxRefusedError;
  }
  throw new Error('expected a refusal');
}

describe('testLauncherSource', () => {
  it('has the shape of 07 §4 t14-launcher.cjs and names only the given binary', () => {
    const source = testLauncherSource({ binaryPath: '/cache/2.1.296/claude', nodePath: NODE });
    const lines = source.split('\n');
    expect(lines[0]).toBe(`#!${NODE}`);
    expect(source).toContain(`const BINARY = "/cache/2.1.296/claude";`);
    expect(source).toContain("spawnSync(BINARY, args, { stdio: 'inherit' })");
    expect(source).toContain('const LINGER_MS = 0;');
    expect(source).toContain('const IGNORE_SIGTERM = false;');
    expect(source.endsWith('\n')).toBe(true);
  });

  it('embeds the deviations and escapes the binary path as a JSON literal', () => {
    const source = testLauncherSource({
      binaryPath: '/odd "dir"/claude',
      nodePath: NODE,
      options: { lingerMs: MAX_LINGER_MS, ignoreSigterm: true },
    });
    expect(source).toContain(`const BINARY = "/odd \\"dir\\"/claude";`);
    expect(source).toContain(`const LINGER_MS = ${String(MAX_LINGER_MS)};`);
    expect(source).toContain('const IGNORE_SIGTERM = true;');
  });

  it('refuses an invalid linger and a Node.js path that is not one absolute POSIX line', () => {
    for (const lingerMs of [-1, 1.5, MAX_LINGER_MS + 1, Number.NaN]) {
      const refusal = refusalOf(() =>
        testLauncherSource({ binaryPath: '/b', nodePath: NODE, options: { lingerMs } }),
      );
      expect(refusal.code).toBe('unsafe-option');
      expect(refusal.message).toMatch(/lingerMs/);
    }
    for (const nodePath of ['node', 'C:\\node.exe', '/usr/bin/node\n#!/bin/sh', '/a\rb']) {
      const refusal = refusalOf(() => testLauncherSource({ binaryPath: '/b', nodePath }));
      expect(refusal.code).toBe('unsafe-option');
      expect(refusal.message).toMatch(/Node\.js path/);
    }
  });
});

describe('writeTestLauncher and recheckTestLauncher', () => {
  async function written(): Promise<TestLauncher> {
    return writeTestLauncher({ dir, cli: fake.cli, platform: 'linux', nodePath: NODE });
  }

  it('refuses win32: a launcher there would have to be a native executable', async () => {
    const refused = await writeTestLauncher({ dir, cli: fake.cli, platform: 'win32' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(SandboxRefusedError);
    expect((refused as SandboxRefusedError).code).toBe('unsafe-option');
    expect((refused as SandboxRefusedError).message).toMatch(/native executable/);
  });

  it('refuses a pinned binary that changed since its verification', async () => {
    const changed: VerifiedCli = {
      ...fake.cli,
      identity: { ...fake.cli.identity, size: fake.cli.identity.size + 1n },
    };
    await expect(
      writeTestLauncher({ dir, cli: changed, platform: 'linux', nodePath: NODE }),
    ).rejects.toMatchObject({ code: 'binary' });
  });

  it('writes the generated source into a new file, never over an existing one', async () => {
    const nested = path.join(dir, 'nested');
    const launcher = await writeTestLauncher({
      dir: nested,
      cli: fake.cli,
      platform: 'linux',
      nodePath: NODE,
      options: { lingerMs: 10 },
    });
    expect(launcher.path).toBe(path.join(nested, TEST_LAUNCHER_FILE));
    expect(launcher.cli).toBe(fake.cli);
    expect(launcher.source).toContain('const LINGER_MS = 10;');
    expect(Object.isFrozen(launcher)).toBe(true);
    if (POSIX) expect((await stat(launcher.path)).mode & 0o777).toBe(0o700);
    expect(() => {
      recheckTestLauncher(launcher);
    }).not.toThrow();
    await expect(
      writeTestLauncher({ dir: nested, cli: fake.cli, platform: 'linux', nodePath: NODE }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it.runIf(POSIX)('uses the running Node.js binary for the #! line by default', async () => {
    const launcher = await writeTestLauncher({ dir, cli: fake.cli, platform: process.platform });
    expect(launcher.source.split('\n')[0]).toBe(`#!${process.execPath}`);
  });

  it.runIf(!POSIX)(
    'refuses the default #! line on a host whose Node.js path is not POSIX',
    async () => {
      await expect(
        writeTestLauncher({ dir, cli: fake.cli, platform: 'linux' }),
      ).rejects.toMatchObject({ code: 'unsafe-option' });
    },
  );

  it('refuses a launcher that was changed, removed or replaced by a directory', async () => {
    const launcher = await written();
    await writeFile(launcher.path, `${launcher.source}// tampered\n`);
    expect(
      refusalOf(() => {
        recheckTestLauncher(launcher);
      }).message,
    ).toMatch(/changed since/);
    await rm(launcher.path);
    const gone = refusalOf(() => {
      recheckTestLauncher(launcher);
    });
    expect(gone.code).toBe('binary');
    expect(gone.message).toMatch(/not the generated launcher/);
    await mkdir(launcher.path);
    expect(
      refusalOf(() => {
        recheckTestLauncher(launcher);
      }).message,
    ).toMatch(/not the generated launcher/);
  });

  it('refuses a launcher whose pinned binary changed since its verification', async () => {
    const launcher = await written();
    const stale: TestLauncher = {
      ...launcher,
      cli: { ...fake.cli, identity: { ...fake.cli.identity, mtimeNs: 1n } },
    };
    expect(
      refusalOf(() => {
        recheckTestLauncher(stale);
      }).code,
    ).toBe('binary');
  });
});

/** Runs a launcher in front of the fake CLI (its script is the first argument). */
function run(
  launcher: TestLauncher,
  args: readonly string[],
  mode: string,
): {
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
  kill: (signal: NodeJS.Signals) => void;
} {
  const started = Date.now();
  const child = spawn(launcher.path, [fake.script, ...args], {
    env: { FAKE_CLI_MODE: mode },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return {
    exit: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        resolve({ code, signal, ms: Date.now() - started });
      });
    }),
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

describe.runIf(POSIX)('a launcher in front of the fake CLI (POSIX)', () => {
  it('runs the binary with its argv and exits with its status', async () => {
    const launcher = await writeTestLauncher({ dir, cli: fake.cli, platform: process.platform });
    const { exit } = run(launcher, [], 'exit-now');
    await expect(exit).resolves.toMatchObject({ code: 3, signal: null });
  });

  it('lingers after a session run but not after the version probe', async () => {
    const launcher = await writeTestLauncher({
      dir,
      cli: fake.cli,
      platform: process.platform,
      options: { lingerMs: 400 },
    });
    const lingered = await run(launcher, [], 'exit-now').exit;
    expect(lingered).toMatchObject({ code: 3, signal: null });
    expect(lingered.ms).toBeGreaterThanOrEqual(400);
    const probe = await run(launcher, ['--version'], 'exit-now').exit;
    expect(probe).toMatchObject({ code: 3, signal: null });
  });

  it('ends by SIGTERM while lingering, unless it ignores SIGTERM', async () => {
    const plain = await writeTestLauncher({
      dir: path.join(dir, 'plain'),
      cli: fake.cli,
      platform: process.platform,
      options: { lingerMs: 30_000 },
    });
    const ignoring = await writeTestLauncher({
      dir: path.join(dir, 'ignoring'),
      cli: fake.cli,
      platform: process.platform,
      options: { lingerMs: 30_000, ignoreSigterm: true },
    });
    const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const first = run(plain, [], 'exit-now');
    const second = run(ignoring, [], 'exit-now');
    // Both are lingering once the fake CLI exited (it exits at once).
    await settle(1000);
    first.kill('SIGTERM');
    second.kill('SIGTERM');
    await expect(first.exit).resolves.toMatchObject({ signal: 'SIGTERM' });
    const stillRunning = await Promise.race([
      second.exit.then(() => false),
      settle(500).then(() => true),
    ]);
    expect(stillRunning).toBe(true);
    second.kill('SIGKILL');
    await expect(second.exit).resolves.toMatchObject({ signal: 'SIGKILL' });
  });
});
