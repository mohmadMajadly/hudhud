/**
 * Routing classification of the frames the Claude Code CLI writes to stdout
 * (plan §1.5, K3).
 *
 * @remarks
 * Lenient (ADR-0005 §7, ADR-0011 §7-8, 02 §3): an unknown `type` or `subtype`
 * is a `conversation` frame; `malformed` only when a routing field is missing
 * or has the wrong JSON type. The routing fields are those of the
 * `InboundEnvelope` schema (`wire-inbound.schema.json`): `type`, `request_id`,
 * `request.subtype`, `response.subtype`, `response.request_id`, and on
 * conversation frames `subtype`, `uuid` and `session_id` when present. A test
 * checks that `malformed` agrees with the generated envelope validator.
 *
 * Frames are untrusted (ADR-0012 §8): every field is read as an own property,
 * so a `__proto__` key stays inert, and the frame is never copied or merged.
 * Sans-IO (ADR-0006).
 *
 * @packageDocumentation
 */

import {
  isJsonObject,
  ownObject,
  ownString,
  type JsonObject,
  type JsonValue,
} from '@hudhudjs/core/protocol';

/**
 * The routing class of one inbound frame.
 *
 * @remarks
 * `frame` is the frame as parsed, unchanged. A `control_response` whose
 * `response.subtype` is neither `success` nor `error` is a failed response
 * (`ok: false`) so its request settles instead of waiting forever; its
 * `error` names the subtype. A success whose `response.response` is absent
 * or not an object has `response` omitted.
 *
 * @internal
 */
export type InboundClass =
  | {
      readonly kind: 'control_request';
      readonly requestId: string;
      readonly subtype: string;
      readonly frame: JsonObject;
    }
  | {
      readonly kind: 'control_response';
      readonly requestId: string;
      readonly ok: true;
      readonly response?: JsonObject;
      readonly frame: JsonObject;
    }
  | {
      readonly kind: 'control_response';
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
      readonly frame: JsonObject;
    }
  | {
      readonly kind: 'control_cancel_request';
      readonly requestId: string;
      readonly frame: JsonObject;
    }
  | { readonly kind: 'keep_alive'; readonly frame: JsonObject }
  | {
      readonly kind: 'conversation';
      readonly type: string;
      readonly subtype?: string;
      readonly frame: JsonObject;
    }
  | { readonly kind: 'malformed'; readonly reason: MalformedReason; readonly frame: JsonObject };

/**
 * Why a frame is `malformed`: the routing field that is missing or has the
 * wrong JSON type.
 *
 * @internal
 */
export type MalformedReason =
  | 'type'
  | 'request_id'
  | 'request'
  | 'request.subtype'
  | 'response'
  | 'response.subtype'
  | 'response.request_id'
  | 'subtype'
  | 'uuid'
  | 'session_id';

function malformed(reason: MalformedReason, frame: JsonObject): InboundClass {
  return { kind: 'malformed', reason, frame };
}

function ownValue(obj: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** An own optional field that is present must be a string. */
function optionalStringIsWrong(obj: JsonObject, key: string): boolean {
  return Object.hasOwn(obj, key) && typeof obj[key] !== 'string';
}

function classifyControlResponse(frame: JsonObject): InboundClass {
  const response = ownObject(frame, 'response');
  if (response === undefined) return malformed('response', frame);
  const subtype = ownString(response, 'subtype');
  if (subtype === undefined) return malformed('response.subtype', frame);
  const requestId = ownString(response, 'request_id');
  if (requestId === undefined) return malformed('response.request_id', frame);
  if (subtype === 'success') {
    const body = ownValue(response, 'response');
    return isJsonObject(body)
      ? { kind: 'control_response', requestId, ok: true, response: body, frame }
      : { kind: 'control_response', requestId, ok: true, frame };
  }
  if (subtype === 'error') {
    const error = ownString(response, 'error') ?? '';
    return { kind: 'control_response', requestId, ok: false, error, frame };
  }
  return {
    kind: 'control_response',
    requestId,
    ok: false,
    error: `unrecognized control response subtype ${JSON.stringify(subtype.slice(0, 64))}`,
    frame,
  };
}

/**
 * Classifies one parsed inbound frame by its routing envelope. Total: never
 * throws for any JSON object.
 *
 * @internal
 */
export function classifyInbound(frame: JsonObject): InboundClass {
  const type = ownString(frame, 'type');
  if (type === undefined) return malformed('type', frame);
  switch (type) {
    case 'control_request': {
      const requestId = ownString(frame, 'request_id');
      if (requestId === undefined) return malformed('request_id', frame);
      const request = ownObject(frame, 'request');
      if (request === undefined) return malformed('request', frame);
      const subtype = ownString(request, 'subtype');
      if (subtype === undefined) return malformed('request.subtype', frame);
      return { kind: 'control_request', requestId, subtype, frame };
    }
    case 'control_response':
      return classifyControlResponse(frame);
    case 'control_cancel_request': {
      const requestId = ownString(frame, 'request_id');
      if (requestId === undefined) return malformed('request_id', frame);
      return { kind: 'control_cancel_request', requestId, frame };
    }
    case 'keep_alive':
      return { kind: 'keep_alive', frame };
    default: {
      if (optionalStringIsWrong(frame, 'subtype')) return malformed('subtype', frame);
      if (optionalStringIsWrong(frame, 'uuid')) return malformed('uuid', frame);
      if (optionalStringIsWrong(frame, 'session_id')) return malformed('session_id', frame);
      const subtype = ownString(frame, 'subtype');
      return subtype === undefined
        ? { kind: 'conversation', type, frame }
        : { kind: 'conversation', type, subtype, frame };
    }
  }
}
