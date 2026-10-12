import net from 'node:net';
import os from 'node:os';

import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { EgressTrap, EgressViolationError } from '../../src/mock/egress-trap.js';
import { textReply, type MockProvider } from '../../src/mock/provider.js';
import {
  guardConnection,
  handleClientError,
  isLoopbackAddress,
  redactHeaders,
  startMockServer,
  type MockServer,
  type MockServerOptions,
} from '../../src/mock/server.js';
import { b64, exchange, parseSse, post, request, user } from './client.js';

const servers: MockServer[] = [];

async function start(options: MockServerOptions = {}): Promise<MockServer> {
  const mock = await startMockServer(options);
  servers.push(mock);
  return mock;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((mock) => mock.close()));
});

/**
 * Polls through event-loop turns (no timers) until `condition` holds. The
 * bound is wall-clock, generous, and only reached when something is broken.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

function sdk(mock: MockServer): Anthropic {
  return new Anthropic({ apiKey: 'fake-key', baseURL: mock.url, maxRetries: 0 });
}

const MODEL = 'claude-opus-5-5';

describe('binding', () => {
  it('binds 127.0.0.1 on an ephemeral port only', async () => {
    const mock = await start();
    expect(mock.host).toBe('127.0.0.1');
    expect(mock.port).toBeGreaterThan(0);
    expect(mock.url).toBe(`http://127.0.0.1:${String(mock.port)}`);
    const connectTo = (host: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port: mock.port });
        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
      });
    await expect(connectTo('127.0.0.1')).resolves.toBeUndefined();
    await expect(connectTo('::1')).rejects.toThrow();
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry?.family === 'IPv4' && !entry.internal);
    if (external !== undefined) await expect(connectTo(external.address)).rejects.toThrow();
  }, 30_000);

  it('admits loopback peers only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.2')).toBe(false);
    expect(isLoopbackAddress('::1')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);

    const fake = (remoteAddress: string | undefined) => {
      const state = { destroyed: false, onClose: (): void => undefined };
      return {
        state,
        socket: {
          remoteAddress,
          destroy: () => {
            state.destroyed = true;
          },
          once: (_event: 'close', listener: () => void) => {
            state.onClose = listener;
          },
        },
      };
    };
    const open = new Set<ReturnType<typeof fake>['socket']>();
    const foreign = fake('192.168.1.5');
    expect(guardConnection(foreign.socket, open)).toBe(false);
    expect(foreign.state.destroyed).toBe(true);
    expect(open.size).toBe(0);
    const local = fake('127.0.0.1');
    expect(guardConnection(local.socket, open)).toBe(true);
    expect(local.state.destroyed).toBe(false);
    expect(open.has(local.socket)).toBe(true);
    local.state.onClose();
    expect(open.size).toBe(0);
  });

  it('rejects invalid limits', async () => {
    await expect(startMockServer({ maxBodyBytes: -1 })).rejects.toThrow(RangeError);
    await expect(startMockServer({ maxBodyBytes: 1.5 })).rejects.toThrow(/maxBodyBytes/);
    await expect(startMockServer({ maxCapturedRequests: -1 })).rejects.toThrow(
      /maxCapturedRequests/,
    );
  });

  it('closes idempotently and destroys open connections', async () => {
    const mock = await startMockServer();
    const pending = post(mock.port, { model: MODEL, messages: [user('[[mock:hang]]')] });
    await until(() => mock.requests.length === 1, 'the hanging request');
    expect(mock.openConnections).toBe(1);
    const first = mock.close();
    expect(mock.close()).toBe(first);
    await first;
    await expect(pending).rejects.toThrow();
  });
});

describe('scripted responses', () => {
  it('answers JSON and captures the request with credentials redacted', async () => {
    const mock = await start();
    const reply = await request(mock.port, {
      body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [user('[[mock:text]]')] }),
      headers: {
        'x-api-key': 'fake-key',
        authorization: 'Bearer fake-token',
        'anthropic-beta': 'a,b',
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.headers['request-id']).toBe('req_mock_00001');
    expect(JSON.parse(reply.text)).toMatchObject({
      id: 'msg_mock_00001',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'Hello from mock.' }],
      stop_reason: 'end_turn',
    });
    const [captured] = mock.requests;
    expect(captured).toMatchObject({
      seq: 1,
      method: 'POST',
      target: '/v1/messages?beta=true',
      body: { model: MODEL, max_tokens: 10 },
    });
    expect(captured?.headers['x-api-key']).toBe('<redacted>');
    expect(captured?.headers['authorization']).toBe('<redacted>');
    expect(captured?.headers['anthropic-beta']).toBe('a,b');
    expect(JSON.stringify(mock.requests)).not.toContain('fake-key');
    expect(captured?.bytes).toBeGreaterThan(0);
    expect(Object.isFrozen(captured)).toBe(true);
    mock.assertNoViolations();
  });

  it('streams SSE frames as the CLI expects', async () => {
    const mock = await start();
    const reply = await post(mock.port, {
      model: MODEL,
      stream: true,
      messages: [user(`[[mock:bash cmd=${b64('echo hi')}]]`)],
    });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/event-stream');
    const events = parseSse(reply.text);
    expect(events.map((event) => event.event)).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    for (const event of events) expect(event.data['type']).toBe(event.event);
    expect(events[6]?.data).toEqual({
      type: 'content_block_delta',
      index: 1,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({ command: 'echo hi', description: 'mock command' }),
      },
    });
  });

  it('is accepted by the SDK the CLI embeds: JSON, streaming and a tool round trip', async () => {
    const mock = await start();
    const client = sdk(mock);
    const marker = `[[mock:bash cmd=${b64('echo hi')}]]`;

    const first = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: 'user', content: marker }],
    });
    expect(first.stop_reason).toBe('tool_use');
    const toolUse = first.content.find((block) => block.type === 'tool_use');
    expect(toolUse).toEqual({
      type: 'tool_use',
      id: 'toolu_mock_0001',
      name: 'Bash',
      input: { command: 'echo hi', description: 'mock command' },
    });

    const streamed = await client.beta.messages
      .stream({ model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: marker }] })
      .finalMessage();
    expect(streamed.content).toEqual([
      { type: 'text', text: 'Calling Bash.', citations: null },
      { ...toolUse, id: 'toolu_mock_0002' },
    ]);
    expect(streamed.stop_reason).toBe('tool_use');
    expect(streamed.usage.output_tokens).toBe(20);

    // The CLI appends a role:"system" message after the tool result (D16); the SDK
    // types do not know the role, so the raw request is posted for this step.
    const followUp = await post(mock.port, {
      model: MODEL,
      stream: true,
      messages: [
        { role: 'user', content: marker },
        { role: 'assistant', content: streamed.content },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_mock_0002', content: 'hi\n' }],
        },
        { role: 'system', content: '<total_tokens>1000 tokens left</total_tokens>' },
      ],
    });
    const text = parseSse(followUp.text)
      .filter((event) => event.event === 'content_block_delta')
      .map((event) => (event.data['delta'] as { text: string }).text)
      .join('');
    expect(text).toBe('Tool finished. RESULT<<hi\n>>');
    expect(mock.requests.map((captured) => captured.seq)).toEqual([1, 2, 3]);
    mock.assertNoViolations();
  });

  it('maps error replies to SDK errors, with retry-after for 429 and 529', async () => {
    const mock = await start();
    const client = sdk(mock);
    const failure = await client.beta.messages
      .create({
        model: MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: '[[mock:err status=401]]' }],
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(APIError);
    expect((failure as APIError).status).toBe(401);
    expect((failure as APIError).type).toBe('authentication_error');

    for (const [status, retry] of [
      [429, '0'],
      [529, '0'],
      [500, undefined],
    ] as const) {
      const reply = await post(mock.port, {
        messages: [user(`[[mock:err status=${String(status)}]]`)],
      });
      expect(reply.status).toBe(status);
      expect(reply.headers['retry-after']).toBe(retry);
      expect(JSON.parse(reply.text)).toMatchObject({
        type: 'error',
        request_id: reply.headers['request-id'],
      });
    }
  });

  it('defaults the model and tolerates non-object bodies', async () => {
    const mock = await start();
    const reply = await post(mock.port, [1, 2]);
    expect(JSON.parse(reply.text)).toMatchObject({
      model: 'claude-mock',
      content: [{ text: 'ok' }],
    });
    const odd = await post(mock.port, { model: 7, messages: 'x', stream: 'yes' });
    expect(JSON.parse(odd.text)).toMatchObject({ model: 'claude-mock', content: [{ text: 'ok' }] });
  });

  it('answers 400 to a body that is not JSON and still captures it', async () => {
    const mock = await start();
    const reply = await request(mock.port, { body: '{nope' });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.text)).toMatchObject({
      error: { type: 'invalid_request_error', message: 'mock: body is not JSON' },
    });
    expect(mock.requests[0]?.body).toBeUndefined();
    expect(mock.requests[0]?.bytes).toBe(5);
    mock.assertNoViolations();
  });

  it('uses a pluggable provider and answers 500 when it throws', async () => {
    let calls = 0;
    const provider: MockProvider = {
      respond: (request, context) => {
        calls += 1;
        if (calls === 2) throw new Error('provider bug');
        return Promise.resolve(
          textReply(`seq=${String(context.seq)} model=${String(request.model)}`),
        );
      },
    };
    const mock = await start({ provider });
    const ok = await post(mock.port, { model: 'm', messages: [] });
    expect(JSON.parse(ok.text)).toMatchObject({ content: [{ text: 'seq=1 model=m' }] });
    const failed = await post(mock.port, { messages: [] });
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toMatchObject({
      error: { type: 'api_error', message: 'mock: provider failed: Error: provider bug' },
    });
    mock.reset();
    const again = await post(mock.port, { messages: [] });
    expect(JSON.parse(again.text)).toMatchObject({ content: [{ text: 'seq=1 model=undefined' }] });
  });

  it('answers 500 when a provider returns an impossible error status', async () => {
    const statuses = [200, 600, 450.5];
    const mock = await start({
      provider: { respond: () => ({ kind: 'error', status: statuses.shift() ?? 0 }) },
    });
    for (const status of ['200', '600', '450.5']) {
      const reply = await post(mock.port, { messages: [] });
      expect(reply.status).toBe(500);
      expect(JSON.parse(reply.text)).toMatchObject({
        error: { type: 'api_error', message: `mock: invalid error status ${status}` },
      });
    }
  });

  it('reset clears captures, violations, ids and provider state', async () => {
    const mock = await start();
    const errn = { messages: [user('[[mock:errn status=529 n=1]]')] };
    expect((await post(mock.port, errn)).status).toBe(529);
    await post(mock.port, { messages: [user(`[[mock:bash cmd=${b64('x')}]]`)] });
    await request(mock.port, { method: 'GET', path: '/v1/models' });
    expect(mock.requests).toHaveLength(2);
    expect(mock.violations).toHaveLength(1);
    mock.reset();
    expect(mock.requests).toEqual([]);
    expect(mock.violations).toEqual([]);
    mock.assertNoViolations();
    expect((await post(mock.port, errn)).status).toBe(529);
    const bash = JSON.parse(
      (await post(mock.port, { messages: [user(`[[mock:bash cmd=${b64('x')}]]`)] })).text,
    ) as {
      id: string;
      content: { id?: string }[];
    };
    expect(bash.id).toBe('msg_mock_00002');
    expect(bash.content[1]?.id).toBe('toolu_mock_0001');
  });

  it('keeps at most maxCapturedRequests captures, newest last', async () => {
    const mock = await start({ maxCapturedRequests: 2 });
    for (let index = 0; index < 3; index += 1) await post(mock.port, { messages: [] });
    expect(mock.requests.map((captured) => captured.seq)).toEqual([2, 3]);
    const none = await start({ maxCapturedRequests: 0 });
    await post(none.port, { messages: [] });
    expect(none.requests).toEqual([]);
  });

  it('streams slow replies through the injected sleep', async () => {
    const delays: number[] = [];
    const mock = await start({
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    const reply = await post(mock.port, {
      stream: true,
      messages: [user('[[mock:slow chunks=3 ms=250]]')],
    });
    const deltas = parseSse(reply.text).filter((event) => event.event === 'content_block_delta');
    expect(deltas).toHaveLength(3);
    expect(delays).toEqual([250, 250]);
    const instant = await post(mock.port, {
      stream: true,
      messages: [user('[[mock:slow chunks=2 ms=0]]')],
    });
    expect(parseSse(instant.text)).toHaveLength(8);
    expect(delays).toEqual([250, 250]);
  });

  it('streams slow replies with the default sleep', async () => {
    const mock = await start();
    const reply = await post(mock.port, {
      stream: true,
      messages: [user('[[mock:slow chunks=2 ms=1]]')],
    });
    expect(
      parseSse(reply.text).filter((event) => event.event === 'content_block_delta'),
    ).toHaveLength(2);
  });

  it('stops streaming when the client goes away mid-stream', async () => {
    const live: { client?: net.Socket; open?: () => number } = {};
    let sleeps = 0;
    const mock = await start({
      sleep: async () => {
        sleeps += 1;
        live.client?.resetAndDestroy();
        await until(() => live.open?.() === 0, 'the server side to close');
      },
    });
    live.open = () => mock.openConnections;
    const body = JSON.stringify({ stream: true, messages: [user('[[mock:slow chunks=5 ms=10]]')] });
    const client = net.createConnection({ host: '127.0.0.1', port: mock.port });
    live.client = client;
    client.on('error', () => undefined);
    client.write(
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: 127.0.0.1:${String(mock.port)}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
    );
    await until(() => sleeps === 1 && mock.openConnections === 0, 'the aborted stream');
    // One more turn lets the handler observe the close and return.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(sleeps).toBe(1);
    expect((await post(mock.port, { messages: [] })).status).toBe(200);
  });
});

describe('egress trap', () => {
  it('refuses CONNECT with 403 and records host:port without credentials', async () => {
    const mock = await start();
    const response = await exchange(
      mock.port,
      'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n' +
        'Proxy-Authorization: Basic c2VjcmV0\r\n\r\n',
    );
    expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(mock.violations).toEqual([
      { seq: 1, kind: 'connect', method: 'CONNECT', target: 'api.anthropic.com:443' },
    ]);
    expect(JSON.stringify(mock.violations)).not.toContain('c2VjcmV0');
    expect(() => {
      mock.assertNoViolations();
    }).toThrow(EgressViolationError);
  });

  it('survives clients that reset the CONNECT socket during refusal (J12)', async () => {
    const mock = await start();
    const connect = 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n';
    const settle = (socket: net.Socket): Promise<void> =>
      new Promise((resolve) => {
        socket.on('error', () => undefined);
        socket.on('close', () => {
          resolve();
        });
      });
    // Reset right after sending: races the server's refusal write.
    for (let round = 0; round < 20; round += 1) {
      const socket = net.createConnection({ host: '127.0.0.1', port: mock.port }, () => {
        socket.write(connect, () => socket.resetAndDestroy());
      });
      await settle(socket);
    }
    // Reset on the first byte of the refusal: the handler certainly ran.
    for (let round = 0; round < 5; round += 1) {
      const socket = net.createConnection({ host: '127.0.0.1', port: mock.port }, () => {
        socket.write(connect);
      });
      socket.once('data', () => socket.resetAndDestroy());
      await settle(socket);
    }
    await until(() => mock.openConnections === 0, 'every reset socket to close');
    expect(mock.violations.length).toBeGreaterThanOrEqual(5);
    expect(mock.violations.every((violation) => violation.kind === 'connect')).toBe(true);
    // The mock is still alive and serving.
    expect((await post(mock.port, { messages: [user('[[mock:text]]')] })).status).toBe(200);
  });

  it('refuses absolute-URI proxy requests, including ones naming the mock itself', async () => {
    const mock = await start();
    const outside = await exchange(
      mock.port,
      // Userinfo assembled at run time: written out it reads as an e-mail address.
      ['GET http://user:pw', 'example.com/x?key=secret HTTP/1.1\r\nHost: example.com\r\n\r\n'].join(
        '@',
      ),
    );
    expect(outside).toMatch(/^HTTP\/1\.1 403 /);
    const self = await request(mock.port, {
      path: `http://127.0.0.1:${String(mock.port)}/v1/messages?beta=true`,
      body: '{}',
    });
    expect(self.status).toBe(403);
    const star = await exchange(mock.port, 'OPTIONS * HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(star).toMatch(/^HTTP\/1\.1 400 /);
    expect(mock.violations).toEqual([
      { seq: 1, kind: 'absolute-uri', method: 'GET', target: 'http://example.com' },
      {
        seq: 2,
        kind: 'absolute-uri',
        method: 'POST',
        target: `http://127.0.0.1:${String(mock.port)}`,
      },
      { seq: 3, kind: 'path', method: 'OPTIONS', target: '*' },
    ]);
    expect(JSON.stringify(mock.violations)).not.toMatch(/secret|pw/);
    expect(mock.requests).toEqual([]);
  });

  it('fails the test on a request outside the allowlist', async () => {
    const mock = await start();
    const reply = await request(mock.port, {
      method: 'GET',
      path: '/api/claude_cli/bootstrap?entrypoint=sdk-cli',
    });
    expect(reply.status).toBe(404);
    expect(reply.headers.connection).toBe('close');
    expect(JSON.parse(reply.text)).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error' },
    });
    const bare = await post(mock.port, { messages: [] }).then(() =>
      request(mock.port, { path: '/v1/messages', body: '{}' }),
    );
    expect(bare.status).toBe(404);
    expect(mock.violations).toEqual([
      {
        seq: 1,
        kind: 'path',
        method: 'GET',
        target: '/api/claude_cli/bootstrap?entrypoint=<redacted>',
      },
      { seq: 2, kind: 'path', method: 'POST', target: '/v1/messages' },
    ]);
    expect(() => {
      mock.assertNoViolations();
    }).toThrow(/2 violation\(s\)\n#1 path: GET \/api\/claude_cli\/bootstrap/);
  });

  it('answers allowlisted extras without a handler with 404 and no violation', async () => {
    const mock = await start({
      allow: [{ method: 'POST', target: '/v1/messages/count_tokens?beta=true' }],
    });
    const reply = await request(mock.port, {
      path: '/v1/messages/count_tokens?beta=true',
      body: '{}',
    });
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.text)).toMatchObject({ error: { message: 'mock: no handler' } });
    expect(mock.requests).toHaveLength(1);
    mock.assertNoViolations();
  });

  it('refuses foreign Host headers and accepts localhost', async () => {
    const mock = await start();
    const foreign = await request(mock.port, { headers: { host: 'evil.example' }, body: '{}' });
    expect(foreign.status).toBe(403);
    const none = await exchange(
      mock.port,
      'POST /v1/messages?beta=true HTTP/1.0\r\nContent-Length: 2\r\n\r\n{}',
    );
    expect(none).toMatch(/^HTTP\/1\.1 403 /);
    const local = await request(mock.port, {
      headers: { host: `localhost:${String(mock.port)}` },
      body: '{"messages":[]}',
    });
    expect(local.status).toBe(200);
    expect(mock.violations).toEqual([
      { seq: 1, kind: 'host', method: 'POST', target: 'evil.example' },
      { seq: 2, kind: 'host', method: 'POST', target: '<none>' },
    ]);
  });

  it('refuses Upgrade requests', async () => {
    const mock = await start();
    const upgrade = (target: string): Promise<string> =>
      exchange(
        mock.port,
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${String(mock.port)}\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    expect(await upgrade('/socket?token=secret')).toMatch(/^HTTP\/1\.1 403 /);
    expect(await upgrade('ws://example.com/socket')).toMatch(/^HTTP\/1\.1 403 /);
    expect(mock.violations).toEqual([
      { seq: 1, kind: 'upgrade', method: 'GET', target: '/socket?token=<redacted>' },
      { seq: 2, kind: 'upgrade', method: 'GET', target: 'ws://example.com' },
    ]);
  });

  it('records malformed requests', async () => {
    const mock = await start();
    const response = await exchange(mock.port, 'NOT HTTP AT ALL\r\n\r\n');
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(mock.violations).toHaveLength(1);
    expect(mock.violations[0]).toMatchObject({
      kind: 'malformed-request',
      method: '-',
      target: '-',
    });
    expect(mock.violations[0]?.detail).toMatch(/^HPE_/);
  });

  it('handles client errors: resets close quietly, others are violations', () => {
    const trap = new EgressTrap();
    const socket = (writable: boolean) => {
      const calls: string[] = [];
      return {
        calls,
        writable,
        end: (data: string) => calls.push(`end:${data.slice(0, 12)}`),
        destroy: () => calls.push('destroy'),
      };
    };
    const reset = socket(true);
    handleClientError(trap, Object.assign(new Error('x'), { code: 'ECONNRESET' }), reset);
    const pipe = socket(true);
    handleClientError(trap, Object.assign(new Error('x'), { code: 'EPIPE' }), pipe);
    const eof = socket(true);
    handleClientError(trap, Object.assign(new Error('x'), { code: 'HPE_INVALID_EOF_STATE' }), eof);
    expect([reset.calls, pipe.calls, eof.calls]).toEqual([['destroy'], ['destroy'], ['destroy']]);
    expect(trap.total).toBe(0);
    const writable = socket(true);
    handleClientError(trap, new Error('no code'), writable);
    expect(writable.calls).toEqual(['end:HTTP/1.1 400']);
    const closed = socket(false);
    handleClientError(trap, Object.assign(new Error('x'), { code: 'HPE_X' }), closed);
    expect(closed.calls).toEqual(['destroy']);
    expect(trap.violations.map((violation) => violation.detail)).toEqual(['unknown', 'HPE_X']);
  });
});

describe('request body bounds', () => {
  it('accepts a body at the limit', async () => {
    const mock = await start({ maxBodyBytes: 15 });
    const body = '{"messages":[]}';
    expect(body).toHaveLength(15);
    expect((await request(mock.port, { body })).status).toBe(200);
    mock.assertNoViolations();
  });

  it('refuses a declared Content-Length over the limit without reading it', async () => {
    const mock = await start({ maxBodyBytes: 15 });
    const reply = await request(mock.port, { body: '{"messages":[1]}' });
    expect(reply.status).toBe(413);
    expect(mock.violations).toEqual([
      {
        seq: 1,
        kind: 'body-too-large',
        method: 'POST',
        target: '/v1/messages?beta=<redacted>',
        detail: 'limit 15 bytes',
      },
    ]);
    expect(mock.requests).toEqual([]);
  });

  it('refuses a chunked body once it passes the limit', async () => {
    const mock = await start({ maxBodyBytes: 15 });
    const response = await exchange(
      mock.port,
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: 127.0.0.1:${String(mock.port)}\r\n` +
        'Transfer-Encoding: chunked\r\n\r\n8\r\n{"messag\r\n8\r\nes":[1]}\r\n0\r\n\r\n',
    );
    expect(response).toMatch(/^HTTP\/1\.1 413 /);
    expect(mock.violations[0]?.kind).toBe('body-too-large');
    expect(mock.requests).toEqual([]);
  });

  it('drops a request whose client goes away mid-body', async () => {
    const mock = await start();
    const socket = net.createConnection({ host: '127.0.0.1', port: mock.port });
    socket.on('error', () => undefined);
    socket.write(
      `POST /v1/messages?beta=true HTTP/1.1\r\nHost: 127.0.0.1:${String(mock.port)}\r\n` +
        'Content-Length: 100\r\n\r\n{"mess',
    );
    await until(() => mock.openConnections === 1, 'the connection');
    socket.destroy();
    await until(() => mock.openConnections === 0, 'the server side to close');
    expect(mock.requests).toEqual([]);
    expect(mock.violations).toEqual([]);
    expect((await post(mock.port, { messages: [] })).status).toBe(200);
  });
});

describe('redactHeaders', () => {
  it('redacts credentials, joins repeated values and skips missing ones', () => {
    expect(
      redactHeaders({
        'X-Api-Key': 'k',
        authorization: 'a',
        'proxy-authorization': 'p',
        cookie: 'c',
        accept: ['a', 'b'],
        missing: undefined,
        'user-agent': 'claude-cli/2.1.296 (external, sdk-cli)',
      }),
    ).toEqual({
      'x-api-key': '<redacted>',
      authorization: '<redacted>',
      'proxy-authorization': '<redacted>',
      cookie: '<redacted>',
      accept: 'a, b',
      'user-agent': 'claude-cli/2.1.296 (external, sdk-cli)',
    });
  });
});
