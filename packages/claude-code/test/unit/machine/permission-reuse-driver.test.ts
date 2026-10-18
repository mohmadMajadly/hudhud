// The premise of the bounded permission id window (CAPS-1, W3-Z ruling 7):
// with the shipped binding (`SessionDriver` and its `PermissionBridge`), an
// answer the application gives for a request is spent, applied or found
// stale, before the second stdout line after the step that ended the
// request. So when an id is forgotten (after MAX_REMEMBERED_PERMISSION_IDS
// later requests) no answer for its earlier request can be left to apply to
// a request that reuses it.
//
// Driven through the loopback binding with the Claude session machine; the
// handler's answer races the CLI's cancel: it is released 0 to 40 microtask
// turns before or after the cancel line, or while a stalled 'block'
// subscriber holds the cancel line in the queue (the answer then arrives
// stale); the CLI reuses the id at once and sends one more request. All
// three ends of the answer occur (applied, stale, dropped). Whatever the
// interleaving, the answer never reaches a
// later request: no allow is written after the cancel, and every trace of
// the answer (its resolution or its `permission.unknown-request`) comes
// before the request of the second line after the cancel.

import { setImmediate } from 'node:timers';

import { createLoopbackDriver, type LoopbackSession } from '@hudhudjs/core/binding';
import type { HudhudEvent, PermissionDecision } from '@hudhudjs/core';
import type { JsonObject } from '@hudhudjs/core/protocol';
import { describe, expect, it } from 'vitest';

import {
  claudeSessionMachine,
  type ClaudeSessionConfig,
  type ClaudeSessionState,
} from '../../../src/protocol/machine/index.js';
import {
  cancelRequest,
  canUseTool,
  initResponse,
  makeConfig,
  SESSION_ID,
} from './session-support.js';

type Loop = LoopbackSession<ClaudeSessionState, ClaudeSessionConfig>;

async function settle(loop: Loop): Promise<void> {
  let quiet = 0;
  for (let round = 0; round < 1000 && quiet < 3; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const idle = loop.transport.buffered === 0 && loop.driver.pending.queue === 0;
    quiet = idle ? quiet + 1 : 0;
  }
  expect(quiet).toBe(3);
}

function send(loop: Loop, frame: JsonObject): void {
  loop.transport.line(JSON.stringify(frame));
}

interface Answers {
  readonly release: Map<string, ((decision: PermissionDecision) => void)[]>;
}

async function open(): Promise<{ loop: Loop; answers: Answers; events: HudhudEvent[] }> {
  const answers: Answers = { release: new Map() };
  const loop = createLoopbackDriver(claudeSessionMachine, makeConfig(), {
    sessionId: SESSION_ID,
    onPermission: (request) =>
      new Promise((resolve) => {
        const list = answers.release.get(request.requestId) ?? [];
        list.push(resolve);
        answers.release.set(request.requestId, list);
      }),
  });
  const events: HudhudEvent[] = [];
  void (async () => {
    for await (const event of loop.session.events()) events.push(event);
  })();
  const started = loop.driver.start();
  send(loop, initResponse());
  await started;
  await settle(loop);
  return { loop, answers, events };
}

function code(event: HudhudEvent): unknown {
  return event.type === 'diagnostic' ? (event as { readonly code?: unknown }).code : undefined;
}

function requestIdOf(event: HudhudEvent): unknown {
  return (
    (event as { readonly requestId?: unknown }).requestId ??
    (event as { readonly data?: { readonly requestId?: unknown } }).data?.requestId
  );
}

type Order = 'answer-first' | 'cancel-first' | 'stalled';

const CASES: readonly { readonly order: Order; readonly delay: number }[] = [
  ...(['answer-first', 'cancel-first'] as const).flatMap((order) =>
    Array.from({ length: 41 }, (_, delay) => ({ order, delay })),
  ),
  { order: 'stalled', delay: 0 },
];

async function rounds(count: number): Promise<void> {
  for (let round = 0; round < count; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** How the answer for X ended, over all cases: each must occur at least once. */
const outcomes = new Set<string>();

describe('an answer racing the CLI cancel never reaches a later request (window premise)', () => {
  it.each(CASES)('$order, $delay microtask turns apart', async ({ order, delay }) => {
    const { loop, answers, events } = await open();
    send(loop, canUseTool('X'));
    await settle(loop);
    const [releaseX] = answers.release.get('X') ?? [];
    expect(releaseX).toBeDefined();

    const before = loop.transport.written.length;
    const cliLines = (): void => {
      // The CLI withdraws X, reuses its id at once, then asks Z.
      send(loop, cancelRequest('X'));
      send(loop, canUseTool('X'));
      send(loop, canUseTool('Z'));
    };
    if (order === 'stalled') {
      // A full 'block' subscriber holds the input queue on the step of a
      // send, so the cancel line waits in the queue unprocessed and the
      // answer is queued behind it: it arrives stale.
      const drained: HudhudEvent[] = [];
      const stall = loop.session.events({ overflow: 'block', maxEvents: 1 });
      void loop.session.send('hold');
      cliLines();
      await rounds(5);
      expect(loop.driver.pending.queue).toBe(1);
      releaseX?.({ behavior: 'allow' });
      await rounds(5);
      expect(loop.driver.pending.queue).toBe(2);
      void (async () => {
        for await (const event of stall) drained.push(event);
      })();
    } else {
      if (order === 'answer-first') releaseX?.({ behavior: 'allow' });
      else cliLines();
      for (let turn = 0; turn < delay; turn += 1) await Promise.resolve();
      if (order === 'answer-first') cliLines();
      else releaseX?.({ behavior: 'allow' });
    }
    await settle(loop);

    // Whatever the interleaving: X was answered (allow) before its cancel,
    // or the cancel came first and nothing allowed X; the reuse was never
    // asked (ruling 7) and got the fixed deny.
    expect(answers.release.get('X')).toHaveLength(1);
    const writes = loop.transport.written
      .slice(before)
      .map((line) => JSON.parse(line) as JsonObject);
    const forX = writes
      .filter((frame) => JSON.stringify(frame).includes('"request_id":"X"'))
      .map((frame) => (frame['response'] as { response: { behavior: string } }).response.behavior);
    const answeredFirst = events.some(
      (event) =>
        event.type === 'permission.resolved' &&
        requestIdOf(event) === 'X' &&
        (event as { readonly behavior?: unknown }).behavior === 'allow',
    );
    expect(forX).toEqual(answeredFirst ? ['allow', 'deny'] : ['deny']);
    const stale = events.some(
      (event) => code(event) === 'permission.unknown-request' && requestIdOf(event) === 'X',
    );
    outcomes.add(answeredFirst ? 'applied' : stale ? 'stale' : 'dropped');

    // Every trace of X's answer comes before Z is requested (the second line
    // after the cancel).
    const zAt = events.findIndex(
      (event) => event.type === 'permission.requested' && requestIdOf(event) === 'Z',
    );
    expect(zAt).toBeGreaterThan(-1);
    const traces = events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          requestIdOf(event) === 'X' &&
          (event.type === 'permission.resolved' || code(event) === 'permission.unknown-request'),
      );
    expect(traces.length).toBeGreaterThanOrEqual(1);
    for (const { index } of traces) expect(index).toBeLessThan(zAt);

    // The harness exits; the session ends without a ladder.
    loop.transport.exit({ code: 0, signal: null });
    await loop.driver.ended;
  });

  it('covered all three ends of the answer: applied, stale and dropped', () => {
    expect([...outcomes].sort()).toEqual(['applied', 'dropped', 'stale']);
  });
});
