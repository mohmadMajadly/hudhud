// Long-running sessions stay bounded (CAPS-1): after N = 100 000 simulated
// turns, frames and never-answered control requests
// through the sans-io session machine, every per-session table is back to
// its idle size or held at its documented cap, and the serialized state
// does not grow with N. No process runs: inputs are folded through
// `stepSession` with a fake clock, and effects are checked per step instead
// of being kept (the runner of session-support.ts keeps every step).

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
  type ClaudeSessionState,
} from '../../../src/protocol/machine/index.js';
import {
  assistant,
  cancelRequest,
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

describe('the bounded records (property)', () => {
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
