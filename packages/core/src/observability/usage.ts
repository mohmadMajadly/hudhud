/**
 * Usage reporting: cumulative totals as reported by the harness plus deltas
 * estimated by hudhud (ADR-0016 §3).
 *
 * @remarks
 * Harness cost figures are client-side estimates and can lag or be absent;
 * every delta computed here is typed `{ estimate: true }` so it can never be
 * confused with a reported value. A reported total lower than the previous
 * one is taken as a counter reset: the delta is then the new total. Values
 * that are not finite non-negative numbers are ignored. Pure and
 * deterministic.
 *
 * @packageDocumentation
 */

import type { UsageTotals } from '../protocol/events/types.js';

export type { UsageTotals };

/**
 * A usage delta computed by hudhud, never reported by the harness.
 *
 * @public
 */
export type EstimatedUsage = UsageTotals & { readonly estimate: true };

/**
 * One observation: the sanitized reported totals and the estimated delta
 * since the previous observation (the payload of a `usage.update` event).
 *
 * @public
 */
export interface UsageObservation {
  readonly reported: UsageTotals;
  readonly estimatedDelta: EstimatedUsage;
}

type Field = keyof UsageTotals;

const FIELDS: readonly Field[] = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'costUsd',
];

/** Cost deltas are rounded to nano-dollars so float noise stays out of reports. */
const COST_SCALE = 1e9;

function valid(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/**
 * Keeps only the valid fields of `usage` (finite, non-negative numbers).
 *
 * @public
 */
export function sanitizeUsage(usage: UsageTotals): UsageTotals {
  const out: Partial<Record<Field, number>> = {};
  for (const field of FIELDS) {
    const value = usage[field];
    if (valid(value)) out[field] = value;
  }
  return out;
}

/**
 * The estimated delta between two cumulative reports. A field is present in
 * the delta when it is valid in `current`; it equals `current - previous`,
 * or `current` when `previous` lacks the field or is larger (reset).
 *
 * @public
 */
export function estimateUsageDelta(
  previous: UsageTotals | undefined,
  current: UsageTotals,
): EstimatedUsage {
  const delta: Partial<Record<Field, number>> = {};
  for (const field of FIELDS) {
    const now = current[field];
    if (!valid(now)) continue;
    const before = previous?.[field];
    let value = valid(before) && before <= now ? now - before : now;
    if (field === 'costUsd') value = Math.round(value * COST_SCALE) / COST_SCALE;
    delta[field] = value;
  }
  return { ...delta, estimate: true };
}

/**
 * Tracks cumulative reports of one session and yields estimated deltas.
 *
 * @public
 */
export class UsageEstimator {
  #last: UsageTotals | undefined;

  /** The last sanitized report, if any. */
  get reported(): UsageTotals | undefined {
    return this.#last;
  }

  /** Records a cumulative report and returns it with the estimated delta. */
  observe(report: UsageTotals): UsageObservation {
    const reported = sanitizeUsage(report);
    const estimatedDelta = estimateUsageDelta(this.#last, reported);
    this.#last = reported;
    return { reported, estimatedDelta };
  }
}
