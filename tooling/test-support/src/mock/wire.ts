/**
 * Wire encoding of mock replies: the non-streaming message body and the SSE
 * event sequence of a streaming reply (05 §2), typed against
 * `@anthropic-ai/sdk`.
 *
 * @remarks
 * Streaming order, as the CLI's embedded SDK expects it: `message_start`,
 * `ping`, then per content block `content_block_start`, one or more
 * `content_block_delta` (`text_delta` or `input_json_delta`) and
 * `content_block_stop`, then `message_delta` with the stop reason and
 * `message_stop`. Every SSE frame is `event: <type>\ndata: <json>\n\n`.
 * Token counts are fixed, so captures and snapshots are deterministic.
 */

import type { BetaErrorResponse } from '@anthropic-ai/sdk/resources/beta/beta';
import type {
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaRawMessageStreamEvent,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { errorTypeFor, type MockErrorReply, type MockMessageReply } from './provider.js';

/** Fixed usage of every mock message. */
export const MOCK_USAGE: Readonly<BetaUsage> = Object.freeze({
  input_tokens: 100,
  output_tokens: 20,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: null,
  inference_geo: null,
  iterations: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: 'standard',
  speed: null,
});

const DELTA_USAGE: Readonly<BetaMessageDeltaUsage> = Object.freeze({
  input_tokens: MOCK_USAGE.input_tokens,
  output_tokens: MOCK_USAGE.output_tokens,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: null,
  iterations: null,
  output_tokens_details: null,
  server_tool_use: null,
});

/** Model reported when the request names none. */
export const DEFAULT_MOCK_MODEL = 'claude-mock';

/** The complete assistant message of a reply. */
export function buildMessage(id: string, model: string, reply: MockMessageReply): BetaMessage {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [...reply.content],
    stop_reason: reply.stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: { ...MOCK_USAGE },
  };
}

/** The Anthropic error body of an error reply. */
export function buildErrorBody(reply: MockErrorReply, requestId: string): BetaErrorResponse {
  return {
    type: 'error',
    error: {
      type: reply.errorType ?? errorTypeFor(reply.status),
      message: reply.message ?? `mock ${String(reply.status)}`,
    },
    request_id: requestId,
  };
}

/** A stream event, including the `ping` keep-alive the SDK skips. */
export type MockStreamEvent = BetaRawMessageStreamEvent | { readonly type: 'ping' };

/** One SSE frame and whether the reply's chunk delay precedes it. */
export interface SseFrame {
  readonly event: MockStreamEvent;
  readonly delayed: boolean;
}

/** Splits `text` into `chunks` near-equal pieces; empty pieces are dropped. */
export function splitText(text: string, chunks: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, chunks)));
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += size)
    pieces.push(text.slice(start, start + size));
  return pieces;
}

/** The SSE event sequence of a streaming reply. */
export function streamFrames(id: string, model: string, reply: MockMessageReply): SseFrame[] {
  const plain = (event: MockStreamEvent): SseFrame => ({ event, delayed: false });
  const start = buildMessage(id, model, reply);
  const frames: SseFrame[] = [
    plain({
      type: 'message_start',
      message: {
        ...start,
        content: [],
        stop_reason: null,
        usage: { ...MOCK_USAGE, output_tokens: 1 },
      },
    }),
    plain({ type: 'ping' }),
  ];
  reply.content.forEach((block, index) => {
    if (block.type === 'text') {
      frames.push(
        plain({ type: 'content_block_start', index, content_block: { ...block, text: '' } }),
      );
      splitText(block.text, reply.chunks ?? 1).forEach((text, piece) => {
        frames.push({
          event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
          delayed: piece > 0,
        });
      });
    } else {
      frames.push(
        plain({ type: 'content_block_start', index, content_block: { ...block, input: {} } }),
        plain({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        }),
      );
    }
    frames.push(plain({ type: 'content_block_stop', index }));
  });
  frames.push(
    plain({
      type: 'message_delta',
      delta: {
        stop_reason: reply.stopReason,
        stop_sequence: null,
        stop_details: null,
        container: null,
      },
      context_management: null,
      usage: { ...DELTA_USAGE },
    }),
    plain({ type: 'message_stop' }),
  );
  return frames;
}

/** Encodes one SSE frame. */
export function encodeSse(event: MockStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
