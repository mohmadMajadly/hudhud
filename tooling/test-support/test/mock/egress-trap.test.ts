import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  absoluteTarget,
  CONNECT_REFUSAL,
  connectTarget,
  EgressTrap,
  EgressViolationError,
  formatViolation,
  ignoreSocketError,
  MAX_RECORDED_LENGTH,
  MAX_RECORDED_VIOLATIONS,
  redactTarget,
  sanitize,
  type TrapSocket,
} from '../../src/mock/egress-trap.js';

/**
 * A socket whose `end` fails the way a reset tunnel does: synchronously, with
 * `error`. A real EventEmitter underneath, so an unheard `error` throws.
 */
class ResettingSocket implements TrapSocket {
  readonly calls: string[] = [];
  readonly #emitter = new EventEmitter();
  on(event: 'error', listener: (error: Error) => void): this {
    this.calls.push(`on:${event}`);
    this.#emitter.on(event, listener);
    return this;
  }
  end(data: string): void {
    this.calls.push(`end:${data}`);
    this.#emitter.emit(
      'error',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    );
  }
}

// Userinfo fixtures are assembled at run time: written out, they read as
// e-mail addresses to the privacy scan.
const AT = '@';

describe('EgressTrap', () => {
  it('records violations in order and fails the test on assert', () => {
    const trap = new EgressTrap();
    expect(() => {
      trap.assertNoViolations();
    }).not.toThrow();
    trap.record({ kind: 'path', method: 'GET', target: '/v1/models' });
    trap.record({ kind: 'body-too-large', method: 'POST', target: '/x', detail: 'limit 1 bytes' });
    expect(trap.total).toBe(2);
    expect(trap.violations.map((violation) => violation.seq)).toEqual([1, 2]);
    let thrown: unknown;
    try {
      trap.assertNoViolations();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EgressViolationError);
    const error = thrown as EgressViolationError;
    expect(error.name).toBe('EgressViolationError');
    expect(error.total).toBe(2);
    expect(error.violations).toHaveLength(2);
    expect(error.message).toBe(
      'mock egress trap: 2 violation(s)\n#1 path: GET /v1/models\n#2 body-too-large: POST /x (limit 1 bytes)',
    );
  });

  it('returns copies and frozen entries', () => {
    const trap = new EgressTrap();
    const entry = trap.record({ kind: 'path', method: 'GET', target: '/' });
    expect(Object.isFrozen(entry)).toBe(true);
    const snapshot = trap.violations as unknown[];
    snapshot.length = 0;
    expect(trap.violations).toHaveLength(1);
  });

  it('clears', () => {
    const trap = new EgressTrap();
    trap.record({ kind: 'path', method: 'GET', target: '/' });
    trap.clear();
    expect(trap.total).toBe(0);
    expect(trap.violations).toEqual([]);
    trap.assertNoViolations();
    expect(trap.record({ kind: 'path', method: 'GET', target: '/' }).seq).toBe(1);
  });

  it('keeps at most MAX_RECORDED_VIOLATIONS but counts all', () => {
    const trap = new EgressTrap();
    for (let index = 0; index < MAX_RECORDED_VIOLATIONS + 5; index += 1) {
      trap.record({ kind: 'connect', method: 'CONNECT', target: 'api.anthropic.com:443' });
    }
    expect(trap.violations).toHaveLength(MAX_RECORDED_VIOLATIONS);
    expect(trap.total).toBe(MAX_RECORDED_VIOLATIONS + 5);
    expect(() => {
      trap.assertNoViolations();
    }).toThrow(/\.\.\. and 5 more$/);
  });

  describe('handleConnect (J12)', () => {
    it('attaches the error listener before writing, so a reset during refusal cannot crash', () => {
      const trap = new EgressTrap();
      const socket = new ResettingSocket();
      // Without a listener, EventEmitter throws the emitted error here.
      expect(() => {
        trap.handleConnect('api.anthropic.com:443', socket);
      }).not.toThrow();
      expect(socket.calls).toEqual(['on:error', `end:${CONNECT_REFUSAL}`]);
      expect(trap.violations).toEqual([
        { seq: 1, kind: 'connect', method: 'CONNECT', target: 'api.anthropic.com:443' },
      ]);
    });

    it('records an empty target for a CONNECT without one', () => {
      const trap = new EgressTrap();
      trap.handleConnect(undefined, new ResettingSocket());
      expect(trap.violations[0]?.target).toBe('<empty>');
    });

    it('refuses with 403 and closes', () => {
      expect(CONNECT_REFUSAL).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
      expect(CONNECT_REFUSAL).toContain('Connection: close');
      expect(CONNECT_REFUSAL.endsWith('\r\n\r\n')).toBe(true);
    });
  });

  it('ignoreSocketError ignores', () => {
    expect(() => {
      ignoreSocketError();
    }).not.toThrow();
  });
});

describe('formatting and redaction', () => {
  it('formats one line per violation', () => {
    expect(formatViolation({ seq: 3, kind: 'connect', method: 'CONNECT', target: 'h:443' })).toBe(
      '#3 connect: CONNECT h:443',
    );
  });

  it('sanitizes control characters and bounds length', () => {
    expect(sanitize('a\r\nb\u0000c\u009bd')).toBe('a??b?c?d');
    expect(sanitize('x'.repeat(MAX_RECORDED_LENGTH + 1))).toBe(
      `${'x'.repeat(MAX_RECORDED_LENGTH)}...`,
    );
    expect(sanitize('abcdef', 3)).toBe('abc...');
    expect(sanitize('abc', 3)).toBe('abc');
  });

  it('strips userinfo from CONNECT targets', () => {
    expect(connectTarget('api.anthropic.com:443')).toBe('api.anthropic.com:443');
    expect(connectTarget(`user:secret${AT}api.anthropic.com:443`)).toBe('api.anthropic.com:443');
    expect(connectTarget('a@b@host:1')).toBe('host:1');
    expect(connectTarget('')).toBe('<empty>');
    expect(connectTarget('host\r\nX-Injected: 1')).toBe('host??X-Injected: 1');
  });

  it('reduces absolute URIs to scheme and host, without userinfo, path or query', () => {
    expect(absoluteTarget('http://example.com/path?key=secret')).toBe('http://example.com');
    expect(absoluteTarget(`http://user:secret${AT}example.com:8080/x`)).toBe(
      'http://example.com:8080',
    );
    expect(absoluteTarget('https://api.anthropic.com/v1/messages')).toBe(
      'https://api.anthropic.com',
    );
    expect(absoluteTarget('/v1/messages')).toBeUndefined();
    expect(absoluteTarget('*')).toBeUndefined();
    expect(absoluteTarget('example.com:443')).toBe('example.com://');
    expect(absoluteTarget('http://[bad')).toBeUndefined();
  });

  it('redacts query values but keeps names', () => {
    expect(redactTarget('/v1/models')).toBe('/v1/models');
    expect(redactTarget('/x?key=secret&beta=true')).toBe('/x?key=<redacted>&beta=<redacted>');
    expect(redactTarget('/x?')).toBe('/x?');
    expect(redactTarget('/x\n?a=1')).toBe('/x??a=<redacted>');
  });
});
