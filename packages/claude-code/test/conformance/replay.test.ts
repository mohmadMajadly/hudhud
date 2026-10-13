// The replay's translation rules on synthetic variants: the paths the
// recorded suites do not take (timers that fire, a recorded timer, the
// frame cap, host writes hudhud cannot make, a session that never ends)
// and the hook the loopback replay (W4-Z) uses.

import { describe, expect, it } from 'vitest';

import type { JsonObject, JsonValue, MachineInput } from '@hudhud/core/protocol';

import type { KitMachine } from '../../../../tooling/test-support/src/machine-kit.js';
import {
  claudeSessionMachine,
  type ClaudeSessionConfig,
  type ClaudeSessionState,
} from '../../src/protocol/machine/index.js';
import type { ConformanceVariant, RecordDir, RecordLine } from './loader.js';
import {
  DEFAULT_SESSION_ID,
  REPLAY_START_MS,
  SPAWNED_PID,
  denormalize,
  pairWrites,
  placeholderUuid,
  replayVariant,
  sendUuid,
  sessionConfigOf,
  writeLabel,
} from './replay.js';
import { summarize } from './summary.js';

function rec(t: number, dir: RecordDir, v: JsonValue): RecordLine {
  return { t, dir, v };
}

/** A variant from records after its config line. */
function variant(
  body: readonly RecordLine[],
  options: { argv?: string[]; platform?: 'linux' | 'win32' } = {},
): ConformanceVariant {
  const platform = options.platform ?? 'linux';
  const launch = { suite: 'demo', case: 'main', platform, argv: options.argv ?? [], env: {} };
  return {
    id: `demo/${platform}`,
    suite: 'demo',
    case: 'main',
    platform,
    entry: {} as ConformanceVariant['entry'],
    launch,
    records: [rec(0, 'config', launch), ...body],
    expect: undefined,
    expectFile: '',
  };
}

const INIT_IN = rec(1, 'in', {
  type: 'control_request',
  request_id: 'init_1',
  request: { subtype: 'initialize' },
});

function initOut(t: number): RecordLine {
  return rec(t, 'out', {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'init_1',
      response: { pid: SPAWNED_PID, account: { apiKeySource: 'ANTHROPIC_API_KEY' } },
    },
  });
}

function systemInit(t: number, sessionId = '<uuid-9>'): RecordLine {
  return rec(t, 'out', {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    capabilities: [],
  });
}

function user(t: number, text: string, uuid?: string): RecordLine {
  return rec(t, 'in', {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...(uuid === undefined ? {} : { uuid }),
  });
}

function resultOut(t: number): RecordLine {
  return rec(t, 'out', {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: '<uuid-9>',
  });
}

const EXIT = (t: number): RecordLine => rec(t, 'exit', { code: 0, signal: null });

function inputs(result: ReturnType<typeof replayVariant>): MachineInput[] {
  return result.steps.map((step) => step.input);
}

describe('placeholders', () => {
  it('maps <uuid-N> in strings and keys to UUIDs, and numbers sends without one', () => {
    expect(placeholderUuid(3)).toBe('00000000-0000-4000-8000-000000000003');
    expect(sendUuid(2)).toBe('00000000-0000-4000-9000-000000000002');
    expect(denormalize({ '<uuid-1>': ['a <uuid-12> b', 3, null, true] })).toEqual({
      '00000000-0000-4000-8000-000000000001': [
        'a 00000000-0000-4000-8000-000000000012 b',
        3,
        null,
        true,
      ],
    });
  });
});

describe('sessionConfigOf', () => {
  it('derives mode and ids from the argv, else the first system/init, else a default', () => {
    expect(sessionConfigOf(variant([]))).toMatchObject({
      mode: 'create',
      sessionId: DEFAULT_SESSION_ID,
      platform: 'posix',
      permissionHandler: true,
    });
    expect(sessionConfigOf(variant([systemInit(5)]))).toMatchObject({
      sessionId: placeholderUuid(9),
    });
    expect(
      sessionConfigOf(variant([systemInit(5)], { argv: ['--session-id=<uuid-2>'] })),
    ).toMatchObject({ mode: 'create', sessionId: placeholderUuid(2) });
    expect(
      sessionConfigOf(variant([], { argv: ['--resume=<uuid-1>'], platform: 'win32' })),
    ).toEqual(
      expect.objectContaining({ mode: 'resume', sessionId: placeholderUuid(1), platform: 'win32' }),
    );
    const fork = sessionConfigOf(
      variant([systemInit(5)], { argv: ['--resume=<uuid-1>', '--fork-session'] }),
    );
    expect(fork).toMatchObject({
      mode: 'fork',
      sessionId: placeholderUuid(9),
      forkedFrom: placeholderUuid(1),
    });
    expect(
      sessionConfigOf(
        variant([], { argv: ['--resume=<uuid-1>', '--fork-session', '--session-id=<uuid-4>'] }),
      ),
    ).toMatchObject({
      mode: 'fork',
      sessionId: placeholderUuid(4),
      forkedFrom: placeholderUuid(1),
    });
    expect(sessionConfigOf(variant([]))).not.toHaveProperty('forkedFrom');
  });
});

describe('replayVariant', () => {
  it('fires an armed timer at its deadline before a later record (the first-frame watchdog)', () => {
    const result = replayVariant(variant([INIT_IN, EXIT(70_001)]));
    expect(result.violations).toEqual([]);
    expect(result.problems).toEqual([]);
    const fired = result.steps.find((step) => step.input.type === 'timer');
    expect(fired).toMatchObject({
      record: 2,
      input: { name: 'first-frame', atMs: REPLAY_START_MS + 60_001 },
    });
    expect(summarize(result.effects.flat())).toMatchObject({
      handshake: 'HANDSHAKE_TIMEOUT',
      ladder: ['watchdog'],
      session: 'failed HANDSHAKE_TIMEOUT',
    });
    // The exit line: stdout.end, the exit, then ladder.done because a ladder started.
    expect(
      inputs(result)
        .slice(-3)
        .map((input) => input.type),
    ).toEqual(['stdout.end', 'process.exit', 'ladder.done']);
  });

  it('fires a recorded timer, and reports one that is not armed', () => {
    const fired = replayVariant(
      variant([INIT_IN, rec(2, 'timer', { name: 'first-frame' }), EXIT(3)]),
    );
    expect(fired.problems).toEqual([]);
    expect(fired.steps.find((step) => step.input.type === 'timer')?.input).toMatchObject({
      name: 'first-frame',
      atMs: REPLAY_START_MS + 60_001,
    });
    const unarmed = replayVariant(variant([INIT_IN, rec(2, 'timer', { name: 'idle' }), EXIT(3)]));
    expect(unarmed.problems).toEqual(['demo/linux:3: timer idle is not armed']);
  });

  it('feeds a line above the frame cap as line.oversized', () => {
    const result = replayVariant(variant([INIT_IN, initOut(2), EXIT(3)]), { maxFrameBytes: 10 });
    expect(result.steps[1]?.input).toMatchObject({ type: 'line.oversized' });
    expect(summarize(result.effects.flat()).handshake).toBe('OVERSIZED_FRAME');
  });

  it('feeds every stderr line', () => {
    const result = replayVariant(variant([INIT_IN, rec(2, 'err', 'one\ntwo\n'), EXIT(3)]));
    expect(inputs(result).filter((input) => input.type === 'stderr.line')).toEqual([
      expect.objectContaining({ text: 'one' }),
      expect.objectContaining({ text: 'two' }),
    ]);
  });

  it('reports host writes no hudhud command makes, and tolerates BOM, CR and blank lines', () => {
    const result = replayVariant(
      variant([
        rec(1, 'in', `${String.fromCharCode(0xfeff)}${JSON.stringify(INIT_IN.v)}\r`),
        initOut(2),
        rec(3, 'in', '   \r'),
        rec(3, 'in', 'not json'),
        rec(3, 'in', '[1]'),
        rec(3, 'in', { type: 'keep_alive' }),
        rec(3, 'in', {
          type: 'control_request',
          request_id: 'm',
          request: { subtype: 'set_model' },
        }),
        rec(3, 'in', { type: 'user', message: {} }),
        rec(3, 'in', {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'never-asked',
            response: { behavior: 'allow' },
          },
        }),
        EXIT(4),
      ]),
    );
    expect(result.problems).toEqual([
      'demo/linux:5: a host write that is not a JSON object',
      'demo/linux:6: a host write that is not a JSON object',
      'demo/linux:7: no hudhud command writes frame keep_alive',
      'demo/linux:8: no hudhud command writes set_model',
      'demo/linux:9: a user frame without message.content',
      'demo/linux:10: the machine did not ask permission request never-asked',
    ]);
    // The BOM/CR initialize paired with the machine's; the blank line and the
    // answer to a request never asked did not (writes without a command are
    // problems above, not write differences).
    expect(result.unpairedRecorded).toEqual(['blank line', 'allow']);
    expect(result.unpairedMachine).toEqual([]);
  });

  it('interrupts session-wide when no application turn is live', () => {
    const result = replayVariant(
      variant([
        INIT_IN,
        initOut(2),
        rec(3, 'in', {
          type: 'control_request',
          request_id: 'int_1',
          request: { subtype: 'interrupt' },
        }),
        EXIT(4),
      ]),
    );
    const interrupt = inputs(result).find((input) => input.type === 'cmd.interrupt');
    expect(interrupt).toEqual(
      expect.not.objectContaining({ turnId: expect.anything() as unknown }),
    );
    expect(interrupt).toMatchObject({ correlation: 'int_1', cancelQueued: false });
  });

  it('answers with cmd.permission-abort for a recorded error answer, and maps request ids', () => {
    const ask = rec(6, 'out', {
      type: 'control_request',
      request_id: 'perm-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'ls' },
        tool_use_id: 'toolu_1',
      },
    });
    const result = replayVariant(
      variant([
        INIT_IN,
        initOut(2),
        user(3, 'hi'),
        systemInit(4),
        ask,
        rec(7, 'in', {
          type: 'control_response',
          response: { subtype: 'error', request_id: 'perm-1', error: 'host failed' },
        }),
        resultOut(8),
        EXIT(9),
      ]),
    );
    expect(result.violations).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(inputs(result).find((input) => input.type === 'cmd.permission-abort')).toMatchObject({
      requestId: 'perm-1',
    });
    // The recorded init_1 answer reached the machine as its own request id.
    expect(result.frames[2]).toMatchObject({ response: { request_id: 'hudhud_1' } });
    expect(summarize(result.effects.flat())).toMatchObject({
      handshake: 'ok',
      turns: ['send-1 completed'],
      permissions: ['cancelled by application'],
    });
  });

  it('leaves a control response for a request the machine never wrote as recorded', () => {
    const result = replayVariant(
      variant([
        INIT_IN,
        rec(2, 'out', {
          type: 'control_response',
          response: { subtype: 'success', request_id: 'other' },
        }),
        EXIT(3),
      ]),
    );
    expect(result.frames[2]).toMatchObject({ response: { request_id: 'other' } });
  });

  it('reports a session that does not end', () => {
    const result = replayVariant(variant([INIT_IN, initOut(2)]));
    expect(result.ended).toBe(false);
    expect(result.problems).toEqual(['demo/linux:3: the session did not end at the recorded exit']);
  });

  it('drives any machine with the same contract: a JSON boundary gives the same replay', () => {
    // The shape of the loopback replay (W4-Z): state, input and output cross JSON.
    const boundary: KitMachine<ClaudeSessionState, ClaudeSessionConfig> = {
      initialState: (config) =>
        JSON.parse(JSON.stringify(claudeSessionMachine.initialState(config))) as ClaudeSessionState,
      step: (state, input) =>
        JSON.parse(
          JSON.stringify(
            claudeSessionMachine.step(
              JSON.parse(JSON.stringify(state)) as ClaudeSessionState,
              JSON.parse(JSON.stringify(input)) as MachineInput,
            ),
          ),
        ) as ReturnType<typeof claudeSessionMachine.step>,
    };
    const body = [
      INIT_IN,
      initOut(2),
      user(3, 'hi', '<uuid-1>'),
      systemInit(4),
      resultOut(5),
      EXIT(6),
    ];
    const direct = replayVariant(variant(body));
    const crossed = replayVariant(variant(body), { machine: boundary });
    expect(crossed.effects).toEqual(direct.effects);
    expect(crossed.violations).toEqual([]);
    expect(summarize(direct.effects.flat()).turns).toEqual(['<uuid-1> completed']);
  });
});

describe('writes', () => {
  it('labels every write kind', () => {
    const frame = (value: JsonObject): JsonObject => value;
    expect(writeLabel(undefined)).toBe('stdin.end');
    expect(writeLabel(frame({ type: 'user' }))).toBe('user');
    expect(
      writeLabel(
        frame({ type: 'control_request', request: { subtype: 'interrupt', cancel_queued: true } }),
      ),
    ).toBe('interrupt {"cancel_queued":true}');
    expect(writeLabel(frame({ type: 'control_request', request: { subtype: 'initialize' } }))).toBe(
      'initialize',
    );
    expect(writeLabel(frame({ type: 'control_request' }))).toBe('undefined');
    expect(
      writeLabel(
        frame({
          type: 'control_response',
          response: { subtype: 'error', request_id: 'r', error: 'no' },
        }),
      ),
    ).toBe('error {"error":"no"}');
    expect(
      writeLabel(
        frame({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'r',
            response: { behavior: 'deny', message: 'm' },
          },
        }),
      ),
    ).toBe('deny {"message":"m"}');
    expect(writeLabel(frame({ type: 'keep_alive' }))).toBe('frame keep_alive');
  });

  it('pairs by key and counts a pair only when the writes are equal', () => {
    const write = (key: string, label: string, frame?: JsonObject) => ({
      record: 0,
      key,
      label,
      frame,
      paired: false,
    });
    const userFrame = (text: string, uuid?: string): JsonObject => ({
      type: 'user',
      message: { content: text },
      ...(uuid === undefined ? {} : { uuid }),
    });
    expect(
      pairWrites(
        [
          write('turn:a', 'user', userFrame('one')),
          write('eof', 'stdin.end'),
          write('turn:b', 'user', userFrame('two')),
        ],
        [
          write('turn:a', 'user', userFrame('one', 'a')),
          write('turn:b', 'user', userFrame('changed', 'b')),
          write('request:interrupt', 'interrupt'),
        ],
      ),
    ).toEqual({ recorded: ['stdin.end', 'user'], machine: ['user', 'interrupt'] });
  });
});
