/**
 * Builders for every frame hudhud writes to the Claude Code CLI's stdin
 * (plan §1.5, K3), and the checks that guard the control channel.
 *
 * @remarks
 * Stdin carries the agent's full authority (ADR-0012, 02 §10): whoever writes
 * it can change settings, call MCP tools without a permission check and read
 * files. The builders therefore copy only the fields hudhud authors, by name,
 * into fresh objects; nothing is spread from caller or CLI data. Every typed
 * frame passes the strict generated validator before it is encoded
 * ({@link encodeOutboundFrame}), so a frame with an unknown key, for example
 * `initialize.workspaceTrust`, can never be written (ADR-0012 §2, J3).
 *
 * The unstable `/raw` tier (plan §2.6) writes control requests the strict
 * schema does not know; {@link rawControlRefusal} and {@link rawFrameRefusal}
 * still refuse the two that write the user's configuration: `initialize`
 * (the only carrier of `workspaceTrust`, and owned by the session machine)
 * and `update_settings` without the config-write opt-in (ADR-0012 §3, §7).
 *
 * Sans-IO (ADR-0006).
 *
 * @packageDocumentation
 */

import {
  encodeJsonLine,
  isJsonObject,
  isJsonValue,
  makeErrorData,
  ownObject,
  ownString,
  type EncodeJsonLineResult,
  type JsonObject,
  type JsonValue,
  type KnownErrorData,
} from '@hudhud/core/protocol';

import { validateOutboundFrame } from '../generated/validators.gen.js';
import type {
  PermissionDecisionWire,
  PermissionModeWire,
  UserContentBlockWire,
  UserContentWire,
} from './types.js';

/**
 * The `initialize` control request.
 *
 * @remarks
 * `InitializeBody` has no fields in v1 (ADR-0015 provenance ruling) and no
 * `workspaceTrust` field at all, so the builder takes no body: there is no
 * value from which `workspaceTrust` could be copied. A future field becomes a
 * named parameter here and a property of the strict schema.
 *
 * @internal
 */
export function initializeRequest(requestId: string): JsonObject {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } };
}

/**
 * The `interrupt` control request (05 §7).
 *
 * @internal
 */
export function interruptRequest(requestId: string, cancelQueued: boolean): JsonObject {
  return {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'interrupt', cancel_queued: cancelQueued },
  };
}

/**
 * The `set_permission_mode` control request.
 *
 * @internal
 */
export function setPermissionModeRequest(requestId: string, mode: PermissionModeWire): JsonObject {
  return {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'set_permission_mode', mode },
  };
}

function contentBlock(block: UserContentBlockWire): JsonObject {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return {
    type: 'image',
    source: {
      type: block.source.type,
      media_type: block.source.media_type,
      data: block.source.data,
    },
  };
}

/**
 * A user message (05 §5): `content` as a string or Messages API blocks, and
 * the `uuid` the CLI echoes in `result.user_message_uuid(s)`. The shape
 * follows the MIT Python SDK (`parent_tool_use_id: null`, `session_id: ""`).
 *
 * @internal
 */
export function userMessage(uuid: string, content: UserContentWire): JsonObject {
  const copied: JsonValue = typeof content === 'string' ? content : content.map(contentBlock);
  return {
    type: 'user',
    message: { role: 'user', content: copied },
    parent_tool_use_id: null,
    session_id: '',
    uuid,
  };
}

function decisionBody(decision: PermissionDecisionWire): JsonObject {
  if (decision.behavior === 'allow') {
    const body: Record<string, JsonValue> = { behavior: 'allow' };
    if (decision.updatedInput !== undefined) body['updatedInput'] = decision.updatedInput;
    if (decision.updatedPermissions !== undefined) {
      body['updatedPermissions'] = decision.updatedPermissions;
    }
    return body;
  }
  const body: Record<string, JsonValue> = { behavior: 'deny', message: decision.message };
  if (decision.interrupt !== undefined) body['interrupt'] = decision.interrupt;
  return body;
}

/**
 * The success answer to a `can_use_tool` request (05 §6).
 *
 * @remarks
 * Only `behavior`, `updatedInput`, `updatedPermissions`, `message` and
 * `interrupt` are copied. Destination stripping and the 4096-update limit are
 * the permission machine's job (plan §1.5); the strict validator refuses more
 * than 4096 updates as a last line.
 *
 * @internal
 */
export function permissionResponse(
  requestId: string,
  decision: PermissionDecisionWire,
): JsonObject {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: decisionBody(decision) },
  };
}

/**
 * An error answer to a control request from the CLI.
 *
 * @internal
 */
export function controlErrorResponse(requestId: string, message: string): JsonObject {
  return {
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error: message },
  };
}

/**
 * Checks a typed outbound frame against the strict schema, then encodes it
 * with the outbound byte cap (ADR-0011 §7).
 *
 * @remarks
 * A frame the schema refuses yields `PROTOCOL_ERROR` with
 * `details.reason: 'schema'` and the failing location; nothing is encoded.
 *
 * @internal
 */
export function encodeOutboundFrame(frame: JsonObject, maxBytes: number): EncodeJsonLineResult {
  const check = validateOutboundFrame(frame);
  if (!check.ok) {
    return {
      ok: false,
      error: makeErrorData(
        'PROTOCOL_ERROR',
        'Outbound frame does not match the strict wire schema; nothing was written.',
        {
          reason: 'schema',
          instancePath: check.issue.instancePath,
          keyword: check.issue.keyword,
        },
      ),
    };
  }
  return encodeJsonLine(frame, maxBytes);
}

/**
 * What the application allowed for the raw control channel (plan §2.6).
 *
 * @internal
 */
export interface RawControlPolicy {
  /** `claudeCode.dangerouslyAllowRawControl`. */
  readonly allowRawControl: boolean;
  /** `dangerouslyAllowConfigWrites`: permits `update_settings` (ADR-0012 §3, §7). */
  readonly allowConfigWrites: boolean;
}

function refused(rule: string, message: string): KnownErrorData {
  return makeErrorData('INVALID_OPTIONS', message, { rule });
}

/**
 * Why a raw control request may not be sent, or `undefined` when it may.
 *
 * @remarks
 * Refused: raw control not enabled; an empty subtype; `initialize` (the
 * session sends it, and it is the only carrier of `workspaceTrust`, J3);
 * `update_settings` unless config writes are allowed; a body that is not
 * plain JSON or that carries its own `subtype` key.
 *
 * @internal
 */
export function rawControlRefusal(
  subtype: string,
  body: JsonObject | undefined,
  policy: RawControlPolicy,
): KnownErrorData | undefined {
  if (!policy.allowRawControl) {
    return refused(
      'raw-control-disabled',
      'Raw control requests need claudeCode.dangerouslyAllowRawControl: true.',
    );
  }
  if (subtype.length === 0) return refused('raw-subtype-empty', 'The control subtype is empty.');
  if (subtype === 'initialize') {
    return refused(
      'raw-initialize',
      'initialize is sent by the session itself and cannot be sent through the raw tier.',
    );
  }
  if (subtype === 'update_settings' && !policy.allowConfigWrites) {
    return refused(
      'raw-config-write',
      'update_settings writes settings files; it needs dangerouslyAllowConfigWrites: true.',
    );
  }
  if (body !== undefined) {
    if (!isJsonObject(body) || !isJsonValue(body)) {
      return refused('raw-body-not-json', 'The control request body is not a plain JSON object.');
    }
    if (Object.hasOwn(body, 'subtype')) {
      return refused('raw-body-subtype', 'The control request body may not carry a subtype key.');
    }
  }
  return undefined;
}

/**
 * A raw control request: `request` is `{ subtype, ...body }`, built from the
 * body's own enumerable keys as data properties (a `__proto__` key stays an
 * own key and never reaches a prototype). Check {@link rawControlRefusal}
 * first.
 *
 * @internal
 */
export function rawControlRequest(
  requestId: string,
  subtype: string,
  body: JsonObject | undefined,
): JsonObject {
  const request: JsonObject = Object.fromEntries<JsonValue>([
    ['subtype', subtype],
    ...(body === undefined ? [] : Object.entries(body)),
  ]);
  return { type: 'control_request', request_id: requestId, request };
}

/**
 * Why a caller-built raw frame (`RawSession.writeFrame`, plan §2.6) may not
 * be written, or `undefined` when it may. Applies the control-request rules
 * of {@link rawControlRefusal} to a `control_request` frame.
 *
 * @internal
 */
export function rawFrameRefusal(
  frame: JsonObject,
  policy: RawControlPolicy,
): KnownErrorData | undefined {
  if (!policy.allowRawControl) return rawControlRefusal('', undefined, policy);
  if (!isJsonObject(frame) || !isJsonValue(frame)) {
    return refused('raw-frame-not-json', 'The raw frame is not a plain JSON object.');
  }
  if (ownString(frame, 'type') !== 'control_request') return undefined;
  const request = ownObject(frame, 'request');
  const subtype = request === undefined ? undefined : ownString(request, 'subtype');
  if (subtype === undefined) {
    return refused('raw-frame-no-subtype', 'A raw control_request needs request.subtype.');
  }
  return rawControlRefusal(subtype, undefined, policy);
}
