/**
 * Errors as data: the closed code table, retryability and the plain-JSON
 * `ErrorData` shape that crosses the sans-IO boundary (ADR-0006, plan §3).
 *
 * @remarks
 * Harness-neutral and free of I/O. The thrown classes live in the binding
 * layer (`binding/errors.ts`). Nothing here ever carries a secret value:
 * messages and details name variables and files, never their contents
 * (ADR-0016 §1).
 */

import { isJsonObject, isJsonValue, type JsonObject } from './json.js';

/**
 * Every error code of the v1 taxonomy (plan §3.1). The list is closed.
 *
 * @public
 */
export const HUDHUD_ERROR_CODES = [
  'INVALID_OPTIONS',
  'CAPABILITY_UNSUPPORTED',
  'ADAPTER_API_VERSION_MISMATCH',
  'BINARY_NOT_FOUND',
  'BINARY_REFUSED',
  'BINARY_VERIFICATION_FAILED',
  'BINARY_PROBE_FAILED',
  'CWD_INVALID',
  'CWD_TOO_LONG',
  'PROJECT_CREDENTIAL_ENV',
  'SESSION_ID_IN_USE',
  'SPAWN_FAILED',
  'HANDSHAKE_TIMEOUT',
  'HANDSHAKE_FAILED',
  'SESSION_NOT_FOUND',
  'AUTHENTICATION_FAILED',
  'SESSION_POISONED',
  'PROTOCOL_ERROR',
  'OVERSIZED_FRAME',
  'OUTBOUND_FRAME_TOO_LARGE',
  'CONTROL_REQUEST_FAILED',
  'PROCESS_EXITED',
  'SESSION_CLOSED',
  'HARNESS_DISPOSED',
  'ABORTED',
  'SUBSCRIBER_OVERFLOW',
] as const;

/**
 * One of the closed error codes: every code this version of hudhud raises.
 *
 * @remarks
 * Data read from elsewhere (for example a newer peer) may carry codes this
 * version does not know; {@link ErrorData} is therefore open (ADR-0005 §6).
 *
 * @public
 */
export type HudhudErrorCode = (typeof HUDHUD_ERROR_CODES)[number];

/**
 * Whether repeating the same call with the same inputs may succeed without a
 * change by the application (plan §3.1). Fixed per code.
 *
 * @public
 */
export const ERROR_RETRYABLE: Readonly<Record<HudhudErrorCode, boolean>> = {
  INVALID_OPTIONS: false,
  CAPABILITY_UNSUPPORTED: false,
  ADAPTER_API_VERSION_MISMATCH: false,
  BINARY_NOT_FOUND: false,
  BINARY_REFUSED: false,
  BINARY_VERIFICATION_FAILED: false,
  BINARY_PROBE_FAILED: true,
  CWD_INVALID: false,
  CWD_TOO_LONG: false,
  PROJECT_CREDENTIAL_ENV: false,
  SESSION_ID_IN_USE: true,
  SPAWN_FAILED: false,
  HANDSHAKE_TIMEOUT: true,
  HANDSHAKE_FAILED: true,
  SESSION_NOT_FOUND: false,
  AUTHENTICATION_FAILED: false,
  SESSION_POISONED: false,
  PROTOCOL_ERROR: false,
  OVERSIZED_FRAME: false,
  OUTBOUND_FRAME_TOO_LARGE: false,
  CONTROL_REQUEST_FAILED: true,
  PROCESS_EXITED: true,
  SESSION_CLOSED: false,
  HARNESS_DISPOSED: false,
  ABORTED: false,
  SUBSCRIBER_OVERFLOW: false,
};

/**
 * An error as plain JSON data. Round-trips through `JSON.stringify` /
 * `JSON.parse`.
 *
 * @remarks
 * `code` is open, as in `errors.schema.json` (ADR-0005 §6): hudhud itself only
 * raises {@link HudhudErrorCode} values ({@link KnownErrorData}), but data
 * read from a newer peer may carry a code this version does not know.
 *
 * @public
 */
export interface ErrorData {
  readonly code: HudhudErrorCode | (string & {});
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

/**
 * `ErrorData` whose code is one of the closed codes: what hudhud builds and
 * what `parseErrorData` accepts.
 *
 * @public
 */
export type KnownErrorData = ErrorData & { readonly code: HudhudErrorCode };

const CODE_SET: ReadonlySet<string> = new Set(HUDHUD_ERROR_CODES);

/** Deepest nesting `details` may have; deeper values are refused, not walked. */
const MAX_DETAILS_DEPTH = 64;

/**
 * Narrows to a known error code.
 *
 * @public
 */
export function isHudhudErrorCode(value: unknown): value is HudhudErrorCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

/**
 * Whether a code is retryable.
 *
 * @public
 */
export function isRetryable(code: HudhudErrorCode): boolean {
  return ERROR_RETRYABLE[code];
}

/**
 * Whether a value is a plain JSON object (finite numbers, bounded depth): the
 * check applied to `details`.
 *
 * @internal
 */
export function isJsonObjectValue(value: unknown): value is JsonObject {
  return isJsonObject(value) && isJsonValue(value, MAX_DETAILS_DEPTH);
}

/**
 * Builds `ErrorData` with the retryability fixed by the code table.
 *
 * @public
 */
export function makeErrorData(
  code: HudhudErrorCode,
  message: string,
  details?: JsonObject,
): KnownErrorData {
  const retryable = ERROR_RETRYABLE[code];
  return details === undefined
    ? { code, message, retryable }
    : { code, message, retryable, details };
}

/**
 * Why a value is not valid `ErrorData`.
 *
 * @public
 */
export type ErrorDataFailure =
  'not-object' | 'unknown-code' | 'bad-message' | 'bad-retryable' | 'bad-details';

/**
 * Validates untrusted JSON as `ErrorData`. Fields are read with `Object.hasOwn`
 * and rebuilt, so unknown or `__proto__` keys on the envelope are dropped.
 * `retryable` must match the code table.
 *
 * @remarks
 * Strict: only the codes this version knows are accepted (`unknown-code`
 * otherwise), so the result can be rebuilt as an error class. The schema
 * check `validateErrorData` is the open counterpart (ADR-0005 §6).
 *
 * @public
 */
export function parseErrorData(
  value: unknown,
):
  | { readonly ok: true; readonly value: KnownErrorData }
  | { readonly ok: false; readonly reason: ErrorDataFailure } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not-object' };
  }
  const own = (key: string): unknown =>
    Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
  const code = own('code');
  if (!isHudhudErrorCode(code)) return { ok: false, reason: 'unknown-code' };
  const message = own('message');
  if (typeof message !== 'string') return { ok: false, reason: 'bad-message' };
  if (own('retryable') !== ERROR_RETRYABLE[code]) return { ok: false, reason: 'bad-retryable' };
  const details = own('details');
  if (details === undefined) return { ok: true, value: makeErrorData(code, message) };
  if (!isJsonObjectValue(details)) return { ok: false, reason: 'bad-details' };
  return { ok: true, value: makeErrorData(code, message, details) };
}
