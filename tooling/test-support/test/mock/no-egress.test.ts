/**
 * The mock never opens an outbound connection (plan §5.3 W1-T6). Every
 * outbound socket API of Node is patched to throw for the whole scripted
 * session; only the test's own client sockets, created through the original
 * `Socket#connect`, are let through.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startMockServer } from '../../src/mock/server.js';
import { b64, exchange, parseSse, post, type SocketFactory } from './client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('no outbound sockets', () => {
  it('serves a whole scripted session and traps egress without connecting anywhere', async () => {
    const attempts: string[] = [];
    const ours = new WeakSet<net.Socket>();
    // Re-applied to each allowed socket below, so taken as a plain value.
    const originalConnect: unknown = Object.getOwnPropertyDescriptor(
      net.Socket.prototype,
      'connect',
    )?.value;
    if (typeof originalConnect !== 'function') throw new Error('Socket#connect not found');
    const blocked = (name: string) => (): never => {
      attempts.push(name);
      throw new Error(`outbound connection attempted through ${name}`);
    };
    vi.spyOn(net, 'connect').mockImplementation(blocked('net.connect'));
    vi.spyOn(net, 'createConnection').mockImplementation(blocked('net.createConnection'));
    vi.spyOn(tls, 'connect').mockImplementation(blocked('tls.connect'));
    vi.spyOn(dgram, 'createSocket').mockImplementation(blocked('dgram.createSocket'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(blocked('fetch'));
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ): net.Socket {
      if (!ours.has(this)) blocked('net.Socket#connect')();
      return Reflect.apply(
        originalConnect as (...a: unknown[]) => unknown,
        this,
        args,
      ) as net.Socket;
    });

    // The patch is live.
    expect(() => net.connect(443, 'api.anthropic.com')).toThrow(/net\.connect/);
    expect(() => tls.connect(443, 'api.anthropic.com')).toThrow(/tls\.connect/);
    expect(() => new net.Socket().connect(443, 'api.anthropic.com')).toThrow(/Socket#connect/);
    attempts.length = 0;

    const factory: SocketFactory = (port) => {
      const socket = new net.Socket();
      ours.add(socket);
      return socket.connect(port, '127.0.0.1');
    };

    const mock = await startMockServer();
    try {
      const marker = `[[mock:bash cmd=${b64('echo hi')}]]`;
      const first = await post(
        mock.port,
        { model: 'm', stream: true, messages: [{ role: 'user', content: marker }] },
        factory,
      );
      const toolUse = parseSse(first.text).find(
        (event) =>
          event.event === 'content_block_start' &&
          (event.data['content_block'] as { type: string }).type === 'tool_use',
      );
      expect(toolUse).toBeDefined();
      const second = await post(
        mock.port,
        {
          model: 'm',
          messages: [
            { role: 'user', content: marker },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_mock_0001' }] },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_mock_0001', content: 'hi' }],
            },
            { role: 'system', content: '<total_tokens>5 tokens left</total_tokens>' },
          ],
        },
        factory,
      );
      expect(JSON.parse(second.text)).toMatchObject({
        content: [{ type: 'text', text: 'Tool finished. RESULT<<hi>>' }],
      });

      const connect = await exchange(
        mock.port,
        'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n',
        factory,
      );
      expect(connect).toMatch(/^HTTP\/1\.1 403 /);
      const proxied = await exchange(
        mock.port,
        'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n',
        factory,
      );
      expect(proxied).toMatch(/^HTTP\/1\.1 403 /);
      expect(mock.violations.map((violation) => violation.target)).toEqual([
        'api.anthropic.com:443',
        'http://example.com',
      ]);
    } finally {
      await mock.close();
    }
    expect(attempts).toEqual([]);
  });
});
