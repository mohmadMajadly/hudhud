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

import { InvalidOptionsError } from '@hudhud/core';
import { ArgvError, assertNoReservedFlags, formatFlag } from '@hudhud/core/process';

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
