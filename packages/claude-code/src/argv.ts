/**
 * The single point where the Claude Code argv is built (plan §2.5,
 * ADR-0011 §3).
 *
 * @remarks
 * Every element comes from `formatFlag`: `--name` or `--name=value`, one
 * element each, so no option value can become a flag of its own whatever it
 * contains. Flag names are kebab case (`--allowed-tools`, not
 * `--allowedTools`; the CLI accepts both spellings, 01 §1.3). Always passed:
 * the stream-json flags, `--setting-sources` and `--permission-mode`
 * (ADR-0012 §2, §3), so the CLI's own defaults (project settings, `auto`)
 * are never reached by omission. `--permission-prompt-tool=stdio` only with
 * a permission handler. System prompts go through `--append-system-prompt`
 * (W1 provenance ruling); nothing goes through `initialize`.
 */

import { InvalidOptionsError } from '@hudhudjs/core';
import {
  ArgvError,
  assertNoReservedFlags,
  formatFlag,
  type ProcessPlatform,
} from '@hudhudjs/core/process';

import {
  checkSessionId,
  type EffectiveConnectOptions,
  type EffectiveSessionOptions,
} from './options.js';

/** How the session starts (plan §2.5). */
export type LaunchSpec =
  | { readonly mode: 'create'; readonly sessionId: string }
  | { readonly mode: 'resume'; readonly resumeId: string }
  | { readonly mode: 'fork'; readonly resumeId: string; readonly sessionId: string };

/**
 * Flags that `/raw` `extraArgs` may not contain (plan §2.6, L4): every flag
 * of plan §2.5 under both spellings, the bypass flag, the flag that moves the
 * project config root, and the ones that would add settings or prompts
 * around hudhud's own (`--settings`, `--system-prompt`), resume another
 * conversation (`--continue`) or change the print-mode contract (`--print`,
 * `-p`).
 */
export const RESERVED_FLAGS: readonly string[] = [
  'output-format',
  'input-format',
  'verbose',
  'setting-sources',
  'settings',
  'permission-mode',
  'session-id',
  'resume',
  'fork-session',
  'continue',
  'permission-prompt-tool',
  'allow-dangerously-skip-permissions',
  'dangerously-skip-permissions',
  'bare',
  'model',
  'max-turns',
  'include-partial-messages',
  'allowedTools',
  'disallowedTools',
  'add-dir',
  'append-system-prompt',
  'system-prompt',
  'project-config-root',
  'print',
  'p',
  'r',
  'c',
];

function flag(name: string, value?: string): string {
  try {
    return formatFlag(name, value);
  } catch (error) {
    // Validated options never get here (their strings are NUL-free and
    // well-formed); a caller that skipped validation gets the typed error.
    throw new InvalidOptionsError(`--${name} cannot be passed as argv: ${String(error)}`, {
      details: { path: name, rule: 'argv' },
      cause: error,
    });
  }
}

/**
 * Builds the CLI argv (without the executable) from validated options.
 *
 * @throws `InvalidOptionsError` for a malformed session id or a value that
 *   cannot be one argv element
 */
export function buildArgv(
  connect: Pick<EffectiveConnectOptions, 'bare'>,
  session: EffectiveSessionOptions,
  launch: LaunchSpec,
): string[] {
  const argv = [
    flag('output-format', 'stream-json'),
    flag('input-format', 'stream-json'),
    flag('verbose'),
    flag('setting-sources', session.settingSources.join(',')),
    flag('permission-mode', session.permissionMode),
  ];
  switch (launch.mode) {
    case 'create':
      argv.push(flag('session-id', checkSessionId(launch.sessionId, 'sessionId')));
      break;
    case 'resume':
      argv.push(flag('resume', checkSessionId(launch.resumeId, 'resumeId')));
      break;
    case 'fork':
      argv.push(
        flag('resume', checkSessionId(launch.resumeId, 'resumeId')),
        flag('fork-session'),
        flag('session-id', checkSessionId(launch.sessionId, 'sessionId')),
      );
      break;
  }
  if (session.permissionPrompting === 'stdio') argv.push(flag('permission-prompt-tool', 'stdio'));
  if (session.dangerouslyAllowBypassPermissions) {
    argv.push(flag('allow-dangerously-skip-permissions'));
  }
  if (connect.bare) argv.push(flag('bare'));
  const cc = session.claudeCode;
  if (cc.model !== null) argv.push(flag('model', cc.model));
  if (cc.maxTurns !== null) argv.push(flag('max-turns', String(cc.maxTurns)));
  if (cc.includePartialMessages) argv.push(flag('include-partial-messages'));
  if (cc.allowedTools.length > 0) argv.push(flag('allowed-tools', cc.allowedTools.join(',')));
  if (cc.disallowedTools.length > 0) {
    argv.push(flag('disallowed-tools', cc.disallowedTools.join(',')));
  }
  for (const dir of cc.additionalDirectories) argv.push(flag('add-dir', dir));
  if (cc.appendSystemPrompt !== null) {
    argv.push(flag('append-system-prompt', cc.appendSystemPrompt));
  }
  return argv;
}

/**
 * Longest Windows command line hudhud starts the CLI with, in UTF-16 code
 * units. `CreateProcess` refuses a command line of more than 32,767 units
 * including its terminating NUL; the margin keeps hudhud clear of that
 * boundary (lead ruling F1).
 */
export const WIN32_MAX_COMMAND_LINE = 32_000;

/**
 * One argument as libuv quotes it for `CreateProcess` (`quote_cmd_arg` in
 * `src/win/process.c`, the MSVCRT parsing rules): unchanged without space,
 * tab or quote; in quotes when it holds no quote and no backslash; else in
 * quotes with every quote escaped and the backslashes before a quote or the
 * closing quote doubled. An empty argument is `""`.
 */
export function quoteWin32Arg(arg: string): string {
  if (arg === '') return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  // Built back to front, as libuv does: a backslash is doubled while only
  // backslashes stand between it and a quote or the closing quote.
  const reversed: string[] = [];
  let quoteHit = true;
  for (let index = arg.length - 1; index >= 0; index -= 1) {
    const unit = arg.charAt(index);
    reversed.push(unit);
    if (quoteHit && unit === '\\') {
      reversed.push('\\');
    } else if (unit === '"') {
      quoteHit = true;
      reversed.push('\\');
    } else {
      quoteHit = false;
    }
  }
  return `"${reversed.reverse().join('')}"`;
}

/**
 * The command line `CreateProcess` receives for `file` and `args` from
 * Node's `child_process.spawn` (`shell: false`, no verbatim arguments): the
 * executable as argv[0], then every argument, each quoted by
 * {@link quoteWin32Arg}, separated by one space.
 */
export function win32CommandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map(quoteWin32Arg).join(' ');
}

/**
 * Refuses, before anything is spawned, a launch whose Windows command line
 * would exceed {@link WIN32_MAX_COMMAND_LINE} (long `--append-system-prompt`
 * values, many `--add-dir` entries). Nothing is checked on POSIX, where the
 * limit is the far larger `ARG_MAX` of the whole environment block.
 *
 * @throws `InvalidOptionsError` rule `command-line-too-long`, with the
 *   length and the limit in `details`
 */
export function checkCommandLine(
  file: string,
  args: readonly string[],
  platform: ProcessPlatform,
): void {
  if (platform !== 'win32') return;
  const length = win32CommandLine(file, args).length;
  if (length > WIN32_MAX_COMMAND_LINE) {
    throw new InvalidOptionsError(
      `the CLI command line would be ${String(length)} UTF-16 code units on Windows; the limit is ${String(WIN32_MAX_COMMAND_LINE)} (shorten appendSystemPrompt, additionalDirectories or the tool rules)`,
      {
        details: {
          path: 'argv',
          rule: 'command-line-too-long',
          length,
          limit: WIN32_MAX_COMMAND_LINE,
        },
      },
    );
  }
}

/**
 * Checks `/raw` `extraArgs` against {@link RESERVED_FLAGS} (plan §2.6, L4).
 *
 * @throws `InvalidOptionsError` rule `reserved-flag` (or the argv problem),
 *   `details.index` and `details.flag` naming the element
 */
export function checkExtraArgs(extraArgs: readonly string[]): void {
  try {
    assertNoReservedFlags(extraArgs, RESERVED_FLAGS);
  } catch (error) {
    if (!(error instanceof ArgvError)) throw error;
    throw new InvalidOptionsError(`raw.extraArgs: ${error.message}`, {
      details: {
        path: `raw.extraArgs[${String(error.index)}]`,
        rule: error.reason,
        ...(error.flag === undefined ? {} : { flag: error.flag }),
      },
      cause: error,
    });
  }
}
