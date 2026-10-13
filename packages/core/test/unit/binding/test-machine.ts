/**
 * A small, harness-neutral test machine for the binding tests (plan §4.2:
 * "fake transport and timers driving a test machine"). It speaks a toy line
 * protocol: the harness writes JSON objects with a `t` field, the machine
 * writes JSON objects with an `op` field. State, config, inputs and effects
 * are plain JSON, so it also runs through the loopback binding.
 *
 * Harness lines:
 * - `{t:'ready', cliPid?}`: the handshake answer;
 * - `{t:'say', id?, text}`: an assistant message (event with `raw`);
 * - `{t:'burst', id?, n}`: `n` delta events;
 * - `{t:'result', id, error?}`: settles turn `id`;
 * - `{t:'drop', id}`: fails turn `id` with `TURN_DROPPED`;
 * - `{t:'ask', rid}` / `{t:'withdraw', rid}`: a permission request and its withdrawal;
 * - `{t:'ack', c}`: answers a pending `set-permission-mode 'wait'`;
 * - `{t:'interrupted'}`: acknowledges the abort interrupt;
 * - `{t:'idle'}`: nothing runs any more (the drain may end input);
 * - `{t:'throw'}`: the machine throws (a machine bug);
 * - `{t:'end-now'}`: the machine ends the session without an exit.
 */

import type { JsonObject } from '../../../src/protocol/json.js';
import { isJsonObject } from '../../../src/protocol/json.js';
import type {
  HarnessMachine,
  MachineEffect,
  MachineInput,
  MachineStep,
} from '../../../src/protocol/machine/contract.js';
import { classifyExit, type TerminationIntent } from '../../../src/protocol/machine/outcome.js';
import { makeErrorData, type HudhudErrorCode } from '../../../src/protocol/errors.js';

export interface TestConfig {
  readonly sessionId: string;
  readonly handshakeMs: number;
  readonly interruptWaitMs: number;
  readonly closeMs: number;
}

export const TEST_CONFIG: TestConfig = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  handshakeMs: 60_000,
  interruptWaitMs: 1000,
  closeMs: 30_000,
};

export interface TestState {
  readonly config: TestConfig;
  readonly phase: 'new' | 'handshake' | 'ready' | 'ended';
  readonly pid: number;
  readonly seq: number;
  readonly stdinOpen: boolean;
  readonly turns: readonly string[];
  readonly asks: readonly string[];
  readonly waits: readonly string[];
  readonly timers: readonly string[];
  readonly intent: TerminationIntent;
  readonly closing: boolean;
  readonly interrupting: boolean;
  readonly lastResultIsError: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

class Draft {
  readonly s: Mutable<TestState>;
  readonly effects: MachineEffect[] = [];
  readonly at: string;

  constructor(state: TestState, at: string) {
    this.s = { ...state };
    this.at = at;
  }

  emit(effect: MachineEffect): void {
    this.effects.push(effect);
  }

  event(fields: JsonObject & { readonly type: string }): void {
    this.emit({
      type: 'event',
      event: { ...fields, seq: this.s.seq, ts: this.at, sessionId: this.s.config.sessionId },
    });
    this.s.seq += 1;
  }

  write(op: JsonObject): void {
    if (this.s.stdinOpen) this.emit({ type: 'write', line: `${JSON.stringify(op)}\n` });
  }

  endStdin(): void {
    if (!this.s.stdinOpen) return;
    this.s.stdinOpen = false;
    this.emit({ type: 'stdin.end' });
  }

  setTimer(name: string, ms: number): void {
    this.s.timers = [...this.s.timers.filter((other) => other !== name), name];
    this.emit({ type: 'timer.set', name, ms });
  }

  clearTimer(name: string): void {
    if (!this.s.timers.includes(name)) return;
    this.s.timers = this.s.timers.filter((other) => other !== name);
    this.emit({ type: 'timer.clear', name });
  }

  firedTimer(name: string): boolean {
    if (!this.s.timers.includes(name)) return false;
    this.s.timers = this.s.timers.filter((other) => other !== name);
    return true;
  }

  error(code: HudhudErrorCode, message = code.toLowerCase()): ReturnType<typeof makeErrorData> {
    return makeErrorData(code, message);
  }

  drain(): void {
    if (this.s.closing && this.s.intent === 'close' && this.s.turns.length === 0) this.endStdin();
  }

  ladder(intent: TerminationIntent): void {
    this.emit({ type: 'ladder.start', intent });
  }

  commit(): MachineStep<TestState> {
    return { state: this.s, effects: this.effects };
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function onLine(d: Draft, text: string): void {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    d.event({ type: 'diagnostic', code: 'stdout.non-json-line', message: 'not json' });
    return;
  }
  if (!isJsonObject(frame)) return;
  const id = typeof frame['id'] === 'string' ? frame['id'] : undefined;
  const kind = frame['t'];
  switch (typeof kind === 'string' ? kind : '') {
    case 'ready':
      if (d.s.phase !== 'handshake') return;
      d.clearTimer('handshake');
      d.s.phase = 'ready';
      d.emit({
        type: 'handshake.ok',
        info: {
          id: d.s.config.sessionId,
          mode: 'create',
          pid: d.s.pid,
          ...(typeof frame['cliPid'] === 'number' ? { cliPid: frame['cliPid'] } : {}),
          ...(typeof frame['forkedFrom'] === 'string' ? { forkedFrom: frame['forkedFrom'] } : {}),
          ...(typeof frame['apiKeySource'] === 'string'
            ? { apiKeySource: frame['apiKeySource'] }
            : {}),
          ...(typeof frame['tokenSource'] === 'string'
            ? { tokenSource: frame['tokenSource'] }
            : {}),
          version: '1.0.0',
          features: ['f1'],
        },
      });
      d.event({
        type: 'session.started',
        mode: 'create',
        pid: d.s.pid,
        version: '1.0.0',
        raw: frame,
      });
      d.drain();
      return;
    case 'say':
      d.event({
        type: 'message.assistant',
        ...(id === undefined ? {} : { turnId: id }),
        text: textOf(frame['text']),
        raw: frame,
      });
      return;
    case 'burst': {
      const n = typeof frame['n'] === 'number' ? frame['n'] : 0;
      for (let index = 0; index < n; index += 1) {
        d.event({
          type: 'message.delta',
          ...(id === undefined ? {} : { turnId: id }),
          index,
          deltaType: 'text',
          raw: frame,
        });
      }
      return;
    }
    case 'result': {
      if (id === undefined || !d.s.turns.includes(id)) return;
      d.s.turns = d.s.turns.filter((turn) => turn !== id);
      const isError = frame['error'] === true;
      d.s.lastResultIsError = isError;
      const result = {
        turnId: id,
        sessionId: d.s.config.sessionId,
        outcome: isError ? 'error' : 'completed',
        isError,
        permissionDenials: [],
        synthesized: false,
      };
      d.emit({ type: 'turn.settle', turnId: id, result });
      d.event({ type: 'turn.completed', turnId: id, result, raw: frame });
      d.drain();
      return;
    }
    case 'drop':
      if (id === undefined || !d.s.turns.includes(id)) return;
      d.s.turns = d.s.turns.filter((turn) => turn !== id);
      d.emit({
        type: 'turn.fail',
        turnId: id,
        error: makeErrorData('TURN_DROPPED', 'dropped', { turnId: id }),
      });
      d.drain();
      return;
    case 'ask': {
      const rid = textOf(frame['rid']);
      d.s.asks = [...d.s.asks, rid];
      d.emit({
        type: 'permission.ask',
        requestId: rid,
        request: {
          requestId: rid,
          sessionId: d.s.config.sessionId,
          toolName: 'Tool',
          toolUseId: `tu-${rid}`,
          input: {},
          suggestions: [],
          raw: frame,
        },
      });
      d.event({
        type: 'permission.requested',
        requestId: rid,
        toolName: 'Tool',
        toolUseId: `tu-${rid}`,
        raw: frame,
      });
      return;
    }
    case 'withdraw': {
      const rid = textOf(frame['rid']);
      if (!d.s.asks.includes(rid)) return;
      d.s.asks = d.s.asks.filter((ask) => ask !== rid);
      d.emit({ type: 'permission.cancel', requestId: rid, reason: 'harness' });
      return;
    }
    case 'ack': {
      const correlation = textOf(frame['c']);
      if (!d.s.waits.includes(correlation)) return;
      d.s.waits = d.s.waits.filter((wait) => wait !== correlation);
      d.emit({ type: 'control.settle', correlation, ok: true, response: null });
      return;
    }
    case 'interrupted':
      if (!d.s.interrupting) return;
      d.s.interrupting = false;
      d.clearTimer('interrupt-wait');
      d.endStdin();
      return;
    case 'idle':
      d.drain();
      return;
    case 'throw':
      throw new Error('test machine bug');
    case 'throw-odd':
      throw Object.assign(new Error('odd'), { name: 'not a name!' });
    case 'bogus': {
      // Contract violations a driver must contain: double settlement, a
      // send.rejected outside a send, a write after stdin.end, a second
      // handshake answer.
      const result = {
        turnId: id ?? 'none',
        sessionId: d.s.config.sessionId,
        outcome: 'completed',
        isError: false,
        permissionDenials: [],
        synthesized: false,
      };
      if (id !== undefined) d.s.turns = d.s.turns.filter((turn) => turn !== id);
      d.emit({ type: 'turn.settle', turnId: id ?? 'none', result });
      d.emit({ type: 'turn.settle', turnId: id ?? 'none', result });
      d.emit({ type: 'turn.fail', turnId: id ?? 'none', error: d.error('PROTOCOL_ERROR') });
      d.emit({ type: 'send.rejected', turnId: id ?? 'none', error: d.error('PROTOCOL_ERROR') });
      d.emit({
        type: 'handshake.ok',
        info: { id: 'x', mode: 'create', pid: 1, version: '0', features: [] },
      });
      d.emit({ type: 'handshake.fail', error: d.error('HANDSHAKE_FAILED') });
      return;
    }
    case 'write-after-end':
      d.emit({ type: 'stdin.end' });
      d.emit({ type: 'stdin.end' });
      d.emit({ type: 'write', line: 'late\n' });
      return;
    case 'double-end':
      d.emit({ type: 'session.end', outcome: 'unknown' });
      end(d, 'unknown', undefined, null);
      return;
    case 'end-now':
      end(d, 'unknown', undefined, null);
      return;
    default:
      return;
  }
}

function end(
  d: Draft,
  outcome: 'closed' | 'aborted' | 'failed' | 'crashed' | 'killed-externally' | 'unknown',
  error: ReturnType<typeof makeErrorData> | undefined,
  exit: { readonly code: number | null; readonly signal: string | null } | null,
): void {
  for (const turn of d.s.turns) {
    if (error === undefined) {
      d.emit({
        type: 'turn.settle',
        turnId: turn,
        result: {
          turnId: turn,
          sessionId: d.s.config.sessionId,
          outcome: 'cancelled',
          isError: false,
          permissionDenials: [],
          synthesized: true,
        },
      });
    } else {
      d.emit({ type: 'turn.fail', turnId: turn, error });
    }
  }
  d.s.turns = [];
  for (const ask of d.s.asks)
    d.emit({ type: 'permission.cancel', requestId: ask, reason: 'harness' });
  d.s.asks = [];
  for (const wait of d.s.waits) {
    d.emit({
      type: 'control.settle',
      correlation: wait,
      ok: false,
      error: d.error('SESSION_CLOSED'),
    });
  }
  d.s.waits = [];
  for (const name of d.s.timers) d.emit({ type: 'timer.clear', name });
  d.s.timers = [];
  d.event({
    type: 'session.terminated',
    intent: d.s.intent,
    outcome,
    ...(exit?.code === null || exit === null ? {} : { exitCode: exit.code }),
    ...(exit?.signal === null || exit === null ? {} : { signal: exit.signal }),
  });
  d.emit(
    error === undefined
      ? { type: 'session.end', outcome }
      : { type: 'session.end', outcome, error },
  );
  d.s.phase = 'ended';
}

function abort(d: Draft, intent: TerminationIntent): void {
  if (d.s.intent !== 'none' && d.s.intent !== 'close') return;
  d.clearTimer('close');
  d.s.intent = intent;
  if (d.s.phase === 'handshake') {
    d.clearTimer('handshake');
    d.emit({ type: 'handshake.fail', error: d.error('ABORTED') });
  }
  for (const ask of d.s.asks)
    d.emit({ type: 'permission.cancel', requestId: ask, reason: 'abort' });
  d.s.asks = [];
  if (d.s.phase === 'ready' && d.s.stdinOpen) {
    d.write({ op: 'interrupt' });
    d.s.interrupting = true;
    d.setTimer('interrupt-wait', d.s.config.interruptWaitMs);
  } else {
    d.endStdin();
  }
  d.ladder(intent);
}

function onTimer(d: Draft, name: string): void {
  if (!d.firedTimer(name)) return;
  switch (name) {
    case 'handshake':
      d.s.intent = 'watchdog';
      d.emit({ type: 'handshake.fail', error: d.error('HANDSHAKE_TIMEOUT') });
      d.endStdin();
      d.ladder('watchdog');
      return;
    case 'close':
      abort(d, 'close-timeout');
      return;
    case 'interrupt-wait':
      d.s.interrupting = false;
      d.endStdin();
      return;
    default:
      return;
  }
}

function dispatch(d: Draft, input: MachineInput): void {
  switch (input.type) {
    case 'process.started':
      if (d.s.phase !== 'new') return;
      d.s.pid = input.pid;
      if (d.s.intent !== 'none') return;
      d.s.phase = 'handshake';
      d.write({ op: 'init' });
      d.setTimer('handshake', d.s.config.handshakeMs);
      return;
    case 'line':
      onLine(d, input.text);
      return;
    case 'line.oversized':
    case 'line.invalid-utf8':
      d.event({
        type: 'diagnostic',
        code: input.type,
        message: 'skipped',
        data: { bytes: input.bytes },
      });
      return;
    case 'stderr.line':
    case 'ladder.done':
    case 'stdout.end':
    case 'process.spawn-error':
      return;
    case 'stdin.error':
      if (!d.s.stdinOpen) return;
      d.s.stdinOpen = false;
      d.event({
        type: 'diagnostic',
        code: 'stdin.error',
        message: 'stdin failed',
        data: { code: input.code },
      });
      return;
    case 'timer':
      onTimer(d, input.name);
      return;
    case 'process.exit': {
      if (d.s.phase === 'handshake') {
        d.emit({ type: 'handshake.fail', error: d.error('HANDSHAKE_FAILED') });
      }
      const classified = classifyExit({
        intent: d.s.intent,
        exit: { code: input.code, signal: input.signal },
        lastResultIsError: d.s.lastResultIsError,
        turnActive: d.s.turns.length > 0,
        platform: 'posix',
      });
      const error =
        classified.error === 'none'
          ? undefined
          : makeErrorData('PROCESS_EXITED', 'the harness exited', { outcome: classified.outcome });
      end(d, classified.outcome, error, { code: input.code, signal: input.signal });
      return;
    }
    case 'cmd.send': {
      const { turnId } = input;
      if (!UUID.test(turnId) || d.s.turns.includes(turnId)) {
        d.emit({
          type: 'send.rejected',
          turnId,
          error: d.error('PROTOCOL_ERROR', 'turn id must be a fresh UUID'),
        });
        return;
      }
      if (d.s.intent !== 'none' || d.s.closing || !d.s.stdinOpen) {
        d.emit({ type: 'turn.fail', turnId, error: d.error('SESSION_CLOSED') });
        return;
      }
      d.s.turns = [...d.s.turns, turnId];
      d.event({ type: 'turn.queued', turnId });
      d.write({ op: 'user', id: turnId, content: input.content });
      return;
    }
    case 'cmd.interrupt':
      if (!d.s.stdinOpen || d.s.intent !== 'none') {
        d.emit({
          type: 'control.settle',
          correlation: input.correlation,
          ok: false,
          error: d.error('SESSION_CLOSED'),
        });
        return;
      }
      d.write({ op: 'interrupt', ...(input.turnId === undefined ? {} : { id: input.turnId }) });
      d.emit({ type: 'control.settle', correlation: input.correlation, ok: true, response: null });
      return;
    case 'cmd.set-permission-mode':
      if (input.mode === 'bad') {
        d.emit({
          type: 'control.settle',
          correlation: input.correlation,
          ok: false,
          error: d.error('CONTROL_REQUEST_FAILED'),
        });
        return;
      }
      if (input.mode === 'explode') throw new Error('mode bug');
      if (input.mode === 'rearm-close') {
        d.setTimer('close', d.s.config.closeMs);
        d.emit({
          type: 'control.settle',
          correlation: input.correlation,
          ok: true,
          response: null,
        });
        return;
      }
      if (input.mode === 'unknown-code') {
        d.emit({
          type: 'control.settle',
          correlation: input.correlation,
          ok: false,
          error: { code: 'FROM_THE_FUTURE', message: 'newer peer', retryable: false },
        });
        return;
      }
      d.write({ op: 'mode', mode: input.mode });
      if (input.mode === 'wait') d.s.waits = [...d.s.waits, input.correlation];
      else
        d.emit({
          type: 'control.settle',
          correlation: input.correlation,
          ok: true,
          response: null,
        });
      return;
    case 'cmd.permission': {
      const { requestId, decision } = input;
      if (!d.s.asks.includes(requestId)) return;
      d.s.asks = d.s.asks.filter((ask) => ask !== requestId);
      d.write({ op: 'answer', rid: requestId, decision });
      d.event({
        type: 'permission.resolved',
        requestId,
        behavior: decision['behavior'] === 'allow' ? 'allow' : 'deny',
        by: 'application',
      });
      return;
    }
    case 'cmd.permission-abort': {
      const { requestId } = input;
      if (!d.s.asks.includes(requestId)) return;
      d.s.asks = d.s.asks.filter((ask) => ask !== requestId);
      d.event({ type: 'permission.resolved', requestId, behavior: 'cancelled', by: 'application' });
      return;
    }
    case 'cmd.close':
      if (d.s.closing || d.s.intent !== 'none') return;
      d.s.closing = true;
      d.s.intent = 'close';
      d.setTimer('close', d.s.config.closeMs);
      for (const ask of d.s.asks)
        d.emit({ type: 'permission.cancel', requestId: ask, reason: 'close' });
      d.s.asks = [];
      if (d.s.phase === 'ready') d.drain();
      return;
    case 'cmd.abort':
      abort(d, input.intent);
      return;
  }
}

/** The test machine on the neutral contract. */
export const testMachine: HarnessMachine<TestState, TestConfig> = {
  initialState: (config) => ({
    config,
    phase: 'new',
    pid: 0,
    seq: 1,
    stdinOpen: true,
    turns: [],
    asks: [],
    waits: [],
    timers: [],
    intent: 'none',
    closing: false,
    interrupting: false,
    lastResultIsError: false,
  }),
  step: (state, input) => {
    if (state.phase === 'ended') return { state, effects: [] };
    const d = new Draft(state, input.at);
    dispatch(d, input);
    return d.commit();
  },
};

/**
 * Wraps a machine and records re-entrancy: `maxDepth` is the deepest
 * nesting of `step` calls ever seen (1 means never re-entered).
 */
export function probe<S, C>(
  machine: HarnessMachine<S, C>,
): HarnessMachine<S, C> & {
  readonly stats: { depth: number; maxDepth: number; steps: number; inputs: string[] };
} {
  const stats = { depth: 0, maxDepth: 0, steps: 0, inputs: [] as string[] };
  return {
    stats,
    initialState: (config) => machine.initialState(config),
    step: (state, input) => {
      stats.depth += 1;
      stats.maxDepth = Math.max(stats.maxDepth, stats.depth);
      stats.steps += 1;
      stats.inputs.push(input.type);
      try {
        return machine.step(state, input);
      } finally {
        stats.depth -= 1;
      }
    },
  };
}

/** A harness line of the toy protocol. */
export function line(frame: JsonObject): string {
  return JSON.stringify(frame);
}
