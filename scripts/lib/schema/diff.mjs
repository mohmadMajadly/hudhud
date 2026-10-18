// Additive-only linter for the committed JSON Schemas (ADR-0005 §5, plan
// §1.3). Compares each package's `schemas/` with `schemas/.baseline/` (the
// last released copy) and reports every change that could make a value
// valid under the baseline invalid now: removed schemas, definitions or
// properties; narrowed types, enums, constants and numeric or length
// limits; new `required` entries; `additionalProperties` closed or
// constrained; removed union arms; added constraints. New optional
// properties, new definitions, new union arms and widened limits pass.
// Definitions and properties whose name starts with `x-` are experimental
// and exempt (ADR-0005 §6).
//
// Schemas that applications and other languages read (every schema except
// those in WIDENING_ALLOWED) also fail when a closed enum is widened: a new
// value of a closed enum, a closed enum opened to any string, or a closed
// enum dropped. A reader that switches exhaustively over a closed enum, or a
// closed enum generated in another language, breaks on the new value. The
// known values of an open enum (an `anyOf` of an `enum` and `{ type:
// 'string' }`) may grow (ADR-0005 §6).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson, isPlainObject } from './compose.mjs';

/** @typedef {import('./compose.mjs').Json} Json */
/** @typedef {import('./compose.mjs').JsonObject} JsonObject */

/**
 * @typedef {object} Violation
 * @property {string} file
 * @property {string} pointer JSON Pointer into the baseline schema.
 * @property {string} kind
 * @property {string} detail
 */

export const BASELINE_DIR = '.baseline';

/**
 * Committed schemas whose values only flow into hudhud or between hudhud
 * and its harness, never to an application: there a widened enum is
 * additive. The options are written by applications and read by hudhud; the
 * Claude Code wire schemas describe the CLI's frames (read leniently, ADR-0005
 * §7) and the frames hudhud writes to it. Every other schema is read by
 * applications or other languages, where widening a closed enum breaks
 * readers; a schema missing from this list counts as such (fail closed).
 */
export const WIDENING_ALLOWED = new Set([
  'packages/claude-code/schemas/options.schema.json',
  'packages/claude-code/schemas/wire-inbound.schema.json',
  'packages/claude-code/schemas/wire-outbound.schema.json',
]);

const LOWER_LIMITS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'];
const UPPER_LIMITS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'];
const EXACT_CONSTRAINTS = ['pattern', 'multipleOf', 'uniqueItems', 'allOf', 'dependentRequired'];
const SUB_SCHEMAS = [
  'items',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const UNIONS = ['anyOf', 'oneOf'];

/**
 * @param {string} name
 * @returns {boolean}
 */
const isExperimental = (name) => name.startsWith('x-');

/**
 * @param {string} token
 * @returns {string}
 */
const escapePointer = (token) => token.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * Normalizes a schema position: absent or `true` accepts everything, `false`
 * nothing.
 *
 * @param {Json | undefined} schema
 * @returns {JsonObject | false}
 */
function normalize(schema) {
  if (schema === false) return false;
  return isPlainObject(schema) ? schema : {};
}

/**
 * The values a closed `enum` or `const` allows, or `undefined` when the
 * schema has neither.
 *
 * @param {JsonObject} schema
 * @returns {Json[] | undefined}
 */
function closedValues(schema) {
  if (schema['const'] !== undefined) return [schema['const']];
  const values = schema['enum'];
  return Array.isArray(values) ? values : undefined;
}

/**
 * Whether a schema is an open enum: an `anyOf` with an `enum` arm of known
 * values and an arm that accepts every string.
 *
 * @param {JsonObject} schema
 * @returns {boolean}
 */
function isOpenEnum(schema) {
  const arms = schema['anyOf'];
  return (
    Array.isArray(arms) &&
    arms.some((arm) => isPlainObject(arm) && Array.isArray(arm['enum'])) &&
    arms.some((arm) => canonicalJson(arm) === canonicalJson({ type: 'string' }))
  );
}

/**
 * @param {readonly Json[]} values
 * @returns {string}
 */
function listValues(values) {
  return values.map((v) => JSON.stringify(v)).join(', ');
}

/**
 * @param {Json | undefined} type
 * @returns {string[] | undefined}
 */
function typeList(type) {
  if (type === undefined) return undefined;
  return (Array.isArray(type) ? type : [type]).map(String);
}

/**
 * Comparison of one baseline document with its current version.
 */
class SchemaComparison {
  /**
   * @param {string} file
   * @param {JsonObject} baseline
   * @param {JsonObject} current
   * @param {boolean} wideningAllowed Whether a widened closed enum is additive.
   */
  constructor(file, baseline, current, wideningAllowed) {
    this.file = file;
    this.wideningAllowed = wideningAllowed;
    /** @type {JsonObject} */
    this.baseDefs = normalizeDefs(baseline['$defs']);
    /** @type {JsonObject} */
    this.currentDefs = normalizeDefs(current['$defs']);
    /** @type {Violation[]} */
    this.violations = [];
    /** @type {Set<string>} */
    this.visiting = new Set();
  }

  /**
   * @param {string} pointer
   * @param {string} kind
   * @param {string} detail
   */
  report(pointer, kind, detail) {
    this.violations.push({ file: this.file, pointer, kind, detail });
  }

  /**
   * Resolves a local `$ref` to its definition name and body.
   *
   * @param {JsonObject} schema
   * @param {JsonObject} defs
   * @returns {{ name: string, body: Json | undefined } | undefined}
   */
  static resolve(schema, defs) {
    const ref = schema['$ref'];
    if (typeof ref !== 'string') return undefined;
    const name = ref.replace(/^#\/\$defs\//, '');
    return { name, body: defs[name] };
  }

  /**
   * @param {Json | undefined} baseSchema
   * @param {Json | undefined} currentSchema
   * @param {string} pointer
   * @param {boolean} [open] The known-values arm of an open enum on both
   *   sides: its values may grow.
   */
  compare(baseSchema, currentSchema, pointer, open = false) {
    const base = normalize(baseSchema);
    const current = normalize(currentSchema);
    if (base === false) return;
    if (current === false) {
      this.report(pointer, 'closed', 'now accepts nothing');
      return;
    }
    const baseRef = SchemaComparison.resolve(base, this.baseDefs);
    const currentRef = SchemaComparison.resolve(current, this.currentDefs);
    if (baseRef !== undefined || currentRef !== undefined) {
      this.compareResolved(
        baseRef ?? { name: pointer, body: base },
        currentRef ?? { name: pointer, body: current },
        pointer,
      );
      return;
    }
    const baseValues = closedValues(base);
    if (baseValues !== undefined && isOpenEnum(current)) {
      this.compareOpened(baseValues, /** @type {Json[]} */ (current['anyOf']), pointer);
      return;
    }
    this.compareTypes(base, current, pointer);
    this.compareValues(base, current, pointer, open);
    this.compareLimits(base, current, pointer);
    this.compareObjects(base, current, pointer);
    this.compareUnions(base, current, pointer);
    this.compareNot(base, current, pointer);
    for (const keyword of SUB_SCHEMAS) {
      if (current[keyword] === undefined) continue;
      if (base[keyword] === undefined)
        this.report(`${pointer}/${keyword}`, 'constraint-added', keyword);
      else this.compare(base[keyword], current[keyword], `${pointer}/${keyword}`);
    }
  }

  /**
   * Compares through `$ref`s. The same definition on both sides is compared
   * once, under `$defs`; recursion through definitions stops at a pair
   * already being compared.
   *
   * @param {{ name: string, body: Json | undefined }} base
   * @param {{ name: string, body: Json | undefined }} current
   * @param {string} pointer
   */
  compareResolved(base, current, pointer) {
    const key = `${base.name}|${current.name}`;
    if (base.name === current.name || this.visiting.has(key)) return;
    this.visiting.add(key);
    this.compare(base.body, current.body, pointer);
    this.visiting.delete(key);
  }

  /**
   * @param {JsonObject} base
   * @param {JsonObject} current
   * @param {string} pointer
   */
  compareTypes(base, current, pointer) {
    const currentTypes = typeList(current['type']);
    if (currentTypes === undefined) return;
    const baseTypes = typeList(base['type']);
    const lost = (baseTypes ?? ['any']).filter(
      (t) => !currentTypes.includes(t) && !(t === 'integer' && currentTypes.includes('number')),
    );
    if (lost.length > 0)
      this.report(`${pointer}/type`, 'type-narrowed', `no longer ${lost.join(', ')}`);
  }

  /**
   * A closed enum (or `const`) that became an open enum: widening, which
   * breaks readers of a read schema. A baseline value the open enum no
   * longer accepts (a non-string outside its known values) is narrowing.
   *
   * @param {readonly Json[]} baseValues The baseline's closed values.
   * @param {readonly Json[]} arms The `anyOf` arms of the current open enum.
   * @param {string} pointer
   */
  compareOpened(baseValues, arms, pointer) {
    const known = new Set(
      arms.flatMap((arm) =>
        isPlainObject(arm) && Array.isArray(arm['enum']) ? arm['enum'].map(canonicalJson) : [],
      ),
    );
    const lost = baseValues.filter(
      (value) => typeof value !== 'string' && !known.has(canonicalJson(value)),
    );
    if (lost.length > 0) {
      this.report(pointer, 'enum-narrowed', `no longer allows ${listValues(lost)}`);
    }
    if (!this.wideningAllowed) {
      this.report(
        pointer,
        'enum-widened',
        `the closed enum ${listValues(baseValues)} became open; readers that handle only these values break`,
      );
    }
  }

  /**
   * `enum` and `const`: every value the baseline allowed must stay allowed.
   * In a read schema a closed enum must not gain values either; `open`
   * exempts the known values of an open enum.
   *
   * @param {JsonObject} base
   * @param {JsonObject} current
   * @param {string} pointer
   * @param {boolean} open
   */
  compareValues(base, current, pointer, open) {
    const currentValues = closedValues(current);
    const baseValues = closedValues(base);
    const frozen = !open && !this.wideningAllowed;
    if (currentValues === undefined) {
      if (baseValues !== undefined && frozen) {
        this.report(
          pointer,
          'enum-widened',
          `no longer restricted to ${listValues(baseValues)}; readers that handle only these values break`,
        );
      }
      return;
    }
    if (baseValues === undefined) {
      this.report(pointer, 'enum-narrowed', 'values are now restricted');
      return;
    }
    const kept = new Set(currentValues.map(canonicalJson));
    const lost = baseValues.filter((value) => !kept.has(canonicalJson(value)));
    if (lost.length > 0) {
      this.report(pointer, 'enum-narrowed', `no longer allows ${listValues(lost)}`);
    }
    if (!frozen) return;
    const was = new Set(baseValues.map(canonicalJson));
    const added = currentValues.filter((value) => !was.has(canonicalJson(value)));
    if (added.length > 0) {
      this.report(
        pointer,
        'enum-widened',
        `now also allows ${listValues(added)}; readers of a closed enum may not handle it (make it an open enum)`,
      );
    }
  }

  /**
   * @param {JsonObject} base
   * @param {JsonObject} current
   * @param {string} pointer
   */
  compareLimits(base, current, pointer) {
    for (const [keywords, tighter] of /** @type {const} */ ([
      [LOWER_LIMITS, (/** @type {number} */ b, /** @type {number} */ c) => c > b],
      [UPPER_LIMITS, (/** @type {number} */ b, /** @type {number} */ c) => c < b],
    ])) {
      for (const keyword of keywords) {
        const c = current[keyword];
        if (typeof c !== 'number') continue;
        const b = base[keyword];
        if (typeof b !== 'number' || tighter(b, c)) {
          this.report(
            `${pointer}/${keyword}`,
            'constraint-narrowed',
            `${b === undefined ? 'none' : JSON.stringify(b)} -> ${String(c)}`,
          );
        }
      }
    }
    for (const keyword of EXACT_CONSTRAINTS) {
      const c = current[keyword];
      if (
        c === undefined ||
        (base[keyword] !== undefined && canonicalJson(base[keyword]) === canonicalJson(c))
      ) {
        continue;
      }
      this.report(`${pointer}/${keyword}`, 'constraint-narrowed', `${keyword} added or changed`);
    }
  }

  /**
   * @param {JsonObject} base
   * @param {JsonObject} current
   * @param {string} pointer
   */
  compareObjects(base, current, pointer) {
    const baseRequired = new Set(Array.isArray(base['required']) ? base['required'] : []);
    const added = (Array.isArray(current['required']) ? current['required'] : []).filter(
      (name) => !baseRequired.has(name),
    );
    if (added.length > 0) {
      this.report(`${pointer}/required`, 'required-added', added.map(String).join(', '));
    }
    const baseProperties = normalizeDefs(base['properties']);
    const currentProperties = normalizeDefs(current['properties']);
    for (const [name, schema] of Object.entries(baseProperties)) {
      if (isExperimental(name)) continue;
      const at = `${pointer}/properties/${escapePointer(name)}`;
      if (Object.hasOwn(currentProperties, name)) this.compare(schema, currentProperties[name], at);
      else this.report(at, 'property-removed', name);
    }
    const baseAdditional = base['additionalProperties'];
    const currentAdditional = current['additionalProperties'];
    if (currentAdditional === undefined || currentAdditional === true || baseAdditional === false)
      return;
    const at = `${pointer}/additionalProperties`;
    if (currentAdditional === false)
      this.report(at, 'additional-properties-closed', 'unknown keys now refused');
    else if (baseAdditional === undefined || baseAdditional === true) {
      this.report(at, 'additional-properties-narrowed', 'unknown keys now constrained');
    } else this.compare(baseAdditional, currentAdditional, at);
  }

  /**
   * Every baseline arm must survive: matched by `$ref`, as the enum arm,
   * by its literal `type` property, or by identical content.
   *
   * @param {JsonObject} base
   * @param {JsonObject} current
   * @param {string} pointer
   */
  compareUnions(base, current, pointer) {
    for (const keyword of UNIONS) {
      const currentArms = current[keyword];
      if (!Array.isArray(currentArms)) continue;
      const baseArms = base[keyword];
      if (!Array.isArray(baseArms)) {
        this.report(`${pointer}/${keyword}`, 'constraint-added', keyword);
        continue;
      }
      // The known values of an open enum on both sides may grow.
      const open = keyword === 'anyOf' && isOpenEnum(base) && isOpenEnum(current);
      baseArms.forEach((arm, index) => {
        const key = armKey(arm);
        const match = currentArms.find((candidate) => armKey(candidate) === key);
        const at = `${pointer}/${keyword}/${String(index)}`;
        if (match === undefined) this.report(at, 'union-arm-removed', key);
        else this.compare(arm, match, at, open);
      });
    }
  }

  /**
   * @param {JsonObject} base
   * @param {JsonObject} current
   * @param {string} pointer
   */
  compareNot(base, current, pointer) {
    const c = current['not'];
    if (c === undefined) return;
    const b = base['not'];
    const at = `${pointer}/not`;
    if (b === undefined) {
      this.report(at, 'constraint-added', 'not');
      return;
    }
    const baseEnum = isPlainObject(b) ? b['enum'] : undefined;
    const currentEnum = isPlainObject(c) ? c['enum'] : undefined;
    if (Array.isArray(baseEnum) && Array.isArray(currentEnum)) {
      const excluded = new Set(baseEnum.map(canonicalJson));
      const added = currentEnum.filter((value) => !excluded.has(canonicalJson(value)));
      if (added.length > 0)
        this.report(
          at,
          'enum-narrowed',
          `now excludes ${added.map((v) => JSON.stringify(v)).join(', ')}`,
        );
    } else if (canonicalJson(b) !== canonicalJson(c)) {
      this.report(at, 'constraint-narrowed', 'not changed');
    }
  }
}

/**
 * @param {Json | undefined} value
 * @returns {JsonObject}
 */
function normalizeDefs(value) {
  return isPlainObject(value) ? value : {};
}

/**
 * The document root without its definitions.
 *
 * @param {JsonObject} doc
 * @returns {JsonObject}
 */
function withoutDefs(doc) {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => key !== '$defs'));
}

/**
 * @param {Json} arm
 * @returns {string}
 */
function armKey(arm) {
  if (isPlainObject(arm)) {
    if (typeof arm['$ref'] === 'string') return `ref ${arm['$ref']}`;
    // The known values of an open enum: compared value by value.
    if (Array.isArray(arm['enum'])) return 'enum';
    const properties = arm['properties'];
    const type = isPlainObject(properties) ? properties['type'] : undefined;
    if (isPlainObject(type) && typeof type['const'] === 'string') return `type ${type['const']}`;
  }
  return `schema ${canonicalJson(arm)}`;
}

/**
 * Compares one baseline document with its current version.
 *
 * @param {string} file Path from the repository root, forward slashes.
 * @param {JsonObject} baseline
 * @param {JsonObject} current
 * @param {boolean} [wideningAllowed] Whether a widened closed enum is
 *   additive; defaults to whether {@link WIDENING_ALLOWED} lists `file`.
 * @returns {Violation[]}
 */
export function diffSchema(file, baseline, current, wideningAllowed = WIDENING_ALLOWED.has(file)) {
  const comparison = new SchemaComparison(file, baseline, current, wideningAllowed);
  for (const [name, schema] of Object.entries(comparison.baseDefs)) {
    if (isExperimental(name)) continue;
    const at = `/$defs/${escapePointer(name)}`;
    if (Object.hasOwn(comparison.currentDefs, name)) {
      comparison.compare(schema, comparison.currentDefs[name], at);
    } else {
      comparison.report(at, 'definition-removed', `${name} was removed or renamed`);
    }
  }
  comparison.compare(withoutDefs(baseline), withoutDefs(current), '');
  return comparison.violations;
}

/**
 * @param {string} file
 * @returns {JsonObject}
 */
function readJsonObject(file) {
  /** @type {unknown} */
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!isPlainObject(value)) throw new Error(`${file}: not a JSON object`);
  return /** @type {JsonObject} */ (value);
}

/**
 * Compares every baseline schema of the given packages with the current one.
 *
 * @param {string} root Repository root.
 * @param {readonly string[]} packageDirs Package directories, relative to the root.
 * @returns {{ violations: Violation[], compared: number }}
 */
export function diffPackages(root, packageDirs) {
  /** @type {Violation[]} */
  const violations = [];
  let compared = 0;
  for (const packageDir of packageDirs) {
    const schemas = path.join(root, packageDir, 'schemas');
    const baselineDir = path.join(schemas, BASELINE_DIR);
    if (!existsSync(baselineDir)) continue;
    for (const name of readdirSync(baselineDir)
      .filter((n) => n.endsWith('.schema.json'))
      .sort()) {
      const file = `${packageDir}/schemas/${name}`;
      compared += 1;
      const currentFile = path.join(schemas, name);
      if (!existsSync(currentFile)) {
        violations.push({ file, pointer: '', kind: 'schema-removed', detail: name });
        continue;
      }
      violations.push(
        ...diffSchema(
          file,
          readJsonObject(path.join(baselineDir, name)),
          readJsonObject(currentFile),
        ),
      );
    }
  }
  return { violations, compared };
}

/**
 * @param {readonly Violation[]} violations
 * @returns {string}
 */
export function formatViolations(violations) {
  return violations.map((v) => `  - ${v.file}#${v.pointer}: ${v.kind} (${v.detail})`).join('\n');
}

/**
 * Replaces each package's baseline with its current schemas (the release
 * task runs this; plan §1.3).
 *
 * @param {string} root Repository root.
 * @param {readonly string[]} packageDirs Package directories, relative to the root.
 * @returns {string[]} Baseline files written, relative to the root.
 */
export function updateBaseline(root, packageDirs) {
  /** @type {string[]} */
  const written = [];
  for (const packageDir of packageDirs) {
    const schemas = path.join(root, packageDir, 'schemas');
    if (!existsSync(schemas)) continue;
    const baseline = path.join(schemas, BASELINE_DIR);
    mkdirSync(baseline, { recursive: true });
    for (const name of readdirSync(schemas)
      .filter((n) => n.endsWith('.schema.json'))
      .sort()) {
      copyFileSync(path.join(schemas, name), path.join(baseline, name));
      written.push(`${packageDir}/schemas/${BASELINE_DIR}/${name}`);
    }
  }
  return written;
}
