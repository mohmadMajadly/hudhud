// W4-Z ruling 3: the bounded feature parser of W4-T3 (`parseFeatures`: at
// most 256 names of at most 128 characters, `[A-Za-z0-9][A-Za-z0-9_.:-]*`,
// unique, unknown names kept) drops no feature name that any recording
// carries, and the session facts and turns carry the recorded names
// unchanged.

import type { JsonObject, JsonValue } from '@hudhudjs/core/protocol';
import { describe, expect, it } from 'vitest';

import {
  MAX_FEATURE_LENGTH,
  MAX_FEATURES,
  parseFeatures,
} from '../../src/protocol/wire/features.js';
import { loadConformanceSuites, type ConformanceVariant } from './loader.js';
import { denormalize, replayVariant } from './replay.js';

const variants = loadConformanceSuites().flatMap((suite) => suite.variants);

function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)[key]
    : undefined;
}

/** The recorded feature arrays of a variant: `system/init` and the `initialize` response. */
function recordedFeatures(variant: ConformanceVariant): {
  readonly init: JsonValue[][];
  readonly initialize: JsonValue[][];
} {
  const init: JsonValue[][] = [];
  const initialize: JsonValue[][] = [];
  for (const record of variant.records) {
    if (record.dir !== 'out') continue;
    const frame = denormalize(record.v);
    const response = field(field(frame, 'response'), 'response');
    if (field(frame, 'type') === 'system' && field(frame, 'subtype') === 'init') {
      const list = field(frame, 'capabilities');
      if (Array.isArray(list)) init.push([...(list as readonly JsonValue[])]);
    } else if (field(frame, 'type') === 'control_response') {
      const list = field(response, 'capabilities');
      if (Array.isArray(list)) initialize.push([...(list as readonly JsonValue[])]);
    }
  }
  return { init, initialize };
}

describe('the recorded feature names', () => {
  it('all pass the bounded parser unchanged', () => {
    const names = new Set<string>();
    let arrays = 0;
    for (const variant of variants) {
      const { init, initialize } = recordedFeatures(variant);
      for (const list of [...init, ...initialize]) {
        arrays += 1;
        expect(list.length, variant.id).toBeLessThanOrEqual(MAX_FEATURES);
        for (const name of list) {
          expect(typeof name, variant.id).toBe('string');
          expect((name as string).length, variant.id).toBeLessThanOrEqual(MAX_FEATURE_LENGTH);
          names.add(name as string);
        }
        expect(parseFeatures(list), variant.id).toEqual(list);
      }
    }
    // Every variant recorded an initialize response, and system/init frames.
    expect(arrays).toBeGreaterThan(2 * variants.length);
    expect([...names]).toEqual(
      expect.arrayContaining(['msg_lifecycle_v1', 'interrupt_receipt_v1', 'ui_surface_v1']),
    );
  });

  it('reach the session facts and every started turn unchanged', () => {
    let handshakes = 0;
    let turns = 0;
    for (const variant of variants) {
      const { init, initialize } = recordedFeatures(variant);
      const effects = replayVariant(variant).effects.flat();
      for (const effect of effects) {
        if (effect.type === 'handshake.ok') {
          handshakes += 1;
          expect(initialize, variant.id).toContainEqual(effect.info.features);
        } else if (effect.type === 'event' && effect.event.type === 'turn.started') {
          turns += 1;
          expect(init, variant.id).toContainEqual(
            field(effect.event as unknown as JsonValue, 'features'),
          );
        }
      }
    }
    // Not vacuous: most variants complete a handshake and start turns.
    expect(handshakes).toBeGreaterThan(variants.length / 2);
    expect(turns).toBeGreaterThan(variants.length);
  });
});
