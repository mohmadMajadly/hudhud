// check:no-ajv (ADR-0005 §4): published output must not import Ajv. The
// generated validators bundle Ajv's runtime helpers; a new schema keyword
// that made Ajv emit a helper esbuild could not inline, or a stray import in
// a source file, would surface here as an `ajv` specifier.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { isAjvSpecifier, moduleSpecifiers } from './imports.mjs';

/** Built files a consumer loads: JavaScript and declarations. */
const SCANNED = /\.(?:[cm]?js|d\.[cm]?ts)$/;

/**
 * @typedef {object} AjvImport
 * @property {string} file Path relative to the root, forward slashes.
 * @property {string} specifier
 */

/**
 * @param {string} dir
 * @returns {string[]} Files below `dir`, recursively.
 */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Scans the `dist` directory of every package below `packagesDir`.
 *
 * @param {string} root Repository root.
 * @param {string} [packagesDir] Relative to the root.
 * @returns {{ scanned: number, imports: AjvImport[] }}
 */
export function scanBuiltOutput(root, packagesDir = 'packages') {
  /** @type {AjvImport[]} */
  const imports = [];
  let scanned = 0;
  const base = path.join(root, packagesDir);
  for (const name of readdirSync(base).sort()) {
    const dist = path.join(base, name, 'dist');
    if (!existsSync(dist)) continue;
    for (const file of listFiles(dist)
      .filter((f) => SCANNED.test(f))
      .sort()) {
      scanned += 1;
      for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
        if (isAjvSpecifier(specifier)) {
          imports.push({ file: path.relative(root, file).replaceAll('\\', '/'), specifier });
        }
      }
    }
  }
  return { scanned, imports };
}
