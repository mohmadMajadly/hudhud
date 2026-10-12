/**
 * Per-run sandbox of the pinned CLI (05 §3, §13.2; ADR-0013 §2-§3, §17;
 * plan §1.11, §4.4, §4.5).
 *
 * @remarks
 * {@link createSandbox} makes a fresh run directory under the test root
 * (`HUDHUD_TEST_ROOT`, else `RUNNER_TEMP`, else the OS temp directory) after
 * refusing any root with a forbidden ancestor (`ancestors.ts`), and creates
 * the redirected config, home, app-data, temp and work directories. Each
 * {@link Sandbox.launch} re-checks the verified pinned binary and spawns it
 * with `shell: false`, the explicit environment of `env.ts` and the standard
 * stream-json flags plus `--setting-sources=` and an explicit
 * `--permission-mode` (05 §13.2). There is no way to launch anything else:
 * the binary comes only from {@link VerifiedCli}, and the egress trap is
 * the mock passed in.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertNoForbiddenAncestors, testRootInstructions } from './ancestors.js';
import type { AncestorProbe } from './ancestors.js';
import { buildSandboxEnv, defaultGitBashPath } from './env.js';
import type { SandboxDirs } from './env.js';
import { SandboxRefusedError } from './errors.js';
import { assertIssuedCli, recheckPinnedCli } from './pinned-cli.js';
import type { VerifiedCli } from './pinned-cli.js';

/** The stream-json flags of every run (05 §4: print mode needs `--verbose`). */
export const STREAM_ARGS: readonly string[] = [
  '--output-format=stream-json',
  '--input-format=stream-json',
  '--verbose',
];

/** Longest Unix socket path (sun_path minus NUL) the CLI can use without its `/tmp` fallback (05 §13). */
export const MAX_SOCKET_PATH_BYTES = 103;

/** The CLI's socket path for the largest Linux pid, given its temp directory (05 §13). */
export function worstCaseSocketPath(tmp: string): string {
  return path.posix.join(tmp, 'cc-socks', '4194304.sock');
}

/**
 * Refuses a temp directory whose Unix socket path would exceed
 * {@link MAX_SOCKET_PATH_BYTES}: the CLI would then fall back to
 * `/tmp/cc-socks-<uid>`, outside the sandbox (05 §13). Windows uses a named
 * pipe and has no such limit.
 */
export function assertSocketRoom(platform: NodeJS.Platform, tmp: string): void {
  if (platform === 'win32') return;
  if (Buffer.byteLength(worstCaseSocketPath(tmp)) <= MAX_SOCKET_PATH_BYTES) return;
  throw new SandboxRefusedError(
    'test-root',
    `sandbox temp directory ${tmp} is too long: the CLI's socket would fall back to /tmp (05 §13). ${testRootInstructions(platform)}`,
  );
}

const SETTING_SOURCES = /^(?:(?:user|project|local)(?:,(?:user|project|local))*)?$/;
const PERMISSION_MODE = /^[A-Za-z]{1,32}$/;
const RESERVED_FLAGS = ['--setting-sources', '--permission-mode'];

/**
 * The test root: `HUDHUD_TEST_ROOT`, else `RUNNER_TEMP` (CI), else
 * `tmpdir` (plan §4.4).
 */
export function resolveTestRoot(
  env: Readonly<Record<string, string | undefined>>,
  tmpdir: string,
): string {
  for (const name of ['HUDHUD_TEST_ROOT', 'RUNNER_TEMP']) {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
  }
  return tmpdir;
}

/** Every path of the real user's home: the environment's and the account database's. */
export function realHomes(
  env: Readonly<Record<string, string | undefined>>,
  accountHome: () => string,
): readonly string[] {
  const homes = [os.homedir(), env['HOME'], env['USERPROFILE']];
  try {
    homes.push(accountHome());
  } catch {
    // no account database entry (for example an arbitrary container uid)
  }
  return homes.filter((home): home is string => home !== undefined && home !== '');
}

/** The real file system as an {@link AncestorProbe}: `lstat` existence and `realpath.native`. */
export const fsProbe: AncestorProbe = {
  exists(file) {
    try {
      lstatSync(file);
      return true;
    } catch {
      return false;
    }
  },
  realpath(dir) {
    try {
      return realpathSync.native(dir);
    } catch {
      return undefined;
    }
  },
};

/** The forbidden-ancestor inputs: by default the real homes and the real file system. */
export interface AncestorPolicy {
  readonly homes: readonly string[];
  readonly probe: AncestorProbe;
}

/** Options of {@link createSandbox}. */
export interface SandboxOptions {
  /** The verified pinned CLI (`resolvePinnedCli`). The only binary a sandbox runs. */
  readonly cli: VerifiedCli;
  /** The running mock; its URL is the base URL and the egress-trap proxy. */
  readonly mock: { readonly url: string };
  /** Test root; default {@link resolveTestRoot} of the process environment and `os.tmpdir()`. */
  readonly testRoot?: string | undefined;
  /** Short label in the run directory name (`[A-Za-z0-9-]`, at most 32). */
  readonly name?: string | undefined;
  /** Variables added to every launch (protected names refused, see `env.ts`). */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Windows Git Bash; default `<ProgramFiles>\Git\bin\bash.exe` when it exists, `null` for none. */
  readonly gitBashPath?: string | null | undefined;
  /** See `SandboxEnvInput.nonessentialTraffic`; only for the one trap test (plan §4.5). */
  readonly nonessentialTraffic?: 'disabled' | 'allowed' | undefined;
  /**
   * Forbidden-ancestor inputs. Default: the real homes and the real file
   * system. Only the launcher's own tests replace it, to exercise the launch
   * mechanics on a host whose temp directory lies under the home; every
   * other caller keeps the default.
   */
  readonly ancestorPolicy?: AncestorPolicy | undefined;
}

/** Options of one {@link Sandbox.launch}. */
export interface LaunchOptions {
  /** CLI arguments in `--flag=value` form, before the enforced flags. */
  readonly args?: readonly string[] | undefined;
  /** `--setting-sources=` value; default `''` (no settings files, 05 §13.1). */
  readonly settingSources?: string | undefined;
  /** `--permission-mode=` value; default `default`. */
  readonly permissionMode?: string | undefined;
  /** Variables for this launch only (protected names refused). */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** A spawned sandboxed CLI. */
export interface SandboxProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  /** The complete argv after the binary. */
  readonly argv: readonly string[];
  /** The complete environment (contains the fake key; redact before logging). */
  readonly env: Readonly<Record<string, string>>;
}

/** One isolated run directory and the means to launch the pinned CLI in it. */
export interface Sandbox {
  readonly dirs: SandboxDirs;
  readonly cli: VerifiedCli;
  readonly mockUrl: string;
  readonly platform: NodeJS.Platform;
  /** The environment every launch starts from (contains the fake key). */
  readonly env: Readonly<Record<string, string>>;
  /** Spawns the pinned CLI in the sandbox. Rejects when the spawn itself fails. */
  launch(options?: LaunchOptions): Promise<SandboxProcess>;
  /** Removes the run directory. Callers stop their processes first. */
  dispose(): Promise<void>;
}

function checkTestRoot(root: string): string {
  if (!path.isAbsolute(root)) {
    throw new SandboxRefusedError('test-root', `test root ${root} is not absolute`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    // reported below
  }
  if (!isDirectory) {
    throw new SandboxRefusedError('test-root', `test root ${root} is not an existing directory`);
  }
  return path.resolve(root);
}

/** The full argv of a launch: caller args, stream flags, setting sources, permission mode. */
export function launchArgv(options: LaunchOptions): readonly string[] {
  const args = options.args ?? [];
  for (const arg of args) {
    if (arg.includes('\0')) throw new SandboxRefusedError('unsafe-option', 'argument contains NUL');
    if (RESERVED_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new SandboxRefusedError(
        'unsafe-option',
        `${arg}: use the settingSources and permissionMode launch options`,
      );
    }
  }
  const sources = options.settingSources ?? '';
  if (!SETTING_SOURCES.test(sources)) {
    throw new SandboxRefusedError('unsafe-option', `setting sources ${JSON.stringify(sources)}`);
  }
  const mode = options.permissionMode ?? 'default';
  if (!PERMISSION_MODE.test(mode)) {
    throw new SandboxRefusedError('unsafe-option', `permission mode ${JSON.stringify(mode)}`);
  }
  return [...args, ...STREAM_ARGS, `--setting-sources=${sources}`, `--permission-mode=${mode}`];
}

/**
 * Creates a fresh sandbox under the test root.
 *
 * @throws SandboxRefusedError `binary` for a CLI not issued by
 *   `resolvePinnedCli` or changed since; `test-root` or
 *   `forbidden-ancestor` (with instructions) when no isolated directory can
 *   be made there.
 */
export async function createSandbox(options: SandboxOptions): Promise<Sandbox> {
  assertIssuedCli(options.cli);
  recheckPinnedCli(options.cli);
  const platform = process.platform;
  const hostEnv = process.env;
  const policy = options.ancestorPolicy ?? {
    homes: realHomes(hostEnv, () => os.userInfo().homedir),
    probe: fsProbe,
  };
  const testRoot = checkTestRoot(options.testRoot ?? resolveTestRoot(hostEnv, os.tmpdir()));
  assertNoForbiddenAncestors({ dir: testRoot, platform, ...policy });
  const name = options.name ?? 'run';
  if (!/^[A-Za-z0-9-]{1,32}$/.test(name)) {
    throw new SandboxRefusedError('unsafe-option', `sandbox name ${JSON.stringify(name)}`);
  }
  const root = await mkdtemp(path.join(testRoot, `hudhud-${name}-`));
  try {
    assertNoForbiddenAncestors({ dir: root, platform, ...policy });
    const home = path.join(root, 'home');
    const dirs: SandboxDirs = {
      root,
      cfg: path.join(root, 'cfg'),
      home,
      appData: path.join(home, 'AppData', 'Roaming'),
      localAppData: path.join(home, 'AppData', 'Local'),
      tmp: path.join(root, 'tmp'),
      work: path.join(root, 'work'),
    };
    assertSocketRoom(platform, dirs.tmp);
    for (const dir of [dirs.cfg, dirs.appData, dirs.localAppData, dirs.tmp, dirs.work]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const gitBashPath =
      options.gitBashPath === null
        ? undefined
        : (options.gitBashPath ?? defaultGitBashPath(hostEnv, (file) => fsProbe.exists(file)));
    const baseEnv = {
      platform,
      dirs,
      mockUrl: options.mock.url,
      hostEnv,
      gitBashPath,
      nonessentialTraffic: options.nonessentialTraffic,
    };
    const env = buildSandboxEnv({ ...baseEnv, extra: options.env });
    const { cli } = options;
    return {
      dirs,
      cli,
      mockUrl: options.mock.url,
      platform,
      env,
      async launch(launch: LaunchOptions = {}): Promise<SandboxProcess> {
        const argv = launchArgv(launch);
        const launchEnv = buildSandboxEnv({
          ...baseEnv,
          extra: { ...options.env, ...launch.env },
        });
        recheckPinnedCli(cli);
        const child = spawn(cli.binaryPath, argv, {
          cwd: dirs.work,
          env: launchEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        return { child, pid: Number(child.pid), argv, env: launchEnv };
      },
      async dispose(): Promise<void> {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
