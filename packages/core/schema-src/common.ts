// Shared building blocks of the TypeBox schema sources (ADR-0005). Build
// time only: TypeBox never reaches a published package. The pipeline
// (scripts/lib/schema/) bundles a package's schema entry, reads its
// `schemaSource` export and writes the committed JSON Schema and the
// precompiled validators.

import Type, { type Static, type TArrayOptions, type TSchema, type TUnsafe } from 'typebox';

import type { JsonObject, JsonValue } from '../src/protocol/json.js';

/** One committed JSON Schema file: named definitions plus the root definition. */
export interface SchemaDocument {
  /** File name under the package's `schemas/` directory. */
  readonly file: string;
  readonly title: string;
  readonly description: string;
  /** Name of the definition the document root refers to. */
  readonly root: string;
  /**
   * Named definitions, in output order. A sub-schema structurally equal to
   * another named definition is written as a `$ref` to it.
   */
  readonly defs: Readonly<Record<string, TSchema>>;
}

/** A committed JSON data file written verbatim (for example `version.json`). */
export interface DataDocument {
  readonly file: string;
  readonly json: JsonObject;
}

/** One precompiled validator of the generated module. */
export interface ValidatorExport {
  /** Exported name, for example `validateHudhudEvent`. */
  readonly name: string;
  /** Schema file that holds the definition. */
  readonly schema: string;
  /** Definition the validator checks. */
  readonly def: string;
  /** Type the validator narrows to: an import path relative to the generated module, and a type name. */
  readonly type: { readonly from: string; readonly name: string };
}

/** What a package's schema entry exports as `schemaSource`. */
export interface SchemaSource {
  readonly documents: readonly SchemaDocument[];
  readonly data: readonly DataDocument[];
  readonly validators: readonly ValidatorExport[];
}

/** Any JSON value. Deliberately unconstrained: inner content is not validated. */
export const JsonValueSchema: TUnsafe<JsonValue> = Type.Unsafe<JsonValue>({});

/** A JSON object whose members are not validated. */
export const JsonObjectSchema: TUnsafe<JsonObject> = Type.Unsafe<JsonObject>({ type: 'object' });

/**
 * An open string enum (ADR-0005 §6): the known values are listed, any other
 * string is accepted on read.
 */
export function openEnum<const Values extends readonly string[]>(
  values: Values,
): TUnsafe<Values[number] | (string & {})> {
  return Type.Unsafe<Values[number] | (string & {})>({
    anyOf: [{ enum: [...values] }, { type: 'string' }],
  });
}

/** An object with arbitrary string keys and values of one schema. */
export function stringMap<Value extends TSchema>(
  value: Value,
): TUnsafe<Readonly<Record<string, Static<Value>>>> {
  return Type.Unsafe<Readonly<Record<string, Static<Value>>>>({
    type: 'object',
    additionalProperties: value,
  });
}

/**
 * An array whose static type is a readonly array, as in the handwritten
 * public types. The JSON Schema is a plain `array`.
 */
export function list<Item extends TSchema>(item: Item, options?: TArrayOptions) {
  return Type.Immutable(Type.Array(item, options));
}

/** A non-negative integer (counts, sequence numbers, pids). */
export const Count = Type.Integer({ minimum: 0 });
