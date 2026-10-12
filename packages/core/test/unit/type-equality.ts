// Type-level equality used by the schema type tests (ADR-0005, plan §1.3):
// a handwritten type and `Static<>` of its TypeBox source must describe the
// same values. Used as `expectTypeOf<TypesEqual<A, B>>().toEqualTypeOf<true>()`,
// so a difference is a compile error in `pnpm build`.
//
// Mutual assignability alone is too weak: an object type with one optional
// property more or less is assignable both ways. Both types are therefore
// first brought into a normal form in which every property is required and
// tagged with its optionality (a missing or extra key then breaks
// assignability), intersections are flattened, `readonly` is dropped, open
// string unions reduce to `string`, and the opaque JSON leaves become tags.

import type { JsonObject, JsonValue } from '../../src/protocol/json.js';

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type IsJsonValue<T> = MutuallyAssignable<T, JsonValue>;

/** `JsonObject`, but not an object type whose properties are all optional. */
type IsJsonObject<T> =
  MutuallyAssignable<T, JsonObject> extends true ? (string extends keyof T ? true : false) : false;

type Optionality<T, K extends keyof T> =
  Pick<T, K> extends Required<Pick<T, K>> ? 'required' : 'optional';

/** Structural normal form of a JSON-shaped type. */
export type Normalize<T> =
  IsJsonValue<T> extends true
    ? 'JsonValue'
    : IsJsonObject<T> extends true
      ? 'JsonObject'
      : T extends string
        ? string extends T
          ? string
          : T
        : T extends readonly (infer Item)[]
          ? Normalize<Item>[]
          : T extends object
            ? { [K in keyof T]-?: [Normalize<T[K]>, Optionality<T, K>] }
            : T;

/** `true` when `A` and `B` describe the same JSON values. */
export type TypesEqual<A, B> = MutuallyAssignable<Normalize<A>, Normalize<B>>;
