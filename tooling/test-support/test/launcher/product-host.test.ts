import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BoundedCommand, CommandOutcome, SpawnSpec } from '@hudhud/core/process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SandboxRefusedError } from '../../src/launcher/errors.js';
import {
  checkProductLaunch,
  isWithin,
  PROBE_DROPPED_CREDENTIALS,
  productHostSeams,
  samePath,
} from '../../src/launcher/product-host.js';
import { createSandbox, testTempBase } from '../../src/launcher/sandbox.js';
import type { Sandbox } from '../../src/launcher/sandbox.js';
import { writeTestLauncher } from '../../src/launcher/test-launcher.js';
import { makeFakeCli, oneSpellingPerName, scopedPolicy } from './fake-cli.js';
import type { FakeCli } from './fake-cli.js';
import { fakeProcess, identityOf } from './fake-process.js';

let fake: FakeCli;
let root = '';
let sandbox: Sandbox;
/** The sandbox environment as the product passes it on: one spelling per name. */
let productEnv: Record<string, string>;

beforeAll(async () => {
  fake = await makeFakeCli();
}, 120_000);

afterAll(async () => {
  await fake.dispose();
});

beforeEach(async () => {
  root = await mkdtemp(path.join(testTempBase(process.platform, tmpdir()), 'hudhud-host-'));
  sandbox = await createSandbox({
    cli: fake.cli,
    mock: { url: 'http://127.0.0.1:47311' },
    testRoot: root,
    ancestorPolicy: scopedPolicy(root),
    env: { FAKE_CLI_MODE: 'normal' },
  });
  productEnv = oneSpellingPerName(sandbox.env);
});

afterEach(async () => {
  await sandbox.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function without(env: Readonly<Record<string, string>>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));
}

function refusalOf(action: () => unknown): SandboxRefusedError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxRefusedError);
    return error as SandboxRefusedError;
  }
  throw new Error('expected a refusal');
}

function sessionSpec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    file: sandbox.cli.binaryPath,
    args: [fake.script],
    cwd: sandbox.dirs.work,
    env: productEnv,
    ...overrides,
  };
}

function probeCommand(cwd: string, overrides: Partial<BoundedCommand> = {}): BoundedCommand {
  return {
    file: sandbox.cli.binaryPath,
    args: ['--version'],
    env: without(productEnv, 'ANTHROPIC_API_KEY'),
    cwd,
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    timeoutMs: 30_000,
    maxStdoutBytes: 4096,
    ...overrides,
  };
}

describe('samePath and isWithin', () => {
  it('compare as the OS compares paths', () => {
    expect(samePath('/a/b', '/a/./b', 'linux')).toBe(true);
    expect(samePath('/a/b', '/A/b', 'linux')).toBe(false);
    expect(samePath('C:\\a\\b.exe', 'c:\\A\\B.EXE', 'win32')).toBe(true);
    expect(samePath('C:\\a\\b.exe', 'C:\\a\\c.exe', 'win32')).toBe(false);

    expect(isWithin('/r', '/r', 'linux')).toBe(true);
    expect(isWithin('/r', '/r/w/x', 'linux')).toBe(true);
    expect(isWithin('/r', '/r2', 'linux')).toBe(false);
    expect(isWithin('/r', '/', 'linux')).toBe(false);
    expect(isWithin('/R', '/r/w', 'linux')).toBe(false);
    expect(isWithin('C:\\R', 'c:\\r\\w', 'win32')).toBe(true);
    expect(isWithin('C:\\r', 'D:\\r\\w', 'win32')).toBe(false);
    expect(isWithin('C:\\r', 'C:\\r2', 'win32')).toBe(false);
  });
});

describe('checkProductLaunch', () => {
  it('accepts the pinned binary in the sandbox with its isolation kept', () => {
    expect(() => {
      checkProductLaunch(sessionSpec(), sandbox, 'session');
    }).not.toThrow();
    const product = { ...productEnv, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
    expect(() => {
      checkProductLaunch(sessionSpec({ env: product }), sandbox, 'session');
    }).not.toThrow();
  });

  it('refuses any other binary', () => {
    const error = refusalOf(() => {
      checkProductLaunch(sessionSpec({ file: process.execPath }), sandbox, 'session');
    });
    expect(error.code).toBe('binary');
    expect(error.message).toMatch(/only binary a sandbox runs is the pinned/);
  });

  it('refuses a working directory outside the sandbox', () => {
    const error = refusalOf(() => {
      checkProductLaunch(sessionSpec({ cwd: root }), sandbox, 'session');
    });
    expect(error.code).toBe('unsafe-option');
    expect(error.message).toMatch(/outside the sandbox/);
  });

  it('refuses an environment that undoes the isolation', () => {
    const redirected = { ...productEnv, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
    expect(
      refusalOf(() => {
        checkProductLaunch(sessionSpec({ env: redirected }), sandbox, 'session');
      }).message,
    ).toMatch(/changes ANTHROPIC_BASE_URL/);
  });

  it('lets only the probe run without the credential', () => {
    const noKey = without(productEnv, 'ANTHROPIC_API_KEY');
    expect(PROBE_DROPPED_CREDENTIALS).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    expect(() => {
      checkProductLaunch(sessionSpec({ env: noKey }), sandbox, 'probe');
    }).not.toThrow();
    expect(
      refusalOf(() => {
        checkProductLaunch(sessionSpec({ env: noKey }), sandbox, 'session');
      }).message,
    ).toMatch(/changes ANTHROPIC_API_KEY.*dropped/);
  });
});

describe('checkProductLaunch with a test launcher (K1, 07 §4)', () => {
  it('runs only the unchanged launcher, never the binary behind it', async () => {
    const launcher = await writeTestLauncher({
      dir: sandbox.dirs.root,
      cli: sandbox.cli,
      platform: 'linux',
      nodePath: '/usr/local/bin/node',
    });
    expect(() => {
      checkProductLaunch(sessionSpec({ file: launcher.path }), sandbox, 'session', launcher);
    }).not.toThrow();
    const direct = refusalOf(() => {
      checkProductLaunch(sessionSpec(), sandbox, 'session', launcher);
    });
    expect(direct.code).toBe('binary');
    expect(direct.message).toMatch(/runs only its launcher/);

    const refused: unknown[] = [];
    const seams = productHostSeams({
      sandbox,
      launcher,
      onRoot: () => undefined,
      onRefused: (error) => refused.push(error),
      spawn: () => Promise.reject(new Error('not spawned in this test')),
    });
    await writeFile(
      launcher.path,
      `${launcher.source}// tampered
`,
    );
    await expect(seams.spawn(sessionSpec({ file: launcher.path }))).rejects.toThrow(
      /changed since it was written/,
    );
    expect(refused).toHaveLength(1);
  });
});

describe('checkProductLaunch in the trap sandbox (nonessential traffic allowed)', () => {
  it('lets the product add the nonessential-traffic switch, and nothing looser', async () => {
    const trap = await createSandbox({
      cli: fake.cli,
      mock: { url: 'http://127.0.0.1:47311' },
      testRoot: root,
      ancestorPolicy: scopedPolicy(root),
      nonessentialTraffic: 'allowed',
    });
    const env = oneSpellingPerName(trap.env);
    const launch = { file: trap.cli.binaryPath, cwd: trap.dirs.work };
    const name = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
    expect(env[name]).toBeUndefined();
    expect(() => {
      checkProductLaunch({ ...launch, env: { ...env, [name]: '1' } }, trap, 'probe');
    }).not.toThrow();
    expect(() => {
      checkProductLaunch({ ...launch, env }, trap, 'session');
    }).not.toThrow();
    expect(() => {
      checkProductLaunch({ ...launch, env: { ...env, [name]: '0' } }, trap, 'session');
    }).toThrow(/changes CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC/);
    await trap.dispose();
  });
});

describe('productHostSeams', () => {
  it('replaces the parent environment, the home and the working directory', () => {
    const seams = productHostSeams({
      sandbox,
      onRoot: () => undefined,
      onRefused: () => undefined,
    });
    expect(seams.env).toBe(sandbox.env);
    expect(seams.homedir).toBe(sandbox.dirs.home);
    expect(seams.cwd()).toBe(sandbox.dirs.work);
  });

  it('checks each spawn, reports the root and returns it', async () => {
    const spawned: SpawnSpec[] = [];
    const roots: unknown[] = [];
    const refused: unknown[] = [];
    const proc = fakeProcess(4242, identityOf(4242, '7'));
    const seams = productHostSeams({
      sandbox,
      onRoot: (root) => {
        roots.push(root);
      },
      onRefused: (error) => refused.push(error),
      spawn: (spec) => {
        spawned.push(spec);
        return Promise.resolve(proc.process);
      },
    });
    await expect(seams.spawn(sessionSpec())).resolves.toBe(proc.process);
    expect(roots).toEqual([proc.process]);
    const bad = seams.spawn(sessionSpec({ file: process.execPath }));
    await expect(bad).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(spawned).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(SandboxRefusedError);
  });

  it('hands the root to the product only once onRoot settled', async () => {
    const proc = fakeProcess(4343, identityOf(4343, '7'));
    const release = Promise.withResolvers<undefined>();
    const reported = Promise.withResolvers<undefined>();
    const seams = productHostSeams({
      sandbox,
      onRoot: async () => {
        reported.resolve(undefined);
        await release.promise;
      },
      onRefused: () => undefined,
      spawn: () => Promise.resolve(proc.process),
    });
    let handed = false;
    const spawned = seams.spawn(sessionSpec()).then((root) => {
      handed = true;
      return root;
    });
    // onRoot was called and holds the spawn. A macrotask later every
    // microtask has run, so a seam that did not await onRoot would have
    // handed the root over by now: the product must still have nothing.
    await reported.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(handed).toBe(false);
    release.resolve(undefined);
    await expect(spawned).resolves.toBe(proc.process);
  });

  it('checks each probe run and makes the probe directory in the sandbox', async () => {
    const ran: BoundedCommand[] = [];
    const refused: unknown[] = [];
    const outcome: CommandOutcome = {
      kind: 'exited',
      exitCode: 0,
      signal: null,
      stdout: '2.1.296',
    };
    const seams = productHostSeams({
      sandbox,
      onRoot: () => undefined,
      onRefused: (error) => refused.push(error),
      run: (command) => {
        ran.push(command);
        return Promise.resolve(outcome);
      },
    });
    const dir = await seams.probe.workDir.create();
    expect(path.dirname(dir)).toBe(sandbox.dirs.tmp);
    expect(existsSync(dir)).toBe(true);
    await expect(seams.probe.run(probeCommand(dir))).resolves.toBe(outcome);
    await expect(seams.probe.run(probeCommand(root))).rejects.toThrow(/outside the sandbox/);
    expect(ran).toHaveLength(1);
    expect(refused).toHaveLength(1);
    await seams.probe.workDir.remove(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('spawns and probes with the core by default', async () => {
    const roots: number[] = [];
    const seams = productHostSeams({
      sandbox,
      onRoot: (root) => {
        roots.push(root.pid);
      },
      onRefused: () => undefined,
    });
    const child = await seams.spawn(sessionSpec());
    expect(roots).toEqual([child.pid]);
    child.endStdin();
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });

    const dir = await seams.probe.workDir.create();
    const outcome = await seams.probe.run(probeCommand(dir));
    await seams.probe.workDir.remove(dir);
    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 0 });
  }, 120_000);
});
