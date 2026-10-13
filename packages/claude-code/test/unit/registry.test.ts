// The per-Harness live session-id registry (plan §1.8, ADR-0008, J6).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { HarnessDisposedError, isHudhudError, SessionIdInUseError } from '@hudhud/core';

import { MAX_SESSION_ID_LENGTH, SessionRegistry } from '../../src/registry.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('SessionRegistry', () => {
  it('claims an id, refuses a second live claim and frees it on release', () => {
    const registry = new SessionRegistry();
    const claim = registry.claim(A);
    expect(claim.sessionId).toBe(A);
    expect(claim.released).toBe(false);
    expect(registry.has(A)).toBe(true);
    expect(registry.size).toBe(1);

    let caught: unknown;
    try {
      registry.claim(A);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionIdInUseError);
    expect(isHudhudError(caught) && caught.code).toBe('SESSION_ID_IN_USE');
    expect((caught as SessionIdInUseError).details).toEqual({ sessionId: A });

    claim.release();
    expect(claim.released).toBe(true);
    expect(registry.has(A)).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.claim(A).sessionId).toBe(A);
  });

  it('compares ids case-insensitively', () => {
    const registry = new SessionRegistry();
    registry.claim(A.toUpperCase());
    expect(registry.has(A)).toBe(true);
    expect(() => registry.claim(A)).toThrow(SessionIdInUseError);
  });

  it('release is idempotent and never frees an id a later claim now owns', () => {
    const registry = new SessionRegistry();
    const first = registry.claim(A);
    first.release();
    const second = registry.claim(A);
    first.release();
    expect(registry.has(A)).toBe(true);
    second.release();
    expect(registry.has(A)).toBe(false);
  });

  it('keeps registries independent: no state is shared between Harnesses', () => {
    const one = new SessionRegistry();
    const two = new SessionRegistry();
    one.claim(A);
    expect(two.has(A)).toBe(false);
    expect(() => two.claim(A)).not.toThrow();
  });

  it('rebinds a claim to the id the harness reported, atomically', () => {
    const registry = new SessionRegistry();
    const claim = registry.claim(A);
    claim.rebind(A.toUpperCase());
    expect(claim.sessionId).toBe(A.toUpperCase());
    expect(registry.size).toBe(1);

    claim.rebind(B);
    expect(claim.sessionId).toBe(B);
    expect(registry.has(A)).toBe(false);
    expect(registry.has(B)).toBe(true);
    expect(registry.size).toBe(1);

    const other = registry.claim(A);
    expect(() => {
      claim.rebind(A);
    }).toThrow(SessionIdInUseError);
    expect(claim.sessionId).toBe(B);
    expect(registry.has(B)).toBe(true);
    other.release();
    claim.release();
    expect(registry.size).toBe(0);
  });

  it('refuses to rebind a released claim', () => {
    const registry = new SessionRegistry();
    const claim = registry.claim(A);
    claim.release();
    expect(() => {
      claim.rebind(B);
    }).toThrow(TypeError);
    expect(registry.has(B)).toBe(false);
  });

  it('dispose drops every claim, refuses later ones and is idempotent', () => {
    const registry = new SessionRegistry();
    const claim = registry.claim(A);
    registry.claim(B);
    registry.dispose();
    registry.dispose();
    expect(registry.size).toBe(0);
    expect(claim.released).toBe(true);
    expect(() => {
      claim.rebind(B);
    }).toThrow(TypeError);
    claim.release();
    expect(() => registry.claim(A)).toThrow(HarnessDisposedError);
  });

  it('rejects ids that are empty, too long or hold control characters', () => {
    const registry = new SessionRegistry();
    expect(() => registry.claim('')).toThrow(TypeError);
    expect(() => registry.claim('x'.repeat(MAX_SESSION_ID_LENGTH + 1))).toThrow(TypeError);
    expect(() => registry.claim('a\u0000b')).toThrow(TypeError);
    expect(() => registry.has('a\nb')).toThrow(TypeError);
    expect(registry.claim('x'.repeat(MAX_SESSION_ID_LENGTH)).sessionId).toHaveLength(
      MAX_SESSION_ID_LENGTH,
    );
  });

  it('treats prototype-like ids as ordinary keys', () => {
    const registry = new SessionRegistry();
    registry.claim('__proto__');
    registry.claim('constructor');
    expect(registry.size).toBe(2);
    expect(registry.has('toString')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('matches a model of live ids over random operation sequences (property)', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('claim' as const), id: fc.integer({ min: 0, max: 4 }) }),
      fc.record({ kind: fc.constant('release' as const), id: fc.integer({ min: 0, max: 4 }) }),
      fc.record({
        kind: fc.constant('rebind' as const),
        id: fc.integer({ min: 0, max: 4 }),
        to: fc.integer({ min: 0, max: 4 }),
      }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
        const registry = new SessionRegistry();
        const claims = new Map<number, ReturnType<SessionRegistry['claim']>>();
        const model = new Map<number, number>(); // slot -> held id
        const name = (n: number): string => `id-${String(n)}`;
        const holder = (id: number): number | undefined =>
          [...model.entries()].find(([, held]) => held === id)?.[0];
        for (const step of ops) {
          if (step.kind === 'claim') {
            const taken = holder(step.id) !== undefined;
            if (taken) {
              expect(() => registry.claim(name(step.id))).toThrow(SessionIdInUseError);
            } else if (!claims.has(step.id)) {
              claims.set(step.id, registry.claim(name(step.id)));
              model.set(step.id, step.id);
            }
          } else if (step.kind === 'release') {
            claims.get(step.id)?.release();
            claims.delete(step.id);
            model.delete(step.id);
          } else {
            const claim = claims.get(step.id);
            if (claim === undefined) continue;
            const owner = holder(step.to);
            if (owner !== undefined && owner !== step.id) {
              expect(() => {
                claim.rebind(name(step.to));
              }).toThrow(SessionIdInUseError);
            } else {
              claim.rebind(name(step.to));
              model.set(step.id, step.to);
            }
          }
          expect(registry.size).toBe(model.size);
          for (let id = 0; id <= 4; id += 1) {
            expect(registry.has(name(id))).toBe(holder(id) !== undefined);
          }
        }
      }),
    );
  });
});
