import { describe, expect, it } from 'vitest';

import { evaluateGate } from '../lib/ci-gate.mjs';

const ok = { classify: 'success' };

describe('evaluateGate', () => {
  it.each([
    [
      'LIGHT',
      {
        ...ok,
        docs: 'success',
        linux: 'skipped',
        'node-floor': 'skipped',
        windows: 'skipped',
        macos: 'skipped',
      },
    ],
    [
      'STANDARD',
      {
        ...ok,
        docs: 'skipped',
        linux: 'success',
        'node-floor': 'success',
        windows: 'skipped',
        macos: 'skipped',
      },
    ],
    [
      'FULL',
      {
        ...ok,
        docs: 'skipped',
        linux: 'success',
        'node-floor': 'success',
        windows: 'success',
        macos: 'success',
      },
    ],
  ])('passes a green %s run', (tier, results) => {
    expect(evaluateGate(tier, results)).toEqual({ ok: true, problems: [] });
  });

  it('fails when a FULL-required OS job was skipped', () => {
    const result = evaluateGate('FULL', {
      ...ok,
      linux: 'success',
      'node-floor': 'success',
      windows: 'skipped',
      macos: 'success',
    });
    expect(result).toEqual({ ok: false, problems: ['windows: required on FULL but skipped'] });
  });

  it('requires the engines-floor job on STANDARD and FULL (R7-7)', () => {
    expect(evaluateGate('STANDARD', { ...ok, linux: 'success', 'node-floor': 'skipped' })).toEqual({
      ok: false,
      problems: ['node-floor: required on STANDARD but skipped'],
    });
    expect(
      evaluateGate('FULL', { ...ok, linux: 'success', windows: 'success', macos: 'success' }),
    ).toEqual({ ok: false, problems: ['node-floor: required on FULL but missing'] });
  });

  it('fails on any failed or cancelled job, even one the tier does not require', () => {
    const result = evaluateGate('STANDARD', {
      ...ok,
      linux: 'success',
      'node-floor': 'success',
      docs: 'cancelled',
    });
    expect(result).toEqual({ ok: false, problems: ['docs: cancelled'] });
  });

  it('fails when a required job is missing', () => {
    expect(evaluateGate('LIGHT', ok)).toEqual({
      ok: false,
      problems: ['docs: required on LIGHT but missing'],
    });
  });

  it('fails on an unknown tier (classify failed)', () => {
    expect(evaluateGate('', { classify: 'failure' })).toEqual({
      ok: false,
      problems: ['classify: failure', 'unknown tier ""'],
    });
    expect(evaluateGate(undefined, {}).ok).toBe(false);
  });
});
