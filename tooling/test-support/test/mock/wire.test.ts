import { describe, expect, it } from 'vitest';

import { textBlock, toolUseBlock, type MockMessageReply } from '../../src/mock/provider.js';
import {
  buildErrorBody,
  buildMessage,
  encodeSse,
  MOCK_USAGE,
  splitText,
  streamFrames,
} from '../../src/mock/wire.js';

const reply: MockMessageReply = {
  kind: 'message',
  stopReason: 'tool_use',
  content: [textBlock('abcde'), toolUseBlock('toolu_1', 'Bash', { command: 'ls' })],
  chunks: 2,
};

describe('wire', () => {
  it('builds a complete message', () => {
    expect(buildMessage('msg_1', 'm', reply)).toEqual({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: reply.content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      diagnostics: null,
      usage: MOCK_USAGE,
    });
  });

  it('builds error bodies', () => {
    expect(buildErrorBody({ kind: 'error', status: 529 }, 'req_1')).toEqual({
      type: 'error',
      error: { type: 'overloaded_error', message: 'mock 529' },
      request_id: 'req_1',
    });
    expect(
      buildErrorBody(
        { kind: 'error', status: 500, errorType: 'billing_error', message: 'm' },
        'req_2',
      ).error,
    ).toEqual({ type: 'billing_error', message: 'm' });
  });

  it('splits text into near-equal pieces', () => {
    expect(splitText('abcde', 2)).toEqual(['abc', 'de']);
    expect(splitText('abc', 10)).toEqual(['a', 'b', 'c']);
    expect(splitText('abc', 0)).toEqual(['abc']);
    expect(splitText('', 3)).toEqual([]);
  });

  it('streams in the order the SDK expects', () => {
    const frames = streamFrames('msg_1', 'm', reply);
    expect(frames.map((frame) => frame.event.type)).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(frames.map((frame) => frame.delayed)).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(frames[0]?.event).toMatchObject({
      type: 'message_start',
      message: { id: 'msg_1', content: [], stop_reason: null, usage: { output_tokens: 1 } },
    });
    expect(frames[2]?.event).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: null },
    });
    expect(frames[6]?.event).toEqual({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
    });
    expect(frames[7]?.event).toEqual({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
    });
    expect(frames[9]?.event).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 20 },
    });
  });

  it('encodes SSE frames', () => {
    expect(encodeSse({ type: 'message_stop' })).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  });
});
