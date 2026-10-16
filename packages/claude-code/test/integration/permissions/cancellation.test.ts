// How a pending permission request ends without the handler's decision,
// against the pinned CLI (W6-T2, plan §5.8; ADR-0007, K12): withdrawn by the
// CLI, by the application's AbortSignal, by close (a non-interrupting deny is
// written so the turn reaches idle), by abort (nothing is written: the
// interrupt makes the CLI withdraw it), asked during the drain, and never
// answered. In every case no allow reaches the CLI, the handler's signal
// fires with the reason, and the tool never runs.
// Evidence: 05 §6 runs 29 and 30 (recorded again as the conformance suites
// permission-never-answered-interrupt and permission-eof).

import type { PermissionDecision, PermissionRequest, Session } from '@hudhudjs/core';
import { expect, test } from 'vitest';

import { integrationSuite } from '../support/harness.js';
import {
  canUseToolIds,
  frameKind,
  markerExists,
  member,
  onlyAnswer,
  PERMISSION_MARKER,
  type SessionTap,
  tappedSession,
  toolResultsSent,
} from './support.js';

const suite = integrationSuite();

/** A handler that records its calls and lets the test decide when (and whether) it answers. */
class PendingHandler {
  readonly requests: PermissionRequest[] = [];
  readonly signals: AbortSignal[] = [];
  readonly #called: Promise<void>;
  #onCall: () => void = () => undefined;

  readonly #answer: (signal: AbortSignal) => Promise<PermissionDecision>;

  constructor(answer: (signal: AbortSignal) => Promise<PermissionDecision>) {
    this.#answer = answer;
    this.#called = new Promise((resolve) => {
      this.#onCall = resolve;
    });
  }

  readonly handle = (
    request: PermissionRequest,
    ctx: { readonly signal: AbortSignal },
  ): Promise<PermissionDecision> => {
    this.requests.push(request);
    this.signals.push(ctx.signal);
    this.#onCall();
    return this.#answer(ctx.signal);
  };

  /** Resolves once the handler was called. */
  called(): Promise<void> {
    return this.#called;
  }
}

/** Resolves when `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else {
      signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    }
  });
}

/** The reason message the bridge aborts a handler's signal with. */
function withdrawnReason(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason.message : String(reason);
}

/** A handler that waits for its signal, then answers allow: a late answer that must be dropped. */
function lateAllow(): PendingHandler {
  return new PendingHandler(async (signal) => {
    await aborted(signal);
    return { behavior: 'allow' };
  });
}

async function openSession(
  handler: PendingHandler,
): Promise<{ session: Session; tap: SessionTap; work: string }> {
  const { session, tap } = await tappedSession(suite, {
    permissionMode: 'default',
    onPermission: handler.handle,
  });
  return { session, tap, work: (await suite.sandbox()).dirs.work };
}

/** Whether the CLI withdrew `requestId` itself (`control_cancel_request`). */
function cliCancelled(tap: SessionTap, requestId: string): boolean {
  return tap.frames.some(
    (frame) =>
      frame.direction === 'in' &&
      frameKind(frame.frame).type === 'control_cancel_request' &&
      member(frame.frame, 'request_id') === requestId,
  );
}

test('withdrawn by the CLI: an interrupt makes the CLI cancel its request; the late allow is dropped (05 §6 run 29, permission-never-answered-interrupt)', async () => {
  const handler = lateAllow();
  const { session, tap, work } = await openSession(handler);

  const turn = session.send(PERMISSION_MARKER);
  await handler.called();
  await turn.interrupt();
  const result = await turn.done;
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({
    outcome: 'cancelled',
    isError: true,
    terminalReason: 'aborted_tools',
  });
  const [requestId = ''] = canUseToolIds(tap);
  expect(cliCancelled(tap, requestId)).toBe(true);
  expect(withdrawnReason(handler.signals[0])).toBe('permission request withdrawn: harness');
  // Nothing was written for the request: the handler's allow came after the withdrawal.
  expect(tap.answersTo(requestId)).toEqual([]);
  expect(markerExists(work)).toBe(false);
  expect(tap.eventsOf('permission.resolved')).toMatchObject([
    { requestId, behavior: 'cancelled', by: 'harness' },
  ]);
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test('never answered, then interrupted: the turn is cancelled and the session closes gracefully although the handler never settles (05 §6 run 29)', async () => {
  // A handler that ignores its signal and never settles.
  const handler = new PendingHandler(() => new Promise<PermissionDecision>(() => undefined));
  const { session, tap, work } = await openSession(handler);

  const turn = session.send(PERMISSION_MARKER);
  await handler.called();
  await turn.interrupt();
  const result = await turn.done;
  // The session is still usable: the next turn runs normally.
  const next = await session.ask('[[mock:text]] after');
  await session.close();
  await tap.ended;

  expect(result).toMatchObject({ outcome: 'cancelled', terminalReason: 'aborted_tools' });
  expect(next).toMatchObject({ outcome: 'completed', isError: false });
  const [requestId = ''] = canUseToolIds(tap);
  expect(cliCancelled(tap, requestId)).toBe(true);
  expect(handler.signals[0]?.aborted).toBe(true);
  expect(tap.answersTo(requestId)).toEqual([]);
  expect(markerExists(work)).toBe(false);
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test("withdrawn by the application's AbortSignal: ask() rejects at once, the turn is interrupted and the CLI cancels the request (05 §6 run 29; plan §2.2 ask)", async () => {
  const handler = lateAllow();
  const { session, tap, work } = await openSession(handler);
  const controller = new AbortController();

  const asked = session.ask(PERMISSION_MARKER, { signal: controller.signal });
  await handler.called();
  controller.abort();
  await expect(asked).rejects.toMatchObject({ name: 'AbortError' });
  // The turn still settles in the background.
  const completed = await tap.event('turn.completed');
  await session.close();
  await tap.ended;

  expect(completed.result).toMatchObject({ outcome: 'cancelled', terminalReason: 'aborted_tools' });
  const [requestId = ''] = canUseToolIds(tap);
  expect(cliCancelled(tap, requestId)).toBe(true);
  expect(withdrawnReason(handler.signals[0])).toBe('permission request withdrawn: harness');
  expect(tap.answersTo(requestId)).toEqual([]);
  expect(tap.controlRequestsOut('interrupt')).toHaveLength(1);
  expect(markerExists(work)).toBe(false);
  expect(tap.eventsOf('permission.resolved')).toMatchObject([
    { requestId, behavior: 'cancelled', by: 'harness' },
  ]);
});

test('withdrawn by close: hudhud writes a non-interrupting deny so the turn reaches idle, then closes (K12; 05 §6 run 30 is the unanswered EOF it avoids)', async () => {
  const handler = lateAllow();
  const { session, tap, work } = await openSession(handler);

  const turn = session.send(PERMISSION_MARKER);
  await handler.called();
  await session.close();
  const result = await turn.done;
  await tap.ended;

  // A deny, not an interrupt: the CLI finishes the turn normally.
  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  const [requestId = ''] = canUseToolIds(tap);
  expect(withdrawnReason(handler.signals[0])).toBe('permission request withdrawn: close');
  expect(onlyAnswer(tap, requestId)).toEqual({
    subtype: 'success',
    request_id: requestId,
    response: { behavior: 'deny', message: 'hudhud session closing', interrupt: false },
  });
  expect(tap.controlRequestsOut('interrupt')).toEqual([]);
  expect(markerExists(work)).toBe(false);
  expect(tap.eventsOf('permission.resolved')).toMatchObject([
    { requestId, behavior: 'cancelled', by: 'close' },
  ]);
  // The model got hudhud's fixed text, not the CLI's "stream closed" failure of run 30.
  expect(toolResultsSent(await suite.mock())).toMatchObject([
    { isError: true, text: 'hudhud session closing' },
  ]);
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test('asked during the drain: the request is denied without asking the application, so stdin never closes on an unanswered request (K12; 05 §6 run 30, permission-eof)', async () => {
  const handler = lateAllow();
  const { session, tap, work } = await openSession(handler);

  const turn = session.send(PERMISSION_MARKER);
  // close() before the CLI could ask: the drain keeps stdin open until idle.
  const closed = session.close();
  const result = await turn.done;
  await closed;
  await tap.ended;

  expect(result).toMatchObject({ outcome: 'completed', isError: false });
  expect(handler.requests).toEqual([]);
  const [requestId = ''] = canUseToolIds(tap);
  expect(onlyAnswer(tap, requestId)).toEqual({
    subtype: 'success',
    request_id: requestId,
    response: { behavior: 'deny', message: 'hudhud session closing', interrupt: false },
  });
  expect(tap.eventsOf('permission.requested')).toEqual([]);
  expect(tap.eventsOf('permission.resolved')).toMatchObject([
    { requestId, behavior: 'deny', by: 'close' },
  ]);
  expect(markerExists(work)).toBe(false);
  // The answer was written before stdin closed: the CLI never saw its request fail on EOF.
  expect(JSON.stringify(toolResultsSent(await suite.mock()))).not.toContain('stream closed');
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
});

test('withdrawn by abort: nothing is written for the request, the interrupt makes the CLI withdraw it (K12, ADR-0007)', async () => {
  const handler = lateAllow();
  const { session, tap, work } = await openSession(handler);

  const turn = session.send(PERMISSION_MARKER);
  const settled = turn.done.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await handler.called();
  const controller = new AbortController();
  controller.abort();
  await expect(session.close({ signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  await session.closed;
  await tap.ended;
  await settled;

  const [requestId = ''] = canUseToolIds(tap);
  expect(withdrawnReason(handler.signals[0])).toBe('permission request withdrawn: abort');
  expect(tap.answersTo(requestId)).toEqual([]);
  // The abort ladder's interrupt (cancel_queued) is the only control request written after the ask.
  expect(
    tap.controlRequestsOut('interrupt').map((frame) => member(frame.frame, 'request')),
  ).toEqual([{ subtype: 'interrupt', cancel_queued: true }]);
  expect(markerExists(work)).toBe(false);
  expect(tap.eventsOf('permission.resolved')).toMatchObject([
    { requestId, behavior: 'cancelled', by: 'abort' },
  ]);
  expect(tap.events.at(-1)).toMatchObject({ type: 'session.terminated', intent: 'abort' });
});
