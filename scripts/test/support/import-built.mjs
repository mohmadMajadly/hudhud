// Test support: imports package specifiers with Node's own resolver in a
// fresh process, so the `exports` map and the built output are exercised
// exactly as a consumer sees them (no Vite/Vitest resolution involved).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {object} ImportSuccess
 * @property {true} ok
 * @property {string} file Resolved file, relative to the importing directory, forward slashes.
 * @property {Record<string, unknown>} exports The module namespace as JSON
 *   (functions and classes are dropped by JSON; see `names`).
 * @property {string[]} names Every export name of the module, sorted.
 */

/**
 * @typedef {object} ImportFailure
 * @property {false} ok
 * @property {string} code Node error code, for example ERR_PACKAGE_PATH_NOT_EXPORTED.
 */

/** @typedef {ImportSuccess | ImportFailure} ImportResult */

const CHILD = `
const specifiers = JSON.parse(process.env.HUDHUD_IMPORT_SPECIFIERS);
const results = {};
for (const specifier of specifiers) {
  try {
    const url = import.meta.resolve(specifier);
    const namespace = await import(specifier);
    results[specifier] = { ok: true, url, exports: { ...namespace }, names: Object.keys(namespace).sort() };
  } catch (error) {
    results[specifier] = { ok: false, code: String(error?.code ?? error) };
  }
}
process.stdout.write(JSON.stringify(results));
`;

/**
 * Imports each specifier from `fromDir` in a child Node process.
 *
 * @param {string} fromDir Directory the imports are resolved from (a package
 *   directory resolves its own name through package self-reference).
 * @param {readonly string[]} specifiers
 * @returns {Record<string, ImportResult>}
 */
export function importBuilt(fromDir, specifiers) {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', CHILD], {
    cwd: fromDir,
    encoding: 'utf8',
    env: { ...process.env, HUDHUD_IMPORT_SPECIFIERS: JSON.stringify(specifiers) },
  });
  /** @type {unknown} */
  const raw = JSON.parse(stdout);
  if (typeof raw !== 'object' || raw === null) throw new Error('unexpected child output');
  /** @type {Record<string, ImportResult>} */
  const results = {};
  for (const [specifier, entry] of Object.entries(raw)) {
    /** @type {unknown} */
    const url = Reflect.get(entry, 'url');
    /** @type {unknown} */
    const namespace = Reflect.get(entry, 'exports');
    /** @type {unknown} */
    const names = Reflect.get(entry, 'names');
    /** @type {unknown} */
    const code = Reflect.get(entry, 'code');
    results[specifier] =
      typeof url === 'string' &&
      typeof namespace === 'object' &&
      namespace !== null &&
      Array.isArray(names)
        ? {
            ok: true,
            file: path.relative(fromDir, fileURLToPath(url)).split(path.sep).join('/'),
            exports: { ...namespace },
            names: names.map(String),
          }
        : { ok: false, code: typeof code === 'string' ? code : 'unknown' };
  }
  return results;
}
