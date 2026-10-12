import { describe, expect, it } from 'vitest';

import { createAllowlist, DEFAULT_ALLOWLIST } from '../../src/mock/allowlist.js';

describe('allowlist', () => {
  it('allows only POST /v1/messages?beta=true by default (ADR-0013 §5)', () => {
    const allowlist = createAllowlist();
    expect(allowlist.entries).toEqual(DEFAULT_ALLOWLIST);
    expect(allowlist.allows('POST', '/v1/messages?beta=true')).toBe(true);
    for (const [method, target] of [
      ['GET', '/v1/messages?beta=true'],
      ['POST', '/v1/messages'],
      ['POST', '/v1/messages?beta=false'],
      ['POST', '/v1/messages?beta=true&x=1'],
      ['POST', '/v1/messages/count_tokens?beta=true'],
      ['post', '/v1/messages?beta=true'],
      ['GET', '/api/claude_cli/bootstrap'],
    ] as const) {
      expect(allowlist.allows(method, target), `${method} ${target}`).toBe(false);
    }
  });

  it('adds exact per-test extras after the defaults', () => {
    const allowlist = createAllowlist([{ method: 'POST', target: '/v1/messages/count_tokens' }]);
    expect(allowlist.entries).toHaveLength(2);
    expect(allowlist.allows('POST', '/v1/messages/count_tokens')).toBe(true);
    expect(allowlist.allows('POST', '/v1/messages/count_tokens?beta=true')).toBe(false);
    expect(allowlist.allows('POST', '/v1/messages?beta=true')).toBe(true);
  });

  it('is immutable', () => {
    const allowlist = createAllowlist([{ method: 'GET', target: '/x' }]);
    expect(Object.isFrozen(allowlist.entries)).toBe(true);
    expect(allowlist.entries.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(Object.isFrozen(DEFAULT_ALLOWLIST)).toBe(true);
  });

  it('refuses extras that could never match', () => {
    expect(() => createAllowlist([{ method: 'post', target: '/x' }])).toThrow(TypeError);
    expect(() => createAllowlist([{ method: 'POST', target: 'http://example.com/x' }])).toThrow(
      /origin-form/,
    );
  });
});
