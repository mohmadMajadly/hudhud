import process from 'node:process';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { fastCheckSeedFromEnv, FcSeedError } from '../src/fast-check-seed.js';

describe('fastCheckSeedFromEnv', () => {
  it('asks for nothing when FC_SEED is unset (fast-check draws a fresh seed)', () => {
    expect(fastCheckSeedFromEnv({})).toEqual({});
  });

  it('accepts every seed fast-check prints, negative ones included', () => {
    for (const [text, seed] of [
      ['-279742588', -279742588],
      ['0', 0],
      ['2147483647', 2147483647],
      ['-2147483648', -2147483648],
    ] as const) {
      expect(fastCheckSeedFromEnv({ FC_SEED: text })).toEqual({ seed });
    }
  });

  it('refuses anything else instead of silently running with a fresh seed', () => {
    for (const text of ['', ' 1', '1 ', '1.5', '1e3', '0x10', 'abc', '2147483648', '-2147483649']) {
      expect(() => fastCheckSeedFromEnv({ FC_SEED: text })).toThrow(FcSeedError);
    }
    expect(() => fastCheckSeedFromEnv({ FC_SEED: 'abc' })).toThrow(
      'FC_SEED must be the decimal 32-bit seed fast-check printed, got "abc"',
    );
  });
});

describe('the unit setup file', () => {
  it('applies FC_SEED to every property of this run', () => {
    const env = process.env['FC_SEED'];
    expect(fc.readConfigureGlobal().seed).toBe(env === undefined ? undefined : Number(env));
  });

  it('makes a property without its own seed replay the FC_SEED run', () => {
    const seen: number[] = [];
    const run = (): void => {
      fc.assert(
        fc.property(fc.integer(), (value) => {
          seen.push(value);
        }),
        { numRuns: 5 },
      );
    };
    const previous = fc.readConfigureGlobal();
    try {
      fc.configureGlobal({ ...previous, seed: 42 });
      run();
      const first = seen.splice(0);
      run();
      expect(seen).toEqual(first);
    } finally {
      fc.configureGlobal(previous);
    }
  });
});
