// The Claude conformance set through the loopback binding (plan §5.6
// acceptance "loopback replays every Claude conformance suite"; ADR-0006
// "JSON-only boundary"; W4-Z ruling 2).
//
// The direct replay (`replay.ts`) feeds the session machine through the
// machine kit. This one drives the same recording through the generic
// session driver of `@hudhudjs/core/binding` over its in-memory transport
// (`createLoopbackDriver`): every config, state, input and step result
// crosses JSON (`loopbackMachine`), the harness output goes through the
// transport's reader, timers through the driver's ManualClock, application
// calls through the public handles (`session.send` with scripted turn ids and
// the Claude user-input encoder, `turn.interrupt`, `session.close`, the
// permission handler), and the ladder and the exit through the transport.
//
// The direct replay is the script: each of its steps becomes the call or the
// transport output that makes it, at its clock time. A recorded `error`
// answer to a permission request has no public call (hudhud never answers
// with a control error): it is fed as the raw `cmd.permission-abort`, as the
// direct replay does (`driver.command`).
//
// What must be identical (`compareLoopback`):
//
// - per record line, the machine inputs (as a multiset) and the inputs with
//   effects (in order): the driver orders its end as stdout EOF, the ladder,
//   then the exit (it waits for the ladder before it feeds the exit, plan
//   §1.6), where the direct replay feeds the exit before `ladder.done`; both
//   orders are only allowed to differ in steps without effects. Control
//   correlations are the driver's own (`c<n>`) and are mapped back.
// - every line written to the harness, in order;
// - every event the driver published, in order, with its `seq`: the driver
//   renumbers events gaplessly from 1, as the machine does, and publishes no
//   diagnostic of its own here (the loopback ladder and sweep report nothing);
// - each turn's `done` (result, or the error's code, message and details);
// - the handshake (`start()`), each control call, each permission request
//   handed to the handler, and how the session ended;
// - no JSON round-trip violation.

import { setImmediate } from 'node:timers';
import { isDeepStrictEqual } from 'node:util';

import {
  isHudhudError,
  type HudhudEvent,
  type PermissionDecision,
  type PermissionRequest,
  type SessionInfo,
  type Turn,
  type TurnResult,
  type UserContentBlock,
  type UserInput,
} from '@hudhudjs/core';
import {
  createLoopbackDriver,
  ManualClock,
  type HarnessMachine,
  type IdSource,
  type LoopbackSession,
  type SessionEnd,
} from '@hudhudjs/core/binding';
import type { JsonObject, JsonValue, MachineEffect, MachineInput } from '@hudhudjs/core/protocol';

import {
  claudeSessionMachine,
  type ClaudeSessionConfig,
  type ClaudeSessionState,
} from '../../src/protocol/machine/index.js';
import { encodeClaudeUserInput } from '../../src/user-input.js';
import { REPLAY_START_MS, SPAWNED_PID, type ReplayResult } from './replay.js';

/** One step the driver ran, as the machine saw it (inside the JSON boundary). */
export interface LoopbackStep {
  readonly record: number;
  readonly input: MachineInput;
  readonly effects: readonly MachineEffect[];
}

/** How a promise of the public API settled. */
export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details: JsonValue | undefined;
    };

/** What the loopback replay observed. */
export interface LoopbackReplay {
  readonly steps: readonly LoopbackStep[];
  readonly written: readonly string[];
  readonly events: readonly HudhudEvent[];
  readonly turns: ReadonlyMap<string, Settled<TurnResult>>;
  readonly controls: ReadonlyMap<string, Settled<void>>;
  readonly requests: ReadonlyMap<string, PermissionRequest>;
  readonly start: Settled<SessionInfo> | undefined;
  readonly end: SessionEnd | undefined;
  readonly roundTripViolations: readonly string[];
  /** Calls the script could not make (a recording the public API cannot express). */
  readonly problems: readonly string[];
}

/** The neutral input of a recorded user `message.content`; `undefined` when it has no neutral form. */
export function neutralInput(content: JsonValue): UserInput | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const blocks: UserContentBlock[] = [];
  for (const item of content as readonly JsonValue[]) {
    const block = neutralBlock(item);
    if (block === undefined) return undefined;
    blocks.push(block);
  }
  return { content: blocks };
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function neutralBlock(item: JsonValue): UserContentBlock | undefined {
  const block = asObject(item);
  if (block?.['type'] === 'text' && typeof block['text'] === 'string') {
    return { type: 'text', text: block['text'] };
  }
  const source = asObject(block?.['source']);
  const mediaType = source?.['media_type'];
  const data = source?.['data'];
  if (
    block?.['type'] === 'image' &&
    source?.['type'] === 'base64' &&
    (mediaType === 'image/png' ||
      mediaType === 'image/jpeg' ||
      mediaType === 'image/gif' ||
      mediaType === 'image/webp') &&
    typeof data === 'string'
  ) {
    return { type: 'image', mediaType, dataBase64: data };
  }
  return undefined;
}

/** Turn ids handed out in the order the script queues them. */
class ScriptedIds implements IdSource {
  readonly #queue: string[] = [];

  push(id: string): void {
    this.#queue.push(id);
  }

  uuid(): string {
    const id = this.#queue.shift();
    if (id === undefined) throw new Error('the replay asked for an unscripted id');
    return id;
  }
}

function settledError(error: unknown): Settled<never> {
  return isHudhudError(error)
    ? { ok: false, code: error.code, message: error.message, details: error.details }
    : { ok: false, code: 'NOT_A_HUDHUD_ERROR', message: String(error), details: undefined };
}

function track<T>(promise: Promise<T>, into: (settled: Settled<T>) => void): void {
  promise.then(
    (value) => {
      into({ ok: true, value });
    },
    (error: unknown) => {
      into(settledError(error));
    },
  );
}

/** Drives the direct replay's script through the loopback binding (see the top of this file). */
export async function replayThroughLoopback(direct: ReplayResult): Promise<LoopbackReplay> {
  const steps: LoopbackStep[] = [];
  let record = 0;
  const recording: HarnessMachine<ClaudeSessionState, ClaudeSessionConfig> = {
    initialState: (config) => claudeSessionMachine.initialState(config),
    step: (state, input) => {
      const out = claudeSessionMachine.step(state, input);
      steps.push({ record, input, effects: out.effects });
      return out;
    },
  };
  const ids = new ScriptedIds();
  const clock = new ManualClock(REPLAY_START_MS);
  const ladders: (() => void)[] = [];
  const asks = new Map<
    string,
    { readonly request: PermissionRequest; readonly answer: (d: PermissionDecision) => void }
  >();
  const loop: LoopbackSession<ClaudeSessionState, ClaudeSessionConfig> = createLoopbackDriver(
    recording,
    direct.config,
    {
      pid: SPAWNED_PID,
      sessionId: direct.config.sessionId,
      clock,
      ids,
      terminate: () =>
        new Promise((resolve) => {
          ladders.push(() => {
            resolve(null);
          });
        }),
      onPermission: (request, { signal }) =>
        new Promise((resolve, reject) => {
          asks.set(request.requestId, { request, answer: resolve });
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('withdrawn'));
            },
            { once: true },
          );
        }),
      driver: { encodeUserInput: encodeClaudeUserInput },
    },
  );
  const { driver, session, transport, machine } = loop;

  const events: HudhudEvent[] = [];
  const collecting = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  const problems: string[] = [];
  collecting.catch((error: unknown) => {
    problems.push(`the event stream failed: ${String(error)}`);
  });
  let start: Settled<SessionInfo> | undefined;
  let end: SessionEnd | undefined;
  void driver.ended.then((value) => {
    end = value;
  });
  const handles = new Map<string, Turn>();
  const turns = new Map<string, Settled<TurnResult>>();
  const controls = new Map<string, Settled<void>>();
  let correlations = 0;
  const releaseLadders = (): void => {
    for (const release of ladders.splice(0)) release();
  };

  const settle = async (): Promise<void> => {
    let quiet = 0;
    for (let round = 0; round < 10_000 && quiet < 2; round += 1) {
      const before = steps.length;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const idle =
        steps.length === before && transport.buffered === 0 && driver.pending.queue === 0;
      quiet = idle ? quiet + 1 : 0;
    }
    if (quiet < 2) problems.push(`record ${String(record)}: the driver did not settle`);
  };

  for (const step of direct.steps) {
    record = step.record;
    clock.advance(step.input.atMs - clock.nowMs());
    const input = step.input;
    switch (input.type) {
      case 'process.started':
        track(driver.start(), (settled) => {
          start = settled;
        });
        break;
      case 'line':
        transport.line(input.text, input.bytes);
        break;
      case 'line.oversized':
      case 'line.invalid-utf8':
        transport.push({ type: input.type, bytes: input.bytes });
        break;
      case 'stderr.line':
        transport.push({ type: 'stderr.line', text: input.text });
        break;
      case 'cmd.send': {
        const neutral = neutralInput(input.content);
        if (neutral === undefined) {
          problems.push(`record ${String(record)}: content without a neutral form`);
          break;
        }
        ids.push(input.turnId);
        const turn = session.send(neutral);
        handles.set(turn.id, turn);
        track(turn.done, (settled) => {
          turns.set(turn.id, settled);
        });
        break;
      }
      case 'cmd.interrupt': {
        correlations += 1;
        const handle = input.turnId === undefined ? undefined : handles.get(input.turnId);
        const done =
          handle === undefined
            ? driver.interrupt(input.turnId, input.cancelQueued)
            : handle.interrupt({ cancelQueued: input.cancelQueued });
        const correlation = input.correlation;
        track(done, (settled) => {
          controls.set(correlation, settled);
        });
        break;
      }
      case 'cmd.permission': {
        const ask = asks.get(input.requestId);
        if (ask === undefined) {
          problems.push(`record ${String(record)}: the handler was not asked ${input.requestId}`);
          break;
        }
        ask.answer(input.decision as unknown as PermissionDecision);
        break;
      }
      case 'cmd.permission-abort':
        driver.command({ type: 'cmd.permission-abort', requestId: input.requestId });
        break;
      case 'cmd.close':
        void session.close();
        break;
      case 'cmd.abort':
        void driver.abort(input.intent);
        break;
      case 'stdout.end':
        transport.endOutput();
        break;
      case 'process.exit':
        transport.exit({ code: input.code, signal: input.signal });
        releaseLadders();
        break;
      case 'ladder.done':
        releaseLadders();
        break;
      case 'timer':
        // The clock fired it on the way to its deadline.
        break;
      case 'stdin.error':
      case 'process.spawn-error':
      case 'cmd.permission-error':
      case 'cmd.set-permission-mode':
        problems.push(`record ${String(record)}: no loopback call for ${input.type}`);
        break;
    }
    await settle();
  }
  await settle();
  if (end === undefined) problems.push('the session did not end');
  await collecting.catch(() => undefined);
  if (correlations !== controls.size) problems.push('a control call did not settle');

  // The driver's own correlations, mapped back to the recorded ones.
  const mapped = new Map<string, string>();
  let next = 0;
  for (const step of direct.steps) {
    if (step.input.type === 'cmd.interrupt') {
      next += 1;
      mapped.set(`c${String(next)}`, step.input.correlation);
    }
  }
  return {
    steps: steps.map((step) => ({
      record: step.record,
      input: withCorrelation(step.input, mapped),
      effects: step.effects.map((effect) => withCorrelation(effect, mapped)),
    })),
    written: [...transport.written],
    events,
    turns,
    controls,
    requests: new Map([...asks].map(([id, ask]) => [id, ask.request])),
    start,
    end,
    roundTripViolations: machine.violations.map((violation) => violation.message),
    problems,
  };
}

/** `value` with its `correlation` mapped (inputs and `control.settle` effects carry one). */
function withCorrelation<T extends MachineInput | MachineEffect>(
  value: T,
  mapped: ReadonlyMap<string, string>,
): T {
  if (!Object.hasOwn(value, 'correlation')) return value;
  const correlation = (value as { readonly correlation: string }).correlation;
  return { ...value, correlation: mapped.get(correlation) ?? correlation };
}

/** The key of an input for the multiset comparison. */
function inputKey(input: MachineInput): string {
  return JSON.stringify(input);
}

/** Every difference between the loopback replay and the direct one (see the top of this file). */
export function compareLoopback(direct: ReplayResult, loop: LoopbackReplay): string[] {
  const out: string[] = [...loop.problems];
  out.push(...loop.roundTripViolations.map((message) => `JSON boundary: ${message}`));
  // After `session.end` the driver feeds the machine nothing more; the direct
  // replay feeds the rest of the script, which the contract requires to yield
  // no effects (the machine kit checks it there). One input moves instead:
  // the driver feeds `ladder.done` before the exit (it waits for the ladder,
  // then feeds the exit), where the direct replay feeds it after.
  const ending = direct.steps.findIndex((step) =>
    step.effects.some((effect) => effect.type === 'session.end'),
  );
  const fed =
    ending < 0
      ? direct.steps
      : [
          ...direct.steps.slice(0, ending + 1),
          ...direct.steps.slice(ending + 1).filter((step) => step.input.type === 'ladder.done'),
        ];
  const records = direct.effects.length;
  for (let index = 0; index < records; index += 1) {
    const directSteps = fed.filter((step) => step.record === index);
    const loopSteps = loop.steps.filter((step) => step.record === index);
    const keys = (list: readonly { readonly input: MachineInput }[]): string[] =>
      list.map((step) => inputKey(step.input)).sort();
    if (!isDeepStrictEqual(keys(loopSteps), keys(directSteps))) {
      out.push(`record ${String(index)}: other machine inputs`);
    }
    const effectful = (list: readonly LoopbackStep[]): [MachineInput, readonly MachineEffect[]][] =>
      list.filter((step) => step.effects.length > 0).map((step) => [step.input, step.effects]);
    if (!isDeepStrictEqual(effectful(loopSteps), effectful(directSteps))) {
      out.push(`record ${String(index)}: other effects`);
    }
  }
  const effects = direct.effects.flat();
  const writes = effects.flatMap((effect) => (effect.type === 'write' ? [effect.line] : []));
  if (!isDeepStrictEqual(loop.written, writes)) out.push('other lines written to the harness');
  const events = effects.flatMap((effect) => (effect.type === 'event' ? [effect.event] : []));
  if (!isDeepStrictEqual(loop.events, events)) out.push('other events published');

  const handshake = effects.find(
    (effect) => effect.type === 'handshake.ok' || effect.type === 'handshake.fail',
  );
  if (handshake?.type === 'handshake.ok') {
    if (
      !isDeepStrictEqual(loop.start, {
        ok: true,
        value: { ...handshake.info, containment: 'best-effort' },
      })
    ) {
      out.push('start() did not resolve with the handshake info');
    }
  } else if (handshake?.type === 'handshake.fail') {
    if (loop.start?.ok !== false || loop.start.code !== handshake.error.code) {
      out.push('start() did not reject with the handshake error');
    }
  }

  // Only the turns the script sent have a handle; harness-originated turns
  // (`bg-<n>`) are events only.
  const sent = new Set(
    direct.steps.flatMap((step) => (step.input.type === 'cmd.send' ? [step.input.turnId] : [])),
  );
  for (const effect of effects) {
    if (
      (effect.type === 'turn.settle' ||
        effect.type === 'turn.fail' ||
        effect.type === 'send.rejected') &&
      !sent.has(effect.turnId)
    ) {
      continue;
    }
    if (effect.type === 'turn.settle') {
      if (!isDeepStrictEqual(loop.turns.get(effect.turnId), { ok: true, value: effect.result })) {
        out.push(`turn ${effect.turnId}: done did not resolve with the result`);
      }
    } else if (effect.type === 'turn.fail' || effect.type === 'send.rejected') {
      const settled = loop.turns.get(effect.turnId);
      const expected = {
        ok: false,
        code: effect.error.code,
        message: effect.error.message,
        details: effect.error.details,
      };
      if (!isDeepStrictEqual(settled, expected)) {
        out.push(`turn ${effect.turnId}: done did not reject with the error`);
      }
    } else if (effect.type === 'control.settle') {
      const settled = loop.controls.get(effect.correlation);
      const expected = effect.ok
        ? { ok: true, value: undefined }
        : {
            ok: false,
            code: effect.error.code,
            message: effect.error.message,
            details: effect.error.details,
          };
      if (!isDeepStrictEqual(settled, expected)) {
        out.push(`control ${effect.correlation}: settled otherwise`);
      }
    } else if (effect.type === 'permission.ask') {
      if (!isDeepStrictEqual(loop.requests.get(effect.requestId), effect.request)) {
        out.push(`permission ${effect.requestId}: the handler got another request`);
      }
    } else if (effect.type === 'session.end') {
      const expected =
        effect.error === undefined
          ? { outcome: effect.outcome }
          : { outcome: effect.outcome, error: effect.error };
      if (!isDeepStrictEqual(loop.end, expected)) out.push('the session ended otherwise');
    }
  }
  return out;
}
