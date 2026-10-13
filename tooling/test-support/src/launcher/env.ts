/**
 * The explicit environment of a sandboxed CLI run (05 §3, §13.2; ADR-0013
 * §2-§3; plan §1.11, §4.4, §4.5).
 *
 * @remarks
 * Nothing is inherited from the host. The map holds the redirected home,
 * config, app-data and temp directories, the fake key, the mock as base URL
 * and as the HTTP(S) proxy in both cases (the egress trap), `NO_PROXY` for
 * the mock host only, the nonessential-traffic variable, the autoupdater
 * switch, a minimal system `PATH` and, on Windows, the system variables the
 * CLI and its tools need plus the Git Bash path. Callers may add variables,
 * but never one that would undo the isolation (see {@link isProtectedEnvName}).
 * Pure: the host environment and file probes are passed in.
 */

import path from 'node:path';

import { SandboxRefusedError } from './errors.js';

/**
 * The only API key a sandboxed CLI ever sees (ADR-0013 §3). Not a
 * credential: it authenticates nowhere, every request goes to the in-process
 * mock. It is shaped like a real key (`sk-ant-` prefix) so the real CLI
 * treats it as one; the prefix `sk-ant-fake-hudhud-` followed by letters and
 * digits only is the one key shape the privacy gate allows (W2-Z ruling G,
 * `FAKE_ANTHROPIC_KEY_PREFIX` in scripts/lib/privacy.mjs).
 */
export const FAKE_API_KEY = 'sk-ant-fake-hudhud-NotACredential0000000000000000';

/** The directories of one sandbox. All absolute; all inside {@link SandboxDirs.root}. */
export interface SandboxDirs {
  readonly root: string;
  /** `CLAUDE_CONFIG_DIR`. */
  readonly cfg: string;
  /** `HOME` and `USERPROFILE`. */
  readonly home: string;
  /** `APPDATA` (`<home>/AppData/Roaming`). */
  readonly appData: string;
  /** `LOCALAPPDATA` (`<home>/AppData/Local`). */
  readonly localAppData: string;
  /** `TMPDIR`, `TMP`, `TEMP`, `CLAUDE_CODE_TMPDIR`. */
  readonly tmp: string;
  /** The CLI's cwd: an empty directory. */
  readonly work: string;
}

/** Inputs of {@link buildSandboxEnv}. */
export interface SandboxEnvInput {
  readonly platform: NodeJS.Platform;
  readonly dirs: SandboxDirs;
  /** Base URL of the in-process mock, `http://127.0.0.1:<port>` (see {@link checkMockUrl}). */
  readonly mockUrl: string;
  /**
   * The host environment; read only for `SystemRoot` on Windows (to locate
   * the system directories). No value is copied into the child otherwise.
   */
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  /** Windows: absolute path of Git Bash for `CLAUDE_CODE_GIT_BASH_PATH`; omitted when absent. */
  readonly gitBashPath?: string | undefined;
  /** Additional variables; protected names are refused (see {@link isProtectedEnvName}). */
  readonly extra?: Readonly<Record<string, string>> | undefined;
  /**
   * `allowed` drops `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` for the one
   * test that proves the trap catches the resulting egress (plan §4.5). The
   * proxy variables (the trap) stay set either way. Default `disabled`.
   */
  readonly nonessentialTraffic?: 'disabled' | 'allowed' | undefined;
}

/** Account and domain name a Windows sandbox reports instead of the real ones. */
const SANDBOX_ACCOUNT = 'hudhud-sandbox';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_SYSTEM_ROOT = /^[A-Za-z]:\\[^;"%]*[^\\;"%]$/;
const DEFAULT_WINDOWS_SYSTEM_ROOT = 'C:\\Windows';
const POSIX_PATH = '/usr/local/bin:/usr/bin:/bin';

/** Variable names the launcher always sets; the caller cannot override them. */
const PINNED_NAMES: readonly string[] = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_TMPDIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'SYSTEMDRIVE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'LOGONSERVER',
  'LANG',
  'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'NO_PROXY',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
];

/** Patterns of names that would redirect traffic, credentials or providers. */
const PROTECTED_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/i,
  /_PROXY$/i,
  /^CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)$/i,
  /^CLAUDE_CODE_SKIP_/i,
  /^AWS_/i,
  /^GOOGLE_/i,
  /^CLOUD_ML_/i,
  /^CLAUDE_CODE_OAUTH/i,
];

/**
 * Whether a caller may not set `name`: a variable the launcher pins, or one
 * that could redirect traffic, credentials or the model provider. Compared
 * case-insensitively (Windows variables are case-insensitive).
 */
export function isProtectedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return PINNED_NAMES.includes(upper) || PROTECTED_PATTERNS.some((re) => re.test(name));
}

/**
 * Validates the mock's base URL: `http://127.0.0.1:<port>` with nothing
 * else. The egress trap is the mock, so a non-loopback URL would let the
 * CLI talk to a real host.
 *
 * @returns the host part for `NO_PROXY`.
 */
export function checkMockUrl(mockUrl: string): string {
  let url: URL;
  try {
    url = new URL(mockUrl);
  } catch (error) {
    throw new SandboxRefusedError('mock', `mock URL ${JSON.stringify(mockUrl)} is not a URL`, {
      cause: error,
    });
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new SandboxRefusedError(
      'mock',
      `mock URL ${JSON.stringify(mockUrl)} must be exactly http://127.0.0.1:<port> (the mock is the egress trap)`,
    );
  }
  return url.hostname;
}

/** The Windows system directory from the host environment, validated; `C:\Windows` otherwise. */
export function windowsSystemRoot(hostEnv: Readonly<Record<string, string | undefined>>): string {
  const candidate = hostEnv['SystemRoot'] ?? hostEnv['SYSTEMROOT'] ?? '';
  return WINDOWS_SYSTEM_ROOT.test(candidate) ? candidate : DEFAULT_WINDOWS_SYSTEM_ROOT;
}

function checkExtra(extra: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(extra)) {
    if (!ENV_NAME.test(name)) {
      throw new SandboxRefusedError('unsafe-option', `env name ${JSON.stringify(name)} is invalid`);
    }
    if (isProtectedEnvName(name)) {
      throw new SandboxRefusedError(
        'unsafe-option',
        `env ${name} is pinned by the sandbox and cannot be set by a test`,
      );
    }
    if (value.includes('\0')) {
      throw new SandboxRefusedError('unsafe-option', `env ${name} contains NUL`);
    }
  }
}

/**
 * Builds the complete, explicit environment of a sandboxed CLI.
 *
 * @throws SandboxRefusedError `mock` for a non-loopback mock URL,
 *   `unsafe-option` for a refused extra variable or Git Bash path.
 */
export function buildSandboxEnv(input: SandboxEnvInput): Readonly<Record<string, string>> {
  const mockHost = checkMockUrl(input.mockUrl);
  const mock = new URL(input.mockUrl).origin;
  const extra = input.extra ?? {};
  checkExtra(extra);
  const { dirs } = input;
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: dirs.cfg,
    CLAUDE_CODE_TMPDIR: dirs.tmp,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    HOME: dirs.home,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_BASE_URL: mock,
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    HTTPS_PROXY: mock,
    HTTP_PROXY: mock,
    https_proxy: mock,
    http_proxy: mock,
    NO_PROXY: mockHost,
    no_proxy: mockHost,
  };
  if (input.nonessentialTraffic === 'allowed') {
    delete env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
  }
  if (input.platform === 'win32') {
    const root = windowsSystemRoot(input.hostEnv);
    const system32 = path.win32.join(root, 'System32');
    env['PATH'] = [system32, root, path.win32.join(system32, 'WindowsPowerShell', 'v1.0')].join(
      ';',
    );
    env['SYSTEMROOT'] = root;
    env['WINDIR'] = root;
    env['COMSPEC'] = path.win32.join(system32, 'cmd.exe');
    env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';
    env['SystemDrive'] = root.slice(0, 2);
    // libuv copies these from the host into a child environment that lacks
    // them (its list of required Windows variables), which would hand the
    // CLI the real HOMEDRIVE/HOMEPATH and account names; set them here.
    const homeDrive = path.win32.parse(dirs.home).root.replace(/\\$/, '');
    env['HOMEDRIVE'] = homeDrive;
    env['HOMEPATH'] = dirs.home.slice(homeDrive.length);
    env['USERNAME'] = SANDBOX_ACCOUNT;
    env['USERDOMAIN'] = SANDBOX_ACCOUNT;
    env['LOGONSERVER'] = `\\\\${SANDBOX_ACCOUNT}`;
    env['USERPROFILE'] = dirs.home;
    env['APPDATA'] = dirs.appData;
    env['LOCALAPPDATA'] = dirs.localAppData;
    if (input.gitBashPath !== undefined) {
      if (!path.win32.isAbsolute(input.gitBashPath) || input.gitBashPath.includes('\0')) {
        throw new SandboxRefusedError(
          'unsafe-option',
          `Git Bash path ${JSON.stringify(input.gitBashPath)} must be absolute`,
        );
      }
      env['CLAUDE_CODE_GIT_BASH_PATH'] = input.gitBashPath;
    }
  } else {
    env['PATH'] = POSIX_PATH;
    env['LANG'] = 'C.UTF-8';
  }
  return { ...env, ...extra };
}

/**
 * The default Git Bash location on Windows (`<ProgramFiles>\Git\bin\bash.exe`)
 * when `exists` confirms it; `undefined` otherwise (the minimal `PATH` has no
 * git, so the CLI needs the explicit path for its Bash tool, 05 §3).
 */
export function defaultGitBashPath(
  hostEnv: Readonly<Record<string, string | undefined>>,
  exists: (file: string) => boolean,
): string | undefined {
  const programFiles = hostEnv['ProgramFiles'] ?? hostEnv['PROGRAMFILES'] ?? '';
  const base = WINDOWS_SYSTEM_ROOT.test(programFiles) ? programFiles : 'C:\\Program Files';
  const candidate = path.win32.join(base, 'Git', 'bin', 'bash.exe');
  return exists(candidate) ? candidate : undefined;
}

/** A copy of `env` safe to log or record: the API key value is replaced. */
export function redactEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    out[name] = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(name) ? '<redacted>' : value;
  }
  return out;
}
