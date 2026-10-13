/**
 * Harness-neutral core of hudhud: public types, error classes, subscriber
 * options and the observability primitives (redaction, stderr tail, usage).
 *
 * @remarks
 * Pre-alpha: the session binding layer (`Harness`, `Session`, `Turn`) lands in
 * later waves. The design is described in docs/architecture.md and the ADRs
 * under docs/adr/.
 *
 * @packageDocumentation
 */

/**
 * The adapter API version implemented by this core.
 *
 * @remarks
 * An integer negotiated at adapter registration; an adapter built against an
 * unsupported value is refused at registration, not at first use (ADR-0004).
 *
 * @public
 */
export const adapterApiVersion = 1;

/**
 * Version of the neutral wire model (events, errors, capabilities, posture),
 * as in `@hudhud/core/schemas/version.json`; bumped only on a breaking change
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
export type { StderrTailOptions } from './observability/stderr-tail.js';
export { StderrTail, TRUNCATED } from './observability/stderr-tail.js';
export type { EstimatedUsage, UsageObservation } from './observability/usage.js';
export { estimateUsageDelta, sanitizeUsage, UsageEstimator } from './observability/usage.js';
