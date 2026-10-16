// Harness capabilities and the harness-supplied feature strings (plan §1.10,
// ADR-0004 §4).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@hudhudjs/core/protocol';

import {
  claudeHarnessCapabilities,
  featureFlags,
  INTERRUPT_CANCEL_QUEUED_CAPABILITY,
  INTERRUPT_RECEIPT_CAPABILITY,
  LIFECYCLE_CAPABILITY,
  MAX_FEATURE_LENGTH,
  MAX_FEATURES,
  parseFeatures,
} from '../../src/capabilities.js';

describe('claudeHarnessCapabilities', () => {
  it('declares the v1 set with job containment and no containment reason', () => {
    const caps = claudeHarnessCapabilities({ processContainment: 'job' });
    expect(caps).toMatchObject({
      multiTurn: 'supported',
      resume: 'supported',
      fork: 'supported',
      interrupt: 'supported',
      permissionsInBand: 'supported',
      workspaceTrust: { none: 'supported', context: 'unsupported', full: 'supported' },
      processContainment: 'job',
    });
    expect(Object.keys(caps.reasons)).toEqual(['workspaceTrust.context']);
  });

  it('explains best-effort containment, with a default or a sanitized, bounded reason', () => {
    const dflt = claudeHarnessCapabilities({ processContainment: 'best-effort' });
    expect(dflt.processContainment).toBe('best-effort');
    expect(dflt.reasons['processContainment']).toMatch(/best-effort/);

    const given = claudeHarnessCapabilities({
      processContainment: 'best-effort',
      containmentReason: ' addon\u0000 failed\nto load ',
    });
    expect(given.reasons['processContainment']).toBe('addon  failed to load');

    const long = claudeHarnessCapabilities({
      processContainment: 'best-effort',
      containmentReason: 'x'.repeat(5000),
    });
    expect(long.reasons['processContainment']).toHaveLength(512);

    const blank = claudeHarnessCapabilities({
      processContainment: 'best-effort',
      containmentReason: '\u0001 ',
    });
    expect(blank.reasons['processContainment']).toBe(dflt.reasons['processContainment']);
  });

  it('gives a reason only for best-effort containment', () => {
    const caps = claudeHarnessCapabilities({
      processContainment: 'cgroup',
      containmentReason: 'ignored',
    });
    expect(caps.reasons['processContainment']).toBeUndefined();
  });

  it('returns frozen data', () => {
    const caps = claudeHarnessCapabilities({ processContainment: 'job' });
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.workspaceTrust)).toBe(true);
    expect(Object.isFrozen(caps.reasons)).toBe(true);
  });
});

describe('parseFeatures', () => {
  it('keeps valid strings in first-seen order, unique, and tolerates unknown ones', () => {
    expect(
      parseFeatures([LIFECYCLE_CAPABILITY, 'future_thing_v9', LIFECYCLE_CAPABILITY, 'a.b:c-d']),
    ).toEqual([LIFECYCLE_CAPABILITY, 'future_thing_v9', 'a.b:c-d']);
  });

  it('drops non-strings, empty, oddly spelled and over-long entries', () => {
    const values: JsonValue[] = [
      1,
      null,
      true,
      ['x'],
      { a: 'b' },
      '',
      ' lead',
      '-lead',
      'has space',
      'new\nline',
      'ünï',
      '__proto__!',
      'x'.repeat(MAX_FEATURE_LENGTH + 1),
      'x'.repeat(MAX_FEATURE_LENGTH),
    ];
    expect(parseFeatures(values)).toEqual(['x'.repeat(MAX_FEATURE_LENGTH)]);
  });

  it('keeps names that look like prototype keys as plain strings', () => {
    const out = parseFeatures(['__proto__', 'constructor', 'toString']); // the leading underscore is refused
    expect(out).toEqual(['constructor', 'toString']);
    expect(Object.getPrototypeOf(out)).toBe(Array.prototype);
  });

  it('keeps at most MAX_FEATURES entries', () => {
    const many = Array.from({ length: MAX_FEATURES * 3 }, (_, i) => `f${String(i)}`);
    const out = parseFeatures(many);
    expect(out).toHaveLength(MAX_FEATURES);
    expect(out[0]).toBe('f0');
  });

  it('is total and bounded for arbitrary JSON arrays (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 600 }), (values) => {
        const out = parseFeatures(values as JsonValue[]);
        expect(out.length).toBeLessThanOrEqual(MAX_FEATURES);
        expect(new Set(out).size).toBe(out.length);
        for (const feature of out) {
          expect(feature.length).toBeLessThanOrEqual(MAX_FEATURE_LENGTH);
          expect(feature).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
          expect(values).toContain(feature);
        }
      }),
    );
  });

  it('keeps every valid string of an arbitrary list, up to the cap (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/), { maxLength: 100 }),
        (names) => {
          expect(parseFeatures(names)).toEqual([...new Set(names)]);
        },
      ),
    );
  });
});

describe('featureFlags', () => {
  it('derives the flags the adapter acts on and ignores unknown strings', () => {
    expect(featureFlags([])).toEqual({
      commandLifecycle: false,
      interruptReceipt: false,
      interruptCancelQueued: false,
    });
    expect(
      featureFlags([
        'mystery',
        LIFECYCLE_CAPABILITY,
        INTERRUPT_RECEIPT_CAPABILITY,
        INTERRUPT_CANCEL_QUEUED_CAPABILITY,
      ]),
    ).toEqual({ commandLifecycle: true, interruptReceipt: true, interruptCancelQueued: true });
    expect(featureFlags([INTERRUPT_RECEIPT_CAPABILITY])).toEqual({
      commandLifecycle: false,
      interruptReceipt: true,
      interruptCancelQueued: false,
    });
  });
});
