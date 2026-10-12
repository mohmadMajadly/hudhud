// Errors as data (plan §1.4, §3.1): source of schemas/errors.schema.json.

import Type from 'typebox';

import { JsonObjectSchema, openEnum, type SchemaDocument } from './common.js';

/** Every error code of plan §3.1, in table order. */
export const KNOWN_ERROR_CODES = [
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

/** Open on read (ADR-0005 §6): a later version may add codes. */
export const HudhudErrorCode = openEnum(KNOWN_ERROR_CODES);

export const ErrorData = Type.Object({
  code: HudhudErrorCode,
  message: Type.String(),
  retryable: Type.Boolean(),
  details: Type.Optional(JsonObjectSchema),
});

export const errorsDocument: SchemaDocument = {
  file: 'errors.schema.json',
  title: 'hudhud error data',
  description:
    'Errors as data: the code, a message, whether repeating the same call may succeed, and JSON details.',
  root: 'ErrorData',
  defs: { HudhudErrorCode, ErrorData },
};
