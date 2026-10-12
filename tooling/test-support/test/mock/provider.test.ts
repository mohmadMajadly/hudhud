import { describe, expect, it } from 'vitest';

import {
  errorTypeFor,
  QUOTED_RESULT_LIMIT,
  scenarioProvider,
  SCENARIO_LIMITS,
  textBlock,
  textReply,
  toolUseBlock,
  type MessagesRequest,
  type MockReply,
  type ReplyContext,
} from '../../src/mock/provider.js';
import { b64 } from './client.js';

function context(): ReplyContext {
  let next = 0;
  return {
    seq: 1,
    toolUseId: () => {
      next += 1;
      return `toolu_test_${String(next)}`;
    },
  };
}

function ask(messages: unknown[], provider = scenarioProvider()): MockReply {
  const request: MessagesRequest = { model: undefined, stream: false, messages, body: {} };
  const reply = provider.respond(request, context());
  if (reply instanceof Promise) throw new Error('scenario provider must answer synchronously');
  return reply;
}

const marked = (marker: string): unknown[] => [{ role: 'user', content: marker }];

function text(reply: MockReply): string {
  if (reply.kind !== 'message') throw new Error(`expected a message, got ${reply.kind}`);
  return reply.content
    .map((block) => (block.type === 'text' ? block.text : `<${block.name}>`))
    .join('|');
}

function badRequest(reply: MockReply): string {
  if (reply.kind !== 'error') throw new Error(`expected an error, got ${reply.kind}`);
  expect(reply.status).toBe(400);
  return reply.message ?? '';
}

const toolRoundTrip = (marker: string, result: unknown, isError = false): unknown[] => [
  { role: 'user', content: marker },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_test_1', name: 'X', input: {} }] },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_test_1', content: result, is_error: isError },
    ],
  },
  { role: 'system', content: '<total_tokens>9 tokens left</total_tokens>' },
];

describe('block builders', () => {
  it('build SDK-shaped blocks', () => {
    expect(textBlock('a')).toEqual({ type: 'text', text: 'a', citations: null });
    expect(toolUseBlock('id', 'Bash', { command: 'x' })).toEqual({
      type: 'tool_use',
      id: 'id',
      name: 'Bash',
      input: { command: 'x' },
    });
    expect(textReply('a')).toEqual({
      kind: 'message',
      content: [textBlock('a')],
      stopReason: 'end_turn',
    });
  });

  it('maps statuses to API error types', () => {
    expect(
      [400, 401, 402, 403, 404, 413, 429, 500, 503, 504, 529].map((status) => errorTypeFor(status)),
    ).toEqual([
      'invalid_request_error',
      'authentication_error',
      'billing_error',
      'permission_error',
      'not_found_error',
      'invalid_request_error',
      'rate_limit_error',
      'api_error',
      'api_error',
      'timeout_error',
      'overloaded_error',
    ]);
  });
});

describe('scenarioProvider', () => {
  it('answers ok to untagged side requests', () => {
    expect(text(ask([{ role: 'user', content: 'Generate a title' }]))).toBe('ok');
  });

  it('text', () => {
    expect(text(ask(marked('[[mock:text]]')))).toBe('Hello from mock.');
    expect(text(ask(marked(`[[mock:text t=${b64('مرحبا ✓')}]]`)))).toBe('مرحبا ✓');
    expect(badRequest(ask(marked('[[mock:text t=@@]]')))).toBe(
      'mock: text: invalid scenario: t must be base64',
    );
  });

  it('echo', () => {
    expect(text(ask(marked('say [[mock:echo]] this')))).toBe('ECHO:say  this');
  });

  it('tool: tool use at step 0, then text quoting the results', () => {
    const marker = `[[mock:tool name=Read in=${b64('{"file_path":"a.txt"}')} after=${b64('Done.')}]]`;
    const first = ask(marked(marker));
    expect(first).toEqual({
      kind: 'message',
      stopReason: 'tool_use',
      content: [
        textBlock('Calling Read.'),
        toolUseBlock('toolu_test_1', 'Read', { file_path: 'a.txt' }),
      ],
    });
    expect(text(ask(toolRoundTrip(marker, 'contents')))).toBe('Done. RESULT<<contents>>');
    const plain = `[[mock:tool name=Read in=${b64('{}')}]]`;
    expect(text(ask(toolRoundTrip(plain, 'boom', true)))).toBe(
      'Tool finished. RESULT<<[is_error] boom>>',
    );
  });

  it('tool: quotes at most QUOTED_RESULT_LIMIT characters', () => {
    const marker = `[[mock:tool name=Read in=${b64('{}')}]]`;
    const reply = text(ask(toolRoundTrip(marker, 'y'.repeat(QUOTED_RESULT_LIMIT + 10))));
    expect(reply).toBe(`Tool finished. RESULT<<${'y'.repeat(QUOTED_RESULT_LIMIT)}>>`);
  });

  it('tool: malformed arguments answer 400', () => {
    expect(badRequest(ask(marked(`[[mock:tool in=${b64('{}')}]]`)))).toMatch(
      /name must be a tool name/,
    );
    expect(badRequest(ask(marked(`[[mock:tool name=a/b in=${b64('{}')}]]`)))).toMatch(/name must/);
    expect(badRequest(ask(marked('[[mock:tool name=Read]]')))).toMatch(/in is required/);
    expect(badRequest(ask(marked(`[[mock:tool name=Read in=${b64('{nope')}]]`)))).toMatch(
      /in must be base64 JSON/,
    );
  });

  it('bash and ps', () => {
    const bash = ask(marked(`[[mock:bash cmd=${b64('echo hi')}]]`));
    expect(bash.kind === 'message' && bash.content[1]).toEqual(
      toolUseBlock('toolu_test_1', 'Bash', { command: 'echo hi', description: 'mock command' }),
    );
    const ps = ask(marked(`[[mock:ps cmd=${b64('Get-Date')}]]`));
    expect(ps.kind === 'message' && ps.content[1]).toEqual(
      toolUseBlock('toolu_test_1', 'PowerShell', {
        command: 'Get-Date',
        description: 'mock command',
      }),
    );
    expect(text(ask(toolRoundTrip(`[[mock:ps cmd=${b64('x')}]]`, 'out')))).toBe(
      'Tool finished. RESULT<<out>>',
    );
    expect(badRequest(ask(marked('[[mock:bash]]')))).toMatch(/cmd is required/);
    expect(badRequest(ask(marked('[[mock:ps]]')))).toMatch(/cmd is required/);
  });

  it('loop: a Bash tool use at every step', () => {
    const reply = ask(toolRoundTrip('[[mock:loop]]', 'x'));
    expect(reply).toEqual({
      kind: 'message',
      stopReason: 'tool_use',
      content: [
        toolUseBlock('toolu_test_1', 'Bash', { command: 'echo loop1', description: 'loop' }),
      ],
    });
  });

  it('slow: chunked text with a delay', () => {
    expect(ask(marked('[[mock:slow]]'))).toMatchObject({ chunks: 10, chunkDelayMs: 500 });
    const reply = ask(marked('[[mock:slow chunks=3 ms=0]]'));
    expect(reply).toMatchObject({ chunks: 3, chunkDelayMs: 0 });
    expect(text(reply)).toBe('chunk0 chunk1 chunk2 ');
    expect(ask(marked('[[mock:slow chunks=0 ms=1]]'))).toMatchObject({ chunks: 1 });
    expect(
      badRequest(ask(marked(`[[mock:slow chunks=${String(SCENARIO_LIMITS.chunks + 1)}]]`))),
    ).toMatch(/chunks must be an integer from 0 to 10000/);
    expect(badRequest(ask(marked('[[mock:slow ms=-1]]')))).toMatch(/ms must be an integer/);
  });

  it('big: one block of the requested size, bounded', () => {
    const reply = text(ask(marked('[[mock:big bytes=20]]')));
    expect(reply).toBe(`BIG:${'x'.repeat(12)}:END`);
    expect(reply).toHaveLength(20);
    expect(text(ask(marked('[[mock:big bytes=3]]')))).toBe('BIG::END');
    expect(text(ask(marked('[[mock:big]]')))).toHaveLength(1_000_000);
    expect(
      badRequest(ask(marked(`[[mock:big bytes=${String(SCENARIO_LIMITS.bigBytes + 1)}]]`))),
    ).toMatch(/bytes must be an integer/);
    expect(badRequest(ask(marked('[[mock:big bytes=1e3]]')))).toMatch(/bytes must be an integer/);
  });

  it('err: always the status', () => {
    expect(ask(marked('[[mock:err]]'))).toEqual({ kind: 'error', status: 500 });
    expect(ask(marked('[[mock:err status=401]]'))).toEqual({ kind: 'error', status: 401 });
    expect(badRequest(ask(marked('[[mock:err status=200]]')))).toMatch(
      /status must be from 400 to 599/,
    );
    expect(badRequest(ask(marked('[[mock:err status=600]]')))).toMatch(/status must be an integer/);
  });

  it('errn: fails n times per key, then recovers; reset forgets the counts', () => {
    const provider = scenarioProvider();
    const marker = marked('[[mock:errn status=529 n=2 key=k]]');
    expect(ask(marker, provider)).toEqual({ kind: 'error', status: 529 });
    expect(ask(marked('[[mock:errn status=529 n=2 key=other]]'), provider)).toEqual({
      kind: 'error',
      status: 529,
    });
    expect(ask(marker, provider)).toEqual({ kind: 'error', status: 529 });
    expect(text(ask(marker, provider))).toBe('Recovered after 2 errors.');
    provider.reset?.();
    expect(ask(marker, provider)).toEqual({ kind: 'error', status: 529 });
    const defaults = scenarioProvider();
    expect(ask(marked('[[mock:errn]]'), defaults)).toEqual({ kind: 'error', status: 529 });
    expect(text(ask(marked('[[mock:errn]]'), defaults))).toBe('Recovered after 1 errors.');
  });

  it('hang', () => {
    expect(ask(marked('[[mock:hang]]'))).toEqual({ kind: 'hang' });
  });

  it('answers 400 to an unknown scenario instead of passing silently', () => {
    expect(badRequest(ask(marked('[[mock:txet]]')))).toBe(
      'mock: txet: invalid scenario: unknown scenario txet',
    );
  });
});
