/**
 * Helpers of the driver tests: a session over the test machine, an
 * in-memory transport and a manual clock. Deterministic: no real timers;
 * progress is made by draining pending callbacks (`settle`) and by moving
 * the manual clock.
 */

import process from 'node:process';

import { afterEach, beforeEach, expect } from 'vitest';

import { counterIds, ManualClock, type IdSource } from '../../../src/binding/clock.js';
import { SessionDriver, type DriverOptions } from '../../../src/binding/driver.js';
import { createSession, type Session } from '../../../src/binding/handles.js';
import { LoopbackTransport, type LoopbackTransportOptions } from '../../../src/binding/loopback.js';
import type { HudhudEvent } from '../../../src/protocol/events/types.js';
import type { JsonObject } from '../../../src/protocol/json.js';
import type { HarnessMachine } from '../../../src/protocol/machine/contract.js';
import {
  line,
  probe,
  TEST_CONFIG,
  testMachine,
  type TestConfig,
  type TestState,
} from './test-machine.js';

/** Lets every pending promise reaction and immediate run (no time passes). */
export async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export interface Rig {
  readonly driver: SessionDriver<TestState, TestConfig>;
  readonly session: Session;
  readonly transport: LoopbackTransport;
  readonly clock: ManualClock;
  readonly machine: ReturnType<typeof probe<TestState, TestConfig>>;
  /** Writes of the machine, parsed. */
  ops(): JsonObject[];
  /** The harness writes one toy-protocol line. */
  say(frame: JsonObject): void;
}

export interface RigOptions extends Partial<
  Omit<DriverOptions<TestState, TestConfig>, 'machine' | 'transport'>
> {
  readonly machineImpl?: HarnessMachine<TestState, TestConfig>;
  readonly transportOptions?: LoopbackTransportOptions;
  readonly transport?: LoopbackTransport;
  readonly clock?: ManualClock;
  readonly ids?: IdSource;
}

export function rig(options: RigOptions = {}): Rig {
  const { machineImpl, transportOptions, transport: given, ...rest } = options;
  const clock = options.clock ?? new ManualClock();
  const machine = probe(machineImpl ?? testMachine);
  const transport = given ?? new LoopbackTransport(transportOptions);
  const driver = new SessionDriver<TestState, TestConfig>({
    config: TEST_CONFIG,
    sessionId: TEST_CONFIG.sessionId,
    hostExit: null,
    ids: counterIds(),
    ...rest,
    clock,
    machine,
    transport,
  });
  return {
    driver,
    session: createSession(driver),
    transport,
    clock,
    machine,
    ops: () => transport.written.map((text) => JSON.parse(text) as JsonObject),
    say: (frame) => {
      transport.line(line(frame));
    },
  };
}

/** Starts the rig and completes the handshake. */
export async function ready(r: Rig, frame: JsonObject = { t: 'ready' }): Promise<void> {
  const started = r.driver.start();
  await settle();
  r.say(frame);
  await started;
  await settle();
}

/** A JSON value as text for assertions: strings as is, anything else as JSON. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The iterator of an async iterable. */
export function iteratorOf<T>(iterable: AsyncIterable<T>): AsyncIterator<T> {
  return iterable[Symbol.asyncIterator]();
}

/** The next value of an event iterator, typed. */
export async function nextEvent(
  iterator: AsyncIterator<HudhudEvent>,
): Promise<HudhudEvent | undefined> {
  const result = await iterator.next();
  return result.done === true ? undefined : result.value;
}

/** Every event of an iterator until it ends (rethrows its error). */
export async function collect(iterable: AsyncIterable<HudhudEvent>): Promise<HudhudEvent[]> {
  const out: HudhudEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

/** Collects in the background; `result()` settles once the iterator ended. */
export function collector(iterable: AsyncIterable<HudhudEvent>): {
  readonly events: HudhudEvent[];
  readonly result: () => Promise<{ readonly events: HudhudEvent[]; readonly error?: unknown }>;
} {
  const events: HudhudEvent[] = [];
  const done = (async () => {
    try {
      for await (const event of iterable) events.push(event);
      return { events };
    } catch (error) {
      return { events, error };
    }
  })();
  return { events, result: () => done };
}

/** Settles a promise into a value or the thrown error, for assertions. */
export async function outcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

/** Tracks a promise's state without awaiting it. */
export function state<T>(promise: Promise<T>): {
  readonly current: () => 'pending' | 'fulfilled' | 'rejected';
} {
  let current: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  promise.then(
    () => {
      current = 'fulfilled';
    },
    () => {
      current = 'rejected';
    },
  );
  return { current: () => current };
}

/**
 * Fails the test when anything reaches the process as an unhandled
 * rejection or uncaught exception (handler exceptions never escape).
 */
export function guardProcess(): void {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  beforeEach(() => {
    seen.length = 0;
    process.on('unhandledRejection', onRejection);
    process.on('uncaughtException', onRejection);
  });
  afterEach(async () => {
    await settle();
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onRejection);
    expect(seen).toEqual([]);
  });
}

export function types(events: readonly HudhudEvent[]): string[] {
  return events.map((event) => event.type);
}
