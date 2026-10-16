/**
 * The Claude Code adapter's capabilities (plan §1.10, §2.2; architecture
 * "Capability model"; ADR-0004 §4).
 *
 * @remarks
 * Two kinds of capability, both pure and computed without touching the
 * harness:
 *
 * - {@link claudeHarnessCapabilities}: the neutral `HarnessCapabilities` of
 *   the Harness, built once at connect. It is a fixed statement about what
 *   hudhud's Claude Code v1 adapter provides plus the one runtime input, the
 *   process containment the Harness can offer (K2). The `--version` probe
 *   (K4) is deliberately not an input: feature detection uses what the
 *   harness announces, never version sniffing (ADR-0004 §4); the version only
 *   feeds the tested window in `compat.ts`.
 * - `parseFeatures` and `featureFlags` (re-exported from
 *   `protocol/wire/features.ts`, where the machines can reach them): the
 *   per-session feature strings of `system/init.capabilities` and of the
 *   `initialize` response, validated and bounded; unknown names are kept
 *   (ADR-0004 §4).
 */

import type { HarnessCapabilities, ProcessContainment } from '@hudhudjs/core';

export {
  featureFlags,
  INTERRUPT_CANCEL_QUEUED_CAPABILITY,
  INTERRUPT_RECEIPT_CAPABILITY,
  LIFECYCLE_CAPABILITY,
  MAX_FEATURE_LENGTH,
  MAX_FEATURES,
  parseFeatures,
} from './protocol/wire/features.js';
export type { ClaudeFeatureFlags } from './protocol/wire/features.js';

/**
 * Input of {@link claudeHarnessCapabilities}.
 *
 * @internal
 */
export interface ClaudeCapabilitiesInput {
  /** What the Harness can provide (K2): `'job'` only when the Windows addon loaded. */
  readonly processContainment: ProcessContainment;
  /** Why containment is `'best-effort'` (for example the addon failed to load); sanitized and bounded. */
  readonly containmentReason?: string;
}

/** Longest reason kept. */
const MAX_REASON_LENGTH = 512;

const DEFAULT_CONTAINMENT_REASON =
  'Process-tree containment is best-effort: the Windows job-object addon is not in use.';

const WORKSPACE_TRUST_CONTEXT_REASON =
  'The CLI has no per-session workspace-trust API (initialize.workspaceTrust is a persisted trust grant, ' +
  "07 §10); v1 offers workspaceTrust 'none' and 'full'.";

function cleanReason(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const stripped = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return stripped.slice(0, MAX_REASON_LENGTH);
}

/**
 * The Harness capabilities of the Claude Code adapter (plan §1.10).
 *
 * Multi-turn, resume, fork, interrupt, in-band permissions and
 * `workspaceTrust: 'none' | 'full'` are `supported`; `workspaceTrust: 'context'`
 * is `unsupported` with a reason. A `'best-effort'` containment carries a
 * reason under `processContainment`. The result is a fresh, frozen object.
 *
 * @internal
 */
export function claudeHarnessCapabilities(input: ClaudeCapabilitiesInput): HarnessCapabilities {
  const reasons: Record<string, string> = {
    'workspaceTrust.context': WORKSPACE_TRUST_CONTEXT_REASON,
  };
  if (input.processContainment === 'best-effort') {
    const given = input.containmentReason === undefined ? '' : cleanReason(input.containmentReason);
    reasons['processContainment'] = given === '' ? DEFAULT_CONTAINMENT_REASON : given;
  }
  return Object.freeze({
    multiTurn: 'supported',
    resume: 'supported',
    fork: 'supported',
    interrupt: 'supported',
    permissionsInBand: 'supported',
    workspaceTrust: Object.freeze({
      none: 'supported',
      context: 'unsupported',
      full: 'supported',
    } as const),
    processContainment: input.processContainment,
    reasons: Object.freeze(reasons),
  } as const);
}
