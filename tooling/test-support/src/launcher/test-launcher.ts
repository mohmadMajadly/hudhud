/**
 * A launcher in front of the pinned CLI, for the K1 signal-target tests
 * (plan §4.4 "launcher signal target per K1", §5.8 W6-T3; 07 §4).
 *
 * @remarks
 * 07 §4 measured that whatever sits between hudhud and the binary (the npm
 * package's fallback `cli-wrapper.cjs`, a shell shim, a user's launcher)
 * makes the spawned pid differ from `initialize.pid`, and that such a
 * launcher re-raises nothing to its child. The spike's `t14-launcher.cjs`
 * had the wrapper's shape: `spawnSync(binary, argv, { stdio: 'inherit' })`.
 * {@link testLauncherSource} generates exactly that shape, with two
 * optional deviations the ladder tests need to reach the K1 branches with a
 * real process tree: lingering after the CLI exited (so the spawned process
 * outlives the CLI and snapshot S1 can lack `initialize.pid`), and ignoring
 * `SIGTERM` (so only the ladder's `SIGKILL` ends the launcher).
 *
 * The sandbox stays closed: the launcher's content is generated here from a
 * fixed template, it names only the verified pinned binary, and every
 * launch re-checks both ({@link recheckTestLauncher}: the file is unchanged
 * byte for byte and the pinned binary is unchanged since its verification).
 * A launcher is a Node.js script with a `#!` line, which only a POSIX
 * kernel executes; on Windows a launcher would have to be a native
 * executable, so {@link writeTestLauncher} refuses `win32`.
 */

import { lstatSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SandboxRefusedError } from './errors.js';
import { recheckPinnedCli } from './pinned-cli.js';
import type { VerifiedCli } from './pinned-cli.js';

/** The longest {@link TestLauncherOptions.lingerMs}: a launcher always ends by itself. */
export const MAX_LINGER_MS = 120_000;

/** How the launcher deviates from the plain `t14-launcher.cjs` shape. */
export interface TestLauncherOptions {
  /**
   * After a session run (any argv other than the version probe's
   * `--version`), keep running this long after the CLI exited, then exit
   * with the CLI's status. Integer, 0 (default) to {@link MAX_LINGER_MS}.
   */
  readonly lingerMs?: number | undefined;
  /** Ignore `SIGTERM` (default `false`): the launcher then ends only by `SIGKILL` or after lingering. */
  readonly ignoreSigterm?: boolean | undefined;
}

/** A launcher written by {@link writeTestLauncher}. */
export interface TestLauncher {
  /** Absolute path of the launcher script: the product's `binaryPath`. */
  readonly path: string;
  /** Its exact content. */
  readonly source: string;
  /** The verified pinned binary it runs. */
  readonly cli: VerifiedCli;
}

/** Inputs of {@link writeTestLauncher}. */
export interface WriteTestLauncherInput {
  /** Directory to write into (the sandbox root); created when missing. */
  readonly dir: string;
  readonly cli: VerifiedCli;
  /** The platform the launcher runs on; `win32` is refused (see the module remarks). */
  readonly platform: NodeJS.Platform;
  /** Absolute Node.js binary of the `#!` line; default `process.execPath`. */
  readonly nodePath?: string | undefined;
  readonly options?: TestLauncherOptions | undefined;
}

/** The file name of the launcher in its directory. */
export const TEST_LAUNCHER_FILE = 'claude-launcher.cjs';

function lingerOf(options: TestLauncherOptions): number {
  const linger = options.lingerMs ?? 0;
  if (!Number.isSafeInteger(linger) || linger < 0 || linger > MAX_LINGER_MS) {
    throw new SandboxRefusedError(
      'unsafe-option',
      `launcher lingerMs must be an integer from 0 to ${String(MAX_LINGER_MS)}, got ${String(linger)}`,
    );
  }
  return linger;
}

/**
 * The launcher's source (see the module remarks). Paths are embedded as
 * JSON string literals; the `#!` path must not contain a line break.
 *
 * @throws SandboxRefusedError `unsafe-option` for a relative or multi-line
 *   Node.js path or an invalid `lingerMs`.
 */
export function testLauncherSource(input: {
  readonly binaryPath: string;
  readonly nodePath: string;
  readonly options?: TestLauncherOptions | undefined;
}): string {
  const options = input.options ?? {};
  const linger = lingerOf(options);
  if (!path.posix.isAbsolute(input.nodePath) || /[\r\n]/.test(input.nodePath)) {
    throw new SandboxRefusedError(
      'unsafe-option',
      `the launcher's Node.js path must be an absolute POSIX path on one line: ${JSON.stringify(input.nodePath)}`,
    );
  }
  return [
    `#!${input.nodePath}`,
    "'use strict';",
    '// hudhud test launcher (plan §5.8 W6-T3), shaped like 07 §4 t14-launcher.cjs:',
    "// spawnSync(binary, argv, { stdio: 'inherit' }); re-raises nothing to its child.",
    "const { spawnSync } = require('node:child_process');",
    `const BINARY = ${JSON.stringify(input.binaryPath)};`,
    `const LINGER_MS = ${String(linger)};`,
    `const IGNORE_SIGTERM = ${String(options.ignoreSigterm === true)};`,
    "if (IGNORE_SIGTERM) process.on('SIGTERM', () => {});",
    'const args = process.argv.slice(2);',
    "const result = spawnSync(BINARY, args, { stdio: 'inherit' });",
    'const code = result.status === null ? 1 : result.status;',
    "if (LINGER_MS > 0 && !args.includes('--version')) setTimeout(() => process.exit(code), LINGER_MS);",
    'else process.exit(code);',
    '',
  ].join('\n');
}

/**
 * Writes a launcher for `cli` into `dir` (mode 0700).
 *
 * @throws SandboxRefusedError `unsafe-option` on `win32` or for invalid
 *   options; `binary` when the pinned binary changed since verification.
 */
export async function writeTestLauncher(input: WriteTestLauncherInput): Promise<TestLauncher> {
  if (input.platform === 'win32') {
    throw new SandboxRefusedError(
      'unsafe-option',
      'a test launcher is a #! script, which Windows does not execute; a Windows launcher would have to be a native executable',
    );
  }
  recheckPinnedCli(input.cli);
  const source = testLauncherSource({
    binaryPath: input.cli.binaryPath,
    nodePath: input.nodePath ?? process.execPath,
    options: input.options,
  });
  await mkdir(input.dir, { recursive: true });
  const file = path.join(input.dir, TEST_LAUNCHER_FILE);
  await writeFile(file, source, { mode: 0o700, flag: 'wx' });
  return Object.freeze({ path: file, source, cli: input.cli });
}

/**
 * Re-checks a launcher before a launch: still a regular file (not a link)
 * with exactly the generated content, and its pinned binary unchanged
 * since verification.
 *
 * @throws SandboxRefusedError `binary` on any deviation.
 */
export function recheckTestLauncher(launcher: TestLauncher): void {
  let content: string;
  try {
    if (!lstatSync(launcher.path).isFile()) throw new Error('not a regular file');
    content = readFileSync(launcher.path, 'utf8');
  } catch (error) {
    throw new SandboxRefusedError('binary', `${launcher.path}: not the generated launcher`, {
      cause: error,
    });
  }
  if (content !== launcher.source) {
    throw new SandboxRefusedError('binary', `${launcher.path}: changed since it was written`);
  }
  recheckPinnedCli(launcher.cli);
}
