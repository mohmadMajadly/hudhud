// The assembled adapter end to end over the fake host (W5-T1): connect, a
// session's handshake, a turn, the graceful close with its sweep after the
// exit, and the registry's lifecycle. Nothing real runs.

import { describe, expect, it } from 'vitest';

import type { HudhudEvent } from '@hudhud/core';

import { connectWith } from '../../../src/connect.js';
import { BINARY, CLI_PID, FakeHost, LAUNCHER, PROJECT, settle, VERSION } from './fake-host.js';

async function collect(iterable: AsyncIterable<HudhudEvent>): Promise<HudhudEvent[]> {
  const out: HudhudEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('connect, create, ask, close', () => {
  it('runs one session through the whole pipeline', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    expect(harness.binary).toEqual({
      path: BINARY,
      version: VERSION,
      source: 'option',
      verification: {
        status: 'verified',
        method: 'sha256-manifest',
        mode: 'advisory',
        detail: `sha256 matches ${VERSION}`,
      },
    });
    expect(harness.compat).toMatchObject({
      harness: 'claude-code',
      version: VERSION,
      status: 'tested',
    });
    const session = await harness.sessions.create({ cwd: PROJECT });
    expect(session.info).toMatchObject({ pid: CLI_PID, version: VERSION, mode: 'create' });
    const events = collect(session.events());
    const result = await session.ask('hello');
    expect(result).toMatchObject({ outcome: 'completed', isError: false, text: 'done' });
    await session.close();
    await settle();
    const seen = await events;
    expect(seen[0]?.type).toBe('compat');
    expect(seen.at(-1)).toMatchObject({ type: 'session.terminated', outcome: 'closed' });
    expect(harness.registry.size).toBe(0);
    await harness[Symbol.asyncDispose]();
  });

  it('reports the requested path when it differs from the realpath (a launcher)', async () => {
    const fake = new FakeHost();
    fake.links.set(LAUNCHER, BINARY);
    const harness = await connectWith({ binaryPath: LAUNCHER }, fake.make);
    expect(harness.binary).toMatchObject({
      path: BINARY,
      requestedPath: LAUNCHER,
      source: 'option',
    });
    await harness[Symbol.asyncDispose]();
  });
});
