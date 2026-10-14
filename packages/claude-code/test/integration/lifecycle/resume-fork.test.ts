// Lifecycle (W6-T1, plan §4.4 "lifecycle", §5.8): sessions.resume, fork and
// the per-Harness session-id registry against the pinned CLI. Evidence: the
// resume/fork matrix of 07 §1 (Windows and Linux identical) and the
// conformance suites recorded from it (plan §4.3: `resume`, `resume-not-found`,
// `fork`, `fork-session-id`).

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { HudhudEvent, Session } from '@hudhud/core';
import { expect, test } from 'vitest';

import type { ClaudeCodeHarness } from '../../../src/connect.js';
import { integrationSuite } from '../support/harness.js';
import {
  diagnostics,
  hasCode,
  messagesOf,
  ofType,
  record,
  terminatedOf,
  turnRequests,
} from './events.js';

const suite = integrationSuite();

/** A first session with one echo turn naming `word`, closed; its id. */
async function seed(harness: ClaudeCodeHarness, word: string): Promise<string> {
  const session = await harness.sessions.create();
  const result = await session.ask(`[[mock:echo]] ${word}`);
  expect(result.text?.endsWith(word)).toBe(true);
  await session.close();
  return session.id;
}

/** The transcript files `<cfg>/projects/<project>/<id>.jsonl` (07 §1 "Transcripts"). */
async function transcripts(id: string): Promise<string[]> {
  const projects = path.join((await suite.sandbox()).dirs.cfg, 'projects');
  if (!existsSync(projects)) return [];
  return readdirSync(projects)
    .map((project) => path.join(projects, project, `${id}.jsonl`))
    .filter((file) => existsSync(file));
}

/** The session id the CLI reported in the turn's `system/init` (07 §1 column 5). */
function initSessionId(events: readonly HudhudEvent[]): unknown {
  const raw = ofType(events, 'turn.started')[0]?.raw;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Readonly<Record<string, unknown>>)['session_id']
    : undefined;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

// Conformance `resume` (07 §1 a1, a2: `--resume=U1` runs under U1 with the
// history loaded; nothing is replayed on stdout before the first message).
test('sessions.resume continues the session under its id with its history', async () => {
  const harness = await suite.testConnect();
  const id = await seed(harness, 'ALPHA');
  const session = await harness.sessions.resume(id);
  expect(session.id).toBe(id);
  expect(session.info).toMatchObject({ id, mode: 'resume', version: suite.cli.version });
  expect(session.info.forkedFrom).toBeUndefined();
  const recording = record(session);
  const result = await session.ask('[[mock:echo]] BRAVO');
  expect(result).toMatchObject({ sessionId: id, outcome: 'completed', text: 'ECHO:BRAVO' });
  await session.close();
  const events = await recording.done;
  expect(ofType(events, 'session.started')[0]?.mode).toBe('resume');
  expect(initSessionId(events)).toBe(id);
  expect(diagnostics(events, 'session.id-mismatch')).toEqual([]);
  expect(terminatedOf(events)).toMatchObject({ intent: 'close', outcome: 'closed' });
  // The resumed turn's request carries the first session's history (a2).
  const [request] = turnRequests(await suite.mock(), 'BRAVO');
  expect(request).toBeDefined();
  if (request === undefined) return;
  expect(JSON.stringify(messagesOf(request))).toContain('ALPHA');
  expect(await transcripts(id)).toHaveLength(1);
});

// Conformance `resume-not-found` (07 §1 a11: an error result with num_turns
// 0 before any control_response, exit 1) -> SESSION_NOT_FOUND (plan §3.1, J7).
test('resuming an unknown session id rejects with SESSION_NOT_FOUND and leaves nothing running', async () => {
  // The CLI exits on its own right after the spawn (a11), often before the
  // Windows identity read (one process-table query) finished.
  await suite.setup({ rootsMayExitBeforeIdentity: true });
  const harness = await suite.testConnect();
  const unknown = randomUUID();
  const error = await rejection(harness.sessions.resume(unknown));
  expect(hasCode(error, 'SESSION_NOT_FOUND')).toBe(true);
  expect(error).toMatchObject({ name: 'SessionNotFoundError', retryable: false });
  // The id is free again afterwards (the claim was released with the session).
  const again = await rejection(harness.sessions.resume(unknown));
  expect(hasCode(again, 'SESSION_NOT_FOUND')).toBe(true);
  // No API request was made for it.
  expect((await suite.mock()).requests).toEqual([]);
});

// Conformance `fork` and `fork-session-id` (07 §1 a4, a5: a fork runs under
// a new id with a full copy of the history; with `--session-id=U2` under
// U2). The product always names the fork's id (plan §2.5, §4.3 W4-Z ruling 8).
test('fork continues a session under a new hudhud-chosen id; the original is unchanged', async () => {
  const harness = await suite.testConnect();
  const id = await seed(harness, 'ALPHA');
  const fork = await harness.sessions.resume(id, { fork: true });
  expect(fork.id).not.toBe(id);
  expect(fork.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(fork.info).toMatchObject({ id: fork.id, mode: 'fork', forkedFrom: id });
  const forkRecording = record(fork);
  const forked = await fork.ask('[[mock:echo]] BRAVO');
  expect(forked).toMatchObject({ sessionId: fork.id, outcome: 'completed', text: 'ECHO:BRAVO' });
  await fork.close();
  const forkEvents = await forkRecording.done;
  expect(ofType(forkEvents, 'session.started')[0]?.mode).toBe('fork');
  // The CLI runs under the id hudhud chose (a5), so no mismatch is reported.
  expect(initSessionId(forkEvents)).toBe(fork.id);
  expect(diagnostics(forkEvents, 'session.id-mismatch')).toEqual([]);
  expect(terminatedOf(forkEvents)).toMatchObject({ intent: 'close', outcome: 'closed' });

  const mock = await suite.mock();
  const [forkRequest] = turnRequests(mock, 'BRAVO');
  expect(JSON.stringify(forkRequest === undefined ? null : messagesOf(forkRequest))).toContain(
    'ALPHA',
  );
  // Two transcripts: the original and the fork's copy (07 §1 "Transcripts").
  expect(await transcripts(id)).toHaveLength(1);
  expect(await transcripts(fork.id)).toHaveLength(1);

  // The original continues without the fork's turn.
  const original = await harness.sessions.resume(id);
  const continued = await original.ask('[[mock:echo]] CHARLIE');
  expect(continued.text).toBe('ECHO:CHARLIE');
  await original.close();
  const [originalRequest] = turnRequests(mock, 'CHARLIE');
  const history = JSON.stringify(
    originalRequest === undefined ? null : messagesOf(originalRequest),
  );
  expect(history).toContain('ALPHA');
  expect(history).not.toContain('BRAVO');
});

// J6 (07 §1 "Concurrency": the CLI provides no exclusion on resume, so
// hudhud owns it): a second live session with the same id in one Harness is
// SESSION_ID_IN_USE, refused before anything is spawned; the id is free
// again once the live session ended. A fork of a live session is a new id
// and is not refused.
test('two live resumes of the same id in one Harness: the second is SESSION_ID_IN_USE', async () => {
  const harness = await suite.testConnect();
  const id = await seed(harness, 'ALPHA');
  let spawns = 0;
  suite.onSpawn(() => {
    spawns += 1;
  });
  const live = await harness.sessions.resume(id);
  expect(spawns).toBe(1);
  const second = await rejection(harness.sessions.resume(id));
  expect(hasCode(second, 'SESSION_ID_IN_USE')).toBe(true);
  expect(second).toMatchObject({ name: 'SessionIdInUseError', retryable: true });
  expect(spawns).toBe(1);

  const fork: Session = await harness.sessions.resume(id, { fork: true });
  expect(fork.id).not.toBe(id);
  expect(spawns).toBe(2);

  // The live session still works, and is the only one under its id.
  const result = await live.ask('[[mock:echo]] DELTA');
  expect(result.text).toBe('ECHO:DELTA');
  await live.close();
  await fork.close();

  // Ended: the id may be resumed again.
  const after = await harness.sessions.resume(id);
  expect(after.id).toBe(id);
  await after.close();
  expect(spawns).toBe(3);
});

// J6 with a session created under the id in the same Harness.
test('resuming the id of a live created session is SESSION_ID_IN_USE', async () => {
  const harness = await suite.testConnect();
  const created = await harness.sessions.create();
  const error = await rejection(harness.sessions.resume(created.id));
  expect(hasCode(error, 'SESSION_ID_IN_USE')).toBe(true);
  await created.close();
});
