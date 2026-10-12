/**
 * In-process mock of the Anthropic Messages API with an egress trap
 * (ADR-0013 §1-§7, §16; plan §1.11, §4.4, §4.5).
 *
 * @remarks
 * One `http.Server` per test (or suite), bound to `127.0.0.1` on an
 * ephemeral port and nothing else; connections from any other address are
 * destroyed on arrival. The server answers only allowlisted requests
 * (`POST /v1/messages?beta=true` by default) through a pluggable provider,
 * in JSON or as SSE, and captures each of them (headers with credentials
 * redacted, parsed body) for request-shape snapshots. Everything else is an
 * egress violation that {@link MockServer.assertNoViolations} turns into a
 * test failure: `CONNECT` tunnels and absolute-URI proxy requests (the mock
 * is the CLI's `HTTPS_PROXY`/`HTTP_PROXY`), foreign `Host` headers,
 * `Upgrade` requests, non-allowlisted paths, oversized bodies and malformed
 * requests. The mock never forwards anything: it opens no outbound
 * connection of any kind.
 *
 * No timers are used except the injectable `sleep` between the deltas of a
 * `slow` stream; ids and token counts are deterministic.
 */

import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { createAllowlist, type AllowlistEntry } from './allowlist.js';
import {
  absoluteTarget,
  EgressTrap,
  ignoreSocketError,
  redactTarget,
  sanitize,
  type EgressViolation,
} from './egress-trap.js';
import {
  scenarioProvider,
  type MessagesRequest,
  type MockErrorReply,
  type MockProvider,
  type MockReply,
} from './provider.js';
import { isRecord } from './scenario.js';
import {
  buildErrorBody,
  buildMessage,
  DEFAULT_MOCK_MODEL,
  encodeSse,
  streamFrames,
} from './wire.js';

/** The only address the mock binds to. */
export const MOCK_HOST = '127.0.0.1';

/** Default limit of one request body: far above the largest CLI request (05 §11). */
export const DEFAULT_MAX_BODY_BYTES: number = 64 * 1024 * 1024;

/** Default number of captured requests kept; older ones are dropped first. */
export const DEFAULT_MAX_CAPTURED_REQUESTS = 1000;

/** Header names whose values are never captured. */
export const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
]);

/** Options of {@link startMockServer}. */
export interface MockServerOptions {
  /** Response provider; default {@link scenarioProvider}. */
  readonly provider?: MockProvider;
  /** Extra allowed requests on top of `POST /v1/messages?beta=true`. */
  readonly allow?: readonly AllowlistEntry[];
  /** Largest accepted request body in bytes; default {@link DEFAULT_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number;
  /** Captured requests kept; default {@link DEFAULT_MAX_CAPTURED_REQUESTS}. */
  readonly maxCapturedRequests?: number;
  /** Waits between delayed stream deltas; default a real timer. Tests inject a fake. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** One allowlisted request as received. */
export interface CapturedRequest {
  /** 1-based sequence number since the last reset (shared with reply ids). */
  readonly seq: number;
  readonly method: string;
  /** Origin-form target, for example `/v1/messages?beta=true`. */
  readonly target: string;
  /** Lower-case header names; credential headers are `<redacted>`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body, or `undefined` when it was not valid JSON. */
  readonly body: unknown;
  /** Body size in bytes. */
  readonly bytes: number;
}

/** A running mock server. */
export interface MockServer {
  /** Base URL for `ANTHROPIC_BASE_URL` and the proxy variables, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The address actually bound, as reported by the server: always `127.0.0.1`. */
  readonly host: string;
  readonly port: number;
  /** Captured allowlisted requests, oldest first (a copy). */
  readonly requests: readonly CapturedRequest[];
  /** Connections currently open (HTTP, hijacked `CONNECT` and upgrade sockets). */
  readonly openConnections: number;
  /** Recorded egress violations, oldest first (a copy). */
  readonly violations: readonly EgressViolation[];
  /**
   * Fails the test when any violation was recorded.
   *
   * @throws EgressViolationError
   */
  assertNoViolations(): void;
  /** Clears captures, violations, sequence numbers and provider state. */
  reset(): void;
  /** Stops listening and destroys every open connection. Idempotent. */
  close(): Promise<void>;
}

/** Whether a peer address is the IPv4 loopback the mock is bound to. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === MOCK_HOST || address === `::ffff:${MOCK_HOST}`;
}

/** The part of an accepted socket the connection guard uses. */
export interface GuardedSocket {
  readonly remoteAddress?: string | undefined;
  destroy(): void;
  once(event: 'close', listener: () => void): unknown;
}

/**
 * Admits a new connection: destroys it unless it comes from the loopback
 * address, otherwise tracks it in `open` until it closes.
 *
 * @returns whether the connection was admitted.
 */
export function guardConnection<T extends GuardedSocket>(socket: T, open: Set<T>): boolean {
  if (!isLoopbackAddress(socket.remoteAddress)) {
    socket.destroy();
    return false;
  }
  open.add(socket);
  socket.once('close', () => open.delete(socket));
  return true;
}

/** The part of a socket the `clientError` handler uses. */
export interface ClientErrorSocket {
  readonly writable: boolean;
  end(data: string): unknown;
  destroy(): void;
}

/**
 * Codes of a peer that went away: a reset, a broken pipe, or a close in the
 * middle of a request (an interrupted CLI). Not violations.
 */
const PEER_GONE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'HPE_INVALID_EOF_STATE',
]);

/**
 * Handles an HTTP parser or socket error: a peer that went away only
 * closes the socket; anything else is a `malformed-request` violation answered with 400
 * when the socket is still writable.
 */
export function handleClientError(
  trap: EgressTrap,
  error: Error & { code?: string },
  socket: ClientErrorSocket,
): void {
  const code = error.code ?? 'unknown';
  if (PEER_GONE_CODES.has(code)) {
    socket.destroy();
    return;
  }
  trap.record({ kind: 'malformed-request', method: '-', target: '-', detail: sanitize(code) });
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  } else {
    socket.destroy();
  }
}

/** Header map with credential values replaced by `<redacted>`. */
export function redactHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    result[key] = REDACTED_HEADERS.has(key)
      ? '<redacted>'
      : Array.isArray(value)
        ? value.join(', ')
        : value;
  }
  return result;
}

type BodyResult =
  | { readonly kind: 'body'; readonly data: Buffer }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'aborted' };

/** Reads a request body up to `limit` bytes; never buffers more than that. */
function readBody(req: http.IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) return Promise.resolve({ kind: 'too-large' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.off('data', onData);
        chunks.length = 0;
        resolve({ kind: 'too-large' });
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('error', ignoreSocketError);
    req.on('end', () => {
      resolve({ kind: 'body', data: Buffer.concat(chunks) });
    });
    req.on('close', () => {
      resolve({ kind: 'aborted' });
    });
  });
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** Sends a JSON response. */
function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Refuses a request outside the rules and closes its connection. */
function refuse(res: http.ServerResponse, status: number): void {
  const reply: MockErrorReply = {
    kind: 'error',
    status,
    message: 'mock: refused by the egress trap',
  };
  sendJson(res, status, buildErrorBody(reply, 'req_mock_refused'), { connection: 'close' });
}

function messagesRequest(body: unknown): MessagesRequest {
  const record = isRecord(body) ? body : {};
  const model = record['model'];
  const messages = record['messages'];
  return {
    model: typeof model === 'string' ? model : undefined,
    stream: record['stream'] === true,
    messages: Array.isArray(messages) ? messages : [],
    body,
  };
}

/**
 * Starts a mock server on `127.0.0.1` and an ephemeral port.
 *
 * @example
 * ```ts
 * const mock = await startMockServer();
 * try {
 *   // launch the CLI with ANTHROPIC_BASE_URL, HTTPS_PROXY and HTTP_PROXY = mock.url
 *   mock.assertNoViolations();
 * } finally {
 *   await mock.close();
 * }
 * ```
 */
export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const provider = options.provider ?? scenarioProvider();
  const allowlist = createAllowlist(options.allow);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxCaptured = options.maxCapturedRequests ?? DEFAULT_MAX_CAPTURED_REQUESTS;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new RangeError(`maxBodyBytes must be a non-negative integer: ${String(maxBodyBytes)}`);
  }
  if (!Number.isSafeInteger(maxCaptured) || maxCaptured < 0) {
    throw new RangeError(
      `maxCapturedRequests must be a non-negative integer: ${String(maxCaptured)}`,
    );
  }

  const trap = new EgressTrap();
  const open = new Set<Socket>();
  let captured: CapturedRequest[] = [];
  let seq = 0;
  let toolSeq = 0;
  let port = 0;

  const capture = (entry: CapturedRequest): void => {
    captured.push(entry);
    if (captured.length > maxCaptured) captured = captured.slice(captured.length - maxCaptured);
  };

  const sendReply = async (
    res: http.ServerResponse,
    request: MessagesRequest,
    reply: MockReply,
    id: number,
  ): Promise<void> => {
    const requestId = `req_mock_${pad(id, 5)}`;
    if (reply.kind === 'hang') return;
    if (reply.kind === 'error') {
      // A custom provider may get the status wrong; never let it throw in writeHead.
      const valid = Number.isInteger(reply.status) && reply.status >= 400 && reply.status <= 599;
      const error: MockErrorReply = valid
        ? reply
        : {
            kind: 'error',
            status: 500,
            message: `mock: invalid error status ${String(reply.status)}`,
          };
      const retry = error.status === 429 || error.status === 529 ? { 'retry-after': '0' } : {};
      sendJson(res, error.status, buildErrorBody(error, requestId), {
        'request-id': requestId,
        ...retry,
      });
      return;
    }
    const messageId = `msg_mock_${pad(id, 5)}`;
    const model = request.model ?? DEFAULT_MOCK_MODEL;
    if (!request.stream) {
      sendJson(res, 200, buildMessage(messageId, model, reply), { 'request-id': requestId });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'request-id': requestId,
    });
    // The client may go away between deltas (interrupt mid-stream).
    const connection = { closed: false };
    res.once('close', () => {
      connection.closed = true;
    });
    const delayMs = reply.chunkDelayMs ?? 0;
    for (const frame of streamFrames(messageId, model, reply)) {
      if (frame.delayed && delayMs > 0) await sleep(delayMs);
      if (connection.closed) return;
      res.write(encodeSse(frame.event));
    }
    res.end();
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    res.on('error', ignoreSocketError);
    // A server-side request always has both; the types are shared with the client side.
    const method = String(req.method);
    const target = String(req.url);

    if (!target.startsWith('/')) {
      const absolute = absoluteTarget(target);
      if (absolute === undefined) {
        trap.record({ kind: 'path', method, target: sanitize(target) });
        refuse(res, 400);
      } else {
        trap.record({ kind: 'absolute-uri', method, target: absolute });
        refuse(res, 403);
      }
      return;
    }
    const host = req.headers.host;
    if (host !== `${MOCK_HOST}:${String(port)}` && host !== `localhost:${String(port)}`) {
      trap.record({ kind: 'host', method, target: sanitize(host ?? '<none>') });
      refuse(res, 403);
      return;
    }
    if (!allowlist.allows(method, target)) {
      trap.record({ kind: 'path', method, target: redactTarget(target) });
      refuse(res, 404);
      return;
    }

    const body = await readBody(req, maxBodyBytes);
    if (body.kind === 'aborted') return;
    if (body.kind === 'too-large') {
      trap.record({
        kind: 'body-too-large',
        method,
        target: redactTarget(target),
        detail: `limit ${String(maxBodyBytes)} bytes`,
      });
      refuse(res, 413);
      return;
    }

    seq += 1;
    const id = seq;
    let parsed: unknown;
    let valid = true;
    try {
      parsed = JSON.parse(body.data.toString('utf8'));
    } catch {
      valid = false;
    }
    capture(
      Object.freeze({
        seq: id,
        method,
        target,
        headers: Object.freeze(redactHeaders(req.headers)),
        body: parsed,
        bytes: body.data.length,
      }),
    );
    const requestId = `req_mock_${pad(id, 5)}`;
    if (!valid) {
      const reply: MockErrorReply = {
        kind: 'error',
        status: 400,
        message: 'mock: body is not JSON',
      };
      sendJson(res, 400, buildErrorBody(reply, requestId), { 'request-id': requestId });
      return;
    }
    const pathname = target.split('?', 1)[0];
    if (pathname !== '/v1/messages') {
      const reply: MockErrorReply = { kind: 'error', status: 404, message: 'mock: no handler' };
      sendJson(res, 404, buildErrorBody(reply, requestId), { 'request-id': requestId });
      return;
    }
    const request = messagesRequest(parsed);
    let reply: MockReply;
    try {
      reply = await provider.respond(request, {
        seq: id,
        toolUseId: () => {
          toolSeq += 1;
          return `toolu_mock_${pad(toolSeq, 4)}`;
        },
      });
    } catch (error) {
      reply = { kind: 'error', status: 500, message: `mock: provider failed: ${String(error)}` };
    }
    await sendReply(res, request, reply, id);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.on('connection', (socket: Socket) => {
    guardConnection(socket, open);
  });
  server.on('connect', (req: http.IncomingMessage, socket: Socket) => {
    trap.handleConnect(req.url, socket);
  });
  server.on('upgrade', (req: http.IncomingMessage, socket: Socket) => {
    socket.on('error', ignoreSocketError);
    const target = String(req.url);
    trap.record({
      kind: 'upgrade',
      method: String(req.method),
      target: absoluteTarget(target) ?? redactTarget(target),
    });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  server.on('clientError', (error: Error & { code?: string }, socket: Socket) => {
    handleClientError(trap, error, socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: MOCK_HOST, port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = server.address() as AddressInfo;
  port = bound.port;

  let closing: Promise<void> | undefined;
  return {
    url: `http://${MOCK_HOST}:${String(port)}`,
    host: bound.address,
    port,
    get requests() {
      return [...captured];
    },
    get openConnections() {
      return open.size;
    },
    get violations() {
      return trap.violations;
    },
    assertNoViolations() {
      trap.assertNoViolations();
    },
    reset() {
      captured = [];
      seq = 0;
      toolSeq = 0;
      trap.clear();
      provider.reset?.();
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        for (const socket of open) socket.destroy();
      });
      return closing;
    },
  };
}
