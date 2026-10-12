import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  UsageEstimator,
  estimateUsageDelta,
  sanitizeUsage,
  type UsageTotals,
} from '../../../src/observability/usage.js';

describe('sanitizeUsage', () => {
  it('keeps finite non-negative numbers only', () => {
    expect(
      sanitizeUsage({
        inputTokens: 10,
        outputTokens: -1,
        cacheCreationInputTokens: Number.NaN,
        cacheReadInputTokens: Number.POSITIVE_INFINITY,
        costUsd: 0,
      }),
    ).toEqual({ inputTokens: 10, costUsd: 0 });
  });
});

describe('estimateUsageDelta', () => {
  it('is the difference of cumulative totals, marked as an estimate', () => {
    const delta = estimateUsageDelta(
      { inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
      { inputTokens: 25, outputTokens: 5, costUsd: 0.3, cacheReadInputTokens: 7 },
    );
    expect(delta).toEqual({
      inputTokens: 15,
      outputTokens: 0,
      costUsd: 0.2,
      cacheReadInputTokens: 7,
      estimate: true,
    });
  });

  it('treats a lower total as a reset and starts from the new total', () => {
    expect(estimateUsageDelta({ inputTokens: 100 }, { inputTokens: 4 })).toEqual({
      inputTokens: 4,
      estimate: true,
    });
  });

  it('takes the whole total without a previous report and ignores invalid fields', () => {
    expect(estimateUsageDelta(undefined, { outputTokens: 3, inputTokens: -2 })).toEqual({
      outputTokens: 3,
      estimate: true,
    });
    expect(estimateUsageDelta({ outputTokens: Number.NaN }, { outputTokens: 3 })).toEqual({
      outputTokens: 3,
      estimate: true,
    });
  });

  it('never produces a negative or non-finite delta', () => {
    const totals: fc.Arbitrary<UsageTotals> = fc.record(
      {
        inputTokens: fc.oneof(fc.nat(), fc.double()),
        outputTokens: fc.oneof(fc.nat(), fc.double()),
        cacheCreationInputTokens: fc.nat(),
        cacheReadInputTokens: fc.nat(),
        costUsd: fc.double({ min: 0, max: 1000 }),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.option(totals, { nil: undefined }), totals, (previous, current) => {
        const delta = estimateUsageDelta(previous, current);
        expect(delta.estimate).toBe(true);
        for (const [key, value] of Object.entries(delta)) {
          if (key === 'estimate') continue;
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });
});

describe('UsageEstimator', () => {
  it('tracks cumulative reports and yields deltas', () => {
    const estimator = new UsageEstimator();
    expect(estimator.reported).toBeUndefined();
    expect(estimator.observe({ inputTokens: 5, outputTokens: -3 })).toEqual({
      reported: { inputTokens: 5 },
      estimatedDelta: { inputTokens: 5, estimate: true },
    });
    expect(estimator.observe({ inputTokens: 12 })).toEqual({
      reported: { inputTokens: 12 },
      estimatedDelta: { inputTokens: 7, estimate: true },
    });
    expect(estimator.reported).toEqual({ inputTokens: 12 });
  });
});
