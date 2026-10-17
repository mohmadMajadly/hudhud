/**
 * Per-run sandbox of the pinned CLI (05 §3, §13.2; ADR-0013 §2-§3, §17;
 * plan §1.11, §4.4, §4.5).
 *
 * @remarks
 * {@link createSandbox} makes a fresh run directory under the test root
 * (`HUDHUD_TEST_ROOT`, else on Windows `RUNNER_TEMP`, else the OS temp
 * directory, on macOS `/private/tmp`; see {@link resolveTestRoot})
 * after refusing any root with a forbidden ancestor (`ancestors.ts`), and creates
 * the redirected config, home, app-data, temp and work directories. Each
 * {@link Sandbox.launch} re-checks the verified pinned binary and spawns it
 * with `shell: false`, the explicit environment of `env.ts` and the standard
 * stream-json flags plus `--setting-sources=` and an explicit
 * `--permission-mode` (05 §13.2), or with a launch the product built from
 * the sandbox environment (`exact`, the fixture recorder: hudhud's own argv
 * and environment, checked to keep every isolation variable, see
 * {@link exactLaunch}). There is no way to launch anything else: the binary
 * comes only from {@link VerifiedCli}, and the egress trap is the mock
 * passed in.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { childEnv } from '@hudhudjs/core/process';

import { assertNoForbiddenAncestors, testRootInstructions } from './ancestors.js';
import type { AncestorProbe } from './ancestors.js';
import { buildSandboxEnv, defaultGitBashPath, isProtectedEnvName } from './env.js';
import type { SandboxCredential, SandboxDirs } from './env.js';
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

/** The short, native temp directory macOS tests use instead of `$TMPDIR` (see {@link testTempBase}). */
export const DARWIN_TEST_TEMP_BASE = '/private/tmp';

/**
 * Where tests make their temp directories that sandboxes live in: `tmpdir`,
 * except on macOS, where it is {@link DARWIN_TEST_TEMP_BASE}. The macOS
 * `$TMPDIR` (`/var/folders/<2>/<30>/T/`, about 49 bytes) leaves too little
 * of the 103-byte socket path for a run directory below a test directory, so
 * the CLI would put its socket in `/tmp` (05 §13, macOS gate item 5);
 * `/private/tmp` is the real path of `/tmp` (gate item 6: no symlink in the
 * paths the CLI sees), a native file system outside the home, and
 * `mkdtemp` makes each directory in it private (mode 0700).
 */
export function testTempBase(platform: NodeJS.Platform, tmpdir: string): string {
  return platform === 'darwin' ? DARWIN_TEST_TEMP_BASE : tmpdir;
}

/**
 * The test root: `HUDHUD_TEST_ROOT`, else on Windows `RUNNER_TEMP` (CI),
 * else {@link testTempBase} (plan §4.4). `RUNNER_TEMP` is never the default
 * on POSIX: GitHub's hosted runners put it under the runner's home
 * (`/home/runner/work/_temp` on Linux, `/Users/runner/work/_temp` on macOS),
 * which the forbidden-ancestor rule refuses (W7-T1: CI sets
 * `HUDHUD_TEST_ROOT` explicitly), and on macOS `$TMPDIR` is too long for
 * the CLI socket (see {@link testTempBase}).
 */
export function resolveTestRoot(
  env: Readonly<Record<string, string | undefined>>,
  tmpdir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const names = platform === 'win32' ? ['HUDHUD_TEST_ROOT', 'RUNNER_TEMP'] : ['HUDHUD_TEST_ROOT'];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
  }
  return testTempBase(platform, tmpdir);
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
   * Test-only: `fake-auth-token` runs the CLI with a fake `ANTHROPIC_AUTH_TOKEN`
   * instead of the fake API key (the K10 fixture, see `SandboxCredential`).
   */
  readonly credential?: SandboxCredential | undefined;
  /**
   * Forbidden-ancestor inputs. Default: the real homes and the real file
   * system. Only the launcher's own tests replace it, to exercise the launch
   * mechanics on a host whose temp directory lies under the home; every
   * other caller keeps the default.
   */
  readonly ancestorPolicy?: AncestorPolicy | undefined;
}

/**
 * A launch built by the product (`@hudhudjs/claude-code` `buildArgv` and
 * `buildChildEnv` with the sandbox environment as the parent; the fixture
 * recorder, W4-T2). The sandbox spawns it as the product's process layer
 * would (`childEnv` of `@hudhudjs/core/process`), after checking that it
 * keeps every isolation variable of the sandbox (see {@link exactLaunch}).
 */
export interface ExactLaunch {
  /** The complete argv after the binary. */
  readonly argv: readonly string[];
  /** The complete environment, before the spawn layer's Windows blanks. */
  readonly env: Readonly<Record<string, string>>;
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
  /** A product-built launch instead of the four options above (which must then be absent). */
  readonly exact?: ExactLaunch | undefined;
}

/** Hooks of one {@link Sandbox.launch}. */
export interface LaunchHooks {
  /** Called synchronously with the child right after the spawn call (before its `spawn` event). */
  readonly onSpawn?: ((child: ChildProcessWithoutNullStreams) => void) | undefined;
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
  /**
   * Spawns the pinned CLI in the sandbox. Rejects when the spawn itself
   * fails. `hooks.onSpawn` runs synchronously right after the spawn call,
   * before anything is awaited, so its listeners see every byte and the
   * `close` event of a process that exits at once.
   */
  launch(options?: LaunchOptions, hooks?: LaunchHooks): Promise<SandboxProcess>;
  /** Removes the run directory. Callers stop their processes first. */
  dispose(): Promise<void>;
}

/**
 * Validates the test root and returns the path the sandbox uses: on macOS
 * its real path (`/tmp` is `/private/tmp`, and the CLI must see the same
 * paths hudhud passes, gate item 6); elsewhere the resolved path as given (a
 * Windows `subst` drive must stay a drive: its real path can lie under the
 * home, 05 §13.1).
 *
 * @throws SandboxRefusedError `test-root` for a relative or missing root.
 */
export function checkTestRoot(root: string, platform: NodeJS.Platform): string {
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
  return platform === 'darwin' ? realpathSync.native(root) : path.resolve(root);
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
 * Sandbox variables a product-built launch may leave out, per platform:
 * the ones that platform never reads, so leaving them out cannot send the
 * CLI to a host location. hudhud's `'harness'` preset passes neither (its
 * allowlist is per platform, `@hudhudjs/claude-code` `env.ts`). POSIX: `TMP`
 * and `TEMP` are Windows names (the temp directory comes from `TMPDIR` and
 * `CLAUDE_CODE_TMPDIR`, both kept). Windows: the home comes from
 * `USERPROFILE` and the temp directory from `TEMP`/`TMP` (all kept), not
 * from `HOME` or `TMPDIR`; Git Bash derives its home from `USERPROFILE`.
 */
export const UNREAD_ENV_NAMES: Readonly<Record<'win32' | 'posix', readonly string[]>> = {
  posix: ['TMP', 'TEMP'],
  win32: ['HOME', 'TMPDIR'],
};

/** The value of `name` in `env`, compared as the OS compares names. */
function envValue(
  env: Readonly<Record<string, string>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return Object.hasOwn(env, name) ? env[name] : undefined;
  const upper = name.toUpperCase();
  const found = Object.keys(env).find((key) => key.toUpperCase() === upper);
  return found === undefined ? undefined : env[found];
}

/**
 * Checks a product-built launch against the sandbox and returns what is
 * spawned: the argv as given and the environment through the product's
 * spawn layer (`childEnv`: on Windows the required variables the map lacks
 * are passed empty, so nothing comes from the host).
 *
 * @throws SandboxRefusedError `unsafe-option` when other launch options are
 *   mixed in, an argument holds NUL, a Windows name appears twice in
 *   different case, or the environment changes or adds a variable the
 *   sandbox pins or protects (home, config and temp directories, the
 *   credential, the mock and the proxy trap, ...; {@link isProtectedEnvName})
 *   or leaves one out that the platform reads ({@link UNREAD_ENV_NAMES} lists
 *   the ones it may leave out); names compare as the OS compares them.
 */
export function exactLaunch(
  launch: LaunchOptions,
  sandboxEnv: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): ExactLaunch {
  const { exact } = launch;
  if (exact === undefined) throw new SandboxRefusedError('unsafe-option', 'no exact launch');
  const mixed = (['args', 'settingSources', 'permissionMode', 'env'] as const).filter(
    (key) => launch[key] !== undefined,
  );
  if (mixed.length > 0) {
    throw new SandboxRefusedError(
      'unsafe-option',
      `an exact launch takes no ${mixed.join(', ')}: the product builds the whole launch`,
    );
  }
  if (exact.argv.some((arg) => arg.includes('\0'))) {
    throw new SandboxRefusedError('unsafe-option', 'argument contains NUL');
  }
  assertKeepsIsolation(exact.env, sandboxEnv, platform);
  return {
    argv: [...exact.argv],
    env: childEnv(exact.env, platform === 'win32' ? 'win32' : 'posix'),
  };
}

/** What {@link assertKeepsIsolation} lets a launch do beyond keeping the sandbox's values. */
export interface IsolationAllowance {
  /** Protected names the launch may leave out. */
  readonly mayDrop?: readonly string[] | undefined;
  /** Protected names the sandbox leaves out that the launch may add, with their one value. */
  readonly mayAdd?: Readonly<Record<string, string>> | undefined;
}

/**
 * Switches a launch may add although the sandbox leaves them out: they only
 * restrict the CLI further. A sandbox made with `nonessentialTraffic:
 * 'allowed'` (the one trap test, plan §4.5) leaves the nonessential-traffic
 * switch out, and hudhud still sets it where its own option says so (the
 * version probe always does).
 */
export const STRICTER_ADDITIONS: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});

/**
 * Checks that a product-built environment keeps every isolation variable
 * of the sandbox: each name the sandbox pins or protects
 * ({@link isProtectedEnvName}) has the sandbox's value, or is absent from
 * both. Names compare as the OS compares them; on Windows a name that
 * appears twice in different case is refused. A name may be left out only
 * when the platform never reads it ({@link UNREAD_ENV_NAMES}) or when it is
 * listed in `allowance.mayDrop` (the version probe, which the product runs
 * without any credential); a name the sandbox leaves out may be added only
 * with the value `allowance.mayAdd` gives it (a switch that restricts the
 * CLI further, see {@link STRICTER_ADDITIONS}).
 *
 * @throws SandboxRefusedError `unsafe-option` naming the variable, never its value.
 */
export function assertKeepsIsolation(
  env: Readonly<Record<string, string>>,
  sandboxEnv: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  allowance: IsolationAllowance = {},
): void {
  const mayDrop = allowance.mayDrop ?? [];
  const mayAdd = allowance.mayAdd ?? {};
  if (platform === 'win32') {
    const seen = new Set<string>();
    for (const name of Object.keys(env)) {
      const upper = name.toUpperCase();
      if (seen.has(upper)) {
        throw new SandboxRefusedError(
          'unsafe-option',
          `the launch names ${name} twice in different case: one variable on Windows`,
        );
      }
      seen.add(upper);
    }
  }
  const droppable = new Set([
    ...UNREAD_ENV_NAMES[platform === 'win32' ? 'win32' : 'posix'],
    ...mayDrop.map((name) => name.toUpperCase()),
  ]);
  const names = new Set([...Object.keys(sandboxEnv), ...Object.keys(env)]);
  for (const name of names) {
    if (!isProtectedEnvName(name)) continue;
    const kept = envValue(env, name, platform);
    if (kept === undefined && droppable.has(name.toUpperCase())) continue;
    const pinned = envValue(sandboxEnv, name, platform);
    // A name absent from the sandbox comes from the launch, so `kept` is set.
    if (pinned === undefined && kept === envValue(mayAdd, name, platform)) continue;
    if (kept !== pinned) {
      throw new SandboxRefusedError(
        'unsafe-option',
        `the launch changes ${name}, which the sandbox pins (${kept === undefined ? 'dropped' : 'changed or added'})`,
      );
    }
  }
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
  const testRoot = checkTestRoot(
    options.testRoot ?? resolveTestRoot(hostEnv, os.tmpdir(), platform),
    platform,
  );
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
      credential: options.credential,
    };
    const env = buildSandboxEnv({ ...baseEnv, extra: options.env });
    const { cli } = options;
    return {
      dirs,
      cli,
      mockUrl: options.mock.url,
      platform,
      env,
      async launch(launch: LaunchOptions = {}, hooks: LaunchHooks = {}): Promise<SandboxProcess> {
        const { argv, env: launchEnv } =
          launch.exact === undefined
            ? {
                argv: launchArgv(launch),
                env: buildSandboxEnv({ ...baseEnv, extra: { ...options.env, ...launch.env } }),
              }
            : exactLaunch(launch, env, platform);
        recheckPinnedCli(cli);
        const child = spawn(cli.binaryPath, argv, {
          cwd: dirs.work,
          env: launchEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
        hooks.onSpawn?.(child);
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
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
    throw error;
  }
}
