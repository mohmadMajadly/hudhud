// The lifecycle matrix (R8-2): every public call that takes an AbortSignal,
// crossed with the state of its signal (none, live, aborted before the call,
// aborted while the call is in flight) and with a dispose (none, before the
// call, while it is in flight, after it settled). Every cell asserts the
// documented behaviour (docs/guide/sessions.md, events.md; ADR-0007,
// ADR-0008): how the call settles, that nothing is written for a signal
// aborted before the call or on a disposed session, that the CLI is gone once
// a dispose resolved, and that no abort listener stays on the caller's
// signal once the call settled.

import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import type { Session } from '@hudhudjs/core';

import { connectWith } from '../../../src/connect.js';
import { BINARY, controlOk, FakeHost, settle, type FakeCli } from './fake-host.js';

type SignalKind = 'none' | 'live' | 'aborted-early' | 'aborted-mid';
type DisposeKind = 'none' | 'before' | 'during' | 'after';
/** How a call settled: `ok`, or the code of the error it rejected with. */
type Settled = string;
type Table = Readonly<Record<SignalKind, Readonly<Record<DisposeKind, Settled>>>>;

const SIGNALS: readonly SignalKind[] = ['none', 'live', 'aborted-early', 'aborted-mid'];
const DISPOSES: readonly DisposeKind[] = ['none', 'before', 'during', 'after'];
const CELLS = SIGNALS.flatMap((s) => DISPOSES.map((d) => [s, d] as const));

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code: unknown }).code)
    : `not a HudhudError: ${String(error)}`;
}

async function settled(promise: PromiseLike<unknown>): Promise<Settled> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return codeOf(error);
  }
}

/** The CLI side of the matrix: turns and permission-mode changes can be held. */
interface HeldCli {
  hold: boolean;
  release(): void;
}

/**
 * A fake CLI that starts a turn (`system/init`) at once and, while `hold` is
 * set, holds its result and the answer to `set_permission_mode`; an
 * interrupt ends a started turn as cancelled (`aborted_streaming`), as the
 * recorded CLI does.
 */
function heldCli(fake: FakeHost): HeldCli {
  const running: string[] = [];
  const answers: (() => void)[] = [];
  const finish = (cli: FakeCli, uuid: string, cancelled: boolean): void => {
    cli.emit({
      type: 'result',
      subtype: cancelled ? 'error_during_execution' : 'success',
      is_error: cancelled,
      ...(cancelled ? { terminal_reason: 'aborted_streaming' } : { result: 'done' }),
      num_turns: 1,
      session_id: cli.sessionId,
      user_message_uuid: uuid,
      uuid: `r-${uuid}`,
    });
    cli.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  };
  const held: HeldCli = {
    hold: false,
    release: () => {
      for (const answer of answers.splice(0)) answer();
    },
  };
  fake.script = {
    onWrite: (frame, cli) => {
      if (frame['type'] === 'user') {
        const uuid = String(frame['uuid']);
        cli.emit({ type: 'system', subtype: 'init', session_id: cli.sessionId, uuid: `i-${uuid}` });
        if (!held.hold) {
          finish(cli, uuid, false);
          return true;
        }
        running.push(uuid);
        answers.push(() => {
          if (running.includes(uuid)) {
            running.splice(running.indexOf(uuid), 1);
            finish(cli, uuid, false);
          }
        });
        return true;
      }
      const request = frame['request'] as Record<string, unknown> | undefined;
      const id = String(frame['request_id']);
      if (request?.['subtype'] === 'interrupt') {
        cli.emit(controlOk(id, { still_queued: [] }));
        for (const uuid of running.splice(0)) finish(cli, uuid, true);
        return true;
      }
      if (request?.['subtype'] === 'set_permission_mode' && held.hold) {
        answers.push(() => {
          cli.emit(controlOk(id, {}));
        });
        return true;
      }
      return undefined;
    },
  };
  return held;
}

interface World {
  readonly fake: FakeHost;
  readonly harness: Awaited<ReturnType<typeof connectWith>>;
  readonly cli: HeldCli;
}

async function world(): Promise<World> {
  const fake = new FakeHost();
  const cli = heldCli(fake);
  const harness = await connectWith({ binaryPath: BINARY }, fake.make);
  return { fake, harness, cli };
}

function signalFor(kind: SignalKind): {
  readonly signal?: AbortSignal;
  readonly controller?: AbortController;
} {
  if (kind === 'none') return {};
  const controller = new AbortController();
  if (kind === 'aborted-early') controller.abort('early');
  return { signal: controller.signal, controller };
}

function listeners(signal: AbortSignal | undefined): number {
  return signal === undefined ? 0 : getEventListeners(signal, 'abort').length;
}

function writtenKinds(cli: FakeCli, from: number): string[] {
  return cli.written.slice(from).map((frame) => {
    const request = frame['request'] as Record<string, unknown> | undefined;
    return request === undefined
      ? String(frame['type'])
      : `${String(frame['type'])}:${String(request['subtype'])}`;
  });
}

// ---- session calls ---------------------------------------------------------------------

interface SessionCall {
  /**
   * The frame the call writes when it proceeds (`type` or `type:subtype`),
   * never written for a signal aborted before the call or on a disposed
   * session; none for `close` (an aborted close is an abort, whose ladder
   * writes the interrupt).
   */
  readonly writes?: string;
  /** In flight means a drain that waits for a running turn (`close`). */
  readonly busy?: boolean;
  /** The call settles only when the session ends (`events()`): the cell closes it. */
  readonly untilEnd?: boolean;
  /** Starts the call; what it returns settles as the call does. */
  start(session: Session, signal: AbortSignal | undefined): PromiseLike<unknown>;
  readonly expected: Table;
}

async function sessionCell(call: SessionCall, s: SignalKind, d: DisposeKind): Promise<Settled> {
  const w = await world();
  const session = await w.harness.sessions.create();
  const cli = w.fake.cli;
  const { signal, controller } = signalFor(s);
  w.cli.hold = s === 'aborted-mid' || d === 'during';
  if (d === 'before') await session[Symbol.asyncDispose]();
  // A turn the drain waits for (its own outcome is not this cell's subject).
  if (call.busy === true && w.cli.hold && d !== 'before') {
    session.ask('busy').catch(() => undefined);
  }
  const from = cli.written.length;
  const running = settled(call.start(session, signal));
  await settle();
  if (s === 'aborted-mid') controller?.abort('mid');
  if (d === 'during') {
    await session[Symbol.asyncDispose]();
    expect(cli.exitStatus, 'the CLI is gone once dispose resolved').not.toBeNull();
  }
  w.cli.hold = false;
  w.cli.release();
  if (call.untilEnd === true && (d === 'none' || d === 'after')) await session.close();
  const outcome = await running;
  if (call.writes !== undefined && (s === 'aborted-early' || d === 'before')) {
    expect(writtenKinds(cli, from), 'nothing is written').not.toContain(call.writes);
  }
  if (d === 'after') {
    await session[Symbol.asyncDispose]();
    expect(cli.exitStatus, 'the CLI is gone once dispose resolved').not.toBeNull();
  }
  await settle();
  expect(listeners(signal), 'no abort listener stays on the signal').toBe(0);
  await session[Symbol.asyncDispose]();
  await w.harness[Symbol.asyncDispose]();
  return outcome;
}

/** Drains a turn's iterator; the iterator's own outcome. */
async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  const iterator = iterable[Symbol.asyncIterator]();
  for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
    // Each event is only consumed.
  }
}

const SESSION_CALLS: Readonly<Record<string, SessionCall>> = {
  ask: {
    writes: 'user',
    start: (session, signal) => session.ask('hi', signal === undefined ? {} : { signal }),
    expected: table({
      none: ['ok', 'SESSION_CLOSED', 'ok', 'ok'],
      live: ['ok', 'SESSION_CLOSED', 'ok', 'ok'],
      'aborted-early': ['ABORTED', 'ABORTED', 'ABORTED', 'ABORTED'],
      'aborted-mid': ['ABORTED', 'SESSION_CLOSED', 'ABORTED', 'ABORTED'],
    }),
  },
  'send (done)': {
    writes: 'user',
    start: (session, signal) => session.send('hi', signal === undefined ? {} : { signal }).done,
    expected: table({
      none: ['ok', 'SESSION_CLOSED', 'ok', 'ok'],
      live: ['ok', 'SESSION_CLOSED', 'ok', 'ok'],
      'aborted-early': ['ABORTED', 'ABORTED', 'ABORTED', 'ABORTED'],
      'aborted-mid': ['ABORTED', 'SESSION_CLOSED', 'ABORTED', 'ABORTED'],
    }),
  },
  'send (iterator)': {
    writes: 'user',
    start: (session, signal) => drain(session.send('hi', signal === undefined ? {} : { signal })),
    expected: table({
      none: ['ok', 'SESSION_CLOSED', 'ok', 'ok'],
      live: ['ok', 'SESSION_CLOSED', 'ok', 'ok'],
      'aborted-early': ['ABORTED', 'ABORTED', 'ABORTED', 'ABORTED'],
      'aborted-mid': ['ABORTED', 'SESSION_CLOSED', 'ABORTED', 'ABORTED'],
    }),
  },
  setPermissionMode: {
    writes: 'control_request:set_permission_mode',
    start: (session, signal) =>
      session.setPermissionMode('plan', signal === undefined ? {} : { signal }),
    expected: table({
      none: ['ok', 'SESSION_CLOSED', 'SESSION_CLOSED', 'ok'],
      live: ['ok', 'SESSION_CLOSED', 'SESSION_CLOSED', 'ok'],
      'aborted-early': ['ABORTED', 'ABORTED', 'ABORTED', 'ABORTED'],
      'aborted-mid': ['ABORTED', 'SESSION_CLOSED', 'ABORTED', 'ABORTED'],
    }),
  },
  events: {
    untilEnd: true,
    start: (session, signal) => drain(session.events(signal === undefined ? {} : { signal })),
    expected: table({
      none: ['ok', 'ok', 'ok', 'ok'],
      live: ['ok', 'ok', 'ok', 'ok'],
      'aborted-early': ['ABORTED', 'ABORTED', 'ABORTED', 'ABORTED'],
      'aborted-mid': ['ABORTED', 'ok', 'ABORTED', 'ABORTED'],
    }),
  },
  close: {
    busy: true,
    start: (session, signal) => session.close(signal === undefined ? {} : { signal }),
    expected: table({
      none: ['ok', 'ok', 'ok', 'ok'],
      live: ['ok', 'ok', 'ok', 'ok'],
      'aborted-early': ['ABORTED', 'ABORTED', 'ABORTED', 'ABORTED'],
      'aborted-mid': ['ABORTED', 'ok', 'ABORTED', 'ABORTED'],
    }),
  },
};

/** Rows of `[none, before, during, after]` as a table. */
function table(rows: Readonly<Record<SignalKind, readonly Settled[]>>): Table {
  const out = {} as Record<SignalKind, Record<DisposeKind, Settled>>;
  for (const s of SIGNALS) {
    out[s] = Object.fromEntries(DISPOSES.map((d, index) => [d, rows[s][index] ?? '?'])) as Record<
      DisposeKind,
      Settled
    >;
  }
  return out;
}

describe.each(Object.entries(SESSION_CALLS))('%s', (_name, call) => {
  it.each(CELLS)('signal %s, dispose %s', async (s, d) => {
    expect(await sessionCell(call, s, d)).toBe(call.expected[s][d]);
  });
});

// ---- sessions.create with a Harness dispose ---------------------------------------------------

/** `sessions.create({ signal })` × a dispose of the Harness; "during" lands in the spawn. */
async function createCell(s: SignalKind, d: DisposeKind): Promise<Settled> {
  const fake = new FakeHost();
  const harness = await connectWith({ binaryPath: BINARY }, fake.make);
  const { signal, controller } = signalFor(s);
  if (d === 'before') await harness[Symbol.asyncDispose]();
  let disposing: PromiseLike<void> | undefined;
  fake.beforeSpawn = () => {
    if (s === 'aborted-mid') {
      queueMicrotask(() => {
        controller?.abort('mid');
      });
    }
    if (d === 'during') disposing = harness[Symbol.asyncDispose]();
  };
  const outcome = await settled(harness.sessions.create(signal === undefined ? {} : { signal }));
  if (disposing !== undefined) await disposing;
  if (s === 'aborted-early' || d === 'before') {
    expect(fake.log, 'nothing is spawned').not.toContain('spawn');
  } else if (outcome !== 'ok') {
    expect(fake.cli.exitStatus, 'a failed start leaves nothing running').not.toBeNull();
  }
  await harness[Symbol.asyncDispose]();
  for (const cli of fake.clis) expect(cli.exitStatus, 'dispose ends every CLI').not.toBeNull();
  await settle();
  expect(listeners(signal), 'no abort listener stays on the signal').toBe(0);
  return outcome;
}

const CREATE_EXPECTED = table({
  none: ['ok', 'HARNESS_DISPOSED', 'HARNESS_DISPOSED', 'ok'],
  live: ['ok', 'HARNESS_DISPOSED', 'HARNESS_DISPOSED', 'ok'],
  'aborted-early': ['ABORTED', 'HARNESS_DISPOSED', 'ABORTED', 'ABORTED'],
  'aborted-mid': ['ABORTED', 'HARNESS_DISPOSED', 'HARNESS_DISPOSED', 'ABORTED'],
});

describe('sessions.create', () => {
  it.each(CELLS)('signal %s, Harness dispose %s', async (s, d) => {
    expect(await createCell(s, d)).toBe(CREATE_EXPECTED[s][d]);
  });
});
