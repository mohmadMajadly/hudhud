// The schema pipeline (ADR-0005, plan §1.3): TypeBox sources -> committed
// JSON Schema -> precompiled validators. Shared tooling; each package owns
// its schema entries (K3).
//
// `buildOutputs` produces every generated file in memory; `writeOutputs`
// writes them (schema:build) and `compareOutputs` diffs them against the
// working tree (schema:check), so the check regenerates from scratch and
// never trusts the committed files.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { composeDocument, serializeJson } from './compose.mjs';
import { loadSchemaSource } from './source.mjs';
import { generateValidatorModule } from './validators.mjs';

/**
 * @typedef {object} Pipeline One schema entry of a package.
 * @property {string} packageDir Package directory, relative to the root,
 *   forward slashes.
 * @property {string} schemaId Short package id for in-memory schema ids.
 * @property {string} entry Schema entry, relative to the package.
 * @property {string} validators Generated validator module, relative to the
 *   package.
 */

/** @type {readonly Pipeline[]} */
export const PIPELINES = Object.freeze([
  {
    packageDir: 'packages/core',
    schemaId: 'core',
    entry: 'schema-src/index.ts',
    validators: 'src/protocol/generated/validators.gen.ts',
  },
  {
    packageDir: 'packages/claude-code',
    schemaId: 'claude-code',
    entry: 'schema-src/wire.ts',
    validators: 'src/protocol/generated/validators.gen.ts',
  },
  {
    packageDir: 'packages/claude-code',
    schemaId: 'claude-code-options',
    entry: 'schema-src/options.ts',
    validators: 'src/generated/validators.gen.ts',
  },
]);

/** Directory of the committed schemas inside a package. */
export const SCHEMAS_DIR = 'schemas';

/**
 * Builds every generated file of the given pipelines.
 *
 * @param {string} root Repository root.
 * @param {readonly Pipeline[]} [pipelines]
 * @returns {Promise<Map<string, string>>} Content by path relative to the
 *   root, forward slashes.
 */
export async function buildOutputs(root, pipelines = PIPELINES) {
  /** @type {Map<string, string>} */
  const outputs = new Map();
  /**
   * @param {string} file
   * @param {string} content
   */
  const add = (file, content) => {
    if (outputs.has(file)) throw new Error(`${file} is generated twice`);
    outputs.set(file, content);
  };
  for (const pipeline of pipelines) {
    const entry = `${pipeline.packageDir}/${pipeline.entry}`;
    const source = await loadSchemaSource(root, entry);
    /** @type {Map<string, import('./compose.mjs').JsonObject>} */
    const documents = new Map();
    for (const doc of source.documents) {
      const composed = composeDocument(doc, entry);
      documents.set(doc.file, composed);
      add(`${pipeline.packageDir}/${SCHEMAS_DIR}/${doc.file}`, serializeJson(composed));
    }
    for (const doc of source.data) {
      add(`${pipeline.packageDir}/${SCHEMAS_DIR}/${doc.file}`, serializeJson(doc.json));
    }
    add(
      `${pipeline.packageDir}/${pipeline.validators}`,
      await generateValidatorModule({
        root,
        schemaIdPrefix: `urn:hudhud:${pipeline.schemaId}:`,
        documents,
        validators: source.validators,
        generatedFrom: entry,
      }),
    );
  }
  return outputs;
}

/**
 * Writes the outputs below `root`.
 *
 * @param {string} root
 * @param {ReadonlyMap<string, string>} outputs
 * @returns {string[]} Paths whose content changed.
 */
export function writeOutputs(root, outputs) {
  /** @type {string[]} */
  const changed = [];
  for (const [file, content] of outputs) {
    const target = path.join(root, file);
    if (existsSync(target) && readFileSync(target, 'utf8') === content) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    changed.push(file);
  }
  return changed;
}

/**
 * First differing line, 1-based.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function firstDifferentLine(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  let line = 0;
  while (left[line] === right[line]) line += 1;
  return line + 1;
}

/**
 * Compares the outputs with the working tree. Also reports committed schema
 * files that no source produces any more.
 *
 * @param {string} root
 * @param {ReadonlyMap<string, string>} outputs
 * @param {readonly Pipeline[]} [pipelines]
 * @returns {string[]} Problems, empty when the tree is up to date.
 */
export function compareOutputs(root, outputs, pipelines = PIPELINES) {
  /** @type {string[]} */
  const problems = [];
  for (const [file, content] of outputs) {
    const target = path.join(root, file);
    if (!existsSync(target)) {
      problems.push(`${file}: missing`);
      continue;
    }
    const actual = readFileSync(target, 'utf8');
    if (actual !== content) {
      problems.push(
        `${file}: differs from its sources (line ${String(firstDifferentLine(actual, content))})`,
      );
    }
  }
  for (const packageDir of new Set(pipelines.map((p) => p.packageDir))) {
    const dir = path.join(root, packageDir, SCHEMAS_DIR);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = `${packageDir}/${SCHEMAS_DIR}/${entry.name}`;
      if (entry.isFile() && !outputs.has(file))
        problems.push(`${file}: not produced by any source`);
    }
  }
  return problems;
}
