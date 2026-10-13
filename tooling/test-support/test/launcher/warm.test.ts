import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSandbox, testTempBase } from '../../src/launcher/sandbox.js';
import { warmSandbox, WarmUpError } from '../../src/launcher/warm.js';
import { makeFakeCli, scopedPolicy } from './fake-cli.js';
import type { FakeCli } from './fake-cli.js';

let fake: FakeCli;
let root = '';

beforeAll(async () => {
  fake = await makeFakeCli();
}, 120_000);

afterAll(async () => {
  await fake.dispose();
});

beforeEach(async () => {
  // Short on macOS too: the sandbox's socket path must fit (05 §13).
  root = await mkdtemp(path.join(testTempBase(process.platform, tmpdir()), 'hudhud-warm-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function sandboxWith(mode: string) {
  // The fake binary (a Node.js copy) needs its script as the first argument;
  // warmSandbox launches without arguments, so this wrapper prepends it.
  const sandbox = await createSandbox({
    cli: fake.cli,
    mock: { url: 'http://127.0.0.1:47311' },
    testRoot: root,
    ancestorPolicy: scopedPolicy(root),
    env: { FAKE_CLI_MODE: mode },
  });
  const launch = sandbox.launch.bind(sandbox);
  return {
    ...sandbox,
    launch: (options: Parameters<typeof launch>[0] = {}) =>
      launch({ ...options, args: [fake.script, ...(options.args ?? [])] }),
  };
}

describe('warmSandbox', () => {
  it('runs one session and leaves the CLI-written .claude.json', async () => {
    const sandbox = await sandboxWith('normal');
    await warmSandbox(sandbox, 30_000);
    expect(existsSync(path.join(sandbox.dirs.cfg, '.claude.json'))).toBe(true);
    await sandbox.dispose();
  }, 60_000);

  it('fails when the session exits non-zero', async () => {
    const sandbox = await sandboxWith('exit-1');
    await expect(warmSandbox(sandbox, 30_000)).rejects.toBeInstanceOf(WarmUpError);
  }, 60_000);

  it('fails when no config file was written', async () => {
    const sandbox = await sandboxWith('no-config');
    await expect(warmSandbox(sandbox, 30_000)).rejects.toThrow(/no \.claude\.json/);
  }, 60_000);

  it('uses a default timeout', async () => {
    const sandbox = await sandboxWith('normal');
    await expect(warmSandbox(sandbox)).resolves.toBeUndefined();
  }, 90_000);
});
