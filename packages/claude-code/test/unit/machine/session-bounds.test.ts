// Long-running sessions stay bounded (CAPS-1): after N = 100 000 simulated
// permission requests, turns, frames and never-answered control requests
// through the sans-io session machine, every per-session table is back to
// its idle size or held at its documented cap, and the serialized state
// does not grow with N. No process runs: inputs are folded through
// `stepSession` with a fake clock, and effects are checked per step instead
// of being kept (the runner of session-support.ts keeps every step).
//
// Also the window rule of W3-Z ruling 7 as bounded: a reuse of one of the
// last MAX_REMEMBERED_PERMISSION_IDS ids is denied without asking, its
// eviction order counts the end of a request, and a long id is remembered
// by a bounded key.

import { Buffer } from 'node:buffer';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonObject, JsonValue, MachineEffect } from '@hudhudjs/core/protocol';

import {
  MAX_KEPT_ID_CHARS,
  MAX_UNANSWERED_ENTRIES,
} from '../../../src/protocol/machine/control.js';
import {
  claudeSessionMachine,
  DUPLICATE_REQUEST_DENY_MESSAGE,
  MAX_REMEMBERED_PERMISSION_IDS,
  type ClaudeSessionState,
} from '../../../src/protocol/machine/index.js';
import {
  assistant,
  cancelRequest,
  canUseTool,
  controlOk,
  events,
  initResponse,
  lifecycle,
  makeConfig,
  result,
  sessionState,
  SPAWNED_PID,
  systemInit,
  uuid,
  type Body,
} from './session-support.js';

const N = 100_000;
const START_MS = Date.UTC(2026, 9, 18);

/** Folds inputs one at a time; keeps only the last step's effects. */
class BoundedRun {
  state: ClaudeSessionState = claudeSessionMachine.initialState(makeConfig());
  now = START_MS;

  feed(body: Body): readonly MachineEffect[] {
    this.now += 1;
    const out = claudeSessionMachine.step(this.state, {
      ...body,
      atMs: this.now,
      at: new Date(this.now).toISOString(),
    });
    this.state = out.state;
    return out.effects;
  }

  line(frame: JsonObject): readonly MachineEffect[] {
    const text = JSON.stringify(frame);
    return this.feed({ type: 'line', text, bytes: Buffer.byteLength(text) });
  }

  start(): void {
    this.feed({ type: 'process.started', pid: SPAWNED_PID });
    this.line(initResponse());
    expect(this.state.handshake).toBe('ok');
  }

  /** The serialized state's length. */
  size(): number {
    return JSON.stringify(this.state).length;
  }
}

function writes(effects: readonly MachineEffect[]): JsonObject[] {
  return effects.flatMap((effect) =>
    effect.type === 'write' ? [JSON.parse(effect.line) as JsonObject] : [],
  );
}

function diagnosticCodes(effects: readonly MachineEffect[]): JsonValue[] {
  return events(effects, 'diagnostic').map((event) => event['code'] ?? null);
}

function asks(effects: readonly MachineEffect[]): number {
  return effects.filter((effect) => effect.type === 'permission.ask').length;
}

/** The pending tables the machine holds for a ready, idle session. */
function expectIdle(state: ClaudeSessionState): void {
  expect(state.ended).toBe(false);
  expect(state.turns.turns).toEqual([]);
  expect(state.turns.inflight).toEqual([]);
  expect(state.permission.pending).toEqual([]);
  expect(state.control.outbound).toEqual([]);
  expect(state.control.inbound).toEqual([]);
  expect(state.outbox).toEqual([]);
  expect(state.timers).toEqual([]);
}

function permissionId(n: number): string {
  // The CLI's request ids are UUIDs (fixtures redact them as <uuid-n>).
  return `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

describe(`a session after ${String(N)} simulated inputs stays bounded`, () => {
  it('permission requests: answered, cancelled by the CLI, denied as duplicates', () => {
    const run = new BoundedRun();
    run.start();
    let checkpoint = 0;
    for (let n = 1; n <= N; n += 1) {
      const id = permissionId(n);
      expect(asks(run.line(canUseTool(id)))).toBe(1);
      if (n % 3 === 0) {
        // Withdrawn by the CLI: nothing is written for it.
        expect(writes(run.line(cancelRequest(id)))).toEqual([]);
      } else {
        const decision = n % 2 === 0 ? { behavior: 'allow' } : { behavior: 'deny', message: 'no' };
        expect(writes(run.feed({ type: 'cmd.permission', requestId: id, decision }))).toHaveLength(
          1,
        );
      }
      if (n % 1000 === 0) {
        // A reuse of a remembered id is denied without asking (ruling 7).
        const reused = run.line(canUseTool(permissionId(n - 500)));
        expect(asks(reused)).toBe(0);
        expect(diagnosticCodes(reused)).toEqual(['permission.duplicate-request-id']);
        expect(writes(reused)).toMatchObject([
          { response: { response: { behavior: 'deny', message: DUPLICATE_REQUEST_DENY_MESSAGE } } },
        ]);
      }
      if (n === 2000) checkpoint = run.size();
    }
    expectIdle(run.state);
    expect(run.state.permissionRequestIds).toHaveLength(MAX_REMEMBERED_PERMISSION_IDS);
    expect(new Set(run.state.permissionRequestIds).size).toBe(MAX_REMEMBERED_PERMISSION_IDS);
    // The newest ids are the ones remembered.
    expect(run.state.permissionRequestIds.at(-1)).toBe(permissionId(N));
    // The state does not grow with N: the same size as after 2000 requests
    // (only the widths of counters and timestamps may differ).
    expect(run.size()).toBeLessThanOrEqual(checkpoint + 64);
  });

  it('turns: sent, started, streamed, interrupted and settled', () => {
    const run = new BoundedRun();
    run.start();
    let checkpoint = 0;
    for (let n = 1; n <= N; n += 1) {
      const turnId = uuid(n);
      run.feed({ type: 'cmd.send', turnId, content: `message ${String(n)}` });
      run.line(lifecycle(turnId, 'started'));
      run.line(systemInit());
      run.line(assistant(`reply ${String(n)}`));
      if (n % 10 === 0) {
        // An interrupt of the running turn, answered by the CLI.
        const [written] = writes(
          run.feed({
            type: 'cmd.interrupt',
            turnId,
            cancelQueued: false,
            correlation: `c${String(n)}`,
          }),
        );
        const request = written?.['request_id'];
        if (typeof request !== 'string') throw new Error('the interrupt was not written');
        run.line(controlOk(request));
      }
      const settled = run.line(result({ user_message_uuid: turnId }));
      expect(settled.filter((effect) => effect.type === 'turn.settle')).toHaveLength(1);
      run.line(sessionState('idle'));
      if (n === 2000) checkpoint = run.size();
    }
    expectIdle(run.state);
    expect(run.state.turns.nextInterrupt).toBe(N / 10 + 1);
    expect(run.size()).toBeLessThanOrEqual(checkpoint + 64);
  });

  it('frames: a long turn of streamed frames keeps one turn entry and one idle timer', () => {
    const run = new BoundedRun();
    run.start();
    const turnId = uuid(1);
    run.feed({ type: 'cmd.send', turnId, content: 'long' });
    run.line(systemInit());
    let checkpoint = 0;
    for (let n = 1; n <= N; n += 1) {
      run.line(assistant(`chunk ${String(n)}`));
      if (n === 2000) checkpoint = run.size();
    }
    expect(run.state.turns.turns).toHaveLength(1);
    expect(run.state.timers).toEqual(['idle']);
    expect(run.size()).toBeLessThanOrEqual(checkpoint + 64);
    run.line(result({ user_message_uuid: turnId }));
    run.line(sessionState('idle'));
    expectIdle(run.state);
  });

  it('never-answered control requests the CLI never cancels', () => {
    const run = new BoundedRun();
    run.start();
    let checkpoint = 0;
    for (let n = 1; n <= N; n += 1) {
      const subtype = n % 2 === 0 ? 'request_user_dialog' : 'remote_tool_call';
      const effects = run.line({
        type: 'control_request',
        request_id: permissionId(n),
        request: { subtype },
      });
      expect(writes(effects)).toEqual([]);
      if (n === 2000) checkpoint = run.size();
    }
    expect(run.state.control.inbound).toHaveLength(MAX_UNANSWERED_ENTRIES);
    expect(run.state.control.inbound.at(-1)?.requestId).toBe(permissionId(N));
    expect(run.size()).toBeLessThanOrEqual(checkpoint + 64);
  });
});

describe('the permission id window (ruling 7, bounded)', () => {
  it('asks again an id that was forgotten, and still denies one inside the window', () => {
    const run = new BoundedRun();
    run.start();
    const answer = (id: string): void => {
      run.feed({
        type: 'cmd.permission',
        requestId: id,
        decision: { behavior: 'deny', message: 'x' },
      });
    };
    run.line(canUseTool('first'));
    answer('first');
    for (let n = 1; n < MAX_REMEMBERED_PERMISSION_IDS; n += 1) {
      run.line(canUseTool(permissionId(n)));
      answer(permissionId(n));
    }
    // 'first' is the oldest of exactly MAX ids: still refused.
    expect(run.state.permissionRequestIds[0]).toBe('first');
    expect(asks(run.line(canUseTool('first')))).toBe(0);
    // Refusing it remembered nothing new; one more request forgets it.
    run.line(canUseTool('next'));
    answer('next');
    expect(run.state.permissionRequestIds).not.toContain('first');
    const again = run.line(canUseTool('first'));
    expect(asks(again)).toBe(1);
    expect(diagnosticCodes(again)).toEqual([]);
  });

  it('counts the end of a request: a long-pending id is remembered from its end', () => {
    const run = new BoundedRun();
    run.start();
    run.line(canUseTool('slow'));
    for (let n = 1; n <= MAX_REMEMBERED_PERMISSION_IDS; n += 1) {
      run.line(canUseTool(permissionId(n)));
      run.feed({
        type: 'cmd.permission',
        requestId: permissionId(n),
        decision: { behavior: 'allow' },
      });
    }
    // Pushed out of the window while pending; an in-flight duplicate is
    // still ignored by the correlator.
    expect(run.state.permissionRequestIds).not.toContain('slow');
    expect(diagnosticCodes(run.line(canUseTool('slow')))).toEqual(['control.duplicate-request']);
    // Its end puts it back as the newest id.
    run.line(cancelRequest('slow'));
    expect(run.state.permissionRequestIds.at(-1)).toBe('slow');
    expect(asks(run.line(canUseTool('slow')))).toBe(0);
  });

  it('remembers a long id by a bounded key, and still refuses its reuse', () => {
    const run = new BoundedRun();
    run.start();
    const long = 'x'.repeat(100_000);
    run.line(canUseTool(long));
    run.feed({ type: 'cmd.permission', requestId: long, decision: { behavior: 'allow' } });
    const [key] = run.state.permissionRequestIds;
    expect(key).toBe(`${'x'.repeat(MAX_KEPT_ID_CHARS)}#100000`);
    expect(asks(run.line(canUseTool(long)))).toBe(0);
    // Another long id with the same prefix and length shares the key: it is
    // refused too (fail closed), never asked.
    const sibling = `${'x'.repeat(99_999)}y`;
    expect(diagnosticCodes(run.line(canUseTool(sibling)))).toEqual([
      'permission.duplicate-request-id',
    ]);
    // A different length is a different key.
    expect(asks(run.line(canUseTool(`${long}x`)))).toBe(1);
  });
});

// ---- properties: the bounded records against exact reference models --------------

/** The reference key of an id (the rule of `keptIdKey`, restated). */
function keyOf(id: string): string {
  return id.length <= MAX_KEPT_ID_CHARS
    ? id
    : `${id.slice(0, MAX_KEPT_ID_CHARS)}#${String(id.length)}`;
}

interface IdOp {
  readonly op: 'request' | 'answer' | 'cancel';
  readonly id: number;
}

/**
 * A few ids that come and go, and floods of fresh requests (answered at
 * once) that push them out of the window: short sequences that still cross
 * the cap, so a failure shrinks quickly.
 */
type PermissionOp = IdOp | { readonly op: 'flood'; readonly count: number };

const permissionOp: fc.Arbitrary<PermissionOp> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      op: fc.constantFrom('request' as const, 'answer' as const, 'cancel' as const),
      id: fc.nat(11),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('flood' as const),
      count: fc.integer({ min: 1, max: MAX_REMEMBERED_PERMISSION_IDS + 8 }),
    }),
  },
);

describe('the bounded records (property)', () => {
  it('asks a request exactly when its id is neither in flight nor among the newest remembered', () => {
    fc.assert(
      fc.property(fc.array(permissionOp, { minLength: 1, maxLength: 40 }), (ops) => {
        const run = new BoundedRun();
        run.start();
        const pending = new Set<string>();
        // Exact model: ids by recency of arrival or end, newest last.
        let window: string[] = [];
        const touch = (id: string): void => {
          window = [...window.filter((other) => other !== id), id].slice(
            -MAX_REMEMBERED_PERMISSION_IDS,
          );
        };
        let fresh = 1000;
        for (const step of ops) {
          if (step.op === 'flood') {
            for (let k = 0; k < step.count; k += 1) {
              fresh += 1;
              const id = permissionId(fresh);
              expect(asks(run.line(canUseTool(id)))).toBe(1);
              run.feed({ type: 'cmd.permission', requestId: id, decision: { behavior: 'allow' } });
              touch(id);
            }
            continue;
          }
          const { op, id: n } = step;
          const id = permissionId(n);
          if (op === 'request') {
            const effects = run.line(canUseTool(id));
            if (pending.has(id)) {
              expect(diagnosticCodes(effects)).toEqual(['control.duplicate-request']);
              expect(writes(effects)).toEqual([]);
            } else if (window.includes(id)) {
              expect(asks(effects)).toBe(0);
              expect(diagnosticCodes(effects)).toEqual(['permission.duplicate-request-id']);
              expect(writes(effects)).toMatchObject([
                { response: { response: { behavior: 'deny', interrupt: false } } },
              ]);
            } else {
              expect(asks(effects)).toBe(1);
              pending.add(id);
              touch(id);
            }
          } else if (op === 'answer') {
            const effects = run.feed({
              type: 'cmd.permission',
              requestId: id,
              decision: { behavior: 'allow' },
            });
            expect(writes(effects)).toHaveLength(pending.has(id) ? 1 : 0);
            if (pending.delete(id)) touch(id);
          } else {
            expect(writes(run.line(cancelRequest(id)))).toEqual([]);
            if (pending.delete(id)) touch(id);
          }
        }
        expect(run.state.permissionRequestIds).toEqual(window);
        expect(run.state.permission.pending.map((entry) => entry.requestId).sort()).toEqual(
          [...pending].sort(),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('never-answered entries: at most the cap, the oldest forgotten first, keys bounded', () => {
    const idOf = (n: number): string =>
      n % 7 === 0 ? `${'r'.repeat(300)}${String(n)}` : `r${String(n)}`;
    const op: fc.Arbitrary<IdOp> = fc.record({
      op: fc.constantFrom('request' as const, 'cancel' as const),
      id: fc.nat(150),
    });
    fc.assert(
      fc.property(fc.array(op, { minLength: 100, maxLength: 300 }), (ops) => {
        const run = new BoundedRun();
        run.start();
        let model: string[] = [];
        for (const { op: kind, id: n } of ops) {
          const id = idOf(n);
          const key = keyOf(id);
          if (kind === 'request') {
            const effects = run.line({
              type: 'control_request',
              request_id: id,
              request: { subtype: 'remote_tool_call' },
            });
            expect(writes(effects)).toEqual([]);
            if (model.includes(key)) {
              expect(diagnosticCodes(effects)).toEqual(['control.duplicate-request']);
            } else {
              expect(diagnosticCodes(effects)).toEqual(['control.unanswered-request']);
              model = [...model, key].slice(-MAX_UNANSWERED_ENTRIES);
            }
          } else {
            const effects = run.line(cancelRequest(id));
            expect(writes(effects)).toEqual([]);
            expect(diagnosticCodes(effects)).toEqual(
              model.includes(key) ? [] : ['control.unknown-cancel'],
            );
            model = model.filter((other) => other !== key);
          }
          expect(run.state.control.inbound.map((entry) => entry.requestId)).toEqual(model);
        }
      }),
    );
  });
});
