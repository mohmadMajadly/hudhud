// Loads a package's TypeBox schema entry (build time only, ADR-0005).
//
// The entry is TypeScript and imports TypeBox, so it is bundled with esbuild
// (no plugins, no network) into a temporary ES module, imported once and
// deleted. The `schemaSource` export is then checked and converted to plain
// JSON: TypeBox keeps its own markers in non-enumerable properties, which the
// conversion drops.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

import { isPlainObject } from './compose.mjs';

/** @typedef {import('./compose.mjs').Json} Json */
/** @typedef {import('./compose.mjs').JsonObject} JsonObject */
/** @typedef {import('./compose.mjs').PlainSchemaDocument} PlainSchemaDocument */

/**
 * @typedef {object} DataDocument
 * @property {string} file
 * @property {JsonObject} json
 */

/**
 * @typedef {object} ValidatorExport
 * @property {string} name
 * @property {string} schema
 * @property {string} def
 * @property {{ from: string, name: string }} type
 */

/**
 * @typedef {object} PlainSchemaSource
 * @property {PlainSchemaDocument[]} documents
 * @property {DataDocument[]} data
 * @property {ValidatorExport[]} validators
 */

const FILE_NAME = /^[a-z][a-z0-9-]*(\.schema)?\.json$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RELATIVE_MODULE = /^\.\.?\/[A-Za-z0-9_./-]+\.js$/;

/**
 * @param {unknown} value
 * @returns {Json}
 */
function toJson(value) {
  /** @type {unknown} */
  const json = JSON.parse(JSON.stringify(value));
  return /** @type {Json} */ (json);
}

/**
 * @param {JsonObject} obj
 * @param {string} key
 * @param {RegExp | undefined} pattern
 * @param {string} where
 * @returns {string}
 */
function stringField(obj, key, pattern, where) {
  const value = obj[key];
  if (
    typeof value !== 'string' ||
    value === '' ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new Error(`${where}: "${key}" must be a valid non-empty string`);
  }
  return value;
}

/**
 * @param {JsonObject} obj
 * @param {string} key
 * @param {string} where
 * @returns {JsonObject[]}
 */
function objectArray(obj, key, where) {
  const value = obj[key];
  if (!Array.isArray(value) || !value.every(isPlainObject)) {
    throw new Error(`${where}: "${key}" must be an array of objects`);
  }
  return value;
}

/**
 * @param {JsonObject} obj
 * @param {string} key
 * @param {string} where
 * @returns {JsonObject}
 */
function objectField(obj, key, where) {
  const value = obj[key];
  if (!isPlainObject(value)) throw new Error(`${where}: "${key}" must be an object`);
  return value;
}

/**
 * Checks the `schemaSource` export of a schema entry and returns it as plain
 * JSON.
 *
 * @param {unknown} namespace The entry's module namespace.
 * @param {string} where Entry path, for messages.
 * @returns {PlainSchemaSource}
 */
export function parseSchemaSource(namespace, where) {
  const exports = toJson(namespace);
  const source = isPlainObject(exports) ? exports['schemaSource'] : undefined;
  if (!isPlainObject(source)) throw new Error(`${where}: export "schemaSource" must be an object`);
  const documents = objectArray(source, 'documents', where).map((doc) => {
    /** @type {Record<string, JsonObject>} */
    const defs = {};
    for (const [name, def] of Object.entries(objectField(doc, 'defs', where))) {
      if (!isPlainObject(def)) throw new Error(`${where}: definition ${name} must be an object`);
      defs[name] = def;
    }
    return {
      file: stringField(doc, 'file', FILE_NAME, where),
      title: stringField(doc, 'title', undefined, where),
      description: stringField(doc, 'description', undefined, where),
      root: stringField(doc, 'root', undefined, where),
      defs,
    };
  });
  const data = objectArray(source, 'data', where).map((doc) => ({
    file: stringField(doc, 'file', FILE_NAME, where),
    json: objectField(doc, 'json', where),
  }));
  const validators = objectArray(source, 'validators', where).map((v) => {
    const type = objectField(v, 'type', where);
    return {
      name: stringField(v, 'name', IDENTIFIER, where),
      schema: stringField(v, 'schema', FILE_NAME, where),
      def: stringField(v, 'def', undefined, where),
      type: {
        from: stringField(type, 'from', RELATIVE_MODULE, where),
        name: stringField(type, 'name', IDENTIFIER, where),
      },
    };
  });
  return { documents, data, validators };
}

/**
 * Bundles and imports a schema entry and returns its checked `schemaSource`.
 *
 * @param {string} root Repository root (esbuild's working directory).
 * @param {string} entry Entry file, relative to `root`.
 * @returns {Promise<PlainSchemaSource>}
 */
export async function loadSchemaSource(root, entry) {
  const result = await esbuild.build({
    entryPoints: [path.join(root, entry)],
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  });
  // One entry point without code splitting yields exactly one output file.
  const text = result.outputFiles.map((output) => output.text).join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'hudhud-schema-'));
  try {
    const file = path.join(dir, 'schema-source.mjs');
    writeFileSync(file, text);
    /** @type {unknown} */
    const namespace = await import(pathToFileURL(file).href);
    return parseSchemaSource(namespace, entry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
