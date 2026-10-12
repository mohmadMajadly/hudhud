// Module specifiers of a JavaScript or TypeScript file, found by the
// TypeScript scanner (`ts.preProcessFile`): static and dynamic imports,
// re-exports, `require()` calls and `/// <reference types>` directives. A
// specifier inside a string literal or a comment is not an import, so the
// `.code = 'require("ajv/...")'` strings that Ajv's bundled runtime helpers
// carry are not reported.

import ts from 'typescript';

/**
 * @param {string} text
 * @returns {string[]}
 */
export function moduleSpecifiers(text) {
  const info = ts.preProcessFile(text, true, true);
  return [...info.importedFiles, ...info.typeReferenceDirectives].map((ref) => ref.fileName);
}

/**
 * True for `ajv`, `ajv/...` and the `ajv-*` family (for example
 * `ajv-formats`).
 *
 * @param {string} specifier
 * @returns {boolean}
 */
export function isAjvSpecifier(specifier) {
  return /^ajv(?:$|[/-])/.test(specifier);
}
