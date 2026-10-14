// Interrupts and harness-originated turns against the pinned CLI (W6-T2,
// plan §5.8; ADR-0008 "Turns and interrupts"). Evidence: 05 §7 runs 31-38
// (recorded again as the conformance suites interrupt-midstream,
// interrupt-queued, interrupt-cancel-queued, interrupt-same-write) and 07 §7
// W120 (bg-shell-turn-after-eof).

import type { JsonValue, Session } from '@hudhud/core';
import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import {
  b64,
  frameKind,
  isEvent,
  member,
  tappedSession,
  type EventOf,
  type SessionTap,
} from './support.js';

const suite = integrationSuite();

/** The CLI's answer (`response.response`) to the interrupt request hudhud wrote as `frame`. */
function interruptAnswer(tap: SessionTap, written: JsonValue): JsonValue | undefined {
  const id = member(written, 'request_id');
  const answer = tap.frames.find(
    (frame) =>
      frame.direction === 'in' &&
      frameKind(frame.frame).type === 'control_response' &&
      member(member(frame.frame, 'response'), 'request_id') === id,
  );
  return member(member(answer?.frame, 'response'), 'response');
}

/** The user frames hudhud wrote, by their uuid (the turn id). */
function userFrameSeq(tap: SessionTap, turnId: string): number | undefined {
  return tap.frames.find(
    (frame) =>
      frame.direction === 'out' &&
      member(frame.frame, 'type') === 'user' &&
      member(frame.frame, 'uuid') === turnId,
  )?.seq;
}

/** Texts the model was sent across every captured request. */
async function mockSaw(text: string): Promise<boolean> {
  return (await suite.mock()).requests.some((request) =>
    JSON.stringify(request.body).includes(text),
  );
}

test('interrupt mid-stream: the CLI answers at once, keeps the partial text and ends the turn aborted_streaming (05 §7 run 31, interrupt-midstream)', async () => {
  const { session, tap } = await tappedSession(suite, {
    permissionMode: 'default',
    claudeCode: { includePartialMessages: true },
  });

  const turn = session.send('[[mock:slow chunks=20 ms=100]] stream');
  await tap.event('message.delta', (event) => event.turnId === turn.id);
  await turn.interrupt();
  const result = await turn.done;
  // The session goes on: the next turn is normal (05 §7 run 34).
  const next = await session.ask('[[mock:text]] next');
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({
    outcome: 'cancelled',
    isError: true,
    stopReason: 'cancelled',
    terminalReason: 'aborted_streaming',
    synthesized: false,
  });
  expect(next).toMatchObject({ outcome: 'completed', isError: false });
  const [interrupt] = tap.controlRequestsOut('interrupt');
  expect(member(interrupt?.frame, 'request')).toEqual({
    subtype: 'interrupt',
    cancel_queued: false,
  });
  expect(interruptAnswer(tap, interrupt?.frame ?? null)).toMatchObject({ still_queued: [] });
  // The partial text is preserved on the aborted assistant message.
  const aborted = tap
    .eventsOf('message.assistant')
    .filter((event) => event.turnId === turn.id && event.aborted === true);
  expect(aborted).toHaveLength(1);
  expect(aborted[0]?.text).toMatch(/^chunk0 /u);
  expect(aborted[0]?.text).not.toContain('chunk19');
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

/** Starts a slow first turn and queues a second one behind it. */
async function queuedPair(tap: SessionTap, session: Session) {
  const first = session.send('[[mock:slow chunks=10 ms=150]] first');
  await tap.event('turn.started', (event) => event.turnId === first.id);
  const second = session.send('[[mock:text]] queued');
  // Queued at the CLI: its user frame is on the wire while the first turn streams.
  await tap.frame(
    (frame) =>
      frame.direction === 'out' &&
      member(frame.frame, 'type') === 'user' &&
      member(frame.frame, 'uuid') === second.id,
    'the queued user frame',
  );
  return { first, second };
}

test('interrupt with a queued message: the running turn is cancelled, the queued one runs next (05 §7 run 32, interrupt-queued)', async () => {
  const { session, tap } = await tappedSession(suite, { permissionMode: 'default' });

  const { first, second } = await queuedPair(tap, session);
  await first.interrupt();
  const firstResult = await first.done;
  const secondResult = await second.done;
  await session.close();
  await tap.ended;

  expect(firstResult).toMatchObject({ outcome: 'cancelled', terminalReason: 'aborted_streaming' });
  expect(secondResult).toMatchObject({ outcome: 'completed', isError: false, synthesized: false });
  const [interrupt] = tap.controlRequestsOut('interrupt');
  expect(interruptAnswer(tap, interrupt?.frame ?? null)).toMatchObject({
    still_queued: [second.id],
  });
  // The queued message reached the model.
  expect(await mockSaw('[[mock:text]] queued')).toBe(true);
  expect(tap.eventsOf('diagnostic').map((event) => event.code)).not.toContain(
    'interrupt.still-queued-retry',
  );
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test('interrupt with cancelQueued: the running turn is cancelled and the queued one is dropped by the CLI (05 §7 run 33, interrupt-cancel-queued)', async () => {
  const { session, tap } = await tappedSession(suite, { permissionMode: 'default' });

  const { first, second } = await queuedPair(tap, session);
  await first.interrupt({ cancelQueued: true });
  const firstResult = await first.done;
  const secondResult = await second.done;
  const next = await session.ask('[[mock:text]] after');
  await session.close();
  await tap.ended;

  expect(firstResult).toMatchObject({ outcome: 'cancelled', terminalReason: 'aborted_streaming' });
  // hudhud settles the dropped turn from the CLI's `cancelled` list.
  expect(secondResult).toMatchObject({ outcome: 'cancelled', isError: true, synthesized: true });
  expect(next).toMatchObject({ outcome: 'completed', isError: false });
  const [interrupt] = tap.controlRequestsOut('interrupt');
  expect(member(interrupt?.frame, 'request')).toEqual({
    subtype: 'interrupt',
    cancel_queued: true,
  });
  expect(interruptAnswer(tap, interrupt?.frame ?? null)).toMatchObject({
    still_queued: [],
    cancelled: [second.id],
  });
  expect(await mockSaw('[[mock:text]] queued')).toBe(false);
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test("interrupt right after send: hudhud holds it until the turn's system/init, so the CLI never gets the GH#98713 same-write trigger and the turn is cancelled (05 §7 runs 36 and 37, interrupt-same-write)", async () => {
  const { session, tap } = await tappedSession(suite, { permissionMode: 'default' });

  await session.ask('[[mock:text]] turn one');
  // Run 36 wrote turn 2's user message and the interrupt in one write: the
  // CLI answered still_queued and streamed the whole reply. hudhud is asked
  // for the interrupt in the same tick as the send.
  const turn = session.send('[[mock:slow chunks=8 ms=250]] turn two');
  const interrupted = turn.interrupt();
  await interrupted;
  const result = await turn.done;
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({
    outcome: 'cancelled',
    isError: true,
    terminalReason: 'aborted_streaming',
  });
  const interrupts = tap.controlRequestsOut('interrupt');
  expect(interrupts).toHaveLength(1);
  const [interrupt] = interrupts;
  const userSeq = userFrameSeq(tap, turn.id) ?? Infinity;
  // The second system/init is turn 2's: the interrupt went out only after it arrived.
  const inits = tap.frames.filter(
    (frame) =>
      frame.direction === 'in' &&
      frameKind(frame.frame).type === 'system' &&
      frameKind(frame.frame).subtype === 'init',
  );
  expect(inits).toHaveLength(2);
  const initSeq = inits[1]?.seq ?? Infinity;
  expect(userSeq).toBeLessThan(initSeq);
  expect(interrupt?.seq).toBeGreaterThan(initSeq);
  // Nothing hudhud wrote sits between the user frame and turn 2's system/init.
  expect(
    tap.frames.filter(
      (frame) => frame.direction === 'out' && frame.seq > userSeq && frame.seq < initSeq,
    ),
  ).toEqual([]);
  // The CLI took the interrupt for the running turn (run 37), not for a queued one (run 36).
  expect(interruptAnswer(tap, interrupt?.frame ?? null)).toMatchObject({ still_queued: [] });
  expect(tap.eventsOf('diagnostic').map((event) => event.code)).not.toContain(
    'interrupt.still-queued-retry',
  );
  // The reply was cut short: the full 8-chunk stream of run 36 never completed.
  const assistant = tap
    .eventsOf('message.assistant')
    .filter((event) => event.turnId === turn.id && typeof event.text === 'string');
  expect(assistant.map((event) => event.text).join('')).not.toContain('chunk7');
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test('a background shell outliving its turn: after close() ends stdin the CLI runs a harness-originated turn, then exits (07 §7 W120, bg-shell-turn-after-eof)', async () => {
  const { session, tap } = await tappedSession(suite, { permissionMode: 'default' });
  // 3 s (07 §7 W120), tagged so a survivor fails the test (W6-Z ruling 3).
  const input = {
    command: `sleep ${suite.workloadTag(3)}`,
    run_in_background: true,
    description: 'bg sleep',
  };

  const result = await session.ask(
    `[[mock:tool name=Bash in=${b64(JSON.stringify(input))}]] start it`,
  );
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  const started = tap.eventsOf('turn.started');
  expect(started.map((event) => event.origin)).toEqual(['application', 'harness']);
  const bgTurnId = started[1]?.turnId ?? '';
  expect(bgTurnId).toMatch(/^bg-/u);
  const completed = tap
    .eventsOf('turn.completed')
    .find((event: EventOf<'turn.completed'>) => event.turnId === bgTurnId);
  expect(completed?.result).toMatchObject({ outcome: 'completed', isError: false });
  // The harness turn began after the application's turn ended, once the shell finished.
  const firstEnd = tap.events.findIndex(
    (event) => isEvent(event, 'turn.completed') && event.turnId !== bgTurnId,
  );
  const bgStart = tap.events.findIndex(
    (event) => isEvent(event, 'turn.started') && event.turnId === bgTurnId,
  );
  expect(bgStart).toBeGreaterThan(firstEnd);
  const notified = tap.frames.findIndex(
    (frame) =>
      frame.direction === 'in' &&
      frameKind(frame.frame).type === 'system' &&
      frameKind(frame.frame).subtype === 'task_notification',
  );
  const inits = tap.frames.flatMap((frame, index) =>
    frame.direction === 'in' &&
    frameKind(frame.frame).type === 'system' &&
    frameKind(frame.frame).subtype === 'init'
      ? [index]
      : [],
  );
  expect(notified).toBeGreaterThanOrEqual(0);
  expect(inits).toHaveLength(2);
  expect(inits[1]).toBeGreaterThan(notified);
  expect(tap.events.at(-1)).toMatchObject({
    type: 'session.terminated',
    outcome: 'closed',
    exitCode: 0,
  });
});
