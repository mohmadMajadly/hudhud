/**
 * The permission bridge: `permission.ask` effects become calls of the
 * application's handler, and its answers become `cmd.permission` inputs
 * (ADR-0006 "Callbacks", ADR-0007, ADR-0012 §3, plan §1.6).
 *
 * @remarks
 * - Every ask gets its own `AbortSignal`. A `permission.cancel` effect, the
 *   end of the session or the application's own cancellation aborts it; an
 *   answer that arrives after that is dropped. There is no default timeout
 *   (ADR-0007: a human may answer).
 * - The handler runs outside the driver's step (in a microtask), so its
 *   synchronous code never runs inside the machine's input processing, and
 *   nothing it throws or rejects with reaches the driver.
 * - The returned decision is copied in one pass and checked strictly: a
 *   plain object with exactly the keys of its behaviour, JSON values only,
 *   no accessors, bounded depth and size. The copy, never the application's
 *   object, is handed to the machine, so the application cannot change it
 *   afterwards.
 * - Fail closed: a missing handler, a throwing or rejecting handler and an
 *   invalid decision are answered through the machine with a
 *   non-interrupting deny with a fixed message (never an allow), and the
 *   application gets a diagnostic naming what failed. The handler's own
 *   error text never reaches the harness or the model.
 *
 * The neutral contract has no separate "handler failed" input, so the fixed
 * deny decision is that answer (plan §1.6).
 *
 * @packageDocumentation
 */

import type { JsonObject, JsonValue } from '../protocol/json.js';
import type { PermissionRequestData } from '../protocol/machine/contract.js';

/**
 * A permission request as the application's handler receives it (plan
 * §2.2). Every text field is untrusted harness text: pass it through
 * `sanitizeForDisplay` before rendering.
 *
 * @public
 */
export interface PermissionRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolName: string;
  readonly displayName?: string;
  readonly toolUseId: string;
  readonly input: JsonValue;
  /** Passed through, never applied. */
  readonly suggestions: readonly JsonValue[];
  readonly blockedPath?: string;
  /** Untrusted: sanitize before rendering. */
  readonly decisionReason?: string;
  readonly title?: string;
  readonly description?: string;
  readonly raw: JsonValue;
}

/**
 * The application's answer to a permission request (plan §2.2).
 *
 * @public
 */
export type PermissionDecision =
  | {
      readonly behavior: 'allow';
      readonly updatedInput?: JsonObject;
      readonly updatedPermissions?: readonly JsonObject[];
    }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: boolean };

/**
 * Decides a permission request. `ctx.signal` aborts when the request is
 * withdrawn (by the harness, on close, on abort or when the session ends);
 * the answer is then ignored. No default timeout (ADR-0007).
 *
 * @public
 */
export type PermissionHandler = (
  request: PermissionRequest,
  ctx: { readonly signal: AbortSignal },
) => Promise<PermissionDecision>;

/**
 * Why a decision was refused.
 *
 * @beta
 */
export type DecisionRefusal =
  | 'not-object'
  | 'bad-behavior'
  | 'unknown-key'
  | 'not-json'
  | 'bad-updated-input'
  | 'bad-updated-permissions'
  | 'bad-message'
  | 'bad-interrupt';

/** Deepest nesting accepted in a decision or user input. */
export const MAX_COPY_DEPTH = 64;

/** Most JSON nodes (values of any kind) accepted in one decision or user input. */
export const MAX_COPY_NODES = 100_000;

/**
 * The deny the bridge answers with when the handler threw, rejected or was
 * missing.
 *
 * @beta
 */
export const HANDLER_FAILED_DECISION: JsonObject = Object.freeze({
  behavior: 'deny',
  message: 'hudhud: permission handler failed',
  interrupt: false,
});

/**
 * The deny the bridge answers with when the handler's decision was invalid.
 *
 * @beta
 */
export const INVALID_DECISION_DECISION: JsonObject = Object.freeze({
  behavior: 'deny',
  message: 'hudhud: invalid permission decision',
  interrupt: false,
});

/** Thrown inside {@link copyJson} to abandon the copy. */
class NotJson extends Error {}

/**
 * Copies `value` as JSON in one pass, reading every property once through
 * its descriptor: plain objects (prototype `Object.prototype` or `null`) and
 * arrays with data properties only, no symbol keys, finite numbers, at most
 * {@link MAX_COPY_DEPTH} containers deep and {@link MAX_COPY_NODES} nodes.
 * Returns `undefined` for anything else. The copy is fresh and an own
 * `__proto__` key stays an own key.
 *
 * @internal
 */
export function copyJson(value: unknown): JsonValue | undefined {
  const budget = { nodes: 0 };
  try {
    return copyValue(value, 0, budget);
  } catch {
    // NotJson, or a proxy trap of the application threw: not JSON either way.
    return undefined;
  }
}

function copyValue(value: unknown, depth: number, budget: { nodes: number }): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_COPY_NODES) throw new NotJson();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new NotJson();
  }
  if (typeof value !== 'object' || depth >= MAX_COPY_DEPTH) throw new NotJson();
  if (Object.getOwnPropertySymbols(value).length > 0) throw new NotJson();
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new NotJson();
    const length = value.length;
    const keys = Object.getOwnPropertyNames(value);
    // Indices 0..length-1 plus `length`: no holes, no extra properties.
    if (keys.length !== length + 1) throw new NotJson();
    const out: JsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      out.push(copyValue(dataOf(value, String(index)), depth + 1, budget));
    }
    return out;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new NotJson();
  const out: Record<string, JsonValue> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    Object.defineProperty(out, key, {
      value: copyValue(dataOf(value, key), depth + 1, budget),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** The value of an own, enumerable data property; accessors are refused. */
function dataOf(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new NotJson();
  }
  return descriptor.value;
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a handler's decision strictly and returns the JSON copy to hand to
 * the machine.
 *
 * @beta
 */
export function validateDecision(
  value: unknown,
):
  | { readonly ok: true; readonly decision: JsonObject }
  | { readonly ok: false; readonly reason: DecisionRefusal } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not-object' };
  }
  const copy = copyJson(value);
  if (!isPlainObject(copy)) return { ok: false, reason: 'not-json' };
  const keys = Object.keys(copy);
  const behavior = copy['behavior'];
  if (behavior === 'allow') {
    if (!keys.every((key) => ['behavior', 'updatedInput', 'updatedPermissions'].includes(key))) {
      return { ok: false, reason: 'unknown-key' };
    }
    const updatedInput = copy['updatedInput'];
    if (keys.includes('updatedInput') && !isPlainObject(updatedInput)) {
      return { ok: false, reason: 'bad-updated-input' };
    }
    const updates = copy['updatedPermissions'];
    if (
      keys.includes('updatedPermissions') &&
      !(Array.isArray(updates) && updates.every((item: JsonValue) => isPlainObject(item)))
    ) {
      return { ok: false, reason: 'bad-updated-permissions' };
    }
    return { ok: true, decision: copy };
  }
  if (behavior === 'deny') {
    if (!keys.every((key) => ['behavior', 'message', 'interrupt'].includes(key))) {
      return { ok: false, reason: 'unknown-key' };
    }
    if (typeof copy['message'] !== 'string') return { ok: false, reason: 'bad-message' };
    if (keys.includes('interrupt') && typeof copy['interrupt'] !== 'boolean') {
      return { ok: false, reason: 'bad-interrupt' };
    }
    return { ok: true, decision: copy };
  }
  return { ok: false, reason: 'bad-behavior' };
}

/**
 * What the bridge needs from the driver.
 *
 * @beta
 */
export interface PermissionBridgeDeps {
  /** The application's handler; absent means every ask fails closed. */
  readonly handler: PermissionHandler | undefined;
  /** Feeds `cmd.permission` for `requestId` with `decision` (through the driver's queue). */
  answer(requestId: string, decision: JsonObject): void;
  /** Reports a failure to the application as a `diagnostic` event. */
  diagnostic(code: string, message: string, data: JsonObject): void;
}

interface PendingAsk {
  readonly controller: AbortController;
}

/** A short, display-safe name of what a handler threw. */
function failureName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  return /^[\w.-]{1,64}$/u.test(name) ? name : 'unknown';
}

/**
 * Turns `permission.ask` effects into handler calls (see the module remarks).
 *
 * @beta
 */
export class PermissionBridge {
  readonly #deps: PermissionBridgeDeps;
  readonly #pending = new Map<string, PendingAsk>();

  constructor(deps: PermissionBridgeDeps) {
    this.#deps = deps;
  }

  /** Asks still waiting for an answer. */
  get pending(): number {
    return this.#pending.size;
  }

  /**
   * Starts one ask. The handler is called in a microtask; a second ask with
   * the id of a pending one is ignored.
   */
  ask(requestId: string, request: PermissionRequestData): void {
    if (this.#pending.has(requestId)) return;
    const entry: PendingAsk = { controller: new AbortController() };
    this.#pending.set(requestId, entry);
    queueMicrotask(() => {
      void this.#run(requestId, request, entry);
    });
  }

  /** Withdraws one ask: its signal aborts with `reason`; a late answer is dropped. */
  cancel(requestId: string, reason: string): void {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) return;
    this.#pending.delete(requestId);
    this.#abort(entry, reason);
  }

  /** Withdraws every pending ask (the session ended). */
  cancelAll(reason: string): void {
    for (const requestId of [...this.#pending.keys()]) this.cancel(requestId, reason);
  }

  #abort(entry: PendingAsk, reason: string): void {
    // Outside the caller's step: abort listeners are application code.
    queueMicrotask(() => {
      entry.controller.abort(new Error(`permission request withdrawn: ${reason}`));
    });
  }

  async #run(requestId: string, request: PermissionRequestData, entry: PendingAsk): Promise<void> {
    const handler = this.#deps.handler;
    let outcome:
      | { readonly kind: 'answer'; readonly decision: unknown }
      | { readonly kind: 'failed'; readonly error: unknown };
    if (handler === undefined) {
      outcome = { kind: 'failed', error: new Error('no permission handler') };
    } else {
      try {
        outcome = {
          kind: 'answer',
          decision: await handler(request, { signal: entry.controller.signal }),
        };
      } catch (error) {
        outcome = { kind: 'failed', error };
      }
    }
    // Withdrawn meanwhile: the machine already ended this ask.
    if (this.#pending.get(requestId) !== entry) return;
    this.#pending.delete(requestId);
    if (outcome.kind === 'failed') {
      this.#deps.diagnostic(
        'permission.handler-failed',
        handler === undefined
          ? 'No permission handler is registered; the request was denied.'
          : 'The permission handler failed; the request was denied.',
        { requestId, error: failureName(outcome.error) },
      );
      this.#deps.answer(requestId, HANDLER_FAILED_DECISION);
      return;
    }
    const checked = validateDecision(outcome.decision);
    if (!checked.ok) {
      this.#deps.diagnostic(
        'permission.invalid-decision',
        'The permission decision was invalid; the request was denied.',
        { requestId, reason: checked.reason },
      );
      this.#deps.answer(requestId, INVALID_DECISION_DECISION);
      return;
    }
    this.#deps.answer(requestId, checked.decision);
  }
}
