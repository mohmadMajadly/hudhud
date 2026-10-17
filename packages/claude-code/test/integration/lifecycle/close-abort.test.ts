// Lifecycle (W6-T1, plan §4.4 "lifecycle", §5.8): how sessions end against
// the pinned CLI: the graceful close (K13: drain while the CLI is busy,
// end stdin once it is idle, one deadline from the call), the abort before
// and after the handshake, `Symbol.asyncDispose`, Harness dispose and the
// private Harness of `session()`. Every end is checked through
// `session.terminated` (intent and outcome, plan §3.3); the harness checks
// after every test that no process survived (plan §4.7).

import { performance } from 'node:perf_hooks';

import { isHudhudError, type Session } from '@hudhudjs/core';
import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import { recordTimingSample } from '../support/timing-samples.js';
import { b64, diagnostics, ofType, record, terminatedOf, turnRequests } from './events.js';

const suite = integrationSuite();

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

/**
 * Hang guard of {@link requestArrived}, not a timing assertion: well under
 * the 60 s test guard, so a request that never comes fails with its needle
 * named. The CLI's request followed the user message within 14 to 261 ms
 * (n=94, median 111 ms; W6-Z trace of the whole project on Windows, files
 * one at a time).
 */
const REQUEST_GUARD_MS = 30_000;

/**
 * Resolves once the mock received the turn request naming `needle` (the
 * CLI is mid-turn).
 *
 * @throws Error naming `needle` when no such request came within {@link REQUEST_GUARD_MS}
 */
async function requestArrived(needle: string): Promise<void> {
  const mock = await suite.mock();
  const deadline = performance.now() + REQUEST_GUARD_MS;
  while (turnRequests(mock, needle).length === 0) {
    if (performance.now() >= deadline) {
      throw new Error(
        `no turn request naming ${JSON.stringify(needle)} reached the mock within ${String(REQUEST_GUARD_MS)} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Conformance `eof-idle` and every recording's close (05 §8 run 39: EOF at
// idle exits at once with code 0; §4.3 W4-T2: the drain ends stdin once the
// CLI reported idle). A deadline-bounded close would end `aborted` with
// intent `close-timeout`; ending `closed` proves the drain finished by itself.
test('graceful close at idle: drains, ends stdin, outcome closed', async () => {
  const session = await suite.testSession();
  const recording = record(session);
  await session.ask('[[mock:text]] before close');
  await session.close();
  await session.closed;
  const terminated = terminatedOf(await recording.done);
  expect(terminated).toMatchObject({ intent: 'close', outcome: 'closed', exitCode: 0 });
  expect(terminated.signal).toBeUndefined();
  // After the close every call refuses with SESSION_CLOSED (plan §3.2).
  const error = await rejection(session.ask('[[mock:text]] after close'));
  expect(isHudhudError(error, 'SESSION_CLOSED')).toBe(true);
  // close() again is harmless.
  await expect(session.close()).resolves.toBeUndefined();
});

// Conformance `eof-idle` without any turn (05 §8 run 43).
test('graceful close of a session that never ran a turn', async () => {
  const session = await suite.testSession();
  const recording = record(session);
  await session.close();
  expect(terminatedOf(await recording.done)).toMatchObject({ intent: 'close', outcome: 'closed' });
  expect((await suite.mock()).requests).toEqual([]);
});

// Conformance `eof-midstream` (05 §8 run 40: EOF while a reply streams; the
// CLI finishes the turn, then exits). hudhud's drain waits for the turn and
// for idle before it ends stdin, so the turn completes and the close is
// graceful.
test('close while a turn streams: the turn completes, then the session closes', async () => {
  const session = await suite.testSession();
  const recording = record(session);
  const turn = session.send('[[mock:slow chunks=8 ms=150]] streaming');
  let turnDone = false;
  void turn.done.then(() => {
    turnDone = true;
  });
  await requestArrived('streaming');
  // The close must come while the turn still streams (8 x 150 ms).
  expect(turnDone).toBe(false);
  const closing = session.close();
  const result = await turn.done;
  expect(result).toMatchObject({
    outcome: 'completed',
    isError: false,
    text: 'chunk0 chunk1 chunk2 chunk3 chunk4 chunk5 chunk6 chunk7 ',
  });
  await closing;
  expect(terminatedOf(await recording.done)).toMatchObject({ intent: 'close', outcome: 'closed' });
});

// K13 (plan §2.2 `close()`): one deadline measured from the call covers the
// drain; when it passes, the abort ladder runs and the session ends
// `aborted` with intent `close-timeout`, the active turn `cancelled`. The CLI
// is held mid-turn by a mock that never answers (`hang`); the CLI answers an
// interrupt during a request with no response bytes at once (05 §7 run 35),
// so the ladder ends at its interrupt step.
/**
 * How far past `closeTimeoutMs` the close may resolve: 3x the slowest
 * measured overrun (plan §4.4), per platform, from 20 runs of this test
 * each (W6-Z, files one at a time). Windows 11 (no job addon): 1244 to
 * 1392 ms; the ladder's steps were intent, interrupt `acknowledged`, then
 * snapshot S1 (one CIM query), during which the CLI exited. Linux
 * `node:22-bookworm` (`docker run --init`): 23 to 45 ms; intent, interrupt
 * `acknowledged`, EOF, then the exit. 3 x 1392 ms and 3 x 45 ms.
 */
const CLOSE_OVERRUN_BOUND_MS = process.platform === 'win32' ? 3 * 1392 : 3 * 45;

test('close with a deadline: a turn that never ends is cut at the deadline', async () => {
  const closeTimeoutMs = 2000;
  const session = await suite.testSession({ session: { closeTimeoutMs } });
  const recording = record(session);
  const turn = session.send('[[mock:hang]] never answered');
  await requestArrived('never answered');
  const started = performance.now();
  await session.close();
  const elapsed = performance.now() - started;
  // The overrun past the deadline, recorded before any assertion so a
  // measurement run keeps the samples that break the bound (off by default).
  recordTimingSample('close-abort/close-deadline-overrun', elapsed - closeTimeoutMs);
  const result = await turn.done;
  expect(result.outcome).toBe('cancelled');
  const events = await recording.done;
  expect(terminatedOf(events)).toMatchObject({
    intent: 'close-timeout',
    outcome: 'aborted',
  });
  // The ladder ended at its interrupt: the CLI acknowledged it and exited,
  // nothing was forced (no taskkill, TerminateProcess, TERM or KILL).
  const [ladder] = diagnostics(events, 'termination.ladder');
  const steps = (ladder?.data?.['steps'] ?? []) as readonly {
    readonly name: string;
    readonly outcome: string;
    readonly detail?: string;
  }[];
  expect(steps.find((step) => step.name === 'interrupt')).toMatchObject({
    outcome: 'done',
    detail: 'acknowledged',
  });
  const forced = ['taskkill', 'terminate-process', 'terminate-job', 'sigterm', 'sigkill'];
  expect(steps.filter((step) => forced.includes(step.name))).toEqual([]);
  // Not before the deadline (1 ms for the timer's millisecond rounding)...
  expect(elapsed).toBeGreaterThanOrEqual(closeTimeoutMs - 1);
  // ...and at most the measured overrun past it, with the 3x margin of
  // plan §4.4.
  expect(elapsed).toBeLessThan(closeTimeoutMs + CLOSE_OVERRUN_BOUND_MS);
});

// Abort before the spawn: an already aborted signal refuses at the first
// check (plan §1.8 "An AbortSignal ... is checked between the steps");
// nothing is spawned.
test('abort before the handshake: an aborted signal spawns nothing', async () => {
  const harness = await suite.testConnect();
  let spawns = 0;
  suite.onSpawn(() => {
    spawns += 1;
  });
  const controller = new AbortController();
  controller.abort(new Error('not wanted'));
  const error = await rejection(harness.sessions.create({ signal: controller.signal }));
  expect(isHudhudError(error, 'ABORTED')).toBe(true);
  expect(error).toMatchObject({ name: 'AbortError' });
  expect(spawns).toBe(0);
  // The Harness is unaffected.
  const session = await harness.sessions.create();
  await session.close();
});

// Abort during the handshake (plan §3.2: "create/resume reject after the
// ladder ran (no orphan)"): the signal aborts once the CLI was spawned and
// its identity read, before the product receives the process, so the abort
// always precedes the handshake (the initialize response takes 581 to 1053
// ms after the spawn, 05 §5 and §14); `create` rejects with AbortError only
// once the process is gone.
test('abort during the handshake: create rejects with AbortError after the process ended', async () => {
  const harness = await suite.testConnect();
  const controller = new AbortController();
  const exits: Promise<unknown>[] = [];
  suite.onSpawn(async (root) => {
    exits.push(root.exited);
    const read = await root.identity;
    expect(read.identity).not.toBeNull();
    controller.abort(new Error('changed my mind'));
  });
  const error = await rejection(harness.sessions.create({ signal: controller.signal }));
  expect(isHudhudError(error, 'ABORTED')).toBe(true);
  expect((error as Error).cause).toEqual(new Error('changed my mind'));
  expect(exits).toHaveLength(1);
  // Gone before the rejection: already settled.
  const settled = await Promise.race([exits[0], Promise.resolve('pending')]);
  expect(settled).not.toBe('pending');
  expect((await suite.mock()).requests).toEqual([]);
});

// Abort after the handshake: `close({ signal })` with an aborted signal
// turns the drain into the abort ladder (plan §2.2); `session.terminated`
// says intent `abort`, outcome `aborted` (plan §3.3).
test('abort after the handshake: close with an aborted signal ends aborted', async () => {
  const session = await suite.testSession();
  const recording = record(session);
  await session.ask('[[mock:text]] then abort');
  const controller = new AbortController();
  controller.abort();
  const error = await rejection(session.close({ signal: controller.signal }));
  expect(isHudhudError(error, 'ABORTED')).toBe(true);
  await session.closed;
  expect(terminatedOf(await recording.done)).toMatchObject({ intent: 'abort', outcome: 'aborted' });
});

// `Symbol.asyncDispose` on a Session runs the abort ladder (plan §2.2);
// mid-turn the active turn becomes `cancelled` (plan §3.3).
test('session dispose mid-turn: intent dispose, outcome aborted, the turn cancelled', async () => {
  const session = await suite.testSession();
  const recording = record(session);
  const turn = session.send('[[mock:hang]] disposed while waiting');
  await requestArrived('disposed while waiting');
  await session[Symbol.asyncDispose]();
  expect((await turn.done).outcome).toBe('cancelled');
  expect(terminatedOf(await recording.done)).toMatchObject({
    intent: 'dispose',
    outcome: 'aborted',
  });
});

// Disposing a Harness disposes its live sessions and refuses new ones
// (plan §2.2, §3.1 HARNESS_DISPOSED; connect.ts module remarks).
test('Harness dispose ends every live session and refuses new ones', async () => {
  const harness = await suite.testConnect();
  const sessions: Session[] = [await harness.sessions.create(), await harness.sessions.create()];
  const recordings = sessions.map((session) => record(session));
  await sessions[0]?.ask('[[mock:text]] idle one');
  const busy = sessions[1]?.send('[[mock:hang]] busy one');
  await requestArrived('busy one');

  await harness[Symbol.asyncDispose]();
  for (const recording of recordings) {
    expect(terminatedOf(await recording.done)).toMatchObject({
      intent: 'dispose',
      outcome: 'aborted',
    });
  }
  expect((await busy?.done)?.outcome).toBe('cancelled');
  for (const session of sessions) await session.closed;

  const create = await rejection(harness.sessions.create());
  expect(isHudhudError(create, 'HARNESS_DISPOSED')).toBe(true);
  const resume = await rejection(harness.sessions.resume(sessions[0]?.id ?? ''));
  expect(isHudhudError(resume, 'HARNESS_DISPOSED')).toBe(true);
  // A second dispose is harmless.
  await expect(harness[Symbol.asyncDispose]()).resolves.toBeUndefined();
});

// `session()` (plan §2.3): connect and create in one call through the same
// pipeline; its Harness is private and disposed with the session
// (`disposeWhenClosed`). That Harness is unreachable by design, so what is
// observable is that the session runs on the pinned CLI, closes gracefully
// and leaves no process behind, and that a failed open leaves nothing
// running either (the harness checks both after the test).
test('session(): one call opens a session on the pinned CLI; it closes and nothing remains', async () => {
  const session = await suite.testSessionFunction({ claudeCode: { includePartialMessages: true } });
  expect(session.info).toMatchObject({ mode: 'create', version: suite.cli.version });
  const recording = record(session);
  const reply = 'from session()';
  const result = await session.ask(`[[mock:text t=${b64(reply)}]] one call`);
  expect(result).toMatchObject({ outcome: 'completed', text: reply });
  await session.close();
  const events = await recording.done;
  expect(events[0]).toMatchObject({
    type: 'compat',
    compat: { status: suite.expectedCompatStatus },
  });
  expect(ofType(events, 'message.delta').length).toBeGreaterThan(0);
  expect(terminatedOf(events)).toMatchObject({ intent: 'close', outcome: 'closed' });
});

test('session(): an open aborted during the handshake rejects and leaves nothing running', async () => {
  const controller = new AbortController();
  // The harness hands the CLI over only once its identity was read.
  suite.onSpawn(() => {
    controller.abort();
  });
  const error = await rejection(suite.testSessionFunction({ signal: controller.signal }));
  expect(isHudhudError(error, 'ABORTED')).toBe(true);
});
