/**
 * The unit-test guard (R8-4, ADR-0013): a unit test never runs Claude Code
 * and never uses the user's Claude configuration, whatever the code under
 * test resolves.
 *
 * @remarks
 * Installed in every worker of the `unit` project by `unit-setup.ts`:
 *
 * - Every `node:child_process` launcher (`spawn`, `spawnSync`, `execFile`,
 *   `execFileSync`, `fork`, `exec`, `execSync`) throws {@link UnitGuardError}
 *   for a command named `claude` (any case, with or without `.exe`, `.cmd`,
 *   `.bat`, `.ps1`) outside the temp directory (where tests build their own
 *   stand-ins), before anything starts. A shell command is checked by
 *   its first word as well. The ESM bindings of the module are updated
 *   (`syncBuiltinESMExports`), so `import { spawn } from 'node:child_process'`
 *   is guarded too.
 * - `CLAUDE_CONFIG_DIR` points at a directory that does not exist, so code
 *   that derives the configuration directory from the process environment
 *   finds nothing of the user's.
 *
 * Integration tests run the pinned CLI through the sandboxed launcher and
 * are not affected: the guard is not installed there.
 *
 * @packageDocumentation
 */

import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A Claude Code executable or launcher, by its file name. */
const CLAUDE_NAME = /^claude(?:\.(?:exe|cmd|bat|ps1))?$/iu;

/** Every `node:child_process` function that starts a process. */
const LAUNCHERS = [
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'fork',
  'exec',
  'execSync',
] as const;

/** Launchers whose first argument is a shell command line. */
const SHELL_LAUNCHERS: ReadonlySet<string> = new Set(['exec', 'execSync']);

/** The configuration directory the guard points `CLAUDE_CONFIG_DIR` at; it never exists. */
export const UNIT_GUARD_CONFIG_DIR: string = path.join(
  tmpdir(),
  'hudhud-unit-guard',
  'no-claude-config',
);

/** Thrown when a unit test would start Claude Code. */
export class UnitGuardError extends Error {
  override readonly name = 'UnitGuardError';
}

/**
 * A command named like Claude Code that is not a test's own stand-in: unit
 * tests build their fake CLIs (Node.js scripts named `claude`) in fresh
 * directories under the temp directory, never elsewhere, while an installed
 * Claude Code lives outside it (a bare name is a `PATH` lookup).
 */
function isClaudeName(file: string): boolean {
  const unquoted = file.replace(/^["']|["']$/gu, '');
  // win32 basename splits on both separators.
  if (!CLAUDE_NAME.test(path.win32.basename(unquoted))) return false;
  return !insideTemp(unquoted);
}

/** Under the temp directory (compared without case: on POSIX that only widens the stand-in room). */
function insideTemp(file: string): boolean {
  const root = `${path.resolve(tmpdir())}${path.sep}`.toLowerCase();
  return path.isAbsolute(file) && path.resolve(file).toLowerCase().startsWith(root);
}

/**
 * Whether a launcher call would start Claude Code: the command's file name,
 * and for a shell command line also its first word.
 */
export function startsClaude(command: unknown, shell: boolean): boolean {
  if (typeof command !== 'string') return false;
  if (isClaudeName(command)) return true;
  return shell && isClaudeName(command.trim().split(/\s+/u, 1).join(''));
}

/** Whether the arguments after the command hold options that ask for a shell. */
export function shellOption(args: readonly unknown[]): boolean {
  return args.some(
    (arg) =>
      typeof arg === 'object' &&
      arg !== null &&
      !Array.isArray(arg) &&
      Boolean((arg as { readonly shell?: unknown }).shell),
  );
}

let installed = false;
const refusals: string[] = [];

/**
 * The refusals since the last call, and forgets them. The setup file fails
 * every test that caused one, so a refusal that the code under test caught
 * (a probe reports a spawn error) still fails loudly.
 */
export function takeRefusals(): string[] {
  return refusals.splice(0);
}

/** Throws (and forgets them) when the guard refused anything since the last check. */
export function assertNoRefusals(): void {
  const refused = takeRefusals();
  if (refused.length > 0) throw new UnitGuardError(refused.join('\n'));
}

/**
 * Installs the guard (see the module remarks) on `node:child_process` and
 * `env`. Idempotent.
 */
export function installUnitGuard(env: NodeJS.ProcessEnv = process.env): void {
  env['CLAUDE_CONFIG_DIR'] = UNIT_GUARD_CONFIG_DIR;
  if (installed) return;
  installed = true;
  // The builtin's CommonJS exports object; its ESM bindings follow below.
  const module: Record<string, unknown> = childProcess;
  for (const name of LAUNCHERS) {
    const original = module[name] as (...args: unknown[]) => unknown;
    module[name] = function guarded(this: unknown, ...args: unknown[]): unknown {
      const [command, ...rest] = args;
      if (startsClaude(command, SHELL_LAUNCHERS.has(name) || shellOption(rest))) {
        const message = `unit tests never run Claude Code: ${name}(${JSON.stringify(command)}) was refused (ADR-0013, R8-4)`;
        refusals.push(message);
        throw new UnitGuardError(message);
      }
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}
