/**
 * The integration-test harness: `testConnect` and the per-test and
 * per-suite lifecycle of the Wave 6 suites (plan §1.11, §4.4, §4.5, §4.7;
 * ADR-0013).
 *
 * @remarks
 * Layering (plan §4.3 "Single-source launch"): test-support may not depend
 * on an adapter, so the product's `connect` is injected
 * ({@link ProductConnect}); the composition root that imports both lives in
 * the adapter's test tree (`packages/claude-code/test/integration/support/`).
 * What it injects is the product itself with only the host seams of
 * `product-host.ts` replaced; everything else (discovery, verification, the
 * version probe, the argv and environment builders, the spawn, the session
 * machine, the ladders) is the product's own.
 *
 * Per suite ({@link IntegrationSuite.beginSuite}): the pinned CLI is
 * resolved once (`resolvePinnedCli`: sha256, size and stamp against the
 * pin; refused on a local macOS host by `host-policy.ts`), and a suite
 * directory is made under the test root (`HUDHUD_TEST_ROOT`, else
 * `RUNNER_TEMP` on CI, else the OS temp directory; macOS see
 * `resolveTestRoot`) after the forbidden-ancestor check, which fails with
 * instructions and never skips. The suite directory is used by its real
 * path: hudhud runs the CLI in the real path of its cwd (`validateCwd`), so
 * a `subst` drive or a link in the test root must not move the run out of
 * the sandbox.
 *
 * Per test, created on first use ({@link IntegrationSuite.setup}): the
 * in-process mock with its egress trap, a fresh sandbox inside the suite
 * directory (config, home, app-data, native temp and work directories; the
 * explicit environment with the fake key, the mock as base URL and as the
 * proxy in both cases, `NO_PROXY=127.0.0.1`, the nonessential-traffic
 * variable, the Git Bash path on win32), and a leak tracker (before
 * snapshot, descendant sampling every 250 ms, 1 s on Windows).
 * {@link IntegrationSuite.testConnect} re-checks the pinned binary and calls
 * the product with the binary path, the sandbox config directory and the
 * sandbox host seams; every session process it spawns is recorded by its
 * spawn identity (pid plus start time) and reaches the product only once
 * that identity read settled (identity first, W6-Z ruling 1), so even a
 * session ended at once keeps a tracked tree.
 * {@link IntegrationSuite.testLaunch} runs another entry point of the
 * product (one whose Harness stays private, such as `session()`) with the
 * same request and tracking; {@link IntegrationSuite.onSpawn} lets a test
 * act on each spawned process before the product receives it (W6-T1).
 *
 * After each test ({@link IntegrationSuite.endTest}), always, whatever the
 * test did: every Harness it connected is disposed (which disposes its
 * sessions), then the test fails when any spawned root has not exited, any
 * tracked or new descendant or process naming the sandbox in its command
 * line is alive (each killed by verified pid and start time first), a
 * launch was refused, or a mock recorded an egress violation; then the
 * mocks are closed and the sandbox removed. After the suite
 * ({@link IntegrationSuite.endSuite}): every process whose command line
 * contains the suite directory fails the suite (07 §13, killed first), and
 * the directory is removed.
 *
 * Tests of one suite run one after the other (one test context at a time);
 * concurrency happens inside a test, after {@link IntegrationSuite.warm}
 * (J11).
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { HarnessProcess } from '@hudhud/core/process';

import { hostProcessTable } from '../leaks/process-table.js';
import { assertNoSurvivors, KILL_DEADLINE_MS, LeakTracker } from '../leaks/tracker.js';
import type { LeakHost } from '../leaks/tracker.js';
import { startMockServer } from '../mock/server.js';
import type { MockServer, MockServerOptions } from '../mock/server.js';
import { assertNoForbiddenAncestors } from './ancestors.js';
import { SandboxRefusedError } from './errors.js';
import { recheckPinnedCli, resolvePinnedCli } from './pinned-cli.js';
import type { VerifiedCli } from './pinned-cli.js';
import { productHostSeams, samePath } from './product-host.js';
import type { ProductHostOptions, ProductHostSeams } from './product-host.js';
import { checkTestRoot, createSandbox, fsProbe, realHomes, resolveTestRoot } from './sandbox.js';
import type { AncestorPolicy, Sandbox, SandboxOptions } from './sandbox.js';
import { writeTestLauncher } from './test-launcher.js';
import type { TestLauncher, TestLauncherOptions, WriteTestLauncherInput } from './test-launcher.js';

/** What the harness needs of a Harness the product connected (the core `Harness`). */
export interface ConnectedHarness extends AsyncDisposable {
  readonly binary: { readonly path: string; readonly version: string };
}

/** What {@link ProductConnect} must pass to the product besides the test's options. */
export interface ProductConnectRequest {
  /** The verified pinned binary (or the test's launcher in front of it): the product's `binaryPath`. */
  readonly binaryPath: string;
  /** The sandbox config directory: the product's `claudeCode.configDir`. */
  readonly configDir: string;
  /** The host seams that replace the product's (see `product-host.ts`). */
  readonly host: ProductHostSeams;
}

/**
 * The product's `connect`, injected by the composition root: it connects
 * with the test's options plus everything in `request`, over the product's
 * own host with the seams of `request.host`.
 */
export type ProductConnect<O, H extends ConnectedHarness> = (
  options: O | undefined,
  request: ProductConnectRequest,
) => Promise<H>;

/** Per-test choices, given to {@link IntegrationSuite.setup} before the test's first connect. */
export interface TestSetup {
  /** Options of the test's mock (provider, extra allowlist entries, ...). */
  readonly mock?: MockServerOptions | undefined;
  /** Sandbox options; the binary, the mock and the placement are the suite's. */
  readonly sandbox?:
    | Pick<SandboxOptions, 'name' | 'env' | 'gitBashPath' | 'nonessentialTraffic' | 'credential'>
    | undefined;
  /**
   * A launcher in front of the pinned CLI (`test-launcher.ts`; the K1
   * signal-target tests, 07 §4), written into the sandbox root; the
   * product then connects with the launcher as its `binaryPath`. POSIX only.
   */
  readonly launcher?: TestLauncherOptions | undefined;
  /**
   * For a test whose CLI ends on its own right after the spawn (for example
   * a resume of an unknown id, 07 §1 a11, exit 1 before any handshake): a
   * spawned root whose identity read reports `exited` (the process was
   * already reaped when the read finished; on Windows one process-table
   * query takes hundreds of milliseconds, plan §4.7) does not fail the test.
   * Without an identity its descendants cannot be sampled; the other checks
   * still apply: the root must have exited, and every new process or process
   * naming the sandbox that survives the test fails it. Any other identity
   * problem still fails the test. Default `false`.
   */
  readonly rootsMayExitBeforeIdentity?: boolean | undefined;
}

/** Options of {@link IntegrationSuite}. */
export interface IntegrationSuiteOptions<O, H extends ConnectedHarness> {
  readonly connect: ProductConnect<O, H>;
  /**
   * Runs one complete session on a connected Harness for
   * {@link IntegrationSuite.warm} (J11): one user turn answered by the mock,
   * then a graceful close. Injected with `connect`.
   */
  readonly warmUp: (harness: H) => Promise<void>;
  /** Absolute repository root (the pin and the default CLI cache). */
  readonly repoRoot: string;
  /** Test seams of the harness's own tests. Every other caller keeps the defaults. */
  readonly seams?: IntegrationSeams | undefined;
}

/** Replaceable parts, for the harness's own tests only. */
export interface IntegrationSeams {
  /** Default: `resolvePinnedCli` with the repository pin and cache. */
  readonly resolveCli?: (() => Promise<VerifiedCli>) | undefined;
  /** Default: the host process table. */
  readonly leakHost?: LeakHost | undefined;
  /** Default: `resolveTestRoot` of the process environment and `os.tmpdir()`. */
  readonly testRoot?: string | undefined;
  /** Default: the real homes and the real file system (see `SandboxOptions.ancestorPolicy`). */
  readonly ancestorPolicy?: AncestorPolicy | undefined;
  /** Default: 1000 ms on Windows, else 250 ms (plan §4.7). */
  readonly samplingMs?: number | undefined;
  /** Default: the in-process mock. */
  readonly startMock?: ((options?: MockServerOptions) => Promise<MockServer>) | undefined;
  /** The spawn and probe runner after the launch check; default the core's. */
  readonly productHost?: Pick<ProductHostOptions, 'spawn' | 'run'> | undefined;
  /** Writes a test's launcher; default `writeTestLauncher`. */
  readonly writeLauncher?: ((input: WriteTestLauncherInput) => Promise<TestLauncher>) | undefined;
}

/**
 * The descendant sampling interval of plan §4.7: 1 s on Windows (each read
 * is one CIM query), 250 ms elsewhere.
 */
export function samplingIntervalMs(platform: NodeJS.Platform): number {
  return platform === 'win32' ? 1000 : 250;
}

/** Hang guard of {@link IntegrationSuite.endTest}: a graceful close, table reads, verified kills. */
export const END_TEST_TIMEOUT_MS = 120_000;
/** Hang guard of {@link IntegrationSuite.beginSuite} (hashing the binary) and {@link IntegrationSuite.endSuite}. */
export const SUITE_HOOK_TIMEOUT_MS: number = 2 * KILL_DEADLINE_MS + 60_000;

/** A listener of {@link IntegrationSuite.onSpawn}. */
export type SpawnListener = (root: HarnessProcess) => Promise<void> | void;

/** A spawned session process and whether it has exited. */
interface Root {
  readonly pid: number;
  exited: boolean;
}

/** Everything one test opened. */
interface TestState<H> {
  readonly index: number;
  setup: Promise<TestContext> | undefined;
  sandbox: Sandbox | undefined;
  /** Set once its before snapshot was taken. */
  tracker: LeakTracker | undefined;
  stopSampling: (() => Promise<void>) | undefined;
  /** {@link TestSetup.rootsMayExitBeforeIdentity} of the test's setup. */
  rootsMayExitBeforeIdentity: boolean;
  readonly mocks: MockServer[];
  readonly harnesses: H[];
  /** What {@link IntegrationSuite.testLaunch} returned, disposed after the Harnesses. */
  readonly launched: AsyncDisposable[];
  /** Listeners of {@link IntegrationSuite.onSpawn}. */
  readonly spawnListeners: SpawnListener[];
  readonly roots: Root[];
  readonly pending: Promise<void>[];
  readonly refusals: unknown[];
  readonly failures: Error[];
}

/** The mock, the sandbox and the leak tracking of the running test. */
export interface TestContext {
  readonly mock: MockServer;
  readonly sandbox: Sandbox;
  /** The test's launcher, when {@link TestSetup.launcher} asked for one. */
  readonly launcher: TestLauncher | undefined;
  readonly tracker: LeakTracker;
  readonly stopSampling: () => Promise<void>;
}

/** Runs `step`, collecting a failure instead of throwing. */
async function collect(failures: unknown[], step: () => PromiseLike<void> | void): Promise<void> {
  try {
    await step();
  } catch (error) {
    failures.push(error);
  }
}

/** Throws nothing, the one failure, or every failure together. */
function throwAll(failures: readonly unknown[], what: string): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  // `Error.prototype.toString`: the name and the message.
  const lines = failures.map((failure) => String(failure));
  throw new AggregateError(
    failures,
    `${String(failures.length)} ${what} checks failed:\n${lines.join('\n')}`,
  );
}

/** The lifecycle of one integration suite (see the module remarks). */
export class IntegrationSuite<O, H extends ConnectedHarness> {
  readonly #options: IntegrationSuiteOptions<O, H>;
  readonly #seams: IntegrationSeams;
  readonly #leakHost: LeakHost;
  #cli: VerifiedCli | undefined;
  #suiteDir: string | undefined;
  #test: TestState<H> | undefined;
  #count = 0;

  constructor(options: IntegrationSuiteOptions<O, H>) {
    this.#options = options;
    this.#seams = options.seams ?? {};
    this.#leakHost = this.#seams.leakHost ?? {
      table: hostProcessTable(process.platform, process.env),
    };
  }

  /** The verified pinned CLI of the suite. */
  get cli(): VerifiedCli {
    if (this.#cli === undefined) throw new Error('the suite has not begun (beginSuite)');
    return this.#cli;
  }

  /** The suite directory (by its real path); every sandbox of the suite lies in it. */
  get suiteDir(): string {
    if (this.#suiteDir === undefined) throw new Error('the suite has not begun (beginSuite)');
    return this.#suiteDir;
  }

  /** The test's mock (its egress trap is asserted after the test). */
  async mock(): Promise<MockServer> {
    return (await this.setup()).mock;
  }

  /** The test's sandbox. */
  async sandbox(): Promise<Sandbox> {
    return (await this.setup()).sandbox;
  }

  /**
   * Resolves the pinned CLI and makes the suite directory (`beforeAll`).
   *
   * @throws CliFetchError when the cache holds no verifying copy (run
   *   `pnpm cli:fetch`); SandboxRefusedError `host` on a local macOS host,
   *   `test-root` or `forbidden-ancestor` (with instructions) for the test root.
   */
  async beginSuite(): Promise<void> {
    if (this.#cli !== undefined) throw new Error('the suite has already begun');
    const platform = process.platform;
    this.#cli = await (this.#seams.resolveCli ?? this.#defaultCli)();
    const root = checkTestRoot(
      this.#seams.testRoot ?? resolveTestRoot(process.env, os.tmpdir(), platform),
      platform,
    );
    const policy = this.#policy();
    assertNoForbiddenAncestors({ dir: root, platform, ...policy });
    // Used by its real path: hudhud spawns in the real path of the cwd.
    this.#suiteDir = realpathSync.native(await mkdtemp(path.join(root, 'hudhud-it-')));
    assertNoForbiddenAncestors({ dir: this.#suiteDir, platform, ...policy });
  }

  readonly #defaultCli = (): Promise<VerifiedCli> =>
    resolvePinnedCli({ repoRoot: this.#options.repoRoot, env: process.env });

  #policy(): AncestorPolicy {
    return (
      this.#seams.ancestorPolicy ?? {
        homes: realHomes(process.env, () => os.userInfo().homedir),
        probe: fsProbe,
      }
    );
  }

  /** Starts a test context (`beforeEach`). */
  beginTest(): void {
    if (this.#suiteDir === undefined) throw new Error('the suite has not begun (beginSuite)');
    if (this.#test !== undefined) {
      throw new Error('a test is still running: tests of an integration suite run one at a time');
    }
    this.#count += 1;
    this.#test = {
      index: this.#count,
      setup: undefined,
      sandbox: undefined,
      tracker: undefined,
      stopSampling: undefined,
      rootsMayExitBeforeIdentity: false,
      mocks: [],
      harnesses: [],
      launched: [],
      spawnListeners: [],
      roots: [],
      pending: [],
      refusals: [],
      failures: [],
    };
  }

  #current(): TestState<H> {
    if (this.#test === undefined) throw new Error('no test is running (beginTest)');
    return this.#test;
  }

  /**
   * Creates the test's mock, sandbox and leak tracking; a test calls it
   * itself only to choose {@link TestSetup} options, before its first
   * connect. Later calls return the same context and take no options.
   */
  async setup(setup?: TestSetup): Promise<TestContext> {
    const test = this.#current();
    if (test.setup !== undefined) {
      if (setup !== undefined) {
        throw new Error('setup options must be given before the test first uses its sandbox');
      }
      return test.setup;
    }
    test.setup = this.#open(test, setup ?? {});
    return test.setup;
  }

  async #open(test: TestState<H>, setup: TestSetup): Promise<TestContext> {
    // Each part is registered in the test state as soon as it exists, so
    // endTest closes it whatever fails next.
    test.rootsMayExitBeforeIdentity = setup.rootsMayExitBeforeIdentity === true;
    const mock = await this.#startMock(test, setup.mock);
    const sandbox = await createSandbox({
      name: `it${String(test.index)}`,
      ...setup.sandbox,
      cli: this.cli,
      mock,
      testRoot: this.suiteDir,
      ancestorPolicy: this.#seams.ancestorPolicy,
    });
    test.sandbox = sandbox;
    const launcher =
      setup.launcher === undefined
        ? undefined
        : await (this.#seams.writeLauncher ?? writeTestLauncher)({
            dir: sandbox.dirs.root,
            cli: sandbox.cli,
            platform: sandbox.platform,
            options: setup.launcher,
          });
    const tracker = new LeakTracker({ ...this.#leakHost, marker: sandbox.dirs.root });
    await tracker.begin();
    test.tracker = tracker;
    const stopSampling = tracker.startSampling(
      this.#seams.samplingMs ?? samplingIntervalMs(process.platform),
    );
    test.stopSampling = stopSampling;
    return { mock, sandbox, launcher, tracker, stopSampling };
  }

  async #startMock(
    test: TestState<H>,
    options: MockServerOptions | undefined,
  ): Promise<MockServer> {
    const mock = await (this.#seams.startMock ?? startMockServer)(options);
    test.mocks.push(mock);
    return mock;
  }

  /**
   * Starts another mock for this test (a second API endpoint, for example
   * the C3 redirect of plan §4.4); its egress trap is asserted and it is
   * closed after the test like the test's own mock.
   */
  async extraMock(options?: MockServerOptions): Promise<MockServer> {
    return this.#startMock(this.#current(), options);
  }

  /**
   * Connects the product to the pinned CLI in the test's sandbox (plan
   * §1.11, §4.4). The Harness is disposed after the test.
   *
   * With a test launcher, the product connects with the launcher as its
   * binary, and reports the launcher's path with the pinned CLI's version.
   *
   * @throws SandboxRefusedError `binary` when the pinned binary changed
   *   since its verification or the product reports another binary; every
   *   error of the product's `connect`.
   */
  async testConnect(options?: O): Promise<H> {
    const test = this.#current();
    const { sandbox, request } = await this.#request(test);
    const { cli } = sandbox;
    const { binaryPath } = request;
    const harness = await this.#options.connect(options, request);
    test.harnesses.push(harness);
    if (
      !samePath(harness.binary.path, binaryPath, sandbox.platform) ||
      harness.binary.version !== cli.version
    ) {
      throw new SandboxRefusedError(
        'binary',
        `the product connected ${harness.binary.path} ${harness.binary.version}, not the pinned ${binaryPath} ${cli.version}`,
      );
    }
    return harness;
  }

  /**
   * Runs another entry point of the product in the test's sandbox, with the
   * same request as {@link IntegrationSuite.testConnect} (the pinned binary,
   * the sandbox config directory, the checked host seams): for an entry
   * point that keeps its Harness private, such as the adapter's `session()`.
   * Every process it spawns is tracked like a Harness's; the value it
   * resolves with is disposed after the test, after the Harnesses, whatever
   * the test did.
   *
   * @throws SandboxRefusedError `binary` when the pinned binary changed
   *   since its verification; every error of `launch`.
   */
  async testLaunch<R extends AsyncDisposable>(
    launch: (request: ProductConnectRequest) => Promise<R>,
  ): Promise<R> {
    const test = this.#current();
    const { request } = await this.#request(test);
    const launched = await launch(request);
    test.launched.push(launched);
    return launched;
  }

  /**
   * Calls `listener` with every session process the product spawns in this
   * test from now on, once the harness recorded it for the leak checks
   * (after its identity read settled); the product receives the process
   * only once every listener settled (for example: abort the session, so
   * the abort reaches the product before its handshake can).
   * Listeners run one after the other; one that throws or rejects fails the
   * test and the spawn goes on. A listener that never settles holds the
   * product's spawn until the test's hang guard.
   */
  onSpawn(listener: SpawnListener): void {
    this.#current().spawnListeners.push(listener);
  }

  /** The request of a product launch in the test's sandbox (the binary re-checked). */
  async #request(
    test: TestState<H>,
  ): Promise<{ readonly sandbox: Sandbox; readonly request: ProductConnectRequest }> {
    const { sandbox, tracker, launcher } = await this.setup();
    const { cli } = sandbox;
    recheckPinnedCli(cli);
    const host = productHostSeams({
      sandbox,
      launcher,
      ...this.#seams.productHost,
      onRoot: (root) => this.#recordRoot(test, tracker, root),
      onRefused: (error) => test.refusals.push(error),
    });
    return {
      sandbox,
      request: {
        binaryPath: launcher?.path ?? cli.binaryPath,
        configDir: sandbox.dirs.cfg,
        host,
      },
    };
  }

  /**
   * Records a spawned session process for the leak checks and hands it to
   * the product only once its identity read settled (identity first, W6-Z
   * ruling 1): on Windows without the job addon the read is one CIM query
   * of 0.5 to 1.8 s, longer than a session a test ends right after its
   * spawn (an abort after the first permission request lives about
   * 650 ms), and a root reaped before its read finished has no identity, so
   * its tree could not be checked. The CLI runs meanwhile; its output waits
   * in the pipe. Only this sandbox host seam waits; the product's own
   * timing is unchanged. Then the test's spawn listeners run.
   */
  async #recordRoot(
    test: TestState<H>,
    tracker: LeakTracker,
    child: HarnessProcess,
  ): Promise<void> {
    const root: Root = { pid: child.pid, exited: false };
    test.roots.push(root);
    const markExited = (): void => {
      root.exited = true;
    };
    child.exited.then(markExited, markExited);
    const judged = child.identity.then((read) => {
      if (read.identity === null) {
        if (read.problem === 'exited' && test.rootsMayExitBeforeIdentity) return;
        test.failures.push(
          new Error(
            `no identity could be read for spawned pid ${String(child.pid)} (${read.problem}): its process tree cannot be checked for leaks`,
          ),
        );
      } else if (child.identitySource !== this.#leakHost.table.source) {
        test.failures.push(
          new Error(
            `spawned pid ${String(child.pid)}: identity source ${child.identitySource} differs from the leak table's ${this.#leakHost.table.source}`,
          ),
        );
      } else {
        tracker.recordIdentity(read.identity);
      }
    });
    test.pending.push(judged);
    // A judgement that throws fails the test in endTest (pending); the spawn goes on.
    await judged.catch(() => undefined);
    for (const listener of [...test.spawnListeners]) {
      try {
        await listener(child);
      } catch (error) {
        test.failures.push(
          new Error(`a spawn listener failed: ${String(error)}`, { cause: error }),
        );
      }
    }
  }

  /**
   * Pre-initializes the test's fresh config directory with one complete
   * session before the test fans out several sessions into it (J11): a
   * Harness runs the injected `warmUp` and is disposed; the config
   * directory must then hold the CLI's own `.claude.json`.
   *
   * @throws Error when the warm-up left no `.claude.json`; every error of
   *   the connect and of the warm-up session.
   */
  async warm(options?: O): Promise<void> {
    const harness = await this.testConnect(options);
    await this.#options.warmUp(harness);
    const { cfg } = (await this.sandbox()).dirs;
    if (!existsSync(path.join(cfg, '.claude.json'))) {
      throw new Error(`the warm-up session left no .claude.json in ${cfg}`);
    }
  }

  /**
   * Disposes everything the test opened and asserts zero leaks and zero
   * egress violations (`afterEach`); see the module remarks.
   *
   * @throws the one failure, or an `AggregateError` of every failure
   */
  async endTest(): Promise<void> {
    const test = this.#current();
    this.#test = undefined;
    const failures: unknown[] = [];
    // A failed setup already failed the test that awaited it; whatever it
    // opened before failing is still closed below.
    await test.setup?.catch(() => undefined);
    for (const harness of [...test.harnesses].reverse()) {
      await collect(failures, () => harness[Symbol.asyncDispose]());
    }
    for (const launched of [...test.launched].reverse()) {
      await collect(failures, () => launched[Symbol.asyncDispose]());
    }
    for (const settled of await Promise.allSettled(test.pending)) {
      if (settled.status === 'rejected') failures.push(settled.reason);
    }
    const { stopSampling, tracker, sandbox } = test;
    if (stopSampling !== undefined) await collect(failures, stopSampling);
    failures.push(...test.failures);
    for (const root of test.roots) {
      if (!root.exited) {
        failures.push(
          new Error(
            `spawned pid ${String(root.pid)} had not exited when the test's Harnesses were disposed`,
          ),
        );
      }
    }
    if (tracker !== undefined) await collect(failures, () => tracker.assertNoLeaks());
    failures.push(...test.refusals);
    for (const mock of test.mocks) {
      await collect(failures, () => {
        mock.assertNoViolations();
      });
    }
    for (const mock of test.mocks) await collect(failures, () => mock.close());
    if (sandbox !== undefined) await collect(failures, () => sandbox.dispose());
    throwAll(failures, 'post-test');
  }

  /**
   * The suite-level sweep (`afterAll`, 07 §13): fails when any process
   * still names the suite directory in its command line (killed by verified
   * identity first), then removes the directory.
   */
  async endSuite(): Promise<void> {
    const failures: unknown[] = [];
    const dir = this.#suiteDir;
    if (dir !== undefined) {
      await collect(failures, () => assertNoSurvivors(this.#leakHost, dir));
      await collect(failures, () =>
        rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      );
    }
    throwAll(failures, 'post-suite');
  }
}

/** The Vitest hook functions {@link registerIntegrationHooks} uses. */
export interface SuiteHooks {
  beforeAll(fn: () => Promise<void>, timeout?: number): void;
  afterAll(fn: () => Promise<void>, timeout?: number): void;
  beforeEach(fn: () => void, timeout?: number): void;
  afterEach(fn: () => Promise<void>, timeout?: number): void;
}

/** Registers the suite's lifecycle on the test runner's hooks. */
export function registerIntegrationHooks<O, H extends ConnectedHarness>(
  suite: IntegrationSuite<O, H>,
  hooks: SuiteHooks,
): void {
  hooks.beforeAll(() => suite.beginSuite(), SUITE_HOOK_TIMEOUT_MS);
  hooks.beforeEach(() => {
    suite.beginTest();
  });
  hooks.afterEach(() => suite.endTest(), END_TEST_TIMEOUT_MS);
  hooks.afterAll(() => suite.endSuite(), SUITE_HOOK_TIMEOUT_MS);
}
