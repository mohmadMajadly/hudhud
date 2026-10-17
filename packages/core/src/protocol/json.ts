/**
 * JSON values crossing the sans-IO boundary (ADR-0006) and safe access to
 * untrusted frames (ADR-0012 §8).
 *
 * Untrusted objects are never spread or `Object.assign`ed; fields are read
 * with `Object.hasOwn`, so a `__proto__` key produced by `JSON.parse` stays an
 * inert own property.
 *
 * @packageDocumentation
 */

/**
 * A JSON primitive.
 *
 * @public
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * Any JSON value.
 *
 * @public
 */
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * A JSON object.
 *
 * @public
 */
export type JsonObject = Readonly<Record<string, JsonValue>>;

/**
 * Default nesting limit of {@link parseJsonLine}.
 *
 * @remarks
 * `JSON.parse` in V8 accepts arbitrarily deep input, but `JSON.stringify`,
 * structured clone and recursive consumers overflow the stack long before
 * that, so hostile nesting is refused before it is parsed.
 *
 * @public
 */
export const DEFAULT_MAX_JSON_DEPTH = 512;

/**
 * Result of {@link parseJsonLine}.
 *
 * @public
 */
export type ParseJsonLineResult =
  | { readonly ok: true; readonly value: JsonObject }
  | { readonly ok: false; readonly reason: 'not-json' | 'not-object' | 'too-deep' };

/**
 * True for a plain JSON object: not `null`, not an array, and created by
 * `JSON.parse` or an object literal (prototype `Object.prototype` or `null`).
 *
 * @remarks
 * Shallow: the members are not inspected. Values produced by `JSON.parse`
 * are JSON all the way down; use {@link isJsonValue} for values of any other
 * origin.
 *
 * @public
 */
export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * True when `value` is JSON all the way down: finite numbers, strings,
 * booleans, `null`, arrays and plain objects, at most `maxDepth` containers
 * deep, each container reachable only once.
 *
 * @remarks
 * Iterative, so hostile depth cannot overflow the stack. A container that is
 * reachable twice is refused even without a cycle: shared references can
 * expand exponentially when serialized. Use it for values that did not come
 * from `JSON.parse`, for example application-supplied permission decisions.
 * Never throws: a getter or a proxy trap that throws makes the value not
 * JSON.
 *
 * @public
 */
export function isJsonValue(
  value: unknown,
  maxDepth: number = DEFAULT_MAX_JSON_DEPTH,
): value is JsonValue {
  try {
    return walksAsJson(value, maxDepth);
  } catch {
    return false;
  }
}

function walksAsJson(value: unknown, maxDepth: number): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const current = item.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (Number.isFinite(current)) continue;
      return false;
    }
    if (typeof current !== 'object') return false;
    if (item.depth >= maxDepth || seen.has(current)) return false;
    seen.add(current);
    let members: readonly unknown[];
    if (Array.isArray(current)) members = current;
    else if (isJsonObject(current)) members = Object.values(current);
    else return false;
    for (const member of members) stack.push({ value: member, depth: item.depth + 1 });
  }
  return true;
}

/**
 * Own string property of `obj`, else `undefined`.
 *
 * @public
 */
export function ownString(obj: JsonObject, key: string): string | undefined {
  const value = own(obj, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Own finite number property of `obj`, else `undefined`.
 *
 * @public
 */
export function ownNumber(obj: JsonObject, key: string): number | undefined {
  const value = own(obj, key);
  return typeof value === 'number' ? value : undefined;
}

/**
 * Own boolean property of `obj`, else `undefined`.
 *
 * @public
 */
export function ownBoolean(obj: JsonObject, key: string): boolean | undefined {
  const value = own(obj, key);
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Own plain-object property of `obj`, else `undefined`.
 *
 * @public
 */
export function ownObject(obj: JsonObject, key: string): JsonObject | undefined {
  const value = own(obj, key);
  return isJsonObject(value) ? value : undefined;
}

/**
 * Own array property of `obj`, else `undefined`.
 *
 * @public
 */
export function ownArray(obj: JsonObject, key: string): readonly JsonValue[] | undefined {
  const value = own(obj, key);
  return Array.isArray(value) ? value : undefined;
}

function own(obj: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * Parses one NDJSON line into a JSON object.
 *
 * @remarks
 * Nesting deeper than `maxDepth` is refused as `too-deep` before parsing; it
 * takes precedence over `not-json`. Whitespace around the value is allowed,
 * as `JSON.parse` allows it.
 *
 * @public
 */
export function parseJsonLine(
  text: string,
  maxDepth: number = DEFAULT_MAX_JSON_DEPTH,
): ParseJsonLineResult {
  if (nestingExceeds(text, maxDepth)) return { ok: false, reason: 'too-deep' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: error instanceof SyntaxError ? 'not-json' : 'too-deep' };
  }
  return isJsonObject(value) ? { ok: true, value } : { ok: false, reason: 'not-object' };
}

const OPEN_BRACE = 0x7b;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACE = 0x7d;
const CLOSE_BRACKET = 0x5d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Linear scan of the container nesting depth outside string literals.
 *
 * @internal
 */
export function nestingExceeds(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === BACKSLASH) i += 1;
      else if (code === QUOTE) inString = false;
    } else if (code === QUOTE) {
      inString = true;
    } else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      depth += 1;
      if (depth > maxDepth) return true;
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      depth -= 1;
    }
  }
  return false;
}
