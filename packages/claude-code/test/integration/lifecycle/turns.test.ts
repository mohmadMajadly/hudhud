// Lifecycle (W6-T1, plan §4.4 "lifecycle", §5.8): sessions.create and text
// turns against the pinned CLI through the product's real pipeline. Each
// test mirrors a recorded conformance suite (plan §4.3) and cites the
// research run the suite was recorded for; the harness asserts after every
// test that each Harness was disposed, the egress trap recorded nothing and
// no process leaked.

import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { b64, diagnostics, ofType, record, terminatedOf, turnRequests } from './events.js';

const suite = integrationSuite();

// Conformance `text-turn` and `handshake` (05 §5: the initialize response,
// `system/init` per turn; 05 §12: `session_state_changed` with the pinned
// CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1).
test('create, one text turn, graceful close: the full event sequence', async () => {
  const session = await suite.testSession();
  expect(session.info).toMatchObject({
    id: session.id,
    mode: 'create',
    version: suite.cli.version,
  });
  expect(session.info.forkedFrom).toBeUndefined();
  const recording = record(session);

  const reply = 'One turn, answered by the mock.';
  const result = await session.ask(`[[mock:text t=${b64(reply)}]] one turn`);
  expect(result).toMatchObject({
    sessionId: session.id,
    outcome: 'completed',
    isError: false,
    text: reply,
    stopReason: 'end_turn',
    synthesized: false,
    permissionDenials: [],
  });

  await session.close();
  const events = await recording.done;
  const types = events.map((event) => event.type);
  expect(types[0]).toBe('compat');
  // Pre-handshake events first, then the turn, then the end.
  const started = types.indexOf('session.started');
  const turnStarted = types.indexOf('turn.started');
  const turnCompleted = types.indexOf('turn.completed');
  expect(started).toBeGreaterThan(0);
  expect(turnStarted).toBeGreaterThan(started);
  expect(turnCompleted).toBeGreaterThan(turnStarted);
  expect(ofType(events, 'turn.completed')[0]?.result).toEqual(result);
  const turn = ofType(events, 'turn.started')[0];
  expect(turn).toMatchObject({ turnId: result.turnId, origin: 'application' });
  expect(turn?.features.length).toBeGreaterThan(0);
  // session_state_changed around the turn (05 §12).
  const states = ofType(events, 'session.state').map((event) => event.state);
  expect(states).toContain('running');
  expect(states.at(-1)).toBe('idle');
  expect(terminatedOf(events)).toMatchObject({ intent: 'close', outcome: 'closed' });
  // The event sequence numbers are gapless from the replayed compat at 0.
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
  expect(turnRequests(await suite.mock(), 'one turn')).toHaveLength(1);
});

// Conformance `two-turns` (05 §4: several sequential turns on one process).
test('several text turns on one session, each with its own turn id', async () => {
  const session = await suite.testSession();
  const recording = record(session);
  const first = await session.ask('[[mock:text]] turn one');
  const second = await session.ask('[[mock:echo]] turn two');
  const third = await session.ask(`[[mock:text t=${b64('third')}]] turn three`);
  expect(first).toMatchObject({ outcome: 'completed', text: 'Hello from mock.' });
  // Only the first user message of a session carries the CLI's reminder (05 §5).
  expect(second).toMatchObject({ outcome: 'completed', text: 'ECHO:turn two' });
  expect(third).toMatchObject({ outcome: 'completed', text: 'third' });
  expect(new Set([first.turnId, second.turnId, third.turnId]).size).toBe(3);
  await session.close();
  const events = await recording.done;
  expect(ofType(events, 'turn.completed').map((event) => event.turnId)).toEqual([
    first.turnId,
    second.turnId,
    third.turnId,
  ]);
  expect(terminatedOf(events)).toMatchObject({ intent: 'close', outcome: 'closed' });
  // One process for every turn: each turn's request goes to the same mock.
  const mock = await suite.mock();
  expect(turnRequests(mock, 'turn one')).toHaveLength(1);
  expect(turnRequests(mock, 'turn two')).toHaveLength(1);
  expect(turnRequests(mock, 'turn three')).toHaveLength(1);
});

// Conformance `partial-messages` (05 §7: `--include-partial-messages`, a
// text reply streamed in 5 deltas).
test('partial messages: the streamed deltas add up to the turn text', async () => {
  const session = await suite.testSession({
    session: { claudeCode: { includePartialMessages: true } },
  });
  const turn = session.send('[[mock:slow chunks=5 ms=40]] stream');
  const turnEvents = [];
  for await (const event of turn) turnEvents.push(event);
  const result = await turn.done;
  const expected = 'chunk0 chunk1 chunk2 chunk3 chunk4 ';
  expect(result).toMatchObject({ outcome: 'completed', text: expected });
  const deltas = ofType(turnEvents, 'message.delta').filter((event) => event.deltaType === 'text');
  expect(deltas).toHaveLength(5);
  expect(deltas.map((event) => event.text ?? '').join('')).toBe(expected);
  expect(deltas.every((event) => event.turnId === turn.id)).toBe(true);
  const assistant = ofType(turnEvents, 'message.assistant');
  expect(assistant.map((event) => event.text)).toContain(expected);
  await session.close();
});

// Conformance `utf8-arabic` (05 §11 runs 78-80: Arabic in and out, emoji
// and an accented letter, no U+FFFD, no mojibake).
test('UTF-8 round trip: Arabic user text echoed back, Arabic, emoji and an accent from the model', async () => {
  const session = await suite.testSession();
  const greeting = 'مرحبا';
  const echoed = await session.ask(`[[mock:echo]] ${greeting}`);
  // The first user message also carries the CLI's reminder (05 §5); the
  // user's own text ends it.
  expect(echoed.outcome).toBe('completed');
  expect(echoed.text?.startsWith('ECHO:')).toBe(true);
  expect(echoed.text?.endsWith(greeting)).toBe(true);
  const reply = 'رد: مرحبا 👋 é';
  const answered = await session.ask(`[[mock:text t=${b64(reply)}]] reply`);
  expect(answered).toMatchObject({ outcome: 'completed', text: reply });
  const again = await session.ask(`[[mock:echo]] ${reply}`);
  expect(again.text).toBe(`ECHO:${reply}`);
  for (const text of [echoed.text, answered.text, again.text]) {
    expect(text).not.toContain('�');
  }
  // The CLI sent the Arabic to the API exactly as given.
  const mock = await suite.mock();
  expect(turnRequests(mock, greeting)).not.toHaveLength(0);
  expect(JSON.stringify(mock.requests.map((request) => request.body))).not.toContain('�');
  await session.close();
});

// The driver's pre-handshake buffer (W5 lead review): the adapter's
// diagnostics (`security.posture` first, plan §2.4) and `session.started`
// happen before `create` resolves; every subscriber made afterwards still
// receives them right after `compat`, in `seq` order.
test('events: pre-handshake events are replayed to subscribers created after create', async () => {
  const session = await suite.testSession();
  const early = record(session);
  await session.ask('[[mock:text]] between the subscribers');
  const late = record(session);
  await session.close();
  const [earlyEvents, lateEvents] = await Promise.all([early.done, late.done]);
  for (const events of [earlyEvents, lateEvents]) {
    expect(events[0]).toMatchObject({ type: 'compat', seq: 0 });
    expect(events[1]).toMatchObject({ type: 'diagnostic', code: 'security.posture', seq: 1 });
    const started = ofType(events, 'session.started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      mode: 'create',
      pid: session.info.pid,
      version: suite.cli.version,
      apiKeySource: 'ANTHROPIC_API_KEY',
    });
    expect(diagnostics(events, 'events.pre-handshake-truncated')).toEqual([]);
  }
  // The late subscriber gets the same pre-handshake prefix as the early one.
  const prefixEnd = earlyEvents.findIndex((event) => event.type === 'session.started') + 1;
  expect(lateEvents.slice(0, prefixEnd)).toEqual(earlyEvents.slice(0, prefixEnd));
  // ...and live events from its subscription on: the first turn happened
  // before it subscribed, so it never sees that turn.
  expect(ofType(earlyEvents, 'turn.completed')).toHaveLength(1);
  expect(ofType(lateEvents, 'turn.completed')).toHaveLength(0);
  expect(terminatedOf(lateEvents)).toEqual(terminatedOf(earlyEvents));
});
