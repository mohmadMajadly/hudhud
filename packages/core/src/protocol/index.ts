/**
 * Neutral sans-IO pieces of hudhud: JSON values, the NDJSON line encoder,
 * errors as data, capability and posture types, and the event vocabulary.
 *
 * @remarks
 * Harness-neutral (K3): no harness protocol lives here. Code under this
 * directory stays free of I/O, host globals and ambient time or randomness
 * (ADR-0006); ESLint and dependency-cruiser enforce that boundary.
 *
 * @packageDocumentation
 */

export type { JsonObject, JsonPrimitive, JsonValue, ParseJsonLineResult } from './json.js';
export {
  DEFAULT_MAX_JSON_DEPTH,
  isJsonObject,
  isJsonValue,
  ownArray,
  ownBoolean,
  ownNumber,
  ownObject,
  ownString,
  parseJsonLine,
} from './json.js';

export type { EncodeJsonLineResult } from './encode.js';
export { DEFAULT_MAX_OUTBOUND_FRAME_BYTES, encodeJsonLine } from './encode.js';

export type { ErrorData, ErrorDataFailure, HudhudErrorCode, KnownErrorData } from './errors.js';
export {
  ERROR_RETRYABLE,
  HUDHUD_ERROR_CODES,
  isHudhudErrorCode,
  isRetryable,
  makeErrorData,
  parseErrorData,
} from './errors.js';

export type {
  Capability,
  HarnessCapabilities,
  ProcessContainment,
  SecurityPosture,
  SecurityPostureEntry,
} from './capabilities.js';

export type {
  CompatInfo,
  DiagnosticCode,
  EventBase,
  HudhudEvent,
  StopReason,
  ToolKind,
  TurnOutcome,
  TurnResult,
  UsageTotals,
} from './events/types.js';
