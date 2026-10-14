import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { HarnessProcess, IdentityRead, ProcessTableSource } from '@hudhud/core/process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SandboxRefusedError } from '../../src/launcher/errors.js';
import {
  END_TEST_TIMEOUT_MS,
  IntegrationSuite,
  registerIntegrationHooks,
  samplingIntervalMs,
  SUITE_HOOK_TIMEOUT_MS,
} from '../../src/launcher/integration.js';
import type {
  ConnectedHarness,
  IntegrationSeams,
  ProductConnect,
  ProductConnectRequest,
  SuiteHooks,
} from '../../src/launcher/integration.js';
import { testTempBase } from '../../src/launcher/sandbox.js';
import { TEST_LAUNCHER_FILE, writeTestLauncher } from '../../src/launcher/test-launcher.js';
import type { ProcessRow, ProcessTable } from '../../src/leaks/process-table.js';
import { LeakError } from '../../src/leaks/tracker.js';
import type { MockServer } from '../../src/mock/server.js';
import { hangGuard, HOST_TABLE_READ_MS } from '../hang-guard.js';
import { makeFakeCli, oneSpellingPerName, scopedPolicy } from './fake-cli.js';
import type { FakeCli } from './fake-cli.js';
import { fakeProcess, identityOf } from './fake-process.js';
import type { FakeProcess } from './fake-process.js';

const SELF = 1;

class FakeTable implements ProcessTable {
  readonly source: ProcessTable['source'] = 'linux-proc';
  rows: ProcessRow[] = [];
  failWith: Error | undefined = undefined;

  read(): Promise<readonly ProcessRow[]> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve([...this.rows]);
  }
}

/** What the fake product does on connect. */
interface FakeOptions {
  /** Session processes to spawn through the host seam (each one taken from the queue). */
  readonly sessions?: number;
  /** Spawn this file instead of the binary it was given. */
  readonly file?: string;
  /** Report this binary path or version instead of the pinned one. */
  readonly path?: string;
  readonly version?: string;
  /** Leave the processes running when disposed. */
  readonly keepRunning?: boolean;
  /** Rejection of the dispose. */
  readonly disposeError?: Error;
}

class FakeHarness implements ConnectedHarness {
  readonly binary: { readonly path: string; readonly version: string };
  readonly processes: FakeProcess[] = [];
  readonly request: ProductConnectRequest;
  disposed = 0;
  readonly #options: FakeOptions;

  constructor(request: ProductConnectRequest, options: FakeOptions, version: string) {
    this.request = request;
    this.#options = options;
    this.binary = {
      path: options.path ?? request.binaryPath,
      version: options.version ?? version,
    };
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.disposed += 1;
    if (this.#options.keepRunning !== true) for (const proc of this.processes) proc.exit();
    if (this.#options.disposeError !== undefined) {
      return Promise.reject(this.#options.disposeError);
    }
    return Promise.resolve();
  }
}

let fake: FakeCli;
let root = '';
let table: FakeTable;
let killed: number[];
/** Fake processes the host seam hands out, in order. */
let queue: FakeProcess[];
/** The ones not handed out yet. */
let toSpawn: FakeProcess[];
let harnesses: FakeHarness[];

beforeAll(async () => {
  fake = await makeFakeCli();
}, 120_000);

afterAll(async () => {
  await fake.dispose();
});

beforeEach(async () => {
  root = await mkdtemp(path.join(testTempBase(process.platform, tmpdir()), 'hudhud-int-'));
  table = new FakeTable();
  killed = [];
  queue = [];
  toSpawn = [];
  harnesses = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const connect: ProductConnect<FakeOptions, FakeHarness> = async (options = {}, request) => {
  const harness = new FakeHarness(request, options, fake.cli.version);
  harnesses.push(harness);
  for (let index = 0; index < (options.sessions ?? 0); index += 1) {
    const proc = await request.host.spawn({
      file: options.file ?? request.binaryPath,
      args: [],
      cwd: request.host.cwd(),
      env: oneSpellingPerName(request.host.env),
    });
    const found = queue.find((candidate) => candidate.process === proc);
    if (found !== undefined) harness.processes.push(found);
  }
  return harness;
};

function queued(
  pid: number,
  read: IdentityRead = identityOf(pid, '10'),
  source: ProcessTableSource = 'linux-proc',
): FakeProcess {
  const proc = fakeProcess(pid, read, source);
  queue.push(proc);
  toSpawn.push(proc);
  return proc;
}

function spawnFromQueue(): Promise<HarnessProcess> {
  const next = toSpawn.shift();
  if (next === undefined) return Promise.reject(new Error('no fake process queued'));
  return Promise.resolve(next.process);
}

function suiteWith(
  seams: IntegrationSeams = {},
  warmUp: (harness: FakeHarness) => Promise<void> = () => Promise.resolve(),
): IntegrationSuite<FakeOptions, FakeHarness> {
  return new IntegrationSuite<FakeOptions, FakeHarness>({
    connect,
    warmUp,
    repoRoot: root,
    seams: {
      resolveCli: () => Promise.resolve(fake.cli),
      leakHost: {
        table,
        selfPid: SELF,
        kill: (pid) => {
          killed.push(pid);
          table.rows = table.rows.filter((row) => row.pid !== pid);
        },
        sleep: () => Promise.resolve(),
      },
      testRoot: root,
      ancestorPolicy: scopedPolicy(root),
      samplingMs: 1,
      productHost: { spawn: spawnFromQueue },
      ...seams,
    },
  });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error,
  );
}

function messagesOf(error: unknown): string[] {
  expect(error).toBeInstanceOf(AggregateError);
  return (error as AggregateError).errors.map((inner: unknown) =>
    inner instanceof Error ? inner.message : String(inner),
  );
}

/** A mock whose trap recorded a violation and whose close fails. */
function brokenMock(port: number): MockServer {
  return {
    url: `http://127.0.0.1:${String(port)}`,
    host: '127.0.0.1',
    port,
    requests: [],
    openConnections: 0,
    violations: [],
    assertNoViolations() {
      throw new Error(`egress violation on ${String(port)}`);
    },
    reset: () => undefined,
    close: () => Promise.reject(new Error(`close of ${String(port)} failed`)),
  };
}

describe('IntegrationSuite lifecycle', () => {
  it('refuses to be used out of order', async () => {
    const suite = suiteWith();
    expect(() => suite.cli).toThrow(/has not begun/);
    expect(() => suite.suiteDir).toThrow(/has not begun/);
    expect(() => {
      suite.beginTest();
    }).toThrow(/has not begun/);
    await expect(suite.endSuite()).resolves.toBeUndefined();
    await suite.beginSuite();
    await expect(suite.beginSuite()).rejects.toThrow(/already begun/);
    await expect(suite.setup()).rejects.toThrow(/no test is running/);
    await expect(suite.endTest()).rejects.toThrow(/no test is running/);
    suite.beginTest();
    expect(() => {
      suite.beginTest();
    }).toThrow(/one at a time/);
    await suite.endTest();
    await suite.endSuite();
  });

  it('runs a clean test: connect, record the session root, dispose, remove everything', async () => {
    const suite = suiteWith({ samplingMs: undefined });
    await suite.beginSuite();
    expect(suite.cli).toBe(fake.cli);
    const suiteDir = suite.suiteDir;
    expect(realpathSync.native(suiteDir)).toBe(suiteDir);
    expect(path.basename(suiteDir)).toMatch(/^hudhud-it-/);

    suite.beginTest();
    const context = await suite.setup({ sandbox: { name: 'clean' } });
    await expect(suite.setup({})).rejects.toThrow(/before the test first uses its sandbox/);
    await expect(suite.setup()).resolves.toBe(context);
    await expect(suite.mock()).resolves.toBe(context.mock);
    const sandbox = await suite.sandbox();
    expect(sandbox).toBe(context.sandbox);
    expect(path.dirname(sandbox.dirs.root)).toBe(suiteDir);
    expect(path.basename(sandbox.dirs.root)).toMatch(/^hudhud-clean-/);

    const proc = queued(700);
    table.rows = [{ pid: 700, ppid: SELF, startTime: '10', name: 'claude', commandLine: '' }];
    const harness = await suite.testConnect({ sessions: 1 });
    expect(harness.request.binaryPath).toBe(fake.cli.binaryPath);
    expect(harness.request.configDir).toBe(sandbox.dirs.cfg);
    expect(harness.request.host.env).toBe(sandbox.env);
    expect(harness.request.host.cwd()).toBe(sandbox.dirs.work);
    await proc.process.identity;
    expect(context.tracker.roots).toEqual([{ pid: 700, startTime: '10' }]);

    // The root exits when the Harness is disposed; it left the table.
    table.rows = [];
    await suite.endTest();
    expect(harness.disposed).toBe(1);
    expect(existsSync(sandbox.dirs.root)).toBe(false);
    expect(context.mock.openConnections).toBe(0);
    expect(killed).toEqual([]);

    await suite.endSuite();
    expect(existsSync(suiteDir)).toBe(false);
  });

  it('waits for the identity reads of the spawned roots (identified)', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    await expect(suite.identified()).resolves.toBeUndefined();
    let settle: (read: IdentityRead) => void = () => undefined;
    const slow = fakeProcess(730, identityOf(730, '10'));
    const proc: FakeProcess = {
      process: {
        ...slow.process,
        identity: new Promise<IdentityRead>((resolve) => {
          settle = resolve;
        }),
      },
      exit: (exit) => {
        slow.exit(exit);
      },
    };
    queue.push(proc);
    toSpawn.push(proc);
    const context = await suite.setup();
    await suite.testConnect({ sessions: 1 });
    let done = false;
    const identified = suite.identified().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(context.tracker.roots).toEqual([]);
    settle(identityOf(730, '10'));
    await identified;
    expect(context.tracker.roots).toEqual([{ pid: 730, startTime: '10' }]);
    await suite.endTest();
    await suite.endSuite();
  });

  it('refuses a Harness of another binary or version and still disposes it', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    const other = await failureOf(suite.testConnect({ path: process.execPath }));
    expect(other).toBeInstanceOf(SandboxRefusedError);
    expect((other as SandboxRefusedError).code).toBe('binary');
    await expect(suite.testConnect({ version: '0.0.1' })).rejects.toThrow(/not the pinned/);
    await suite.endTest();
    expect(harnesses.map((harness) => harness.disposed)).toEqual([1, 1]);
    await suite.endSuite();
  });

  it('fails the test for a root still running after the dispose, killing it by identity', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    queued(710);
    table.rows = [{ pid: 710, ppid: SELF, startTime: '10', name: 'claude', commandLine: '' }];
    await suite.testConnect({ sessions: 1, keepRunning: true });
    const failure = await failureOf(suite.endTest());
    const messages = messagesOf(failure);
    expect(messages[0]).toMatch(/spawned pid 710 had not exited/);
    const leak = (failure as AggregateError).errors[1] as LeakError;
    expect(leak).toBeInstanceOf(LeakError);
    expect(leak.leaks.map((row) => [row.pid, row.reason])).toEqual([[710, 'tracked']]);
    expect(leak.outcomes).toEqual(['killed']);
    expect(killed).toEqual([710]);
    expect((failure as Error).message).toMatch(/^2 post-test checks failed:\nError: spawned pid/);
    await suite.endSuite();
  });

  it('fails the test for a root whose identity cannot be tracked', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    queued(720, { identity: null, problem: 'exited' });
    queued(721, identityOf(721, '5'), 'win32-cim');
    queued(SELF, identityOf(SELF, '1'));
    await suite.testConnect({ sessions: 3 });
    const messages = messagesOf(await failureOf(suite.endTest()));
    expect(messages).toEqual([
      expect.stringMatching(/pid 1 is the host process/),
      expect.stringMatching(/no identity could be read for spawned pid 720 \(exited\)/),
      expect.stringMatching(/pid 721: identity source win32-cim differs from .* linux-proc/),
    ]);
    await suite.endSuite();
  });

  it('accepts a root that exited before its identity was read only when the test allows it', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    await suite.setup({ rootsMayExitBeforeIdentity: true });
    queued(780, { identity: null, problem: 'exited' });
    queued(781, { identity: null, problem: 'not-listed' });
    await suite.testConnect({ sessions: 2 });
    const failure = await failureOf(suite.endTest());
    // The exited root passes; any other identity problem still fails.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /^no identity could be read for spawned pid 781 \(not-listed\)/,
    );
    await suite.endSuite();
  });

  it('fails the test for a launch the sandbox refused, even when the product caught it', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    queued(730);
    await expect(suite.testConnect({ sessions: 1, file: process.execPath })).rejects.toBeInstanceOf(
      SandboxRefusedError,
    );
    const failure = await failureOf(suite.endTest());
    expect(failure).toBeInstanceOf(SandboxRefusedError);
    expect((failure as Error).message).toMatch(/only binary a sandbox runs is the pinned/);
    await suite.endSuite();
  });

  it('connects through a test launcher in front of the pinned CLI (K1, 07 §4)', async () => {
    const suite = suiteWith({
      writeLauncher: (input) =>
        writeTestLauncher({ ...input, platform: 'linux', nodePath: '/usr/local/bin/node' }),
    });
    await suite.beginSuite();
    suite.beginTest();
    const context = await suite.setup({ launcher: { lingerMs: 5, ignoreSigterm: true } });
    const launcher = context.launcher;
    expect(launcher?.path).toBe(path.join(context.sandbox.dirs.root, TEST_LAUNCHER_FILE));
    expect(launcher?.source).toContain('const IGNORE_SIGTERM = true;');
    const launcherPath = launcher?.path ?? '';
    queued(750);
    const harness = await suite.testConnect({ sessions: 1 });
    expect(harness.request.binaryPath).toBe(launcherPath);
    expect(harness.processes).toHaveLength(1);
    // The pinned binary itself is refused while the test runs a launcher.
    await expect(suite.testConnect({ path: fake.cli.binaryPath })).rejects.toThrow(
      /not the pinned .*claude-launcher\.cjs/,
    );
    await expect(suite.testConnect({ sessions: 1, file: fake.cli.binaryPath })).rejects.toThrow(
      /runs only its launcher/,
    );
    const failure = await failureOf(suite.endTest());
    expect(failure).toBeInstanceOf(SandboxRefusedError);
    expect((failure as Error).message).toMatch(/runs only its launcher/);
    await suite.endSuite();
  });

  it.runIf(process.platform === 'win32')(
    'refuses a test launcher on Windows by default (it would have to be a native executable)',
    async () => {
      const suite = suiteWith();
      await suite.beginSuite();
      suite.beginTest();
      await expect(suite.setup({ launcher: {} })).rejects.toThrow(/native executable/);
      await suite.endTest();
      await suite.endSuite();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'writes a test launcher with the running Node.js by default',
    async () => {
      const suite = suiteWith();
      await suite.beginSuite();
      suite.beginTest();
      const context = await suite.setup({ launcher: {} });
      expect(context.launcher?.source.split('\n')[0]).toBe(`#!${process.execPath}`);
      await suite.endTest();
      await suite.endSuite();
    },
  );

  it('closes what a failed setup opened', async () => {
    const noMock = suiteWith({ startMock: () => Promise.reject(new Error('no port')) });
    await noMock.beginSuite();
    noMock.beginTest();
    await expect(noMock.testConnect()).rejects.toThrow(/no port/);
    await expect(noMock.endTest()).resolves.toBeUndefined();
    await noMock.endSuite();

    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    const setup = suite.setup({ sandbox: { name: 'not a name' } });
    await expect(setup).rejects.toThrow(/sandbox name/);
    await expect(suite.endTest()).resolves.toBeUndefined();
    await suite.endSuite();
  });

  it('collects every failure after the test and still closes everything', async () => {
    const suite = suiteWith({
      startMock: (options) => Promise.resolve(brokenMock(options ? 2 : 1)),
    });
    await suite.beginSuite();
    suite.beginTest();
    const context = await suite.setup();
    const extra = await suite.extraMock({});
    expect(extra.port).toBe(2);
    await suite.testConnect({ disposeError: new TypeError('dispose refused') });
    table.failWith = new Error('table gone');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const failure = await failureOf(suite.endTest());
    expect(messagesOf(failure)).toEqual([
      'dispose refused',
      'process sampling failed',
      'table gone',
      'egress violation on 1',
      'egress violation on 2',
      'close of 1 failed',
      'close of 2 failed',
    ]);
    expect((failure as Error).message).toMatch(
      /^7 post-test checks failed:\nTypeError: dispose refused\nError: process sampling failed\n/,
    );
    expect(existsSync(context.sandbox.dirs.root)).toBe(false);
    table.failWith = undefined;
    await suite.endSuite();
  });

  it('runs another entry point with the same request and disposes what it returned', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    const sandbox = await suite.sandbox();
    const proc = queued(750);
    const order: string[] = [];
    table.rows = [{ pid: 750, ppid: SELF, startTime: '10', name: 'claude', commandLine: '' }];
    const launched = await suite.testLaunch(async (request) => {
      expect(request.binaryPath).toBe(fake.cli.binaryPath);
      expect(request.configDir).toBe(sandbox.dirs.cfg);
      expect(request.host.env).toBe(sandbox.env);
      const root = await request.host.spawn({
        file: request.binaryPath,
        args: [],
        cwd: request.host.cwd(),
        env: oneSpellingPerName(request.host.env),
      });
      return {
        root,
        [Symbol.asyncDispose]: () => {
          order.push('launched');
          proc.exit();
          table.rows = [];
          return Promise.resolve();
        },
      };
    });
    expect(launched.root).toBe(proc.process);
    await proc.process.identity;
    const { tracker } = await suite.setup();
    expect(tracker.roots).toEqual([{ pid: 750, startTime: '10' }]);
    const harness = await suite.testConnect();
    const dispose = harness[Symbol.asyncDispose].bind(harness);
    harness[Symbol.asyncDispose] = () => {
      order.push('harness');
      return dispose();
    };
    await suite.endTest();
    // The Harnesses first, then what testLaunch returned.
    expect(order).toEqual(['harness', 'launched']);
    await suite.endSuite();
  });

  it('fails the test for a launched value whose dispose fails and for a root it left running', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    queued(760);
    table.rows = [{ pid: 760, ppid: SELF, startTime: '10', name: 'claude', commandLine: '' }];
    await suite.testLaunch(async (request) => {
      await request.host.spawn({
        file: request.binaryPath,
        args: [],
        cwd: request.host.cwd(),
        env: oneSpellingPerName(request.host.env),
      });
      return { [Symbol.asyncDispose]: () => Promise.reject(new Error('launched dispose failed')) };
    });
    await expect(suite.testLaunch(() => Promise.reject(new Error('no launch')))).rejects.toThrow(
      /no launch/,
    );
    const messages = messagesOf(await failureOf(suite.endTest()));
    expect(messages[0]).toBe('launched dispose failed');
    expect(messages[1]).toMatch(/spawned pid 760 had not exited/);
    expect(killed).toEqual([760]);
    await suite.endSuite();
  });

  it('calls spawn listeners in order before the product receives the root', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    suite.beginTest();
    const proc = queued(770);
    const calls: string[] = [];
    const release = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    suite.onSpawn(async (root) => {
      calls.push(`first ${String(root.pid)}`);
      entered.resolve(undefined);
      await release.promise;
      calls.push('first done');
    });
    suite.onSpawn(() => {
      calls.push('second');
      throw new Error('listener broke');
    });
    suite.onSpawn(() => Promise.reject(new RangeError('listener rejected')));
    let connected = false;
    const connecting = suite.testConnect({ sessions: 1 }).then((harness) => {
      connected = true;
      return harness;
    });
    // The first listener runs and holds the spawn; nothing else has run.
    await entered.promise;
    expect(calls).toEqual(['first 770']);
    expect(connected).toBe(false);
    release.resolve(undefined);
    const harness = await connecting;
    // The spawn went on whatever the listeners did.
    expect(harness.processes.map((fakeProc) => fakeProc.process)).toEqual([proc.process]);
    expect(calls).toEqual(['first 770', 'first done', 'second']);
    expect(messagesOf(await failureOf(suite.endTest()))).toEqual([
      'a spawn listener failed: Error: listener broke',
      'a spawn listener failed: RangeError: listener rejected',
    ]);
    await suite.endSuite();
  });

  it('warms the config directory with one session (J11)', async () => {
    const warmed = suiteWith({}, async (harness) => {
      await writeFile(path.join(harness.request.configDir, '.claude.json'), '{}');
    });
    await warmed.beginSuite();
    warmed.beginTest();
    await warmed.warm();
    expect(harnesses).toHaveLength(1);
    await warmed.endTest();
    await warmed.endSuite();

    const cold = suiteWith();
    await cold.beginSuite();
    cold.beginTest();
    await expect(cold.warm({})).rejects.toThrow(/left no \.claude\.json/);
    await cold.endTest();
    await cold.endSuite();
  });

  it('fails the suite for a process naming the suite directory, then removes it', async () => {
    const suite = suiteWith();
    await suite.beginSuite();
    const dir = suite.suiteDir;
    table.rows = [{ pid: 740, ppid: 9, startTime: '3', name: 'bash', commandLine: `x ${dir} y` }];
    const failure = await failureOf(suite.endSuite());
    expect(failure).toBeInstanceOf(LeakError);
    expect((failure as LeakError).leaks.map((row) => row.reason)).toEqual(['command-line']);
    expect(killed).toEqual([740]);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('IntegrationSuite placement and defaults', () => {
  it('refuses a test root below a forbidden ancestor with the default policy', async () => {
    const marked = path.join(root, 'marked');
    await mkdir(path.join(marked, '.claude'), { recursive: true });
    const suite = suiteWith({ testRoot: marked, ancestorPolicy: undefined });
    const failure = await failureOf(suite.beginSuite());
    expect(failure).toBeInstanceOf(SandboxRefusedError);
    expect((failure as SandboxRefusedError).code).toBe('forbidden-ancestor');
  });

  it('places the suite under the default test root', async () => {
    const base = testTempBase(process.platform, tmpdir());
    const suite = suiteWith({ testRoot: undefined, ancestorPolicy: scopedPolicy(base) });
    await suite.beginSuite();
    const dir = suite.suiteDir;
    expect(existsSync(dir)).toBe(true);
    await suite.endSuite();
    expect(existsSync(dir)).toBe(false);
  });

  it('resolves the pinned CLI of the repository by default', async () => {
    const suite = new IntegrationSuite<FakeOptions, FakeHarness>({
      connect,
      warmUp: () => Promise.resolve(),
      repoRoot: root,
    });
    // `root` holds no pin: the default resolution reads the repository's.
    await expect(suite.beginSuite()).rejects.toThrow(/cli-pin\.json/);
  });

  it(
    'tracks leaks on the host process table by default',
    async () => {
      const suite = suiteWith({ leakHost: undefined });
      await suite.beginSuite();
      suite.beginTest();
      await suite.setup();
      await suite.endTest();
      await suite.endSuite();
    },
    hangGuard(4 * HOST_TABLE_READ_MS),
  );

  it('samples every second on Windows and every 250 ms elsewhere (plan §4.7)', () => {
    expect(samplingIntervalMs('win32')).toBe(1000);
    expect(samplingIntervalMs('linux')).toBe(250);
    expect(samplingIntervalMs('darwin')).toBe(250);
  });
});

describe('registerIntegrationHooks', () => {
  it('runs the suite lifecycle on the runner hooks with their hang guards', async () => {
    const registered: { name: string; fn: () => unknown; timeout: number | undefined }[] = [];
    const record =
      (name: string) =>
      (fn: () => unknown, timeout?: number): void => {
        registered.push({ name, fn, timeout });
      };
    const hooks: SuiteHooks = {
      beforeAll: record('beforeAll'),
      afterAll: record('afterAll'),
      beforeEach: record('beforeEach'),
      afterEach: record('afterEach'),
    };
    const suite = suiteWith();
    registerIntegrationHooks(suite, hooks);
    expect(registered.map((hook) => [hook.name, hook.timeout])).toEqual([
      ['beforeAll', SUITE_HOOK_TIMEOUT_MS],
      ['beforeEach', undefined],
      ['afterEach', END_TEST_TIMEOUT_MS],
      ['afterAll', SUITE_HOOK_TIMEOUT_MS],
    ]);
    const run = (name: string): unknown => registered.find((hook) => hook.name === name)?.fn();
    await run('beforeAll');
    run('beforeEach');
    await expect(suite.setup()).resolves.toBeDefined();
    await run('afterEach');
    await run('afterAll');
    expect(() => suite.suiteDir).not.toThrow();
  });
});
