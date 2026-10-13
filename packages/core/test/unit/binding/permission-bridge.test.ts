// The permission bridge (plan §1.6, ADR-0007, ADR-0012 §3): strict copy
// and validation of decisions, fail-closed answers, one AbortSignal per ask.

import { describe, expect, it } from 'vitest';

import {
  copyJson,
  MAX_COPY_DEPTH,
  MAX_COPY_NODES,
  PermissionBridge,
  validateDecision,
  type PermissionHandler,
} from '../../../src/binding/permission-bridge.js';
import type { JsonObject } from '../../../src/protocol/json.js';
import type {
  PermissionErrorReason,
  PermissionRequestData,
} from '../../../src/protocol/machine/contract.js';
import { settle } from './driver-support.js';

const REQUEST: PermissionRequestData = {
  requestId: 'r1',
  sessionId: 's',
  toolName: 'Bash',
  toolUseId: 'tu',
  input: { command: 'ls' },
  suggestions: [],
  raw: {},
};

function nest(depth: number): unknown {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

describe('copyJson', () => {
  it('copies JSON and keeps an own __proto__ key inert', () => {
    const parsed = JSON.parse('{"__proto__":{"x":1},"a":[1,"b",null,true]}') as JsonObject;
    const copy = copyJson(parsed) as JsonObject;
    expect(copy).toEqual(parsed);
    expect(copy).not.toBe(parsed);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, '__proto__')).toBe(true);
    expect(copyJson(Object.create(null) as object)).toEqual({});
  });

  it.each([
    ['undefined', undefined],
    ['a function', () => 1],
    ['a bigint', 1n],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a symbol key', { [Symbol('s')]: 1 }],
    ['an array with holes', new Array<number>(2)],
    ['an array with an extra property', Object.assign([1], { extra: true })],
    ['an array subclass', new (class extends Array<number> {})()],
    ['an accessor', Object.defineProperty({}, 'a', { get: () => 1, enumerable: true })],
    ['a non-enumerable property', Object.defineProperty({}, 'a', { value: 1, enumerable: false })],
    ['a member that is undefined', { a: undefined }],
    [
      'a throwing proxy',
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('trap');
          },
        },
      ),
    ],
    ['too deep', nest(MAX_COPY_DEPTH + 1)],
    ['too many nodes', Array.from({ length: MAX_COPY_NODES }, () => 0)],
  ])('refuses %s', (_name, value) => {
    expect(copyJson(value)).toBeUndefined();
  });

  it('accepts the depth and size limits exactly', () => {
    expect(copyJson(nest(MAX_COPY_DEPTH))).toBeDefined();
    expect(copyJson(Array.from({ length: MAX_COPY_NODES - 1 }, () => 0))).toBeDefined();
  });
});

describe('validateDecision', () => {
  it.each([
    [{ behavior: 'allow' }],
    [{ behavior: 'allow', updatedInput: { a: 1 }, updatedPermissions: [{ type: 'x' }] }],
    [{ behavior: 'deny', message: 'no' }],
    [{ behavior: 'deny', message: 'no', interrupt: true }],
  ])('accepts %j as a copy', (decision) => {
    const result = validateDecision(decision);
    expect(result).toEqual({ ok: true, decision });
    if (result.ok) expect(result.decision).not.toBe(decision);
  });

  it.each([
    [null, 'not-object'],
    [[], 'not-object'],
    ['allow', 'not-object'],
    [{ behavior: 'allow', x: undefined }, 'not-json'],
    [{ behavior: 'maybe' }, 'bad-behavior'],
    [{ behavior: 'allow', message: 'x' }, 'unknown-key'],
    [{ behavior: 'allow', updatedInput: [] }, 'bad-updated-input'],
    [{ behavior: 'allow', updatedInput: 'x' }, 'bad-updated-input'],
    [{ behavior: 'allow', updatedPermissions: {} }, 'bad-updated-permissions'],
    [{ behavior: 'allow', updatedPermissions: [1] }, 'bad-updated-permissions'],
    [{ behavior: 'deny' }, 'bad-message'],
    [{ behavior: 'deny', message: 'x', interrupt: 'yes' }, 'bad-interrupt'],
    [{ behavior: 'deny', message: 'x', updatedInput: {} }, 'unknown-key'],
  ])('refuses %j (%s)', (decision, reason) => {
    expect(validateDecision(decision)).toEqual({ ok: false, reason });
  });
});

function bridgeWith(handler: PermissionHandler | undefined): {
  readonly bridge: PermissionBridge;
  readonly answers: [string, JsonObject][];
  readonly failures: [string, PermissionErrorReason][];
  readonly diagnostics: [string, JsonObject][];
} {
  const answers: [string, JsonObject][] = [];
  const failures: [string, PermissionErrorReason][] = [];
  const diagnostics: [string, JsonObject][] = [];
  const bridge = new PermissionBridge({
    handler,
    answer: (requestId, decision) => answers.push([requestId, decision]),
    fail: (requestId, reason) => failures.push([requestId, reason]),
    diagnostic: (code, _message, data) => diagnostics.push([code, data]),
  });
  return { bridge, answers, failures, diagnostics };
}

describe('PermissionBridge', () => {
  it('calls the handler in a microtask and answers with the copy', async () => {
    const decision = { behavior: 'allow' as const, updatedInput: { a: 1 } };
    let called = false;
    const { bridge, answers } = bridgeWith((request, { signal }) => {
      called = true;
      expect(request).toBe(REQUEST);
      expect(signal.aborted).toBe(false);
      return Promise.resolve(decision);
    });
    bridge.ask('r1', REQUEST);
    bridge.ask('r1', REQUEST);
    expect(called).toBe(false);
    expect(bridge.pending).toBe(1);
    await settle();
    expect(answers).toEqual([['r1', decision]]);
    expect(answers[0]?.[1]).not.toBe(decision);
    expect(bridge.pending).toBe(0);
  });

  it.each([
    [
      'throws an Error',
      (): Promise<never> => {
        throw new TypeError('x');
      },
      'TypeError',
    ],
    [
      'rejects with a string',
      (): Promise<never> =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a handler may reject with anything
        Promise.reject('nope'),
      'string',
    ],
    [
      'throws an odd name',
      (): Promise<never> => {
        throw Object.assign(new Error('x'), { name: 'bad name!' });
      },
      'unknown',
    ],
  ])(
    'a handler that %s fails closed through the machine, with a diagnostic',
    async (_name, handler, error) => {
      const { bridge, answers, failures, diagnostics } = bridgeWith(handler);
      bridge.ask('r1', REQUEST);
      await settle();
      expect(answers).toEqual([]);
      expect(failures).toEqual([['r1', 'handler-failed']]);
      expect(diagnostics).toEqual([['permission.handler-failed', { requestId: 'r1', error }]]);
    },
  );

  it('an invalid decision fails closed through the machine and names the refusal', async () => {
    const { bridge, answers, failures, diagnostics } = bridgeWith(() =>
      Promise.resolve({ behavior: 'allow', extra: 1 } as never),
    );
    bridge.ask('r1', REQUEST);
    await settle();
    expect(answers).toEqual([]);
    expect(failures).toEqual([['r1', 'invalid-decision']]);
    expect(diagnostics).toEqual([
      ['permission.invalid-decision', { requestId: 'r1', reason: 'unknown-key' }],
    ]);
  });

  it('no handler fails closed', async () => {
    const { bridge, answers, failures, diagnostics } = bridgeWith(undefined);
    bridge.ask('r1', REQUEST);
    await settle();
    expect(answers).toEqual([]);
    expect(failures).toEqual([['r1', 'no-handler']]);
    expect(diagnostics).toEqual([
      ['permission.handler-failed', { requestId: 'r1', error: 'Error' }],
    ]);
  });

  it('cancel aborts the signal in a microtask and drops the late answer; cancelAll aborts every ask', async () => {
    const signals: AbortSignal[] = [];
    const releases: (() => void)[] = [];
    const { bridge, answers, failures } = bridgeWith((_request, { signal }) => {
      signals.push(signal);
      return new Promise((resolve) => {
        releases.push(() => {
          resolve({ behavior: 'allow' });
        });
      });
    });
    bridge.ask('r1', REQUEST);
    bridge.ask('r2', REQUEST);
    bridge.ask('r3', REQUEST);
    await settle();
    bridge.cancel('r1', 'harness');
    bridge.cancel('unknown', 'harness');
    expect(signals[0]?.aborted).toBe(false);
    await settle();
    expect(signals[0]?.aborted).toBe(true);
    expect((signals[0]?.reason as Error).message).toMatch(/harness/u);
    bridge.cancelAll('close');
    await settle();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true]);
    for (const release of releases) release();
    await settle();
    expect(answers).toEqual([]);
    expect(failures).toEqual([]);
    expect(bridge.pending).toBe(0);
  });
});
