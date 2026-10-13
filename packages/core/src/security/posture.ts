/**
 * The harness-neutral security posture model (plan §1.9, ADR-0012 §7): one
 * entry per security-relevant setting with its effective value, its default
 * and whether it deviates from the default.
 *
 * @remarks
 * The rule this module serves is that no weakened default is silent:
 * adapters list every security-relevant setting, and `deviates` is computed
 * here by deep JSON equality, never supplied by the adapter, so an entry
 * cannot claim to be the default while it is not.
 *
 * Postures are plain, frozen JSON. {@link serializePosture} and
 * {@link parsePosture} round-trip them; a parsed posture whose `deviates`
 * flags disagree with its values is refused.
 *
 * Values are whatever the adapter lists. Adapters list kinds and names,
 * never secrets, environment values or paths (ADR-0012 §4, ADR-0016).
 *
 * @packageDocumentation
 */

import type { SecurityPosture, SecurityPostureEntry } from '../protocol/capabilities.js';
import { validateSecurityPosture } from '../protocol/generated/validators.gen.js';
import { isJsonObject, isJsonValue, nestingExceeds, type JsonValue } from '../protocol/json.js';

/**
 * One setting as an adapter lists it; {@link buildPosture} adds `deviates`.
 */
export interface PostureEntryInput {
  /** Dotted option path or a fixed name, for example `claudeCode.bare`. */
  readonly setting: string;
  readonly value: JsonValue;
  readonly defaultValue: JsonValue;
}

/** Nesting limit of posture values; posture values are small and flat. */
export const MAX_POSTURE_VALUE_DEPTH = 32;

/**
 * Deep JSON equality: arrays element by element in order, objects by their
 * own keys in any order, primitives by `===` (so `0` equals `-0`, which JSON
 * cannot tell apart).
 */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const right: readonly JsonValue[] = b;
    return a.every((item: JsonValue, index) => jsonEqual(item, right[index] as JsonValue));
  }
  const objA = a as Readonly<Record<string, JsonValue>>;
  const objB = b as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(objA);
  if (keys.length !== Object.keys(objB).length) return false;
  return keys.every(
    (key) => Object.hasOwn(objB, key) && jsonEqual(objA[key] as JsonValue, objB[key] as JsonValue),
  );
}

/** A frozen deep copy; `value` is JSON (checked by the caller). */
function frozenCopy(value: JsonValue): JsonValue {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    const items: readonly JsonValue[] = value;
    return Object.freeze(items.map(frozenCopy));
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Readonly<Record<string, JsonValue>>)) {
    // defineProperty keeps a `__proto__` key an inert own property.
    Object.defineProperty(out, key, {
      value: frozenCopy(item),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(out);
}

/** Why an entry is refused, or `undefined` when it is valid and new. */
function entryProblem(entry: PostureEntryInput, seen: ReadonlySet<string>): string | undefined {
  const { setting } = entry;
  if (typeof setting !== 'string' || setting.length === 0) return 'has no setting name';
  if (seen.has(setting)) return 'is listed twice';
  if (!isJsonValue(entry.value, MAX_POSTURE_VALUE_DEPTH)) return 'has a value that is not JSON';
  if (!isJsonValue(entry.defaultValue, MAX_POSTURE_VALUE_DEPTH)) {
    return 'has a default value that is not JSON';
  }
  return undefined;
}

type BuildResult =
  | { readonly ok: true; readonly posture: SecurityPosture }
  | { readonly ok: false; readonly index: number; readonly problem: string };

function build(entries: readonly PostureEntryInput[]): BuildResult {
  const seen = new Set<string>();
  const out: SecurityPostureEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const problem = entryProblem(entry, seen);
    if (problem !== undefined) return { ok: false, index, problem };
    seen.add(entry.setting);
    const value = frozenCopy(entry.value);
    const defaultValue = frozenCopy(entry.defaultValue);
    out.push(
      Object.freeze({
        setting: entry.setting,
        value,
        defaultValue,
        deviates: !jsonEqual(value, defaultValue),
      }),
    );
  }
  return { ok: true, posture: Object.freeze({ entries: Object.freeze(out) }) };
}

/**
 * Builds a posture from the adapter's entries, in the given order.
 *
 * @remarks
 * `deviates` is `!jsonEqual(value, defaultValue)`. The result is a frozen
 * deep copy, so later changes to the inputs do not reach it.
 *
 * @throws `TypeError` for an empty or duplicate `setting` or a value that is
 *   not JSON (an adapter bug, not a user error)
 */
export function buildPosture(entries: readonly PostureEntryInput[]): SecurityPosture {
  const result = build(entries);
  if (result.ok) return result.posture;
  throw new TypeError(`security posture entry ${String(result.index)} ${result.problem}`);
}

/** The entries that deviate from their default, in posture order. */
export function postureDeviations(posture: SecurityPosture): readonly SecurityPostureEntry[] {
  return posture.entries.filter((entry) => entry.deviates);
}

/** The entry of `setting`, if listed. */
export function postureEntry(
  posture: SecurityPosture,
  setting: string,
): SecurityPostureEntry | undefined {
  return posture.entries.find((entry) => entry.setting === setting);
}

/** JSON text of a posture: `{"entries":[{setting,value,defaultValue,deviates}...]}`. */
export function serializePosture(posture: SecurityPosture): string {
  return JSON.stringify({
    entries: posture.entries.map(({ setting, value, defaultValue, deviates }) => ({
      setting,
      value,
      defaultValue,
      deviates,
    })),
  });
}

/** Result of {@link parsePosture}. */
export type ParsePostureResult =
  | { readonly ok: true; readonly posture: SecurityPosture }
  | {
      readonly ok: false;
      readonly reason: 'not-json' | 'too-deep' | 'schema' | 'invalid-entry' | 'deviates-mismatch';
      /** Index of the offending entry, for `invalid-entry` and `deviates-mismatch`. */
      readonly index?: number;
    };

/**
 * Parses posture JSON (for example a stored or transmitted posture).
 *
 * @remarks
 * The text must match `posture.schema.json`, every entry must pass
 * {@link buildPosture}, and every `deviates` flag must equal the recomputed
 * one: a posture claiming that a non-default value is the default is
 * refused. Unknown members are dropped.
 */
export function parsePosture(text: string): ParsePostureResult {
  // Two containers for the posture and its entries array, one per entry, then the values.
  if (nestingExceeds(text, MAX_POSTURE_VALUE_DEPTH + 3)) return { ok: false, reason: 'too-deep' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (!isJsonObject(parsed)) return { ok: false, reason: 'schema' };
  const checked = validateSecurityPosture(parsed);
  if (!checked.ok) return { ok: false, reason: 'schema' };
  const given = checked.value.entries;
  const built = build(
    given.map(({ setting, value, defaultValue }) => ({ setting, value, defaultValue })),
  );
  if (!built.ok) return { ok: false, reason: 'invalid-entry', index: built.index };
  const mismatch = built.posture.entries.findIndex(
    (entry, index) => entry.deviates !== given[index]?.deviates,
  );
  if (mismatch !== -1) return { ok: false, reason: 'deviates-mismatch', index: mismatch };
  return { ok: true, posture: built.posture };
}
