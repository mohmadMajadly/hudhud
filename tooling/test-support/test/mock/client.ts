/**
 * Minimal loopback clients for the mock tests: an HTTP client whose socket
 * factory can be swapped (the no-egress test allowlists its own sockets), a
 * raw-bytes exchange, and an SSE parser.
 */

import http from 'node:http';
import net from 'node:net';

/** Opens a socket to the mock; the default is a plain `net.createConnection`. */
export type SocketFactory = (port: number) => net.Socket;

export const defaultFactory: SocketFactory = (port) =>
  net.createConnection({ host: '127.0.0.1', port });

export interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly text: string;
}

export interface RequestOptions {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly factory?: SocketFactory;
}

/** One HTTP request over a fresh connection; resolves with the whole response. */
export function request(port: number, options: RequestOptions = {}): Promise<Reply> {
  const factory = options.factory ?? defaultFactory;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/v1/messages?beta=true',
        headers: { 'content-type': 'application/json', ...options.headers },
        // With createConnection and no agent, Node uses this socket directly.
        createConnection: () => factory(port),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** Posts a Messages request body. */
export function post(port: number, body: unknown, factory?: SocketFactory): Promise<Reply> {
  return request(port, {
    body: JSON.stringify(body),
    headers: { 'x-api-key': 'fake-key', 'anthropic-version': '2023-06-01' },
    ...(factory === undefined ? {} : { factory }),
  });
}

/** Writes raw bytes and collects everything until the server closes the socket. */
export function exchange(
  port: number,
  bytes: string,
  factory: SocketFactory = defaultFactory,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = factory(port);
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
    socket.write(bytes);
  });
}

export interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Parses an SSE body; every frame must be `event:` plus `data:` and a blank line. */
export function parseSse(text: string): SseEvent[] {
  if (!text.endsWith('\n\n')) throw new Error('SSE body must end with a blank line');
  return text
    .slice(0, -2)
    .split('\n\n')
    .map((frame) => {
      const match = /^event: ([a-z_]+)\ndata: (.*)$/.exec(frame);
      if (match === null) throw new Error(`malformed SSE frame: ${frame}`);
      const data = JSON.parse(String(match[2])) as Record<string, unknown>;
      return { event: String(match[1]), data };
    });
}

/** A user message with a scenario marker. */
export function user(text: string): { role: 'user'; content: string } {
  return { role: 'user', content: text };
}

/** Base64 of a UTF-8 string, for marker arguments. */
export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
