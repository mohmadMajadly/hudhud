// Helpers of the lifecycle suites (W6-T1): event recording and mock lookups.

import { isHudhudError, type HudhudEvent, type Session } from '@hudhud/core';

import type {
  CapturedRequest,
  MockServer,
} from '../../../../../tooling/test-support/src/mock/server.js';
import { findScenario } from '../../../../../tooling/test-support/src/mock/scenario.js';

/** The `session.terminated` event. */
export type TerminatedEvent = Extract<HudhudEvent, { type: 'session.terminated' }>;

/** A subscriber that keeps every event of a session until the session ends. */
export interface Recording {
  /** The events received so far, in order. */
  readonly events: readonly HudhudEvent[];
  /** Resolves with every event once the stream ended (after `session.terminated`). */
  readonly done: Promise<readonly HudhudEvent[]>;
}

/** Subscribes to `session.events()` now and records until the stream ends. */
export function record(session: Session): Recording {
  const events: HudhudEvent[] = [];
  const iterator = session.events();
  const done = (async () => {
    for await (const event of iterator) events.push(event);
    return events;
  })();
  return { events, done };
}

/** Whether `error` is a `HudhudError` with this code (plan §3.1). */
export function hasCode(error: unknown, code: string): boolean {
  return isHudhudError(error) && error.code === code;
}

/** The base64 form a mock marker argument takes. */
export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** The one `session.terminated` event of a finished recording; it is the last event. */
export function terminatedOf(events: readonly HudhudEvent[]): TerminatedEvent {
  const terminated = ofType(events, 'session.terminated');
  const [only] = terminated;
  if (terminated.length !== 1 || only === undefined) {
    throw new Error(`expected one session.terminated, got ${String(terminated.length)}`);
  }
  if (events.at(-1) !== only) {
    throw new Error('session.terminated is not the last event of the session');
  }
  return only;
}

/** Events of one type, typed. */
export function ofType<T extends HudhudEvent['type']>(
  events: readonly HudhudEvent[],
  type: T,
): Extract<HudhudEvent, { type: T }>[] {
  return events.filter((event): event is Extract<HudhudEvent, { type: T }> => event.type === type);
}

/** The diagnostics of a recording with this code. */
export function diagnostics(
  events: readonly HudhudEvent[],
  code: string,
): Extract<HudhudEvent, { type: 'diagnostic' }>[] {
  return ofType(events, 'diagnostic').filter((event) => event.code === code);
}

/** The `messages` array of a captured Messages API request. */
export function messagesOf(request: CapturedRequest): readonly unknown[] {
  const body = request.body;
  if (typeof body !== 'object' || body === null || !('messages' in body)) return [];
  const { messages } = body as { readonly messages: unknown };
  return Array.isArray(messages) ? messages : [];
}

/**
 * The captured turn requests whose scenario message (the latest user message
 * with a `[[mock:...]]` marker, found as the mock finds it: the CLI may send
 * other messages after it, D16) names `needle`, at the scenario's first step.
 */
export function turnRequests(mock: MockServer, needle: string): CapturedRequest[] {
  return mock.requests.filter((request) => {
    const scenario = findScenario(messagesOf(request));
    return scenario?.step === 0 && scenario.userText.includes(needle);
  });
}

/**
 * A spawn listener that hands the CLI to the product only once its identity
 * (pid and start time) was read. The harness fails a test whose spawned root
 * has no identity (its tree could not be checked for leaks, plan §4.7); on
 * Windows the read is one process-table query that takes hundreds of
 * milliseconds and more on a loaded machine, so a session ended quickly
 * (an abort right after the turn started) could otherwise be reaped before
 * the read finished. The CLI starts meanwhile; its output waits in the pipe.
 */
export async function identityFirst(root: { readonly identity: Promise<unknown> }): Promise<void> {
  await root.identity;
}
