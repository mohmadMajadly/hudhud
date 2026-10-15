/**
 * The host seams through which hudhud itself runs the pinned CLI in a
 * sandbox (plan §1.11 `testConnect`, §4.4; ADR-0013 §2-§3).
 *
 * @remarks
 * Integration tests drive the product: its `connect()` discovers, verifies
 * and probes the binary and its sessions build the argv and environment and
 * spawn the CLI. Only what the product takes from the machine it runs on is
 * replaced, and only with sandbox values:
 *
 * - `env`: the parent environment the product filters is the sandbox's
 *   explicit environment (`env.ts`), never `process.env`, so no form of the
 *   `env` option (`'inherit'` included) can hand the CLI a host variable;
 * - `homedir` and `cwd`: the sandbox home and work directory;
 * - `probe.workDir`: the version probe's empty directory is made in the
 *   sandbox temp directory, not in the host's;
 * - `spawn` and `probe.run`: the core's own spawn and bounded command, after
 *   a check of what the product is about to run (below).
 *
 * Every launch is checked before anything starts: the file is the verified
 * pinned binary, unchanged since its verification (`recheckPinnedCli`); the
 * working directory lies inside the sandbox; the environment keeps every
 * isolation variable of the sandbox (`assertKeepsIsolation`: home, config
 * and temp directories, the fake credential, the mock as base URL and as
 * the proxy trap, `NO_PROXY`, the nonessential-traffic variable); the probe
 * may leave out only the credential, which the product never gives it, and
 * a launch may add only a switch that restricts the CLI further
 * (`STRICTER_ADDITIONS`: the nonessential-traffic switch a sandbox of the
 * one trap test leaves out). A test of the K1 signal target may put a
 * generated launcher in front of the binary (`test-launcher.ts`); the
 * launcher, unchanged and naming the unchanged pinned binary, is then the
 * only file a launch may run. A
 * refusal is reported to `onRefused` (the harness fails the test with it
 * even when the product maps it to its own spawn error) and thrown. Each
 * spawned session process is reported to `onRoot` before the product sees
 * it, for the leak assertions (plan §4.7).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { runBoundedCommand, spawnHarnessProcess } from '@hudhud/core/process';
import type {
  BoundedCommand,
  CommandOutcome,
  HarnessProcess,
  ProbeWorkDir,
  SpawnSpec,
} from '@hudhud/core/process';

import { SandboxRefusedError } from './errors.js';
import { recheckPinnedCli } from './pinned-cli.js';
import { assertKeepsIsolation, STRICTER_ADDITIONS } from './sandbox.js';
import type { Sandbox } from './sandbox.js';
import { recheckTestLauncher } from './test-launcher.js';
import type { TestLauncher } from './test-launcher.js';

/** Credential variables the product leaves out of the version probe (least privilege). */
export const PROBE_DROPPED_CREDENTIALS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

/** The seams of the product's host that a sandboxed run replaces (see the module remarks). */
export interface ProductHostSeams {
  readonly env: Readonly<Record<string, string>>;
  readonly homedir: string;
  readonly cwd: () => string;
  readonly spawn: (spec: SpawnSpec) => Promise<HarnessProcess>;
  readonly probe: {
    readonly run: (command: BoundedCommand) => Promise<CommandOutcome>;
    readonly workDir: ProbeWorkDir;
  };
}

/** Inputs of {@link productHostSeams}. */
export interface ProductHostOptions {
  readonly sandbox: Sandbox;
  /**
   * Called with every spawned session process, before the product sees it;
   * the product receives the process once the returned promise resolved.
   * When it rejects, the process is killed through its handle and awaited,
   * the error goes to `onRefused`, and the spawn rejects with it.
   */
  readonly onRoot: (root: HarnessProcess) => Promise<void> | void;
  /**
   * Called with the error of every refused launch (a {@link SandboxRefusedError})
   * and of every `onRoot` that rejected, before it is thrown.
   */
  readonly onRefused: (error: unknown) => void;
  /** The spawn after the check; default the core's `spawnHarnessProcess`. */
  readonly spawn?: ((spec: SpawnSpec) => Promise<HarnessProcess>) | undefined;
  /** The probe's command runner after the check; default the core's `runBoundedCommand`. */
  readonly run?: ((command: BoundedCommand) => Promise<CommandOutcome>) | undefined;
  /**
   * The test's launcher in front of the pinned CLI (`test-launcher.ts`):
   * when set, it is the only file a launch may run, instead of the binary.
   */
  readonly launcher?: TestLauncher | undefined;
}

/** A launch as the product builds it. */
export interface ProductLaunch {
  readonly file: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Whether two absolute paths name the same file, compared as the OS compares them. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return path.posix.resolve(a) === path.posix.resolve(b);
  return path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
}

/** Whether `dir` is `root` or lies inside it, compared as the OS compares paths. */
export function isWithin(root: string, dir: string, platform: NodeJS.Platform): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const fold = (value: string): string =>
    platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  const relative = paths.relative(fold(root), fold(dir));
  return !relative.startsWith('..') && !paths.isAbsolute(relative);
}

/**
 * Checks a launch the product is about to start (see the module remarks).
 *
 * With a test `launcher`, the launcher (unchanged, naming the unchanged
 * pinned binary) is the only file a launch may run.
 *
 * @throws SandboxRefusedError `binary` for any file other than the verified
 *   pinned binary (or the test's launcher) or a changed one, `unsafe-option`
 *   for a working directory outside the sandbox or an environment that
 *   undoes its isolation.
 */
export function checkProductLaunch(
  launch: ProductLaunch,
  sandbox: Sandbox,
  kind: 'session' | 'probe',
  launcher?: TestLauncher,
): void {
  const { cli, platform } = sandbox;
  const expected = launcher?.path ?? cli.binaryPath;
  if (!samePath(launch.file, expected, platform)) {
    throw new SandboxRefusedError(
      'binary',
      launcher === undefined
        ? `the product would run ${launch.file}; the only binary a sandbox runs is the pinned ${cli.binaryPath}`
        : `the product would run ${launch.file}; this test runs only its launcher ${launcher.path}`,
    );
  }
  if (launcher === undefined) recheckPinnedCli(cli);
  else recheckTestLauncher(launcher);
  if (!isWithin(sandbox.dirs.root, launch.cwd, platform)) {
    throw new SandboxRefusedError(
      'unsafe-option',
      `the product would run the CLI in ${launch.cwd}, outside the sandbox ${sandbox.dirs.root}`,
    );
  }
  assertKeepsIsolation(launch.env, sandbox.env, platform, {
    mayDrop: kind === 'probe' ? PROBE_DROPPED_CREDENTIALS : [],
    mayAdd: STRICTER_ADDITIONS,
  });
}

/** The seams of a sandboxed product host (see the module remarks). */
export function productHostSeams(options: ProductHostOptions): ProductHostSeams {
  const { sandbox, onRoot, onRefused, launcher } = options;
  const spawn = options.spawn ?? spawnHarnessProcess;
  const run = options.run ?? runBoundedCommand;
  const checked = (launch: ProductLaunch, kind: 'session' | 'probe'): void => {
    try {
      checkProductLaunch(launch, sandbox, kind, launcher);
    } catch (error) {
      onRefused(error);
      throw error;
    }
  };
  return {
    env: sandbox.env,
    homedir: sandbox.dirs.home,
    cwd: () => sandbox.dirs.work,
    async spawn(spec) {
      checked(spec, 'session');
      const root = await spawn(spec);
      try {
        await onRoot(root);
      } catch (error) {
        // The product never receives this root, so nothing else would end
        // it: end it here and fail the test. The kill goes through the
        // spawn's own handle, which names exactly this unreaped child (its
        // pid cannot have been reused), never through a bare pid.
        onRefused(error);
        root.killViaHandle('SIGKILL');
        await root.exited;
        throw error;
      }
      return root;
    },
    probe: {
      async run(command) {
        checked(command, 'probe');
        return run(command);
      },
      workDir: {
        create: () => mkdtemp(path.join(sandbox.dirs.tmp, 'probe-')),
        remove: (dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
      },
    },
  };
}
