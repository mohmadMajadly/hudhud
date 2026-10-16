// The unstable raw tier (plan §2.6, ADR-0012 §8, L4): frames in both
// directions, raw control requests and frames gated by
// claudeCode.dangerouslyAllowRawControl and the outbound policies, spawn
// extras with the reserved flags and pinned variables refused, and the end
// of the session ending everything raw.

import { describe, expect, it } from 'vitest';

import {
  AbortError,
  ControlRequestError,
  InvalidOptionsError,
  OutboundFrameTooLargeError,
  SessionClosedError,
} from '@hudhudjs/core';
import { TransportWriteError, type HarnessTransport } from '@hudhudjs/core/binding';

import { connectWith } from '../../../src/connect.js';
import { RawChannel, type RawFrame } from '../../../src/raw-channel.js';
import { createSessionRaw, raw } from '../../../src/raw/session.js';
import { BINARY, captureEvents, diagnosticData, FakeHost, settle } from './fake-host.js';

async function harnessWith(
  fake: FakeHost,
  allow: boolean,
): Promise<Awaited<ReturnType<typeof connectWith>>> {
  return connectWith(
    { binaryPath: BINARY, claudeCode: { dangerouslyAllowRawControl: allow } },
    fake.make,
  );
}

function take(frames: AsyncIterable<RawFrame>, count: number): Promise<RawFrame[]> {
  return (async () => {
    const out: RawFrame[] = [];
    for await (const frame of frames) {
      out.push(frame);
      if (out.length === count) break;
    }
    return out;
  })();
}

describe('frames()', () => {
  it('delivers every frame in both directions, in order, with a gapless seq', async () => {
    const fake = new FakeHost();
    const harness = await harnessWith(fake, false);
    const session = await harness.sessions.create();
    const frames = take(raw(session).frames(), 4);
    await session.ask('hi');
    const seen = (await frames).filter((frame) => frame.kind === 'frame');
    expect(seen).toHaveLength(4);
    expect(seen.map((frame) => [frame.direction, (frame.frame as { type: string }).type])).toEqual([
      ['out', 'user'],
      ['in', 'system'],
      ['in', 'result'],
      ['in', 'system'],
    ]);
    expect(seen.map((frame) => frame.seq)).toEqual([1, 2, 3, 4]);
    expect(seen[0]?.bytes).toBe(JSON.stringify(seen[0]?.frame).length);
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('ends when the session ends; invalid limits are INVALID_OPTIONS', async () => {
    const fake = new FakeHost();
    const harness = await harnessWith(fake, false);
    const session = await harness.sessions.create();
    const rawSession = raw(session);
    expect(() => rawSession.frames({ maxEvents: 0 })).toThrow(InvalidOptionsError);
    const all = (async () => {
      const out: RawFrame[] = [];
      for await (const frame of rawSession.frames()) out.push(frame);
      return out;
    })();
    await session.close();
    // A close without turns writes nothing more; the iteration ends with the session.
    expect(await all).toEqual([]);
    await harness[Symbol.asyncDispose]();
  });

  it('a dropped stretch yields one explicit gap numbered as the first frame left out (Q8b)', async () => {
    const fake = new FakeHost();
    const harness = await harnessWith(fake, false);
    const session = await harness.sessions.create();
    const frames = raw(session).frames({ maxEvents: 2, overflow: 'drop-oldest-with-gap-marker' });
    const iterator = frames[Symbol.asyncIterator]();
    await session.ask('hi');
    const seen: RawFrame[] = [];
    for (let index = 0; index < 2; index += 1) seen.push((await iterator.next()).value as RawFrame);
    const [gap, last] = seen;
    expect(gap).toMatchObject({ kind: 'gap', seq: 1 });
    expect(gap?.kind === 'gap' ? gap.dropped : 0).toBeGreaterThan(0);
    // The frame after the gap continues right after the dropped stretch.
    expect(last?.seq).toBe((gap?.seq ?? 0) + (gap?.kind === 'gap' ? gap.dropped : 0));
    expect(last).toMatchObject({ kind: 'frame' });
    await iterator.return?.();
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it("overflow under 'error' fails that subscriber; its signal aborts it", async () => {
    const fake = new FakeHost();
    const harness = await harnessWith(fake, false);
    const session = await harness.sessions.create({
      events: { signal: new AbortController().signal },
    });
    const strict = raw(session).frames({ maxEvents: 1 })[Symbol.asyncIterator]();
    const controller = new AbortController();
    const aborted = raw(session).frames({ signal: controller.signal })[Symbol.asyncIterator]();
    controller.abort('done');
    await session.ask('hi');
    // The frame that fitted is delivered, then the overflow ends that subscriber.
    expect((await strict.next()).value).toMatchObject({ seq: 1 });
    await expect(strict.next()).rejects.toMatchObject({ code: 'SUBSCRIBER_OVERFLOW' });
    await expect(aborted.next()).rejects.toBeInstanceOf(AbortError);
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('raw() refuses anything but a session of this adapter', () => {
    expect(() => raw({} as never)).toThrow(InvalidOptionsError);
  });
});

describe('raw control (ADR-0012 §8)', () => {
  it('is refused without claudeCode.dangerouslyAllowRawControl', async () => {
    const fake = new FakeHost();
    const harness = await harnessWith(fake, false);
    const session = await harness.sessions.create();
    const rawSession = raw(session);
    await expect(rawSession.controlRequest('get_context_usage')).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
      details: { rule: 'raw-control-disabled' },
    });
    await expect(rawSession.writeFrame({ type: 'keep_alive' })).rejects.toMatchObject({
      details: { rule: 'raw-control-disabled' },
    });
    expect(fake.cli.written.every((frame) => frame['type'] !== 'keep_alive')).toBe(true);
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('with the opt-in: answers, errors, timeouts, aborts and the outbound policies', async () => {
    const fake = new FakeHost({
      script: {
        onWrite: (frame, cli) => {
          const request = frame['request'] as Record<string, unknown> | undefined;
          if (request?.['subtype'] === 'fail_me') {
            cli.emit({
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: frame['request_id'],
                error: 'not supported',
              },
            });
            return true;
          }
          // `silent` is never answered.
          return request?.['subtype'] === 'silent' ? true : undefined;
        },
      },
    });
    const harness = await harnessWith(fake, true);
    const session = await harness.sessions.create();
    const rawSession = raw(session);
    expect(await rawSession.controlRequest('get_context_usage', { verbose: true })).toEqual({});
    const sent = fake.cli.written.at(-1);
    expect(sent).toEqual({
      type: 'control_request',
      request_id: 'hudhud-raw-1',
      request: { subtype: 'get_context_usage', verbose: true },
    });
    const failed = await rawSession.controlRequest('fail_me').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ControlRequestError);
    expect(failed).toMatchObject({ details: { cliError: 'not supported' } });
    const timing = rawSession.controlRequest('silent', undefined, { timeoutMs: 500 });
    await settle();
    fake.clock.advance(500);
    await expect(timing).rejects.toMatchObject({
      code: 'CONTROL_REQUEST_FAILED',
      details: { cause: 'timeout', timeoutMs: 500 },
    });
    const controller = new AbortController();
    const aborting = rawSession.controlRequest('silent', undefined, { signal: controller.signal });
    controller.abort('stop');
    await expect(aborting).rejects.toBeInstanceOf(AbortError);
    await expect(
      rawSession.controlRequest('silent', undefined, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(AbortError);
    await expect(
      rawSession.controlRequest('silent', undefined, { timeoutMs: 0 }),
    ).rejects.toMatchObject({ details: { rule: 'timeout' } });
    await expect(rawSession.controlRequest('initialize')).rejects.toMatchObject({
      details: { rule: 'raw-initialize' },
    });
    await expect(rawSession.controlRequest(42 as never)).rejects.toMatchObject({
      details: { rule: 'raw-subtype-empty' },
    });
    await expect(rawSession.controlRequest('update_settings')).rejects.toMatchObject({
      details: { rule: 'raw-config-write' },
    });
    await expect(
      rawSession.writeFrame({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'x',
          response: { behavior: 'allow', updatedPermissions: [{ destination: 'userSettings' }] },
        },
      }),
    ).rejects.toMatchObject({ details: { rule: 'raw-config-write-permissions' } });
    await rawSession.writeFrame({ type: 'keep_alive' });
    expect(fake.cli.written.at(-1)).toEqual({ type: 'keep_alive' });
    // A silent request still pending when the session ends is SESSION_CLOSED.
    const pending = rawSession.controlRequest('silent');
    await settle();
    await session.close();
    await expect(pending).rejects.toBeInstanceOf(SessionClosedError);
    await expect(rawSession.writeFrame({ type: 'keep_alive' })).rejects.toBeInstanceOf(
      SessionClosedError,
    );
    await harness[Symbol.asyncDispose]();
  });

  it('every pending control request rejects with SESSION_CLOSED when the session ends (Q8a)', async () => {
    const fake = new FakeHost({
      script: {
        // Raw requests are never answered.
        onWrite: (frame) =>
          frame['type'] === 'control_request' &&
          String(frame['request_id']).startsWith('hudhud-raw-')
            ? true
            : undefined,
      },
    });
    const harness = await harnessWith(fake, true);
    for (const end of ['close', 'dispose'] as const) {
      const session = await harness.sessions.create();
      const rawSession = raw(session);
      const pending = [
        rawSession.controlRequest('one'),
        rawSession.controlRequest('two', undefined, { signal: new AbortController().signal }),
      ].map((promise) => promise.catch((error: unknown) => error));
      await settle();
      if (end === 'close') await session.close();
      else await session[Symbol.asyncDispose]();
      for (const error of await Promise.all(pending)) {
        expect(error).toBeInstanceOf(SessionClosedError);
      }
    }
    await harness[Symbol.asyncDispose]();
  });

  it('the outbound cap applies: nothing is written', async () => {
    const fake = new FakeHost();
    const harness = await harnessWith(fake, true);
    const session = await harness.sessions.create({ maxOutboundFrameBytes: 1_048_576 });
    const count = fake.cli.written.length;
    await expect(
      raw(session).writeFrame({ type: 'user', text: 'x'.repeat(1_048_576) }),
    ).rejects.toBeInstanceOf(OutboundFrameTooLargeError);
    expect(fake.cli.written).toHaveLength(count);
    await session.close();
    await harness[Symbol.asyncDispose]();
  });
});

describe('createSessionRaw', () => {
  it('appends extraArgs, applies extraEnv and lists both in the posture by name', async () => {
    const fake = new FakeHost();
    const harness = await harnessWith(fake, false);
    const captured = captureEvents(harness);
    const session = await createSessionRaw(harness, {
      raw: { extraArgs: ['--debug=api', 'value'], extraEnv: { HOME: '/other', MY_FLAG: 'on' } },
    });
    expect(fake.cli.spec.args.slice(-2)).toEqual(['--debug=api', 'value']);
    expect(fake.cli.spec.env).toMatchObject({ HOME: '/other', MY_FLAG: 'on' });
    await session.close();
    const posture = diagnosticData(captured[0], 'security.posture')['entries'];
    expect(posture).toContainEqual(
      expect.objectContaining({ setting: 'raw.extraArgs', value: ['--debug'] }),
    );
    expect(posture).toContainEqual(
      expect.objectContaining({ setting: 'raw.extraEnv', value: ['HOME', 'MY_FLAG'] }),
    );
    expect(JSON.stringify(posture)).not.toContain('/other');
    await harness[Symbol.asyncDispose]();
  });

  it('takes extras in a null-prototype object', async () => {
    const fake = new FakeHost();
    const harness = await harnessWith(fake, false);
    const extras = Object.assign(Object.create(null) as object, { extraArgs: ['--debug'] });
    const session = await createSessionRaw(harness, { raw: extras });
    expect(fake.cli.spec.args.at(-1)).toBe('--debug');
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('extraEnv replaces a variable of any case on win32', async () => {
    const fake = new FakeHost({
      platform: 'win32',
      cwd: 'C:\\work',
      env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows' },
    });
    const harness = await harnessWith(fake, false);
    const session = await createSessionRaw(harness, { raw: { extraEnv: { PATH: 'C:\\tools' } } });
    expect(fake.cli.spec.env['PATH']).toBe('C:\\tools');
    expect(fake.cli.spec.env).not.toHaveProperty('Path');
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it.each([
    [{ extraArgs: ['--permission-mode=auto'] }, 'reserved-flag'],
    [{ extraArgs: ['--dangerously-skip-permissions'] }, 'reserved-flag'],
    [{ extraArgs: ['--project-config-root=/x'] }, 'reserved-flag'],
    [{ extraArgs: [1] }, 'raw-options'],
    [{ extraArgs: 'x' }, 'raw-options'],
    [{ extraEnv: { CLAUDE_CONFIG_DIR: '/x' } }, 'env-pinned'],
    [{ extraEnv: { A: 1 } }, 'raw-options'],
    [{ extraEnv: [] }, 'raw-options'],
    [{ other: true }, 'raw-options'],
    ['nope', 'raw-options'],
  ])('refuses %j before anything runs', async (extras, rule) => {
    const fake = new FakeHost();
    const harness = await harnessWith(fake, false);
    const before = fake.log.length;
    await expect(createSessionRaw(harness, { raw: extras as never })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
      details: { rule },
    });
    expect(fake.log.slice(before)).toEqual([]);
    await harness[Symbol.asyncDispose]();
  });

  it('refuses a Harness that is not this adapter’s and options that are not an object', async () => {
    await expect(createSessionRaw({} as never, { raw: {} })).rejects.toMatchObject({
      details: { rule: 'raw-harness' },
    });
    const fake = new FakeHost();
    const harness = await harnessWith(fake, false);
    await expect(createSessionRaw(harness, 'x' as never)).rejects.toMatchObject({
      details: { rule: 'not-an-object' },
    });
    await harness[Symbol.asyncDispose]();
  });
});

describe('RawChannel on its own', () => {
  function channel(): RawChannel {
    return new RawChannel({
      clock: new FakeHost().clock,
      maxOutboundBytes: 1_048_576,
      policy: { allowRawControl: true, allowConfigWrites: false },
      defaults: {},
    });
  }

  it('a write before the channel was wrapped, or that the transport fails, is SESSION_CLOSED', async () => {
    const unwrapped = channel();
    await expect(unwrapped.writeFrame({ type: 'keep_alive' })).rejects.toBeInstanceOf(
      SessionClosedError,
    );
    const failing = channel();
    failing.wrap({
      write: () => Promise.reject(new Error('plain')),
    } as unknown as HarnessTransport);
    await expect(failing.writeFrame({ type: 'keep_alive' })).rejects.toMatchObject({
      code: 'SESSION_CLOSED',
      message: "The session's input is closed (EIO).",
    });
    failing.close();
    failing.close();
  });

  it('a failed transport write names its errno', async () => {
    const tap = channel();
    tap.wrap({
      write: () => Promise.reject(new TransportWriteError('EPIPE')),
    } as unknown as HarnessTransport);
    await expect(tap.writeFrame({ type: 'keep_alive' })).rejects.toMatchObject({
      message: "The session's input is closed (EPIPE).",
    });
    await expect(tap.controlRequest('x', undefined, {})).rejects.toBeInstanceOf(SessionClosedError);
  });

  it('settles answers without a body as null and error answers without text', async () => {
    const tap = channel();
    const answers: string[] = [];
    let push: ((line: string) => void) | undefined;
    const wrapped = tap.wrap({
      pid: 1,
      write: (line: string) => {
        const id = (JSON.parse(line) as { request_id: string }).request_id;
        answers.push(id);
        const replies: Readonly<Record<string, string>> = {
          'hudhud-raw-1': `{"type":"control_response","response":{"subtype":"success","request_id":"${id}"}}`,
          'hudhud-raw-2': `{"type":"control_response","response":{"subtype":"error","request_id":"${id}","error":"${'e'.repeat(300)}"}}`,
          'hudhud-raw-3': `{"type":"control_response","response":{"subtype":"error","request_id":"${id}"}}`,
        };
        push?.(replies[id] ?? '');
        return Promise.resolve();
      },
      output: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const line = await new Promise<string>((resolve) => {
              push = resolve;
            });
            yield { type: 'line', text: line, bytes: line.length };
          }
        },
      },
    } as unknown as HarnessTransport);
    const reader = wrapped.output[Symbol.asyncIterator]();
    const reading = (async () => {
      for (;;) await reader.next();
    })();
    void reading;
    await settle();
    expect(await tap.controlRequest('a', undefined, {})).toBeNull();
    await settle();
    const error = await tap.controlRequest('b', undefined, {}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CONTROL_REQUEST_FAILED' });
    expect((error as { details: { cliError: string } }).details.cliError).toHaveLength(257);
    await settle();
    await expect(tap.controlRequest('c', undefined, {})).rejects.toMatchObject({
      details: { cliError: 'error' },
    });
    tap.close();
    void reader.return?.();
  });

  it('skips lines that are not JSON objects and answers no foreign response', async () => {
    const tap = channel();
    const lines = [
      { type: 'line', text: 'not json', bytes: 8 },
      {
        type: 'line',
        text: '{"type":"control_response","response":{"request_id":"other"}}',
        bytes: 10,
      },
      { type: 'line', text: '{"type":"control_response"}', bytes: 10 },
      { type: 'stderr.line', text: 'x' },
    ] as const;
    const wrapped = tap.wrap({
      pid: 1,
      output: {
        async *[Symbol.asyncIterator]() {
          for (const line of lines) {
            await Promise.resolve();
            yield line;
          }
        },
      },
    } as unknown as HarnessTransport);
    const frames = take(tap.frames(), 2);
    const seen: unknown[] = [];
    for await (const item of wrapped.output) seen.push(item);
    expect(seen).toEqual(lines);
    expect((await frames).map((frame) => frame.seq)).toEqual([1, 2]);
  });
});
