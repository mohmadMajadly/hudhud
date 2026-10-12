// Composes a committed JSON Schema document from named definitions
// (ADR-0005, plan §1.3). Pure: no I/O.
//
// A schema source names its definitions; inside each definition, a
// sub-schema that is structurally equal to another named definition is
// written as `{"$ref": "#/$defs/<name>"}`. The TypeBox sources compose
// plain values (so `Static<>` sees the full type), and the committed schema
// still has one definition per shared type, which keeps it readable for
// other languages and lets the additive-only linter detect renamed
// definitions.

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** Keywords whose value is a map of name to sub-schema. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs']);
/** Keywords whose value is an array of sub-schemas. */
const SCHEMA_ARRAYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
/** Keywords whose value is one sub-schema (or, for some, a boolean). */
const SCHEMA_SINGLE = new Set([
  'items',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'additionalProperties',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

const DEF_NAME = /^[A-Z][A-Za-z0-9]*$/;

/**
 * @typedef {null | boolean | number | string | JsonArray | JsonObject} Json
 * @typedef {Json[]} JsonArray
 * @typedef {{ [key: string]: Json }} JsonObject
 */

/**
 * @typedef {object} PlainSchemaDocument A schema document of a schema
 *   source, with its definitions already converted to plain JSON.
 * @property {string} file
 * @property {string} title
 * @property {string} description
 * @property {string} root
 * @property {Record<string, JsonObject>} defs
 */

/**
 * @param {unknown} value
 * @returns {value is JsonObject}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON text with object keys sorted at every level, so that two values with
 * the same content compare equal regardless of key order.
 *
 * @param {Json} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The committed text of a JSON file: two-space indentation, LF, final newline.
 *
 * @param {Json} value
 * @returns {string}
 */
export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * A definition that is nothing but a `type` would be substituted for every
 * plain occurrence of that type, so it is refused.
 *
 * @param {JsonObject} schema
 * @returns {boolean}
 */
function isTrivial(schema) {
  const keys = Object.keys(schema);
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'type');
}

/**
 * Rewrites `node`, replacing every sub-schema equal to a named definition by
 * a reference to it. `node` itself is kept when `isDefinitionRoot`.
 *
 * @param {Json} node
 * @param {ReadonlyMap<string, string>} byCanonical
 * @param {boolean} isDefinitionRoot
 * @returns {Json}
 */
function hoist(node, byCanonical, isDefinitionRoot) {
  if (!isPlainObject(node)) return node;
  if (!isDefinitionRoot) {
    const name = byCanonical.get(canonicalJson(node));
    if (name !== undefined) return { $ref: `#/$defs/${name}` };
  }
  /** @type {JsonObject} */
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAPS.has(key) && isPlainObject(value)) {
      /** @type {JsonObject} */
      const map = {};
      for (const [name, sub] of Object.entries(value)) map[name] = hoist(sub, byCanonical, false);
      out[key] = map;
    } else if (SCHEMA_ARRAYS.has(key) && Array.isArray(value)) {
      out[key] = value.map((sub) => hoist(sub, byCanonical, false));
    } else if (SCHEMA_SINGLE.has(key)) {
      out[key] = hoist(value, byCanonical, false);
    } else {
      // Data keywords (`const`, `enum`, annotations) are copied verbatim.
      out[key] = value;
    }
  }
  return out;
}

/**
 * Composes the committed JSON Schema document.
 *
 * @param {PlainSchemaDocument} doc
 * @param {string} generatedFrom Human-readable origin for `$comment`.
 * @returns {JsonObject}
 */
export function composeDocument(doc, generatedFrom) {
  /** @type {Map<string, string>} */
  const byCanonical = new Map();
  for (const [name, schema] of Object.entries(doc.defs)) {
    if (!DEF_NAME.test(name)) {
      throw new Error(`${doc.file}: definition name ${JSON.stringify(name)} is not PascalCase`);
    }
    if (isTrivial(schema)) {
      throw new Error(`${doc.file}: definition ${name} is a bare type; inline it instead`);
    }
    const key = canonicalJson(schema);
    const other = byCanonical.get(key);
    if (other !== undefined) {
      throw new Error(`${doc.file}: definitions ${other} and ${name} are identical`);
    }
    byCanonical.set(key, name);
  }
  if (!Object.hasOwn(doc.defs, doc.root)) {
    throw new Error(`${doc.file}: root ${JSON.stringify(doc.root)} is not a definition`);
  }
  /** @type {JsonObject} */
  const $defs = {};
  for (const [name, schema] of Object.entries(doc.defs))
    $defs[name] = hoist(schema, byCanonical, true);
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $comment: `Generated from ${generatedFrom} by scripts/schema/build.mjs. Do not edit.`,
    title: doc.title,
    description: doc.description,
    $ref: `#/$defs/${doc.root}`,
    $defs,
  };
}
