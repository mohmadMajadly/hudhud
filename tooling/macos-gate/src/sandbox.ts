/**
 * The isolated launch environment of every CLI run in the gate: research 05
 * §13.2 (proven sandbox recipe) and §3 (explicit environment), on macOS.
 *
 * - The pinned binary verified against npm integrity and the SDK manifest.
 * - An explicit environment; nothing is inherited from the runner.
 * - `--setting-sources=` and an explicit `--permission-mode`.
 * - cwd: an empty directory in a fresh temp root (no `.claude`/`CLAUDE.md`
 *   ancestor on a runner).
 * - TMPDIR and CLAUDE_CODE_TMPDIR inside the run root (native APFS).
 * - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and the mock as proxy (egress
 *   trap) with `NO_PROXY` for the mock only.
 * - A fake API key only.
 * - Process cleanup by verified identity (`ps.ts`; macOS has no job object
 *   or cgroup).
 */

import path from 'node:path';

import type { GateFs } from './host.js';

/** The only credential any CLI run ever sees. Not a real key format. */
export const FAKE_API_KEY = 'hudhud-macos-gate-fake-key';

/** argv of every session: stream-json both ways, no setting sources, explicit permission mode. */
export const SESSION_ARGS: readonly string[] = [
  '--output-format=stream-json',
  '--input-format=stream-json',
  '--verbose',
  '--setting-sources=',
  '--permission-mode=default',
  '--permission-prompt-tool=stdio',
];

/** The `PATH` of every CLI run: system directories only. */
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Directories of one run. */
export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly config: string;
  readonly tmp: string;
  readonly work: string;
}

/**
 * Creates a fresh run root under `base` with `home`, `cfg`, `tmp` and `work`.
 * `tmpName` replaces the `tmp` directory name (item 5 uses a long one).
 */
export async function createSandbox(fs: GateFs, base: string, tmpName = 'tmp'): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.posix.join(base, 'hhg-'));
  const sandbox: Sandbox = {
    root,
    home: path.posix.join(root, 'home'),
    config: path.posix.join(root, 'cfg'),
    tmp: path.posix.join(root, tmpName),
    work: path.posix.join(root, 'work'),
  };
  for (const dir of [sandbox.home, sandbox.config, sandbox.tmp, sandbox.work]) {
    await fs.mkdir(dir);
  }
  return sandbox;
}

/** Inputs of {@link sandboxEnv}. */
export interface SandboxEnvInput {
  readonly sandbox: Sandbox;
  /** Base URL of the in-process mock (also the proxy of the egress trap). */
  readonly mockUrl: string;
  /** The runner user's login name (shells and the Keychain key on it). */
  readonly user: string;
  /** `false` omits `ANTHROPIC_API_KEY` (item 3 control run). */
  readonly apiKey?: boolean;
  /** A directory searched before the system `PATH` (item 3 `security` shim). */
  readonly pathPrefix?: string;
}

/** The complete environment of a CLI run. */
export function sandboxEnv(input: SandboxEnvInput): Record<string, string> {
  const { sandbox, mockUrl } = input;
  return {
    PATH: input.pathPrefix === undefined ? SYSTEM_PATH : `${input.pathPrefix}:${SYSTEM_PATH}`,
    HOME: sandbox.home,
    USER: input.user,
    LOGNAME: input.user,
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    TMPDIR: sandbox.tmp,
    CLAUDE_CODE_TMPDIR: sandbox.tmp,
    CLAUDE_CONFIG_DIR: sandbox.config,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
    ANTHROPIC_BASE_URL: mockUrl,
    ...(input.apiKey === false ? {} : { ANTHROPIC_API_KEY: FAKE_API_KEY }),
    HTTPS_PROXY: mockUrl,
    HTTP_PROXY: mockUrl,
    https_proxy: mockUrl,
    http_proxy: mockUrl,
    NO_PROXY: '127.0.0.1',
    no_proxy: '127.0.0.1',
  };
}

/** A `[[mock:NAME k=v]]` marker of the test-support scenario provider. */
export function mockMarker(name: string, args: Readonly<Record<string, string>> = {}): string {
  const pairs = Object.entries(args).map(([key, value]) => ` ${key}=${value}`);
  return `[[mock:${name}${pairs.join('')}]]`;
}

/** The marker of a Bash tool use running `command`. */
export function bashMarker(command: string): string {
  return mockMarker('bash', { cmd: Buffer.from(command, 'utf8').toString('base64') });
}
