// The golden-fixture scripts (plan §4.3, W3-T6, moved by W3-Z): every case
// of every suite runs against a scripted session that answers each wait
// from a fixed set of frames, so the scripts are checked without the CLI
// and without real waits.

import { describe, expect, it } from 'vitest';

import type { JsonValue, OutRecord } from '../../../src/fixtures/session.js';
import {
  b64,
  createSuites,
  field,
  inputOf,
  requestIdOf,
  sessionId,
  SUITES,
  userFrame,
  type ScriptSession,
  type SuiteContext,
} from '../../../src/fixtures/record/suites.js';

/** Frames a wait may be answered with. Every predicate sees every frame. */
const FRAMES: readonly JsonValue[] = [
  'plain text',
  { type: 'result', subtype: 'success' },
  { type: 'control_response', response: { subtype: 'success', request_id: 'other' } },
  { type: 'control_response', response: { subtype: 'success', request_id: 'init_1' } },
  { type: 'control_request', request_id: 'req_1', request: { subtype: 'can_use_tool' } },
  { type: 'control_cancel_request', request_id: 'req_1' },
  { type: 'stream_event', event: { type: 'message_start' } },
  { type: 'stream_event', event: { type: 'content_block_delta' } },
  { type: 'system', subtype: 'init' },
  { type: 'system', subtype: 'session_state_changed' },
  { type: 'assistant', message: { content: [{ type: 'text' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
  { type: 'system', subtype: 'task_started' },
  { type: 'command_lifecycle', state: 'queued' },
  { type: 'command_lifecycle', state: 'completed' },
];

const record = (v: JsonValue): OutRecord => ({ t: 0, dir: 'out', v });

/** A scripted session: records what the script sends and answers every wait. */
class ScriptedSession implements ScriptSession {
  readonly sent: string[] = [];
  readonly waits: string[] = [];

  control(requestId: string, subtype: string): string {
    this.sent.push(`control ${subtype} ${requestId}`);
    return requestId;
  }
  user(text: string): void {
    this.sent.push(`user ${text}`);
  }
  send(frame: JsonValue): void {
    this.sent.push(`send ${JSON.stringify(frame)}`);
  }
  sendRaw(line: string): void {
    this.sent.push(`raw ${line}`);
  }
  respond(requestId: string, response: JsonValue): void {
    this.sent.push(`respond ${requestId} ${JSON.stringify(response)}`);
  }
  closeStdin(): void {
    this.sent.push('eof');
  }
  waitFor(match: (record: OutRecord) => boolean, _timeoutMs: number, label: string) {
    this.waits.push(label);
    // Every frame is offered to the predicate (each branch of it runs).
    const hits = FRAMES.map(record).filter((candidate) => match(candidate));
    const hit = hits[0];
    return hit === undefined
      ? Promise.reject(new Error(`no frame for ${label}`))
      : Promise.resolve(hit);
  }
  waitType(type: string, subtype: string | undefined, timeoutMs: number) {
    const frames = FRAMES.map(record).filter(
      (candidate) =>
        field(candidate.v, 'type') === type &&
        (subtype === undefined ||
          field(candidate.v, 'subtype') === subtype ||
          field(field(candidate.v, 'request'), 'subtype') === subtype ||
          field(field(candidate.v, 'response'), 'subtype') === subtype),
    );
    return this.waitFor(
      (candidate) => frames.includes(candidate) || frames.some((f) => f.v === candidate.v),
      timeoutMs,
      subtype === undefined ? type : `${type}/${subtype}`,
    );
  }
}

/** Plan §4.3, in plan order, then the K10 suite and the dropped-message suite (research 10). */
const PLAN_SUITES = [
  'handshake',
  'text-turn',
  'two-turns',
  'partial-messages',
  'tool-bash',
  'permission-allow',
  'permission-deny',
  'permission-deny-interrupt',
  'permission-error-response',
  'permission-never-answered-interrupt',
  'permission-eof',
  'interrupt-midstream',
  'interrupt-queued',
  'interrupt-cancel-queued',
  'interrupt-same-write',
  'eof-idle',
  'eof-midstream',
  'eof-midtool',
  'resume',
  'resume-not-found',
  'fork',
  'fork-session-id',
  'auth-401-no-retry',
  'auth-401-retries',
  'overloaded-529',
  'max-turns',
  'bg-shell-turn-after-eof',
  'session-state-events',
  'big-frame-5mb',
  'utf8-arabic',
  'crlf-bom',
  'auth-token-source',
  'resume-duplicate-uuid',
];

describe('the suites', () => {
  it('are the suites of plan §4.3 in plan order, then the K10 and research 10 suites', () => {
    expect(SUITES.map((suite) => suite.name)).toEqual(PLAN_SUITES);
    const k10 = SUITES.find((suite) => suite.name === 'auth-token-source');
    expect(k10?.credential).toBe('fake-auth-token');
    expect(SUITES.filter((suite) => suite.credential !== undefined)).toHaveLength(1);
    expect(SUITES.filter((suite) => suite.compress === true).map((s) => s.name)).toEqual([
      'big-frame-5mb',
    ]);
  });

  it('run every case script to its end, pausing only through the given delay', async () => {
    const pauses: number[] = [];
    const suites = createSuites((ms) => {
      pauses.push(ms);
      return Promise.resolve();
    });
    for (const suite of suites) {
      const context: SuiteContext = new Map();
      for (const spec of suite.cases) {
        const launch = spec.launch(context);
        expect(launch).toBeTypeOf('object');
        const session = new ScriptedSession();
        await spec.drive(session, context);
        expect(session.sent.length, `${suite.name}/${spec.name}`).toBeGreaterThan(0);
        expect(spec.shape.length).toBeGreaterThan(0);
      }
    }
    expect([...new Set(pauses)].sort((a, b) => a - b)).toEqual([200, 300, 500, 1500, 3000]);
  });

  it('share the session ids of a suite between its setup and main cases', () => {
    const resume = SUITES.find((suite) => suite.name === 'resume');
    const context: SuiteContext = new Map();
    const [setup, main] = resume?.cases ?? [];
    const setupArgs = setup?.launch(context).args ?? [];
    const mainArgs = main?.launch(context).args ?? [];
    expect(setupArgs[0]?.replace('--session-id=', '')).toBe(mainArgs[0]?.replace('--resume=', ''));
  });
});

describe('script helpers', () => {
  it('encodes marker arguments and user frames', () => {
    expect(b64('echo hi')).toBe('ZWNobyBoaQ==');
    expect(userFrame('x')).toEqual({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: 'x' }] },
      parent_tool_use_id: null,
    });
    expect(userFrame('x', 'u')).toMatchObject({ uuid: 'u' });
  });

  it('reads fields, request ids and tool inputs', () => {
    expect(field({ a: 1 }, 'a')).toBe(1);
    for (const value of ['s', 1, null, [1], undefined] as const) {
      expect(field(value, 'a')).toBeUndefined();
    }
    expect(requestIdOf(record({ request_id: 'r' }))).toBe('r');
    expect(() => requestIdOf(record({ request_id: 1 }))).toThrow(/without request_id/);
    expect(inputOf(record({ request: { input: { c: 'x' } } }))).toEqual({ c: 'x' });
    expect(inputOf(record({ request: {} }))).toEqual({});
  });

  it('creates a session id once per key', () => {
    const context: SuiteContext = new Map();
    const first = sessionId(context, 'U1');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionId(context, 'U1')).toBe(first);
    expect(sessionId(context, 'U2')).not.toBe(first);
  });

  it('fails a script whose frame never comes', async () => {
    const handshake = SUITES[0]?.cases[0];
    const silent = new ScriptedSession();
    silent.waitFor = (_match, _timeout, label) => Promise.reject(new Error(`timeout ${label}`));
    await expect(handshake?.drive(silent, new Map())).rejects.toThrow(/initialize response/);
  });
});
