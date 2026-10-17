/**
 * Harness-neutral core of hudhud: the application types (`Harness`,
 * `Session`, `Turn`, events, results, capabilities), the error classes and
 * codes, subscriber options, the security posture helpers and the redaction
 * helpers.
 *
 * @remarks
 * The stable application tier (ADR-0003, ADR-0004): every export without a
 * `@beta` tag follows semver. The adapter-author pieces here
 * (`defineAdapter`, `AdapterDefinition`, `buildPosture`, `PostureEntryInput`)
 * are `@beta`, as are the subpaths `@hudhudjs/core/binding` and
 * `@hudhudjs/core/process` and the adapter-author part of
 * `@hudhudjs/core/protocol`. The design is described in docs/architecture.md
 * and the ADRs under docs/adr/.
 *
 * @packageDocumentation
 */

export type { AdapterDefinition } from './binding/adapter.js';
export { adapterApiVersion, defineAdapter } from './binding/adapter.js';

export type {
  BinaryInfo,
  Harness,
  Session,
  SessionInfo,
  Turn,
  UserContentBlock,
  UserInput,
} from './binding/handles.js';
export type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from './binding/permission-bridge.js';
export type { BinaryVerification, VerificationMode } from './process/verify/verify.js';

/**
 * Version of the neutral wire model (events, errors, capabilities, posture),
 * as in `@hudhudjs/core/schemas/version.json`; bumped only on a breaking change
 * (ADR-0005).
 *
 * @public
 */
export const wireSchemaVersion = 1;

export type { JsonObject, JsonPrimitive, JsonValue } from './protocol/json.js';

export type {
  Capability,
  HarnessCapabilities,
  ProcessContainment,
  SecurityPosture,
  SecurityPostureEntry,
} from './protocol/capabilities.js';

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
} from './protocol/events/types.js';
export type { HudhudEventOf } from './protocol/events/guard.js';
export { isEventType } from './protocol/events/guard.js';

export type { ErrorData, HudhudErrorCode, KnownErrorData } from './protocol/errors.js';
export { HUDHUD_ERROR_CODES } from './protocol/errors.js';
export type {
  HudhudErrorDetails,
  HudhudErrorOptions,
  ProjectCredentialFindings,
} from './binding/errors.js';
export {
  AbortError,
  AdapterApiVersionError,
  AuthenticationFailedError,
  BinaryNotFoundError,
  BinaryProbeError,
  BinaryRefusedError,
  BinaryVerificationError,
  CapabilityUnsupportedError,
  ControlRequestError,
  CwdInvalidError,
  CwdTooLongError,
  HandshakeError,
  HandshakeTimeoutError,
  HarnessDisposedError,
  HarnessVersionKnownBrokenError,
  HudhudError,
  InvalidOptionsError,
  isHudhudError,
  OutboundFrameTooLargeError,
  OversizedFrameError,
  ProcessExitedError,
  ProjectCredentialEnvError,
  ProtocolError,
  SessionClosedError,
  SessionIdInUseError,
  SessionNotFoundError,
  SessionPoisonedError,
  SpawnError,
  SubscriberOverflowError,
  TurnDroppedError,
} from './binding/errors.js';

export type { ParsePostureResult, PostureEntryInput } from './security/posture.js';
export {
  buildPosture,
  parsePosture,
  postureDeviations,
  postureEntry,
  serializePosture,
} from './security/posture.js';

export type { OverflowPolicy } from './binding/queue.js';
export type { SubscriberOptions } from './binding/fanout.js';

export type { EnvMap, RedactableJson, RedactionPolicy } from './observability/redact.js';
export {
  credentialEnvNames,
  isCredentialEnvName,
  isSensitiveFieldName,
  MIN_ENV_SECRET_LENGTH,
  REDACTED,
  redactJson,
  redactText,
  secretsFromEnv,
} from './observability/redact.js';
