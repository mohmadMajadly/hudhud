/**
 * Pluggable response provider of the mock Messages API (ADR-0013 §6).
 *
 * @remarks
 * A provider turns one parsed request into a {@link MockReply}; the server
 * owns the wire encoding (JSON or SSE). Reply content is typed against
 * `@anthropic-ai/sdk` (a development dependency of this package only), so a
 * reply that the SDK, and therefore the CLI, would not accept fails to
 * compile. {@link scenarioProvider} is the default: the scripted scenarios of
 * the spike mock (05 §2), selected by `[[mock:NAME k=v]]` markers.
 */

import type {
  BetaStopReason,
  BetaTextBlock,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { BetaError } from '@anthropic-ai/sdk/resources/beta/beta';

import { findScenario, type Scenario } from './scenario.js';

/** Content blocks the mock can send. */
export type MockContentBlock = BetaTextBlock | BetaToolUseBlock;

/** The API error type names of the SDK (`error.type` in an error body). */
export type MockErrorType = BetaError['type'];

/** An assistant message. */
export interface MockMessageReply {
  readonly kind: 'message';
  readonly content: readonly MockContentBlock[];
  readonly stopReason: BetaStopReason;
  /** Streaming only: split each text block into this many deltas (default 1). */
  readonly chunks?: number;
  /** Streaming only: delay before each text delta after the first, in ms (default 0). */
  readonly chunkDelayMs?: number;
}

/** An HTTP error with an Anthropic error body. */
export interface MockErrorReply {
  readonly kind: 'error';
  /** HTTP status, 400-599. */
  readonly status: number;
  /** Error type; derived from the status when absent. */
  readonly errorType?: MockErrorType;
  readonly message?: string;
}

/** Accept the request and never answer, until the client or the server closes. */
export interface MockHangReply {
  readonly kind: 'hang';
}

/** What the provider answers. */
export type MockReply = MockMessageReply | MockErrorReply | MockHangReply;

/** A Messages API request as the provider sees it. The body is untrusted JSON. */
export interface MessagesRequest {
  /** `model` when it is a string. */
  readonly model: string | undefined;
  /** `stream === true`. */
  readonly stream: boolean;
  /** `messages` when it is an array, else empty. */
  readonly messages: readonly unknown[];
  /** The whole parsed body. */
  readonly body: unknown;
}

/** Per-request services of the server. */
export interface ReplyContext {
  /** 1-based sequence number of the request since the last reset. */
  readonly seq: number;
  /** A fresh deterministic tool-use id (`toolu_mock_0001`, ...). */
  toolUseId(): string;
}

/** A pluggable response provider. */
export interface MockProvider {
  respond(request: MessagesRequest, context: ReplyContext): MockReply | Promise<MockReply>;
  /** Forgets provider state; called by the server's `reset()`. */
  reset?(): void;
}

/** A text block. */
export function textBlock(text: string): BetaTextBlock {
  return { type: 'text', text, citations: null };
}

/** A tool-use block. */
export function toolUseBlock(id: string, name: string, input: unknown): BetaToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

/** A complete text reply. */
export function textReply(text: string): MockMessageReply {
  return { kind: 'message', content: [textBlock(text)], stopReason: 'end_turn' };
}

/** The error type the real API uses for an HTTP status. */
export function errorTypeFor(status: number): MockErrorType {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 402:
      return 'billing_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 429:
      return 'rate_limit_error';
    case 504:
      return 'timeout_error';
    case 529:
      return 'overloaded_error';
    default:
      return status < 500 ? 'invalid_request_error' : 'api_error';
  }
}

/** Bounds of scenario arguments, so a marker cannot exhaust the test process. */
export const SCENARIO_LIMITS: Readonly<{
  bigBytes: number;
  chunks: number;
  chunkDelayMs: number;
  errorCount: number;
}> = Object.freeze({
  bigBytes: 64 * 1024 * 1024,
  chunks: 10_000,
  chunkDelayMs: 60_000,
  errorCount: 1_000,
});

/** Longest tool result quoted back by the tool scenarios. */
export const QUOTED_RESULT_LIMIT = 2000;

class ScenarioError extends Error {
  override readonly name = 'invalid scenario';
}

function integer(
  args: ReadonlyMap<string, string>,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = args.get(key);
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) > max) {
    throw new ScenarioError(`${key} must be an integer from 0 to ${String(max)}`);
  }
  return Number(raw);
}

function status(args: ReadonlyMap<string, string>, fallback: number): number {
  const value = integer(args, 'status', fallback, 599);
  if (value < 400) throw new ScenarioError('status must be from 400 to 599');
  return value;
}

function base64(args: ReadonlyMap<string, string>, key: string): string | undefined {
  const raw = args.get(key);
  if (raw === undefined) return undefined;
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw)) throw new ScenarioError(`${key} must be base64`);
  return Buffer.from(raw, 'base64').toString('utf8');
}

function required(args: ReadonlyMap<string, string>, key: string): string {
  const value = base64(args, key);
  if (value === undefined) throw new ScenarioError(`${key} is required`);
  return value;
}

/**
 * The default provider: the scripted scenarios of the spike mock (05 §2).
 *
 * | Marker | Reply |
 * |---|---|
 * | none | text `ok` (side requests such as titles) |
 * | `text [t=<b64>]` | text (default `Hello from mock.`) |
 * | `echo` | `ECHO:` and the user text without the marker |
 * | `tool name=<plain> in=<b64 json> [after=<b64>]` | step 0: tool use; then text quoting the tool results |
 * | `bash cmd=<b64>`, `ps cmd=<b64>` | shorthand for the `Bash` and `PowerShell` tools |
 * | `loop` | a `Bash` tool use at every step (for `--max-turns`) |
 * | `slow [chunks=N] [ms=M]` | text streamed in N deltas M ms apart |
 * | `big [bytes=N]` | one text block of N bytes |
 * | `err [status=S]` | HTTP S with an error body (default 500) |
 * | `errn [status=S] [n=K] [key=K2]` | S for the first K requests per key, then text |
 * | `hang` | never answers |
 *
 * An unknown scenario or a malformed argument answers 400 with a message
 * naming the problem, so a typo in a test fails loudly instead of passing
 * with a neutral reply.
 */
export function scenarioProvider(): MockProvider {
  const failures = new Map<string, number>();

  const toolStep = (
    scenario: Scenario,
    context: ReplyContext,
    name: string,
    input: unknown,
    after?: string,
  ): MockReply => {
    if (scenario.step === 0) {
      return {
        kind: 'message',
        stopReason: 'tool_use',
        content: [textBlock(`Calling ${name}.`), toolUseBlock(context.toolUseId(), name, input)],
      };
    }
    const quoted = scenario.toolResults
      .map((result) => (result.isError ? `[is_error] ${result.text}` : result.text))
      .join('\n')
      .slice(0, QUOTED_RESULT_LIMIT);
    return textReply(`${after ?? 'Tool finished.'} RESULT<<${quoted}>>`);
  };

  const play = (scenario: Scenario, context: ReplyContext): MockReply => {
    const { args } = scenario;
    switch (scenario.name) {
      case 'text':
        return textReply(base64(args, 't') ?? 'Hello from mock.');
      case 'echo':
        return textReply(`ECHO:${scenario.userText}`);
      case 'tool': {
        const name = args.get('name');
        if (name === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
          throw new ScenarioError('name must be a tool name');
        }
        const json = required(args, 'in');
        let input: unknown;
        try {
          input = JSON.parse(json);
        } catch {
          throw new ScenarioError('in must be base64 JSON');
        }
        return toolStep(scenario, context, name, input, base64(args, 'after'));
      }
      case 'bash':
        return toolStep(scenario, context, 'Bash', {
          command: required(args, 'cmd'),
          description: 'mock command',
        });
      case 'ps':
        return toolStep(scenario, context, 'PowerShell', {
          command: required(args, 'cmd'),
          description: 'mock command',
        });
      case 'loop':
        return {
          kind: 'message',
          stopReason: 'tool_use',
          content: [
            toolUseBlock(context.toolUseId(), 'Bash', {
              command: `echo loop${String(scenario.step)}`,
              description: 'loop',
            }),
          ],
        };
      case 'slow': {
        const chunks = Math.max(1, integer(args, 'chunks', 10, SCENARIO_LIMITS.chunks));
        const chunkDelayMs = integer(args, 'ms', 500, SCENARIO_LIMITS.chunkDelayMs);
        const text = Array.from({ length: chunks }, (_, index) => `chunk${String(index)} `).join(
          '',
        );
        return { ...textReply(text), chunks, chunkDelayMs };
      }
      case 'big': {
        const bytes = integer(args, 'bytes', 1_000_000, SCENARIO_LIMITS.bigBytes);
        return textReply(`BIG:${'x'.repeat(Math.max(0, bytes - 8))}:END`);
      }
      case 'err':
        return { kind: 'error', status: status(args, 500) };
      case 'errn': {
        const code = status(args, 529);
        const limit = integer(args, 'n', 1, SCENARIO_LIMITS.errorCount);
        const key = args.get('key') ?? 'default';
        const count = (failures.get(key) ?? 0) + 1;
        failures.set(key, count);
        if (count <= limit) return { kind: 'error', status: code };
        return textReply(`Recovered after ${String(count - 1)} errors.`);
      }
      case 'hang':
        return { kind: 'hang' };
      default:
        throw new ScenarioError(`unknown scenario ${scenario.name}`);
    }
  };

  return {
    respond(request, context) {
      const scenario = findScenario(request.messages);
      if (scenario === undefined) return textReply('ok');
      try {
        return play(scenario, context);
      } catch (error) {
        // Every throw in play() is a ScenarioError naming the bad argument.
        return { kind: 'error', status: 400, message: `mock: ${scenario.name}: ${String(error)}` };
      }
    },
    reset() {
      failures.clear();
    },
  };
}
