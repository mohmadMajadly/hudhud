// Generates the precompiled validator module of a package (ADR-0005 §3-4).
//
// Ajv standalone code generation compiles each exported definition. The
// generated code `require`s some Ajv runtime helpers, so esbuild (no
// plugins, no network) bundles them into the module. The result is written
// as TypeScript under `// @ts-nocheck`: the bundled code is untyped, and only
// the exports at the end carry declared types, so `tsc` emits it to `dist`
// with declarations like any other source file. The module imports nothing
// at run time and contains no `eval` or `new Function`; both are asserted
// here and the no-ajv check guards the built output.

import { Ajv2020 } from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import * as esbuild from 'esbuild';

import { isPlainObject } from './compose.mjs';
import { moduleSpecifiers } from './imports.mjs';

/** @typedef {import('./compose.mjs').JsonObject} JsonObject */
/** @typedef {import('./source.mjs').ValidatorExport} ValidatorExport */

const RESULT_NAME = '__hudhudValidators';
/** Prefix of Ajv's internal name for each validator; the typed exports use the plain name. */
const RAW_PREFIX = '__ajv_';

/** Ajv options. Changing any of them changes every generated module. */
export const AJV_OPTIONS = Object.freeze({
  strict: true,
  allErrors: false,
  messages: false,
  verbose: false,
  validateFormats: false,
  // Untrusted frames: only own properties count, never inherited ones.
  ownProperties: true,
  // One function per definition, shared by every validator that refers to it.
  inlineRefs: false,
  code: { source: true, esm: true, lines: true },
});

const FORBIDDEN_CODE = [
  { pattern: /\beval\s*\(/, what: 'eval' },
  { pattern: /\bFunction\s*\(/, what: 'the Function constructor' },
];

/**
 * Wrapper appended to Ajv's code: each validator returns a result object
 * instead of setting `errors` on itself.
 *
 * @param {readonly ValidatorExport[]} validators
 * @param {readonly string[]} rawNames Ajv's function for each validator.
 * @returns {string}
 */
function wrapperSource(validators, rawNames) {
  const entries = validators
    .map((v, i) => `  ${v.name}: check(${String(rawNames[i])})`)
    .join(',\n');
  return `
function check(validate) {
  return (value) => {
    if (validate(value)) return { ok: true, value };
    const first = validate.errors[0];
    return {
      ok: false,
      issue: { instancePath: first.instancePath, schemaPath: first.schemaPath, keyword: first.keyword },
    };
  };
}

export const ${RESULT_NAME} = {
${entries},
};
`;
}

/**
 * The typed tail of the generated module.
 *
 * @param {readonly ValidatorExport[]} validators
 * @returns {string}
 */
function typedExports(validators) {
  const lines = [
    '',
    '/** Where a value first failed its schema. */',
    'export interface SchemaIssue {',
    '  /** JSON Pointer into the value. */',
    '  readonly instancePath: string;',
    '  /** JSON Pointer into the schema. */',
    '  readonly schemaPath: string;',
    '  /** The failing keyword, for example `required` or `additionalProperties`. */',
    '  readonly keyword: string;',
    '}',
    '',
    '/** Result of a generated validator. */',
    'export type SchemaCheck<T> =',
    '  | { readonly ok: true; readonly value: T }',
    '  | { readonly ok: false; readonly issue: SchemaIssue };',
  ];
  for (const v of validators) {
    lines.push(
      '',
      `/** Checks a value against \`${v.schema}#/$defs/${v.def}\`. */`,
      `export const ${v.name}: (value: unknown) => SchemaCheck<${v.type.name}> =`,
      `  ${RESULT_NAME}.${v.name};`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * `import type` lines of the generated module, sorted.
 *
 * @param {readonly ValidatorExport[]} validators
 * @returns {string}
 */
function typeImports(validators) {
  /** @type {Map<string, Set<string>>} */
  const byModule = new Map();
  for (const v of validators) {
    let names = byModule.get(v.type.from);
    if (names === undefined) {
      names = new Set();
      byModule.set(v.type.from, names);
    }
    names.add(v.type.name);
  }
  return [...byModule.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([from, names]) => `import type { ${[...names].sort().join(', ')} } from '${from}';\n`)
    .join('');
}

/**
 * @typedef {object} GenerateOptions
 * @property {string} root Repository root (esbuild's working directory).
 * @property {string} schemaIdPrefix Prefix of the in-memory `$id` of each
 *   schema, for example `urn:hudhud:core:`. Never written to a file.
 * @property {ReadonlyMap<string, JsonObject>} documents Composed schema
 *   documents by file name.
 * @property {readonly ValidatorExport[]} validators
 * @property {string} generatedFrom Human-readable origin for the header.
 */

/**
 * Generates the validator module text.
 *
 * @param {GenerateOptions} options
 * @returns {Promise<string>}
 */
export async function generateValidatorModule(options) {
  const { root, schemaIdPrefix, documents, validators, generatedFrom } = options;
  if (validators.length === 0) throw new Error(`${generatedFrom}: no validators to generate`);
  const ajv = new Ajv2020(AJV_OPTIONS);
  for (const [file, doc] of documents) ajv.addSchema({ ...doc, $id: `${schemaIdPrefix}${file}` });
  // One Ajv function per distinct definition: Ajv would emit the code of a
  // definition twice if two refs named it.
  /** @type {Map<string, string>} */
  const rawByRef = new Map();
  const rawNames = validators.map((v) => {
    const defs = documents.get(v.schema)?.['$defs'];
    if (!isPlainObject(defs) || !Object.hasOwn(defs, v.def)) {
      throw new Error(`${v.name}: ${v.schema} has no definition ${v.def}`);
    }
    const ref = `${schemaIdPrefix}${v.schema}#/$defs/${v.def}`;
    const raw = rawByRef.get(ref) ?? `${RAW_PREFIX}${String(rawByRef.size)}`;
    rawByRef.set(ref, raw);
    return raw;
  });
  const refs = Object.fromEntries([...rawByRef].map(([ref, raw]) => [raw, ref]));
  // Ajv exports each validator; the wrapper below is the only export, which
  // the shape check of the bundle confirms.
  const entry =
    standaloneCode.default(ajv, refs).replaceAll(/^export const (\w+) = /gm, 'const $1 = ') +
    wrapperSource(validators, rawNames);
  const bundled = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'validators.js', loader: 'js' },
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    target: 'es2022',
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  let body = bundled.outputFiles.map((output) => output.text).join('\n');
  const tail = `export {\n  ${RESULT_NAME}\n};\n`;
  if (!body.endsWith(tail)) throw new Error(`${generatedFrom}: unexpected esbuild output shape`);
  body = body.slice(0, -tail.length);
  // The pnpm store directory differs between machines; the module path
  // inside the package does not.
  body = body.replaceAll(/node_modules\/\.pnpm\/[^/]+\/node_modules\//g, 'node_modules/');
  const imports = moduleSpecifiers(body);
  if (imports.length > 0) {
    throw new Error(`${generatedFrom}: generated code imports ${imports.join(', ')}`);
  }
  for (const { pattern, what } of FORBIDDEN_CODE) {
    if (pattern.test(body)) throw new Error(`${generatedFrom}: generated code uses ${what}`);
  }
  const header = [
    '// @ts-nocheck',
    `// Generated by scripts/schema/build.mjs from ${generatedFrom}. Do not edit:`,
    '// `node scripts/schema/check.mjs` fails on any difference. Ajv standalone',
    '// validators with their runtime helpers bundled (ADR-0005): no run-time',
    '// dependency, no eval, no new Function. Only the typed exports at the end',
    '// are part of the module interface.',
    '',
  ].join('\n');
  return `${header}\n${typeImports(validators)}\n${body}${typedExports(validators)}`;
}
