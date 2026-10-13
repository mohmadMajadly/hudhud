/**
 * The feature strings a Claude Code session announces (plan §1.10, ADR-0004
 * §4): validation of the harness-supplied `capabilities` arrays of
 * `system/init` and of the `initialize` response, and the flags hudhud acts
 * on.
 *
 * @remarks
 * Pure and inside the protocol layer (K3) so that the session and turn
 * machines can use it; `capabilities.ts` re-exports it. The arrays come from
 * the harness, so they are bounded: at most {@link MAX_FEATURES} entries of at
 * most {@link MAX_FEATURE_LENGTH} characters of a restricted alphabet,
 * duplicates dropped, anything else discarded. A feature string hudhud does
 * not know is kept (unknown capabilities are tolerated) and simply has no
 * flag.
 */

import type { JsonValue } from '@hudhud/core/protocol';

/**
 * The `system/init` capability that announces `command_lifecycle` frames
 * (05 §5).
 *
 * @internal
 */
export const LIFECYCLE_CAPABILITY = 'msg_lifecycle_v1';

/**
 * The capability that announces the interrupt receipt (05 §5).
 *
 * @internal
 */
export const INTERRUPT_RECEIPT_CAPABILITY = 'interrupt_receipt_v1';

/**
 * The capability that announces cancelling a queued message with an
 * interrupt (05 §5).
 *
 * @internal
 */
export const INTERRUPT_CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1';

/**
 * Most feature strings kept from one frame; the rest are dropped.
 *
 * @internal
 */
export const MAX_FEATURES = 256;

/**
 * Longest feature string kept; a longer one is dropped.
 *
 * @internal
 */
export const MAX_FEATURE_LENGTH = 128;

/** Feature names seen so far are `[a-z0-9_]`; dots, colons and dashes are tolerated. */
const FEATURE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * The valid, unique feature strings of a harness-supplied array, in first-seen
 * order. Non-strings, empty, over-long, oddly spelled and surplus entries are
 * dropped; the result is a fresh array.
 *
 * @internal
 */
export function parseFeatures(values: readonly JsonValue[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.size >= MAX_FEATURES) break;
    if (typeof value !== 'string' || value.length > MAX_FEATURE_LENGTH) continue;
    if (FEATURE_NAME.test(value)) seen.add(value);
  }
  return [...seen];
}

/**
 * The features hudhud acts on, derived from a session's feature strings.
 *
 * @internal
 */
export interface ClaudeFeatureFlags {
  /** `command_lifecycle` frames are emitted (`msg_lifecycle_v1`). */
  readonly commandLifecycle: boolean;
  /** An interrupt is answered with a receipt (`interrupt_receipt_v1`). */
  readonly interruptReceipt: boolean;
  /** An interrupt can cancel a queued message (`interrupt_cancel_queued_v1`). */
  readonly interruptCancelQueued: boolean;
}

/**
 * The flags of a session's feature strings. Unknown strings are ignored.
 *
 * @internal
 */
export function featureFlags(features: readonly string[]): ClaudeFeatureFlags {
  return {
    commandLifecycle: features.includes(LIFECYCLE_CAPABILITY),
    interruptReceipt: features.includes(INTERRUPT_RECEIPT_CAPABILITY),
    interruptCancelQueued: features.includes(INTERRUPT_CANCEL_QUEUED_CAPABILITY),
  };
}
