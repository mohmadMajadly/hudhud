/**
 * The live session-id registry of one Harness (plan §1.8, ADR-0008, J6).
 *
 * @remarks
 * The CLI has no session lock: two processes resuming one session diverge
 * (last written branch wins, 07 §1). hudhud refuses a second live
 * `create` or `resume` of the same session id within one Harness with
 * `SESSION_ID_IN_USE`; the cross-process hazard is documented, not prevented.
 *
 * Design (the plan only says "per-Harness live session-id lock"):
 *
 * - An instance, never module state: each Harness constructs its own
 *   {@link SessionRegistry}, so Harnesses do not see each other's sessions
 *   and nothing leaks across tests or hosts.
 * - Claims, not a bare set: {@link SessionRegistry.claim} returns a
 *   {@link SessionClaim} whose idempotent `release()` frees exactly the id it
 *   holds. A stale release (after `rebind`, after `dispose`, or a second
 *   call) can never free an id another session now owns.
 * - {@link SessionClaim.rebind} moves a claim to the id the harness reported
 *   (a `create` without a caller-supplied id learns it from `system/init`)
 *   atomically: on a conflict the claim keeps its old id.
 * - Ids compare case-insensitively (UUIDs). An id is a non-empty string of at
 *   most {@link MAX_SESSION_ID_LENGTH} characters without control
 *   characters, so memory is bounded by live sessions times that length;
 *   anything else is a programming error (`TypeError`), because option
 *   validation has already checked ids before they reach the registry.
 * - {@link SessionRegistry.dispose} drops every claim and makes later claims
 *   fail with `HARNESS_DISPOSED`, so disposing a Harness cleans up
 *   deterministically even if a session never released.
 */

import { HarnessDisposedError, SessionIdInUseError } from '@hudhud/core';

/**
 * Longest session id the registry accepts.
 *
 * @internal
 */
export const MAX_SESSION_ID_LENGTH = 128;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function keyOf(sessionId: string): string {
  if (sessionId === '' || sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new TypeError(`A session id has 1 to ${String(MAX_SESSION_ID_LENGTH)} characters.`);
  }
  if (CONTROL.test(sessionId)) throw new TypeError('A session id has no control characters.');
  return sessionId.toLowerCase();
}

function inUse(sessionId: string): SessionIdInUseError {
  return new SessionIdInUseError('A live session with this id already exists in this Harness.', {
    details: { sessionId },
  });
}

/**
 * The hold on one live session id.
 *
 * @internal
 */
export interface SessionClaim {
  /** The id currently held (as claimed or rebound). */
  readonly sessionId: string;
  /** `true` after `release()` or after the registry was disposed. */
  readonly released: boolean;
  /**
   * Moves the claim to another id. Throws `SESSION_ID_IN_USE` when another
   * claim holds it, leaving this claim unchanged; a no-op for the id already
   * held; a `TypeError` after release.
   */
  rebind(sessionId: string): void;
  /** Frees the id. Idempotent. */
  release(): void;
}

/**
 * The live session ids of one Harness.
 *
 * @internal
 */
export class SessionRegistry {
  readonly #live = new Map<string, Claim>();
  #disposed = false;

  /** Number of live claims. */
  get size(): number {
    return this.#live.size;
  }

  /** Whether an id is held by a live claim. */
  has(sessionId: string): boolean {
    return this.#live.has(keyOf(sessionId));
  }

  /**
   * Claims an id for a session about to start.
   *
   * @throws HarnessDisposedError after {@link SessionRegistry.dispose}
   * @throws SessionIdInUseError when a live claim holds the id
   */
  claim(sessionId: string): SessionClaim {
    const key = keyOf(sessionId);
    if (this.#disposed) throw new HarnessDisposedError('The Harness was disposed.');
    if (this.#live.has(key)) throw inUse(sessionId);
    const claim = new Claim(this.#live, sessionId, key);
    this.#live.set(key, claim);
    return claim;
  }

  /** Drops every claim and refuses later ones. Idempotent. */
  dispose(): void {
    this.#disposed = true;
    for (const claim of this.#live.values()) claim.drop();
    this.#live.clear();
  }
}

class Claim implements SessionClaim {
  readonly #live: Map<string, Claim>;
  #key: string;
  #id: string;
  #released = false;

  constructor(live: Map<string, Claim>, sessionId: string, key: string) {
    this.#live = live;
    this.#id = sessionId;
    this.#key = key;
  }

  get sessionId(): string {
    return this.#id;
  }

  get released(): boolean {
    return this.#released;
  }

  rebind(sessionId: string): void {
    if (this.#released) throw new TypeError('The claim was released.');
    const key = keyOf(sessionId);
    if (key !== this.#key) {
      if (this.#live.has(key)) throw inUse(sessionId);
      this.#live.delete(this.#key);
      this.#live.set(key, this);
      this.#key = key;
    }
    this.#id = sessionId;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#live.delete(this.#key);
  }

  /** The registry cleared its map; only the flag is left to set. */
  drop(): void {
    this.#released = true;
  }
}
