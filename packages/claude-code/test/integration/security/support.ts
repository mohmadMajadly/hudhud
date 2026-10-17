// Helpers of the security-defaults suites (W6-T4, plan §4.4, §5.8). Every
// file and directory they make lies inside the test's sandbox; nothing here
// starts a CLI: it runs only through the harness (`testConnect`). On
// Windows the probe reads the CLI's command line through test-support's host
// process table (one CIM query by the host's PowerShell, as the leak tracker
// reads it every second).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  HudhudEvent,
  JsonObject,
  PermissionHandler,
  SecurityPostureEntry,
  Session,
} from '@hudhudjs/core';

import { hostProcessTable } from '../../../../../tooling/test-support/src/leaks/process-table.js';
import type { MockServer } from '../../../../../tooling/test-support/src/mock/server.js';

/** Base64 of a UTF-8 string, for the mock's scenario arguments. */
export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Allows every tool call (the probe's Bash tool). */
export const allowAll: PermissionHandler = () => Promise.resolve({ behavior: 'allow' });

/** Every event of a session, collected until it ends. */
export interface Collected {
  readonly events: HudhudEvent[];
  /** Resolves when the session's event stream ended. */
  readonly done: Promise<void>;
}

/** Subscribes to every event of `session` (replayed diagnostics included). */
export function collect(session: Session): Collected {
  const events: HudhudEvent[] = [];
  const done = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  return { events, done };
}

/** The `data` of every diagnostic with `code`. */
export function diagnostics(events: readonly HudhudEvent[], code: string): JsonObject[] {
  const found: JsonObject[] = [];
  for (const event of events) {
    if (event.type !== 'diagnostic' || !('code' in event) || event.code !== code) continue;
    const data: unknown = 'data' in event ? event.data : undefined;
    found.push(typeof data === 'object' && data !== null ? (data as JsonObject) : {});
  }
  return found;
}

/**
 * The entries of the session's one `security.posture` diagnostic.
 *
 * @throws Error unless exactly one was published
 */
export function postureOf(events: readonly HudhudEvent[]): readonly SecurityPostureEntry[] {
  const published = diagnostics(events, 'security.posture');
  if (published.length !== 1) {
    throw new Error(`expected one security.posture diagnostic, got ${String(published.length)}`);
  }
  const entries: unknown = published[0]?.['entries'];
  if (!Array.isArray(entries)) throw new Error('security.posture without entries');
  return entries as readonly SecurityPostureEntry[];
}

/** The posture entry of `setting`. */
export function postureEntry(
  entries: readonly SecurityPostureEntry[],
  setting: string,
): SecurityPostureEntry | undefined {
  return entries.find((entry) => entry.setting === setting);
}

/** The `raw` frame of the first event of `type` (for example `system/init` of `turn.started`). */
export function rawOf(events: readonly HudhudEvent[], type: string): unknown {
  const event = events.find((candidate) => candidate.type === type);
  return event !== undefined && 'raw' in event ? event.raw : undefined;
}

/** Captured requests of `mock` whose body carries `marker` (the turn requests of a scenario). */
export function requestsWith(mock: MockServer, marker: string): MockServer['requests'] {
  return mock.requests.filter((request) => JSON.stringify(request.body).includes(marker));
}

/** Writes `value` as JSON to `file`, creating its directory. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Writes `<dir>/.claude/<name>` with the given `env`. */
export function writeSettings(
  dir: string,
  name: 'settings.json' | 'settings.local.json',
  env: Readonly<Record<string, string>>,
): string {
  const file = path.join(dir, '.claude', name);
  writeJson(file, { env });
  return file;
}

/**
 * A repository laid out as git writes it, without running git (08 §1: the
 * CLI and the guard both find the root by a filesystem walk).
 */
export function makeRepo(root: string): void {
  const git = path.join(root, '.git');
  mkdirSync(path.join(git, 'objects'), { recursive: true });
  mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(
    path.join(git, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n',
  );
}

/**
 * A linked worktree `worktree` of the repository at `main`, as `git worktree
 * add` writes it (08 §1): `main/.git/worktrees/<name>/{HEAD,commondir,gitdir}`
 * and a `.git` file in the worktree.
 */
export function makeLinkedWorktree(main: string, worktree: string): void {
  makeRepo(main);
  const name = path.basename(worktree);
  const admin = path.join(main, '.git', 'worktrees', name);
  mkdirSync(admin, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/wt\n');
  writeFileSync(path.join(admin, 'commondir'), '../..\n');
  // git writes forward slashes on every OS.
  const slashed = (file: string): string => file.split(path.sep).join('/');
  writeFileSync(path.join(admin, 'gitdir'), `${slashed(path.join(worktree, '.git'))}\n`);
  writeFileSync(path.join(worktree, '.git'), `gitdir: ${slashed(admin)}\n`);
}

/** What the probe tool call saw of the CLI process. */
export interface ChildProbe {
  /** `CLAUDE_PID` as the CLI exports it to its tools. */
  readonly pid: number;
  /**
   * Linux: the CLI's own argv (`/proc/<pid>/cmdline`, binary first).
   * Windows and macOS: `undefined`, see {@link ChildProbe.commandLine}.
   */
  readonly argv: readonly string[] | undefined;
  /**
   * Windows: the CLI's command line (`Win32_Process.CommandLine`, quoted
   * as libuv quotes it). macOS: its argv joined by single spaces, unquoted
   * (`ps -ww -o args=`; macOS has no `/proc`).
   */
  readonly commandLine: string | undefined;
  /**
   * Linux: the CLI's own environment (`/proc/<pid>/environ`, exact).
   * Windows: the Bash tool's environment, which is the CLI's plus what the
   * CLI and Git Bash add for tools (names folded to upper case). macOS: the
   * Bash tool's environment (`env`), the CLI's plus what the CLI and the
   * shell add for tools: `ps -E` prints another process's environment
   * only joined by spaces, which values with spaces make ambiguous.
   */
  readonly env: ReadonlyMap<string, string>;
  /** Whether {@link ChildProbe.env} is the CLI's exact environment. */
  readonly exactEnv: boolean;
  /** Whether {@link ChildProbe.commandLine} quotes arguments with spaces (Windows). */
  readonly quotedCommandLine: boolean;
}

/**
 * The Bash command of the probe tool call (see {@link probeChild}). Linux:
 * pid, argv and environment from `/proc`. macOS: pid, the argv joined by
 * `ps` and the tool's environment. Windows: pid and the tool's environment
 * only; the command line is read from outside the sandbox.
 *
 * @remarks
 * Windows used to run `powershell.exe ... Get-CimInstance Win32_Process`
 * inside the tool, that is under the sandbox's fresh profile directories:
 * on the GitHub windows-2025 runner both tests that probe took 56.9 and
 * 61.8 s (CI run 38984419589, the second past the 60 s hang guard) against
 * 4.3 s on the W7-T1 host, while every other Windows test, Bash tools
 * included, stayed within a few seconds of its local time (W7-T1, plan
 * §5.9). The host's table read (the leak tracker's, every second on CI)
 * reads the same `Win32_Process.CommandLine`.
 */
export function probeCommand(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return ['echo "$CLAUDE_PID" > probe-pid.txt', 'env > probe-env.txt'].join('; ');
  }
  if (platform === 'darwin') {
    // No /proc on macOS (integration evidence run 38967893191, research 11):
    // the redirection from /proc failed, so the tool wrote no argv file.
    return [
      'echo "$CLAUDE_PID" > probe-pid.txt',
      '/bin/ps -ww -o args= -p "$CLAUDE_PID" > probe-argv.txt',
      'env > probe-env.txt',
    ].join('; ');
  }
  return [
    'echo "$CLAUDE_PID" > probe-pid.txt',
    "tr '\\0' '\\n' < /proc/$CLAUDE_PID/cmdline > probe-argv.txt",
    "tr '\\0' '\\n' < /proc/$CLAUDE_PID/environ > probe-env.txt",
  ].join('; ');
}

/**
 * The Windows command line of the live process `pid`
 * (`Win32_Process.CommandLine`, one read of the host process table).
 *
 * @throws Error when the table lists no such process.
 */
async function windowsCommandLine(pid: number): Promise<string> {
  const rows = await hostProcessTable('win32', process.env).read();
  const row = rows.find((candidate) => candidate.pid === pid);
  if (row === undefined) throw new Error(`the process table lists no process ${String(pid)}`);
  return row.commandLine.trim();
}

/**
 * Runs one turn in which the mock makes the CLI call its Bash tool with
 * {@link probeCommand}; the tool writes the CLI's pid, argv (Linux and
 * macOS) and environment into files in the session's cwd (inside the sandbox), and
 * nothing of them goes back to the mock. On Windows the CLI's command line
 * is then read from the host process table while the session is still
 * open. The session needs permission for the Bash tool (`onPermission` or
 * `claudeCode.allowedTools`).
 */
export async function probeChild(
  session: Session,
  cwd: string,
  platform: NodeJS.Platform,
): Promise<ChildProbe> {
  const result = await session.ask(`[[mock:bash cmd=${b64(probeCommand(platform))}]] probe`);
  if (result.isError || result.outcome !== 'completed') {
    throw new Error(`the probe turn did not complete: ${result.outcome}`);
  }
  const read = (name: string): string => readFileSync(path.join(cwd, name), 'utf8');
  const pid = Number(read('probe-pid.txt').trim());
  const lines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line !== '');
  const env = new Map<string, string>();
  for (const line of lines(read('probe-env.txt'))) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    env.set(platform === 'win32' ? name.toUpperCase() : name, line.slice(eq + 1));
  }
  const exact = platform !== 'win32' && platform !== 'darwin';
  return {
    pid,
    argv: exact ? lines(read('probe-argv.txt')) : undefined,
    commandLine:
      platform === 'win32'
        ? await windowsCommandLine(pid)
        : exact
          ? undefined
          : read('probe-argv.txt').trim(),
    env,
    exactEnv: exact,
    quotedCommandLine: platform === 'win32',
  };
}

/** A command-line element as libuv quotes it for paths without quotes (02 §2.4). */
function quoteSimple(arg: string): string {
  return /[ \t]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * The argv the probe observed, as one comparable list: Linux the real argv,
 * Windows and macOS the command line split back (every element hudhud
 * passes is `--flag=value` without spaces; on Windows the binary path is
 * quoted when it holds a space, on macOS nothing is quoted, so the binary
 * path must be the exact prefix).
 */
export function observedArgv(probe: ChildProbe, binaryPath: string): readonly string[] {
  if (probe.argv !== undefined) return probe.argv;
  const line = probe.commandLine ?? '';
  const head = probe.quotedCommandLine ? quoteSimple(binaryPath) : binaryPath;
  const fold = (text: string): string => (probe.quotedCommandLine ? text.toLowerCase() : text);
  if (!fold(line).startsWith(`${fold(head)} `)) {
    throw new Error(`the command line does not start with the pinned binary: ${line}`);
  }
  return [binaryPath, ...line.slice(head.length + 1).split(' ')];
}

/** The value of `name` in the probed environment, compared as the OS compares names. */
export function envValue(
  probe: ChildProbe,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  return probe.env.get(platform === 'win32' ? name.toUpperCase() : name);
}
