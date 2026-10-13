// Adapter registration (ADR-0004 §3): an unsupported adapter API version is
// refused at definition time.

import { describe, expect, it } from 'vitest';

import { adapterApiVersion, defineAdapter } from '../../../src/binding/adapter.js';
import { AdapterApiVersionError, InvalidOptionsError } from '../../../src/binding/errors.js';

describe('defineAdapter', () => {
  it('returns the definition frozen', () => {
    const def = defineAdapter({ name: 'claude-code', adapterApiVersion: 1, extra: 'kept' });
    expect(def).toEqual({ name: 'claude-code', adapterApiVersion: 1, extra: 'kept' });
    expect(Object.isFrozen(def)).toBe(true);
    expect(adapterApiVersion).toBe(1);
  });

  it.each([[2], [0], [Number.NaN], ['1' as unknown as number]])(
    'refuses adapter API %s',
    (version) => {
      let caught: unknown;
      try {
        defineAdapter({ name: 'x', adapterApiVersion: version });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AdapterApiVersionError);
      const details = (caught as AdapterApiVersionError).details ?? {};
      expect(details).toMatchObject({ adapter: 'x', supported: [1] });
      expect(Object.hasOwn(details, 'requested')).toBe(
        typeof version === 'number' && Number.isFinite(version),
      );
    },
  );

  it.each([[''], ['Claude'], ['-x'], ['a'.repeat(65)], [3 as unknown as string]])(
    'refuses the name %j',
    (name) => {
      expect(() => defineAdapter({ name, adapterApiVersion: 1 })).toThrow(InvalidOptionsError);
    },
  );
});
