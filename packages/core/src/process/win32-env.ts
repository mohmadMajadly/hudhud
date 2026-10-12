/**
 * The Windows variables libuv copies from the host into a child, and the
 * environment the process layer passes so that it never does (ADR-0012 §4,
 * plan §1.7, §2.5).
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
 * @public
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
 * The environment handed to `child_process.spawn`: a null-prototype copy of
 * `env`, plus, on Windows, every name of {@link WIN32_REQUIRED_ENV_NAMES} it
 * lacks (compared ignoring case) set to `''`, so libuv copies nothing from
 * the host. The child's environment is then a function of `env` alone.
 *
 * @public
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
