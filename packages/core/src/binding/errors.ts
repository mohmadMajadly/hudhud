/**
 * Error classes of the v1 taxonomy (plan §3.1). Every class maps to one code in
 * `protocol/errors.ts` and converts to and from plain JSON `ErrorData`.
 *
 * @remarks
 * Messages and details name variables, files and paths, never secret values
 * (ADR-0016 §1). `cause` is kept in memory for debugging and is never
 * serialized: `toData()` and `toJSON()` emit only `code`, `message`,
 * `retryable` and `details`.
 */

import {
  ERROR_RETRYABLE,
  type ErrorData,
  type HudhudErrorCode,
  makeErrorData,
} from '../protocol/errors.js';

/** The plain-JSON `details` object of an error. */
export type HudhudErrorDetails = NonNullable<ErrorData['details']>;

/** Optional parts of an error. */
export interface HudhudErrorOptions {
  /** Plain JSON; copied on construction. */
  readonly details?: HudhudErrorDetails;
  /** The underlying failure; in memory only, never serialized. */
  readonly cause?: unknown;
}

/** The part of `AbortSignal` the errors need (no DOM or Node typings in core). */
export interface AbortSignalLike {
  readonly reason?: unknown;
}

/** Deep copy of plain JSON (an own `__proto__` key stays an own key). */
function cloneDetails(details: HudhudErrorDetails): HudhudErrorDetails {
  return JSON.parse(JSON.stringify(details)) as HudhudErrorDetails;
}

/**
 * Base of every hudhud error. Not constructible directly: use a subclass or
 * `HudhudError.fromData`.
 */
export abstract class HudhudError extends Error {
  /** The taxonomy code of the class (overridden by every subclass). */
  declare static readonly code: HudhudErrorCode;
  /** The class name, stable under minification (overridden by every subclass). */
  declare static readonly errorName: string;

  readonly code: HudhudErrorCode;
  readonly retryable: boolean;
  readonly details?: HudhudErrorDetails;

  constructor(message: string, options: HudhudErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = new.target.errorName;
    this.code = new.target.code;
    this.retryable = ERROR_RETRYABLE[this.code];
    if (options.details !== undefined) this.details = cloneDetails(options.details);
  }

  /** The error as plain JSON data. Never includes `cause` or `stack`. */
  toData(): ErrorData {
    return makeErrorData(
      this.code,
      this.message,
      this.details === undefined ? undefined : cloneDetails(this.details),
    );
  }

  /** Makes `JSON.stringify(error)` produce `ErrorData`. */
  toJSON(): ErrorData {
    return this.toData();
  }

  /** Rebuilds the class for `data.code`. Retryability comes from the code table. */
  static fromData(data: ErrorData): HudhudError {
    const ErrorClass = ERROR_CLASSES[data.code];
    return new ErrorClass(
      data.message,
      data.details === undefined ? {} : { details: data.details },
    );
  }
}

/** Narrows to any hudhud error. */
export function isHudhudError(value: unknown): value is HudhudError {
  return value instanceof HudhudError;
}

/** Findings of the project credential guard: names only, never values. */
export interface ProjectCredentialFindings {
  readonly files: readonly string[];
  /** Variable names. */
  readonly variables: readonly string[];
  readonly apiKeyHelper: boolean;
  readonly unparseable: readonly string[];
}

/** Code `INVALID_OPTIONS` (plan §3.1). */
export class InvalidOptionsError extends HudhudError {
  static override readonly code = 'INVALID_OPTIONS';
  static override readonly errorName = 'InvalidOptionsError';
}

/** Code `CAPABILITY_UNSUPPORTED` (plan §3.1). */
export class CapabilityUnsupportedError extends HudhudError {
  static override readonly code = 'CAPABILITY_UNSUPPORTED';
  static override readonly errorName = 'CapabilityUnsupportedError';
}

/** Code `ADAPTER_API_VERSION_MISMATCH` (plan §3.1). */
export class AdapterApiVersionError extends HudhudError {
  static override readonly code = 'ADAPTER_API_VERSION_MISMATCH';
  static override readonly errorName = 'AdapterApiVersionError';
}

/** Code `BINARY_NOT_FOUND` (plan §3.1). */
export class BinaryNotFoundError extends HudhudError {
  static override readonly code = 'BINARY_NOT_FOUND';
  static override readonly errorName = 'BinaryNotFoundError';
}

/** Code `BINARY_REFUSED` (plan §3.1). */
export class BinaryRefusedError extends HudhudError {
  static override readonly code = 'BINARY_REFUSED';
  static override readonly errorName = 'BinaryRefusedError';
}

/** Code `BINARY_VERIFICATION_FAILED` (plan §3.1). */
export class BinaryVerificationError extends HudhudError {
  static override readonly code = 'BINARY_VERIFICATION_FAILED';
  static override readonly errorName = 'BinaryVerificationError';
}

/** Code `BINARY_PROBE_FAILED` (plan §3.1). */
export class BinaryProbeError extends HudhudError {
  static override readonly code = 'BINARY_PROBE_FAILED';
  static override readonly errorName = 'BinaryProbeError';
}

/** Code `CWD_INVALID` (plan §3.1). */
export class CwdInvalidError extends HudhudError {
  static override readonly code = 'CWD_INVALID';
  static override readonly errorName = 'CwdInvalidError';
}

/** Code `CWD_TOO_LONG` (plan §3.1). */
export class CwdTooLongError extends HudhudError {
  static override readonly code = 'CWD_TOO_LONG';
  static override readonly errorName = 'CwdTooLongError';
}

/** Code `SESSION_ID_IN_USE` (plan §3.1). */
export class SessionIdInUseError extends HudhudError {
  static override readonly code = 'SESSION_ID_IN_USE';
  static override readonly errorName = 'SessionIdInUseError';
}

/** Code `SPAWN_FAILED` (plan §3.1). */
export class SpawnError extends HudhudError {
  static override readonly code = 'SPAWN_FAILED';
  static override readonly errorName = 'SpawnError';
}

/** Code `HANDSHAKE_TIMEOUT` (plan §3.1). */
export class HandshakeTimeoutError extends HudhudError {
  static override readonly code = 'HANDSHAKE_TIMEOUT';
  static override readonly errorName = 'HandshakeTimeoutError';
}

/** Code `HANDSHAKE_FAILED` (plan §3.1). */
export class HandshakeError extends HudhudError {
  static override readonly code = 'HANDSHAKE_FAILED';
  static override readonly errorName = 'HandshakeError';
}

/** Code `SESSION_NOT_FOUND` (plan §3.1). */
export class SessionNotFoundError extends HudhudError {
  static override readonly code = 'SESSION_NOT_FOUND';
  static override readonly errorName = 'SessionNotFoundError';
}

/** Code `AUTHENTICATION_FAILED` (plan §3.1). */
export class AuthenticationFailedError extends HudhudError {
  static override readonly code = 'AUTHENTICATION_FAILED';
  static override readonly errorName = 'AuthenticationFailedError';
}

/** Code `SESSION_POISONED` (plan §3.1). */
export class SessionPoisonedError extends HudhudError {
  static override readonly code = 'SESSION_POISONED';
  static override readonly errorName = 'SessionPoisonedError';
}

/** Code `PROTOCOL_ERROR` (plan §3.1). */
export class ProtocolError extends HudhudError {
  static override readonly code: HudhudErrorCode = 'PROTOCOL_ERROR';
  static override readonly errorName: string = 'ProtocolError';
}

/** Code `OVERSIZED_FRAME` (plan §3.1). */
export class OversizedFrameError extends ProtocolError {
  static override readonly code = 'OVERSIZED_FRAME';
  static override readonly errorName = 'OversizedFrameError';
}

/** Code `OUTBOUND_FRAME_TOO_LARGE` (plan §3.1). */
export class OutboundFrameTooLargeError extends HudhudError {
  static override readonly code = 'OUTBOUND_FRAME_TOO_LARGE';
  static override readonly errorName = 'OutboundFrameTooLargeError';
}

/** Code `CONTROL_REQUEST_FAILED` (plan §3.1). */
export class ControlRequestError extends HudhudError {
  static override readonly code = 'CONTROL_REQUEST_FAILED';
  static override readonly errorName = 'ControlRequestError';
}

/** Code `PROCESS_EXITED` (plan §3.1). */
export class ProcessExitedError extends HudhudError {
  static override readonly code = 'PROCESS_EXITED';
  static override readonly errorName = 'ProcessExitedError';
}

/** Code `SESSION_CLOSED` (plan §3.1). */
export class SessionClosedError extends HudhudError {
  static override readonly code = 'SESSION_CLOSED';
  static override readonly errorName = 'SessionClosedError';
}

/** Code `HARNESS_DISPOSED` (plan §3.1). */
export class HarnessDisposedError extends HudhudError {
  static override readonly code = 'HARNESS_DISPOSED';
  static override readonly errorName = 'HarnessDisposedError';
}

/** Code `SUBSCRIBER_OVERFLOW` (plan §3.1). */
export class SubscriberOverflowError extends HudhudError {
  static override readonly code = 'SUBSCRIBER_OVERFLOW';
  static override readonly errorName = 'SubscriberOverflowError';
}

/** Code `PROJECT_CREDENTIAL_ENV` (plan §3.1, K5). Details hold names only. */
export class ProjectCredentialEnvError extends HudhudError {
  static override readonly code = 'PROJECT_CREDENTIAL_ENV';
  static override readonly errorName = 'ProjectCredentialEnvError';

  /** Builds the error from guard findings; the message lists names and files, never values. */
  static fromFindings(findings: ProjectCredentialFindings): ProjectCredentialEnvError {
    const parts: string[] = [];
    if (findings.variables.length > 0) {
      parts.push(`credential variables (names only): ${findings.variables.join(', ')}`);
    }
    if (findings.apiKeyHelper) parts.push('an apiKeyHelper entry');
    if (findings.unparseable.length > 0) {
      parts.push(`unparseable settings files: ${findings.unparseable.join(', ')}`);
    }
    const what = parts.length > 0 ? parts.join('; ') : 'credential settings';
    return new ProjectCredentialEnvError(
      `Project settings define ${what}. Files: ${findings.files.join(', ')}.`,
      {
        details: {
          files: [...findings.files],
          variables: [...findings.variables],
          apiKeyHelper: findings.apiKeyHelper,
          unparseable: [...findings.unparseable],
        },
      },
    );
  }
}

/** Code `ABORTED` (plan §3.1). `name` is `'AbortError'`; `cause` is `signal.reason`. */
export class AbortError extends HudhudError {
  static override readonly code = 'ABORTED';
  static override readonly errorName = 'AbortError';

  constructor(message = 'The operation was aborted.', options: HudhudErrorOptions = {}) {
    super(message, options);
  }

  /** Builds the error for an aborted signal, keeping `signal.reason` as `cause`. */
  static fromSignal(signal: AbortSignalLike): AbortError {
    return new AbortError(undefined, { cause: signal.reason });
  }
}

type ErrorClass = new (message: string, options?: HudhudErrorOptions) => HudhudError;

/** Exhaustive by construction: a missing code is a compile error. */
const ERROR_CLASSES: Readonly<Record<HudhudErrorCode, ErrorClass>> = {
  INVALID_OPTIONS: InvalidOptionsError,
  CAPABILITY_UNSUPPORTED: CapabilityUnsupportedError,
  ADAPTER_API_VERSION_MISMATCH: AdapterApiVersionError,
  BINARY_NOT_FOUND: BinaryNotFoundError,
  BINARY_REFUSED: BinaryRefusedError,
  BINARY_VERIFICATION_FAILED: BinaryVerificationError,
  BINARY_PROBE_FAILED: BinaryProbeError,
  CWD_INVALID: CwdInvalidError,
  CWD_TOO_LONG: CwdTooLongError,
  PROJECT_CREDENTIAL_ENV: ProjectCredentialEnvError,
  SESSION_ID_IN_USE: SessionIdInUseError,
  SPAWN_FAILED: SpawnError,
  HANDSHAKE_TIMEOUT: HandshakeTimeoutError,
  HANDSHAKE_FAILED: HandshakeError,
  SESSION_NOT_FOUND: SessionNotFoundError,
  AUTHENTICATION_FAILED: AuthenticationFailedError,
  SESSION_POISONED: SessionPoisonedError,
  PROTOCOL_ERROR: ProtocolError,
  OVERSIZED_FRAME: OversizedFrameError,
  OUTBOUND_FRAME_TOO_LARGE: OutboundFrameTooLargeError,
  CONTROL_REQUEST_FAILED: ControlRequestError,
  PROCESS_EXITED: ProcessExitedError,
  SESSION_CLOSED: SessionClosedError,
  HARNESS_DISPOSED: HarnessDisposedError,
  ABORTED: AbortError,
  SUBSCRIBER_OVERFLOW: SubscriberOverflowError,
};
