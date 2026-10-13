/**
 * The golden-fixture suites of plan §4.3, as scripted sessions of the
 * pinned CLI (driven by `record.ts`; moved here from the W3-T6 scratch
 * recorder by W3-Z, reused by the canary).
 *
 * @remarks
 * Each suite is one or more cases; a case is one CLI process in the suite's
 * sandbox (resume and fork suites first record a `setup` session whose
 * transcript the main case resumes). The scripts follow the runs of research
 * 05 §5-§12 and 07 §1, §7; `shape` lists the record labels (prefixes of
 * `describeRecord` labels, as an ordered subsequence) and `exit` the exit
 * code those runs observed, so a recording that departs from the research is
 * reported instead of silently committed.
 *
 * The scripts use only {@link ScriptSession} (a subset of
 * `RecordingSession`), and every pause goes through the `delay` given to
 * {@link createSuites}, so the scripts are unit-tested against a scripted
 * session without the CLI and without real waits.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { SandboxCredential } from '../../launcher/env.js';
import type { LaunchOptions } from '../../launcher/sandbox.js';
import { isFrame } from '../session.js';
import type { JsonValue, OutRecord, RecordingSession } from '../session.js';

/** Default wait for one awaited frame. */
const FRAME_MS = 60_000;

/** What a script uses of a {@link RecordingSession}. */
export type ScriptSession = Pick<
  RecordingSession,
  'control' | 'user' | 'send' | 'sendRaw' | 'respond' | 'closeStdin' | 'waitFor' | 'waitType'
>;

/** A pause of a script. */
export type Delay = (ms: number) => Promise<unknown>;

/** Values shared by the cases of one suite (session ids). */
export type SuiteContext = Map<string, string>;

/** One CLI process of a suite. */
export interface CaseSpec {
  /** File name part after the platform: `''` for the main case, else for example `setup`. */
  readonly name: string;
  readonly launch: (context: SuiteContext) => LaunchOptions;
  /** Drives the session; returns when the script is done (the recorder then sends EOF if still open). */
  readonly drive: (session: ScriptSession, context: SuiteContext) => Promise<void>;
  /** Exit code observed in the research; `null` for a signal. */
  readonly exit: number | null;
  /** Expected label prefixes, in order (research 05/07). */
  readonly shape: readonly string[];
  /** Time to wait for the exit after EOF. Default 30 s. */
  readonly exitMs?: number;
}

/** A suite of plan §4.3. */
export interface SuiteSpec {
  readonly name: string;
  /** What the suite records (manifest `scenario`). */
  readonly scenario: string;
  /** Research section the script follows. */
  readonly research: string;
  readonly cases: readonly CaseSpec[];
  /** Stored gzip-compressed (`.jsonl.gz`). */
  readonly compress?: boolean;
  /** The sandbox's fake credential; default the fake API key (see `SandboxCredential`). */
  readonly credential?: SandboxCredential;
}

/** Base64 of UTF-8 text, for marker arguments. */
export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** A field of a JSON object; `undefined` for anything else. */
export function field(value: JsonValue | undefined, name: string): JsonValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)[name]
    : undefined;
}

/** A user frame with one text block and, when given, a `uuid` (turns on `command_lifecycle`). */
export function userFrame(text: string, uuid?: string): JsonValue {
  return {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...(uuid === undefined ? {} : { uuid }),
  };
}

function controlFrame(requestId: string, request: Readonly<Record<string, JsonValue>>): JsonValue {
  return { type: 'control_request', request_id: requestId, request };
}

async function initialize(session: ScriptSession): Promise<void> {
  session.control('init_1', 'initialize');
  await session.waitFor(
    (record) =>
      isFrame(record, 'control_response') &&
      field(field(record.v, 'response'), 'request_id') === 'init_1',
    FRAME_MS,
    'initialize response',
  );
}

function result(session: ScriptSession, timeoutMs = FRAME_MS): Promise<OutRecord> {
  return session.waitType('result', undefined, timeoutMs);
}

function canUseTool(session: ScriptSession): Promise<OutRecord> {
  return session.waitType('control_request', 'can_use_tool', FRAME_MS);
}

/** The `request_id` of a control request record. */
export function requestIdOf(record: OutRecord): string {
  const id = field(record.v, 'request_id');
  if (typeof id !== 'string') throw new Error('control request without request_id');
  return id;
}

/** Ordered fixed uuids of user messages (normalized to `<uuid-N>` anyway). */
function turnUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const STDIO_PROMPT = ['--permission-prompt-tool=stdio'];
const PERMISSION_CMD = 'echo hi && touch marker.txt';
const PERMISSION_MARKER = `[[mock:bash cmd=${b64(PERMISSION_CMD)}]] run it`;

/** A permission suite: one `can_use_tool` answered by `answer`. */
function permissionCase(
  answer: (session: ScriptSession, request: OutRecord) => Promise<void>,
  exit: number,
  shape: readonly string[],
): CaseSpec {
  return {
    name: '',
    launch: () => ({ args: STDIO_PROMPT }),
    async drive(session) {
      await initialize(session);
      session.user(PERMISSION_MARKER);
      const request = await canUseTool(session);
      await answer(session, request);
    },
    exit,
    shape: ['out control_response/success init_1', 'out control_request/can_use_tool', ...shape],
  };
}

/** The tool input of a `can_use_tool` record (`{}` when absent). */
export function inputOf(request: OutRecord): JsonValue {
  return field(field(request.v, 'request'), 'input') ?? {};
}

/** The `setup` case of the resume and fork suites: a new session with a chosen id. */
const SETUP_CASE: CaseSpec = {
  name: 'setup',
  launch: (context) => ({ args: [`--session-id=${sessionId(context, 'U1')}`] }),
  async drive(session) {
    await initialize(session);
    session.user('[[mock:echo]] ALPHA');
    await result(session);
  },
  exit: 0,
  shape: ['out control_response/success init_1', 'out system/init', 'out result/success', 'exit 0'],
};

/** The session id stored under `key`, created on first use. */
export function sessionId(context: SuiteContext, key: string): string {
  let id = context.get(key);
  if (id === undefined) {
    id = randomUUID();
    context.set(key, id);
  }
  return id;
}

/** A resumed or forked main case. */
function resumedCase(args: (context: SuiteContext) => readonly string[]): CaseSpec {
  return {
    name: '',
    launch: (context) => ({ args: args(context) }),
    async drive(session) {
      await initialize(session);
      session.user('[[mock:echo]] BRAVO');
      await result(session);
    },
    exit: 0,
    shape: [
      'out control_response/success init_1',
      'out system/init',
      'out result/success',
      'exit 0',
    ],
  };
}

const TEXT_SHAPE = ['out system/init', 'out assistant', 'out result/success'];

/**
 * Every suite of plan §4.3, in plan order, then the K10 suite and the
 * dropped-message suite of research 10; `delay` paces the scripts (real
 * timers by default).
 */
export function createSuites(delay: Delay = sleep): readonly SuiteSpec[] {
  return [
    {
      name: 'handshake',
      scenario: 'initialize, one text turn, EOF',
      research: '05 §5',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:text]] hello');
            await result(session);
          },
          exit: 0,
          shape: [
            'in control_request/initialize init_1',
            'out control_response/success init_1',
            'in user',
            ...TEXT_SHAPE,
            'cmd',
            'exit 0',
          ],
        },
      ],
    },
    {
      name: 'text-turn',
      scenario: 'initialize, one text turn with a user-message uuid (command_lifecycle), EOF',
      research: '05 §5',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.send(userFrame('[[mock:text]] one turn', turnUuid(1)));
            await result(session);
          },
          exit: 0,
          shape: [
            'out control_response/success init_1',
            'out command_lifecycle',
            ...TEXT_SHAPE,
            'exit 0',
          ],
        },
      ],
    },
    {
      name: 'two-turns',
      scenario: 'initialize, two sequential turns (text, echo), EOF',
      research: '05 §4',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.send(userFrame('[[mock:text]] turn one', turnUuid(1)));
            await result(session);
            session.send(userFrame('[[mock:echo]] turn two', turnUuid(2)));
            await result(session);
          },
          exit: 0,
          shape: [...TEXT_SHAPE, ...TEXT_SHAPE, 'exit 0'],
        },
      ],
    },
    {
      name: 'partial-messages',
      scenario: '--include-partial-messages, a text reply streamed in 5 deltas',
      research: '05 §7',
      cases: [
        {
          name: '',
          launch: () => ({ args: ['--include-partial-messages'] }),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:slow chunks=5 ms=40]] stream');
            await result(session);
          },
          exit: 0,
          shape: [
            'out system/init',
            'out stream_event',
            'out assistant',
            'out result/success',
            'exit 0',
          ],
        },
      ],
    },
    {
      name: 'tool-bash',
      scenario:
        'a read-only Bash tool call (echo hi), auto-allowed in default mode without a prompt tool',
      research: '05 §6, §14',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.user(`[[mock:bash cmd=${b64('echo hi')}]] run it`);
            await result(session);
          },
          exit: 0,
          shape: [
            'out system/init',
            'out assistant',
            'out user',
            'out assistant',
            'out result/success',
            'exit 0',
          ],
        },
      ],
    },
    {
      name: 'permission-allow',
      scenario: 'can_use_tool answered allow with updatedInput; the tool runs',
      research: '05 §6',
      cases: [
        permissionCase(
          async (session, request) => {
            session.respond(requestIdOf(request), {
              behavior: 'allow',
              updatedInput: inputOf(request),
            });
            await result(session);
          },
          0,
          ['in control_response', 'out user', 'out result/success', 'exit 0'],
        ),
      ],
    },
    {
      name: 'permission-deny',
      scenario: 'can_use_tool answered deny with a message; the turn continues',
      research: '05 §6',
      cases: [
        permissionCase(
          async (session, request) => {
            session.respond(requestIdOf(request), { behavior: 'deny', message: 'host says no' });
            await result(session);
          },
          0,
          ['in control_response', 'out user', 'out result/success', 'exit 0'],
        ),
      ],
    },
    {
      name: 'permission-deny-interrupt',
      scenario: 'can_use_tool answered deny with interrupt:true; the turn aborts',
      research: '05 §6',
      cases: [
        permissionCase(
          async (session, request) => {
            session.respond(requestIdOf(request), {
              behavior: 'deny',
              message: 'host says no',
              interrupt: true,
            });
            await result(session);
          },
          1,
          ['in control_response', 'out user', 'out result/error_during_execution', 'exit 1'],
        ),
      ],
    },
    {
      name: 'permission-error-response',
      scenario: 'can_use_tool answered with a control_response of subtype error',
      research: '05 §6',
      cases: [
        permissionCase(
          async (session, request) => {
            session.send({
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: requestIdOf(request),
                error: 'host failed',
              },
            });
            await result(session);
          },
          0,
          ['in control_response', 'out user', 'out result/success', 'exit 0'],
        ),
      ],
    },
    {
      name: 'permission-never-answered-interrupt',
      scenario:
        'can_use_tool left unanswered for 3 s, then interrupt: the CLI withdraws its request',
      research: '05 §6',
      cases: [
        permissionCase(
          async (session) => {
            await delay(3000);
            session.control('int_1', 'interrupt');
            await session.waitType('control_cancel_request', undefined, FRAME_MS);
            await result(session);
          },
          1,
          [
            'in control_request/interrupt int_1',
            'out control_cancel_request',
            'out result/error_during_execution',
            'exit 1',
          ],
        ),
      ],
    },
    {
      name: 'permission-eof',
      scenario:
        'can_use_tool left unanswered, then stdin EOF: the request fails and the turn completes',
      research: '05 §6',
      cases: [
        permissionCase(
          async (session) => {
            session.closeStdin();
            await result(session);
          },
          0,
          ['cmd', 'out user', 'out result/success', 'exit 0'],
        ),
      ],
    },
    {
      name: 'interrupt-midstream',
      scenario:
        'interrupt after the first streamed delta of a 20-delta reply (--include-partial-messages)',
      research: '05 §7',
      cases: [
        {
          name: '',
          launch: () => ({ args: ['--include-partial-messages'] }),
          async drive(session) {
            await initialize(session);
            session.send(userFrame('[[mock:slow chunks=20 ms=100]] stream', turnUuid(1)));
            await session.waitFor(
              (record) =>
                isFrame(record, 'stream_event') &&
                field(field(record.v, 'event'), 'type') === 'content_block_delta',
              FRAME_MS,
              'first content_block_delta',
            );
            session.control('int_1', 'interrupt');
            await result(session);
          },
          exit: 1,
          shape: [
            'out stream_event',
            'in control_request/interrupt int_1',
            'out control_response/success int_1',
            'out assistant',
            'out user',
            'out result/error_during_execution',
            'exit 1',
          ],
        },
      ],
    },
    {
      name: 'interrupt-queued',
      scenario:
        'interrupt while a second user message is queued: still_queued, the queued turn runs next',
      research: '05 §7',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.send(userFrame('[[mock:slow chunks=10 ms=150]] first', turnUuid(1)));
            await session.waitType('system', 'init', FRAME_MS);
            await delay(200);
            session.send(userFrame('[[mock:text]] queued', turnUuid(2)));
            await delay(200);
            session.control('int_1', 'interrupt');
            await result(session);
            await result(session);
          },
          exit: 0,
          shape: [
            'in control_request/interrupt int_1',
            'out control_response/success int_1',
            'out result/error_during_execution',
            'out system/init',
            'out result/success',
            'exit 0',
          ],
        },
      ],
    },
    {
      name: 'interrupt-cancel-queued',
      scenario: 'interrupt with cancel_queued:true while a second message is queued: it is dropped',
      research: '05 §7',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.send(userFrame('[[mock:slow chunks=10 ms=150]] first', turnUuid(1)));
            await session.waitType('system', 'init', FRAME_MS);
            await delay(200);
            session.send(userFrame('[[mock:text]] queued', turnUuid(2)));
            await delay(200);
            session.send(controlFrame('int_1', { subtype: 'interrupt', cancel_queued: true }));
            await result(session);
            await delay(1500);
          },
          exit: 1,
          shape: [
            'in control_request/interrupt int_1',
            'out control_response/success int_1',
            'out result/error_during_execution',
            'cmd',
            'exit 1',
          ],
        },
      ],
    },
    {
      name: 'interrupt-same-write',
      scenario:
        'GH#98713: after a completed turn, the turn-2 user message and an interrupt in one stdin write; the interrupt is ignored',
      research: '05 §7',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.send(userFrame('[[mock:text]] turn one', turnUuid(1)));
            await result(session);
            // One write, two lines (split into two `in` records with the same `t` by the recorder).
            session.sendRaw(
              `${JSON.stringify(userFrame('[[mock:slow chunks=8 ms=250]] turn two', turnUuid(2)))}\n${JSON.stringify(controlFrame('int_2', { subtype: 'interrupt' }))}`,
            );
            await result(session);
          },
          exit: 0,
          shape: [
            'out result/success',
            'in user',
            'in control_request/interrupt int_2',
            'out control_response/success int_2',
            'out system/init',
            'out result/success',
            'exit 0',
          ],
        },
      ],
    },
    {
      name: 'eof-idle',
      scenario: 'initialize, then stdin EOF with no turn',
      research: '05 §8',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
          },
          exit: 0,
          shape: ['out control_response/success init_1', 'cmd', 'exit 0'],
        },
      ],
    },
    {
      name: 'eof-midstream',
      scenario: 'stdin EOF while a 2 s reply is streaming: the turn finishes, then exit',
      research: '05 §8',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:slow chunks=8 ms=250]] stream');
            await session.waitType('system', 'init', FRAME_MS);
            await delay(300);
            session.closeStdin();
          },
          exit: 0,
          shape: ['out system/init', 'cmd', 'out assistant', 'out result/success', 'exit 0'],
        },
      ],
    },
    {
      name: 'eof-midtool',
      scenario:
        'stdin EOF while a Bash tool (sleep 3) runs: the tool completes, the model is called again',
      research: '05 §8',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.user(`[[mock:bash cmd=${b64('sleep 3 && echo done')}]] run it`);
            await session.waitFor(
              (record) =>
                isFrame(record, 'system', 'task_started') ||
                (isFrame(record, 'assistant') && JSON.stringify(record.v).includes('"tool_use"')),
              FRAME_MS,
              'tool start',
            );
            await delay(500);
            session.closeStdin();
          },
          exit: 0,
          shape: [
            'out system/init',
            'cmd',
            'out user',
            'out assistant',
            'out result/success',
            'exit 0',
          ],
        },
      ],
    },
    {
      name: 'resume',
      scenario:
        'setup: --session-id=U1 one turn; main: --resume=U1 one turn (same id in system/init)',
      research: '07 §1 a1, a2',
      cases: [SETUP_CASE, resumedCase((context) => [`--resume=${sessionId(context, 'U1')}`])],
    },
    {
      name: 'resume-not-found',
      scenario: '--resume=<unknown uuid>: an error result before any control_response, exit 1',
      research: '07 §1 a11',
      cases: [
        {
          name: '',
          launch: (context) => ({ args: [`--resume=${sessionId(context, 'U9')}`] }),
          async drive(session) {
            session.control('init_1', 'initialize');
            await result(session);
          },
          exit: 1,
          shape: ['out result/error_during_execution', 'exit 1'],
        },
      ],
    },
    {
      name: 'fork',
      scenario: 'setup: --session-id=U1; main: --resume=U1 --fork-session (a new session id)',
      research: '07 §1 a4',
      cases: [
        SETUP_CASE,
        resumedCase((context) => [`--resume=${sessionId(context, 'U1')}`, '--fork-session']),
      ],
    },
    {
      name: 'fork-session-id',
      scenario: 'setup: --session-id=U1; main: --resume=U1 --fork-session --session-id=U2 (id U2)',
      research: '07 §1 a5',
      cases: [
        SETUP_CASE,
        resumedCase((context) => [
          `--resume=${sessionId(context, 'U1')}`,
          '--fork-session',
          `--session-id=${sessionId(context, 'U2')}`,
        ]),
      ],
    },
    {
      name: 'auth-401-no-retry',
      scenario:
        'HTTP 401 with CLAUDE_CODE_MAX_RETRIES=0: synthetic authentication_failed assistant, error result',
      research: '05 §9',
      cases: [
        {
          name: '',
          launch: () => ({ env: { CLAUDE_CODE_MAX_RETRIES: '0' } }),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:err status=401]] hello');
            await result(session);
          },
          exit: 1,
          shape: ['out system/init', 'out assistant', 'out result/success', 'exit 1'],
        },
      ],
    },
    {
      name: 'auth-401-retries',
      scenario:
        'HTTP 401 with CLAUDE_CODE_MAX_RETRIES=2 (shortened from the default 10): system/api_retry x2, then the error result',
      research: '05 §9',
      cases: [
        {
          name: '',
          launch: () => ({ env: { CLAUDE_CODE_MAX_RETRIES: '2' } }),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:err status=401]] hello');
            await result(session, 120_000);
          },
          exit: 1,
          shape: [
            'out system/init',
            'out system/api_retry',
            'out system/api_retry',
            'out assistant',
            'out result/success',
            'exit 1',
          ],
        },
      ],
    },
    {
      name: 'overloaded-529',
      scenario:
        'HTTP 529 on every request: system/api_retry x2 (the 529 cap of 3 attempts), then the error result',
      research: '05 §9',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:err status=529]] hello');
            await result(session, 120_000);
          },
          exit: 1,
          shape: [
            'out system/init',
            'out system/api_retry',
            'out system/api_retry',
            'out assistant',
            'out result/success',
            'exit 1',
          ],
        },
      ],
    },
    {
      name: 'max-turns',
      scenario: '--max-turns=1 with a model that calls a tool at every step: error_max_turns',
      research: '05 §9',
      cases: [
        {
          name: '',
          launch: () => ({ args: ['--max-turns=1'] }),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:loop]] go');
            await result(session);
          },
          exit: 1,
          shape: [
            'out system/init',
            'out assistant',
            'out user',
            'out result/error_max_turns',
            'exit 1',
          ],
        },
      ],
    },
    {
      name: 'bg-shell-turn-after-eof',
      scenario:
        'a background Bash shell (sleep 3) outlives its turn; after EOF the CLI waits, then runs a new turn on its completion',
      research: '07 §7',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            const input = { command: 'sleep 3', run_in_background: true, description: 'bg sleep' };
            session.user(`[[mock:tool name=Bash in=${b64(JSON.stringify(input))}]] start it`);
            await result(session);
            session.closeStdin();
          },
          exit: 0,
          exitMs: 60_000,
          shape: [
            'out result/success',
            'cmd',
            'out system/task_notification',
            'out system/init',
            'out result/success',
            'exit 0',
          ],
        },
      ],
    },
    {
      name: 'session-state-events',
      scenario:
        'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1: session_state_changed running/idle around a text turn',
      research: '05 §12',
      cases: [
        {
          name: '',
          launch: () => ({ env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } }),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:text]] hello');
            await result(session);
            await session.waitType('system', 'session_state_changed', FRAME_MS);
            await session.waitType('system', 'session_state_changed', FRAME_MS);
          },
          exit: 0,
          shape: [
            'out system/session_state_changed',
            'out system/init',
            'out result/success',
            'out system/session_state_changed',
            'exit 0',
          ],
        },
      ],
    },
    {
      name: 'big-frame-5mb',
      scenario: 'a 5 MB model text: assistant and result frames of about 5 MB each, unsplit',
      research: '05 §11',
      compress: true,
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:big bytes=5000000]] big');
            await result(session);
          },
          exit: 0,
          shape: ['out system/init', 'out assistant', 'out result/success', 'exit 0'],
        },
      ],
    },
    {
      name: 'utf8-arabic',
      scenario:
        'Arabic user text echoed back, then a mock reply with Arabic, emoji and an accented letter',
      research: '05 §11',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:echo]] مرحبا');
            await result(session);
            session.user(`[[mock:text t=${b64('رد: مرحبا 👋 é')}]] reply`);
            await result(session);
          },
          exit: 0,
          shape: [...TEXT_SHAPE, ...TEXT_SHAPE, 'exit 0'],
        },
      ],
    },
    {
      name: 'crlf-bom',
      scenario:
        'a UTF-8 BOM before the first line, CRLF line ends and a whitespace-only line on stdin',
      research: '05 §11',
      cases: [
        {
          name: '',
          launch: () => ({}),
          async drive(session) {
            session.sendRaw(
              `\uFEFF${JSON.stringify(controlFrame('init_1', { subtype: 'initialize' }))}\r`,
            );
            await session.waitType('control_response', undefined, FRAME_MS);
            session.sendRaw('   \r');
            session.sendRaw(`${JSON.stringify(userFrame('[[mock:text]] crlf'))}\r`);
            await result(session);
          },
          exit: 0,
          shape: ['out control_response/success init_1', ...TEXT_SHAPE, 'exit 0'],
        },
      ],
    },
    {
      name: 'auth-token-source',
      scenario:
        'K10: a fake ANTHROPIC_AUTH_TOKEN instead of an API key; the apiKeySource the CLI reports, then HTTP 401 with CLAUDE_CODE_MAX_RETRIES=0',
      research: '05 §9, plan §4.3 (K10)',
      credential: 'fake-auth-token',
      cases: [
        {
          name: '',
          launch: () => ({ env: { CLAUDE_CODE_MAX_RETRIES: '0' } }),
          async drive(session) {
            await initialize(session);
            session.user('[[mock:err status=401]] hello');
            await result(session);
          },
          exit: 1,
          shape: [
            'out control_response/success init_1',
            'out system/init',
            'out assistant',
            'out result/success',
            'exit 1',
          ],
        },
      ],
    },
    {
      name: 'resume-duplicate-uuid',
      scenario:
        'setup: --session-id=U1, one turn with user-message uuid N1; main: --resume=U1 and a user message with uuid N1 again: command_lifecycle completed only, no turn',
      research: '10 §3',
      cases: [
        {
          name: 'setup',
          launch: (context) => ({ args: [`--session-id=${sessionId(context, 'U1')}`] }),
          async drive(session) {
            await initialize(session);
            session.send(userFrame('[[mock:echo]] ALPHA', turnUuid(1)));
            await result(session);
          },
          exit: 0,
          shape: [
            'out control_response/success init_1',
            'out command_lifecycle',
            'out system/init',
            'out result/success',
            'exit 0',
          ],
        },
        {
          name: '',
          launch: (context) => ({ args: [`--resume=${sessionId(context, 'U1')}`] }),
          async drive(session) {
            await initialize(session);
            session.send(userFrame('[[mock:echo]] BRAVO', turnUuid(1)));
            await session.waitFor(
              (record) =>
                isFrame(record, 'command_lifecycle') && field(record.v, 'state') === 'completed',
              FRAME_MS,
              'command_lifecycle completed',
            );
          },
          exit: 0,
          shape: ['out control_response/success init_1', 'out command_lifecycle', 'cmd', 'exit 0'],
        },
      ],
    },
  ];
}

/** {@link createSuites} with real timers. */
export const SUITES: readonly SuiteSpec[] = createSuites();
