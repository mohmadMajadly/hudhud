/**
 * The Windows variables libuv copies from the host into a child, and the
 * environment the process layer passes so that it never does (ADR-0012 §4,
 * plan §1.7, §2.5); plus the variables a macOS child sets itself at start.
 *
 * @packageDocumentation
 */

import type { ProcessPlatform } from './cwd.js';

/**
 * The variables libuv's Windows process creation copies from the host into
 * a child's environment when the given map lacks them (`required_vars` in
 * libuv `src/win/process.c`; measured with Node 24). The process layer
 * never lets that happen: {@link childEnv} passes each of them the map
 * lacks as an empty string, and `spawnHarnessProcess` refuses a map without
 * a non-empty `SYSTEMROOT`, the one variable a child cannot run without.
 * Adapters use the same list to report what the child really receives.
 *
 * @beta
 */
export const WIN32_REQUIRED_ENV_NAMES: readonly string[] = Object.freeze([
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);

/**
 * The variables a macOS child can show although the map lacked them and
 * neither spawn nor libuv passed them: the child sets them itself at start.
 * The process layer passes nothing for them and cannot keep them out.
 *
 * - `__CF_USER_TEXT_ENCODING`: CoreFoundation, loaded by any child linked
 *   against it (Node.js is), computes the user's default text encoding at
 *   initialization. When the variable is missing, or names another uid, it
 *   reads `.CFUserTextEncoding` in the home of the account database entry of
 *   `getuid()` and calls `setenv` with `0x<uid>:0x<script>:0x<region>` (hex;
 *   CoreFoundation `_CFStringGetUserDefaultEncoding`). The value names the
 *   uid and a text encoding, no secret and nothing from the host
 *   environment. Passing a value with the right uid would only replace
 *   CoreFoundation's value with a host-derived one (the variable stays
 *   present either way), so hudhud does not pass one.
 *
 * Tests of the exact child environment allow exactly these names on macOS
 * (and verify that the value is not the host's); adapters that report what
 * the child receives name them as set by the child.
 *
 * @beta
 */
export const DARWIN_CHILD_SET_ENV_NAMES: readonly string[] = Object.freeze([
  '__CF_USER_TEXT_ENCODING',
]);

/**
 * The environment handed to `child_process.spawn`: a null-prototype copy of
 * `env`, plus, on Windows, every name of {@link WIN32_REQUIRED_ENV_NAMES} it
 * lacks (compared ignoring case) set to `''`, so libuv copies nothing from
 * the host. The child's environment is then a function of `env` alone.
 *
 * @beta
 */
export function childEnv(
  env: Readonly<Record<string, string>>,
  platform: ProcessPlatform,
): Record<string, string> {
  const copy = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(env)) copy[name] = value;
  if (platform === 'win32') {
    const present = new Set(Object.keys(env).map((name) => name.toUpperCase()));
    for (const name of WIN32_REQUIRED_ENV_NAMES) if (!present.has(name)) copy[name] = '';
  }
  return copy;
}
