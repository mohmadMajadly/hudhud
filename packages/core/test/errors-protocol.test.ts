import { describe, expect, it } from 'vitest';

import {
  ERROR_RETRYABLE,
  HUDHUD_ERROR_CODES,
  isHudhudErrorCode,
  isJsonObjectValue,
  isRetryable,
  makeErrorData,
  parseErrorData,
} from '../src/protocol/errors.js';

describe('error code table', () => {
  it('lists 26 unique codes and a retryability entry for each', () => {
    expect(HUDHUD_ERROR_CODES).toHaveLength(27);
    expect(new Set(HUDHUD_ERROR_CODES).size).toBe(27);
    expect(Object.keys(ERROR_RETRYABLE).sort()).toEqual([...HUDHUD_ERROR_CODES].sort());
  });

  it('marks exactly the retryable codes of plan 3.1', () => {
    const retryable = HUDHUD_ERROR_CODES.filter((code) => isRetryable(code));
    expect(retryable).toEqual([
      'BINARY_PROBE_FAILED',
      'SESSION_ID_IN_USE',
      'HANDSHAKE_TIMEOUT',
      'HANDSHAKE_FAILED',
      'CONTROL_REQUEST_FAILED',
      'PROCESS_EXITED',
      'TURN_DROPPED',
    ]);
  });

  it('recognizes codes', () => {
    expect(isHudhudErrorCode('ABORTED')).toBe(true);
    expect(isHudhudErrorCode('aborted')).toBe(false);
    expect(isHudhudErrorCode(42)).toBe(false);
  });

  it('is harness-neutral', () => {
    expect(HUDHUD_ERROR_CODES.join(' ')).not.toMatch(/claude/i);
  });
});

describe('makeErrorData', () => {
  it('derives retryable from the code and omits absent details', () => {
    expect(makeErrorData('PROCESS_EXITED', 'gone')).toEqual({
      code: 'PROCESS_EXITED',
      message: 'gone',
      retryable: true,
    });
    expect('details' in makeErrorData('SESSION_CLOSED', 'x')).toBe(false);
    expect(makeErrorData('SESSION_CLOSED', 'x', { a: 1 })).toEqual({
      code: 'SESSION_CLOSED',
      message: 'x',
      retryable: false,
      details: { a: 1 },
    });
  });
});

describe('isJsonObjectValue', () => {
  it('accepts plain JSON objects', () => {
    expect(isJsonObjectValue({ a: [1, 'b', null, true, { c: 1.5 }] })).toBe(true);
    expect(isJsonObjectValue(Object.create(null))).toBe(true);
  });

  it('refuses non-objects, non-finite numbers, non-JSON values and class instances', () => {
    expect(isJsonObjectValue(null)).toBe(false);
    expect(isJsonObjectValue([])).toBe(false);
    expect(isJsonObjectValue('x')).toBe(false);
    expect(isJsonObjectValue({ a: Number.NaN })).toBe(false);
    expect(isJsonObjectValue({ a: Infinity })).toBe(false);
    expect(isJsonObjectValue({ a: undefined })).toBe(false);
    expect(isJsonObjectValue({ a: () => 1 })).toBe(false);
    expect(isJsonObjectValue({ a: 1n })).toBe(false);
    expect(isJsonObjectValue({ a: new Date(0) })).toBe(false);
  });

  it('refuses nesting deeper than 64 without recursing unboundedly', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(isJsonObjectValue({ deep })).toBe(false);
    let ok: unknown = 1;
    for (let i = 0; i < 60; i += 1) ok = [ok];
    expect(isJsonObjectValue({ ok })).toBe(true);
  });
});

describe('parseErrorData', () => {
  const good = { code: 'HANDSHAKE_FAILED', message: 'm', retryable: true };

  it('round-trips ErrorData through JSON', () => {
    for (const code of HUDHUD_ERROR_CODES) {
      for (const details of [undefined, { cause: 'x', n: [1, 2], nested: { k: null } }]) {
        const data = makeErrorData(code, `msg ${code}`, details);
        const parsed = parseErrorData(JSON.parse(JSON.stringify(data)));
        expect(parsed).toEqual({ ok: true, value: data });
      }
    }
  });

  it('refuses malformed input with a reason', () => {
    expect(parseErrorData(null)).toEqual({ ok: false, reason: 'not-object' });
    expect(parseErrorData([])).toEqual({ ok: false, reason: 'not-object' });
    expect(parseErrorData('x')).toEqual({ ok: false, reason: 'not-object' });
    expect(parseErrorData({ ...good, code: 'NOPE' })).toEqual({
      ok: false,
      reason: 'unknown-code',
    });
    expect(parseErrorData({ message: 'm' })).toEqual({ ok: false, reason: 'unknown-code' });
    expect(parseErrorData({ ...good, message: 1 })).toEqual({ ok: false, reason: 'bad-message' });
    expect(parseErrorData({ ...good, retryable: false })).toEqual({
      ok: false,
      reason: 'bad-retryable',
    });
    expect(parseErrorData({ ...good, details: [] })).toEqual({ ok: false, reason: 'bad-details' });
    expect(parseErrorData({ ...good, details: { a: Number.NaN } })).toEqual({
      ok: false,
      reason: 'bad-details',
    });
  });

  it('rebuilds the envelope: unknown keys are dropped and inherited fields are ignored', () => {
    const parsed = parseErrorData({ ...good, extra: 1, stack: 'secret path' });
    expect(parsed).toEqual({ ok: true, value: good });
    const inherited = Object.create({ code: 'ABORTED', message: 'm', retryable: false }) as object;
    expect(parseErrorData(inherited)).toEqual({ ok: false, reason: 'unknown-code' });
  });

  it('keeps a __proto__ key in details inert', () => {
    const text =
      '{"code":"ABORTED","message":"m","retryable":false,"details":{"__proto__":{"x":1}}}';
    const parsed = parseErrorData(JSON.parse(text));
    expect(parsed.ok).toBe(true);
    expect(({} as { x?: number }).x).toBeUndefined();
  });
});
