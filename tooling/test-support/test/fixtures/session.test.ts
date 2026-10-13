import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isFrame, RecordingSession } from '../../src/fixtures/session.js';
import type { OutRecord } from '../../src/fixtures/session.js';
import { createSandbox, testTempBase } from '../../src/launcher/sandbox.js';
import type { Sandbox } from '../../src/launcher/sandbox.js';
import { makeFakeCli, scopedPolicy } from '../launcher/fake-cli.js';
import type { FakeCli } from '../launcher/fake-cli.js';

let fake: FakeCli;
let root = '';
let sandbox: Sandbox;

beforeAll(async () => {
  fake = await makeFakeCli();
}, 120_000);

afterAll(async () => {
  await fake.dispose();
});

beforeEach(async () => {
  // Short on macOS too: the sandbox's socket path must fit (05 §13).
  root = await mkdtemp(path.join(testTempBase(process.platform, tmpdir()), 'hudhud-session-'));
  sandbox = await createSandbox({
    cli: fake.cli,
    mock: { url: 'http://127.0.0.1:47311' },
    testRoot: root,
    ancestorPolicy: scopedPolicy(root),
  });
});

afterEach(async () => {
  await sandbox.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function start(mode = 'normal', clock?: () => number): Promise<RecordingSession> {
  return RecordingSession.start(
    sandbox,
    { args: [fake.script], env: { FAKE_CLI_MODE: mode } },
    clock === undefined ? {} : { clock },
  );
}

describe('isFrame', () => {
  const rec = (v: OutRecord['v']): OutRecord => ({ t: 0, dir: 'out', v });

  it('matches type, subtype, request subtype and response subtype', () => {
    expect(isFrame(rec({ type: 'system', subtype: 'init' }), 'system')).toBe(true);
    expect(isFrame(rec({ type: 'system', subtype: 'init' }), 'system', 'init')).toBe(true);
    expect(
      isFrame(
        rec({ type: 'control_request', request: { subtype: 'can_use_tool' } }),
        'control_request',
        'can_use_tool',
      ),
    ).toBe(true);
    expect(
      isFrame(
        rec({ type: 'control_response', response: { subtype: 'success' } }),
        'control_response',
        'success',
      ),
    ).toBe(true);
    expect(isFrame(rec({ type: 'system', subtype: 'init' }), 'system', 'other')).toBe(false);
    expect(isFrame(rec({ type: 'system' }), 'result')).toBe(false);
    expect(isFrame(rec('plain'), 'system')).toBe(false);
    expect(isFrame(rec([1]), 'system')).toBe(false);
  });
});

describe('RecordingSession', () => {
  it('records stdin, stdout (JSON and plain), stderr, EOF and the exit in order', async () => {
    const session = await start();
    session.control('init_1', 'initialize', { hooks: null });
    const response = await session.waitType('control_response', 'success', 30_000);
    expect(response.t).toBeGreaterThanOrEqual(0);
    session.sendRaw('not json');
    await session.waitFor((r) => r.v === 'plain text: not json', 30_000, 'plain line');
    session.user('hello');
    await session.waitType('result', undefined, 30_000);
    const assistant = await session.waitType('assistant', undefined, 10);
    expect(assistant.v).toMatchObject({ type: 'assistant' });
    session.respond('req_1', { behavior: 'allow' });
    const exit = await session.stop(30_000);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(session.exit).toEqual(exit);
    const dirs = session.records.map((r) => r.dir);
    expect(dirs[0]).toBe('in');
    expect(dirs).toContain('err');
    expect(dirs.at(-2)).toBe('cmd');
    expect(dirs.at(-1)).toBe('exit');
    expect(session.records.find((r) => r.dir === 'in' && r.v === 'not json')).toBeDefined();
    expect(session.outputs()).toHaveLength(session.records.filter((r) => r.dir === 'out').length);
    expect(session.records.every((r) => Number.isInteger(r.t) && r.t >= 0)).toBe(true);
  }, 60_000);

  it('consumes each stdout record once across waits, including waits registered together', async () => {
    const session = await start();
    const first = session.waitType('system', undefined, 30_000);
    const second = session.waitType('system', undefined, 30_000);
    session.control('init_1', 'initialize');
    session.user('x');
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBe(b);
    expect([a.v, b.v].map((v) => (v as { subtype: string }).subtype)).toEqual([
      'background_tasks_changed',
      'init',
    ]);
    await session.waitType('result', undefined, 30_000);
    await session.stop(30_000);
  }, 60_000);

  it('times out a wait and reports a missing exit', async () => {
    const session = await start('hang');
    await expect(session.waitType('result', 'success', 50)).rejects.toThrow(
      /timeout after 50 ms waiting for result\/success/,
    );
    await expect(session.waitType('result', undefined, 20)).rejects.toThrow(/waiting for result$/);
    expect(await session.waitExit(20)).toBeUndefined();
    const exit = await session.stop(200);
    expect(exit.code === null || exit.signal !== null || exit.code !== 0).toBe(true);
    await session.stop(10);
    // An EPIPE on stdin (the CLI exited while a write was in flight) is
    // swallowed by the session; without its listener this emit would throw.
    expect(session.process.child.stdin.emit('error', new Error('write EPIPE'))).toBe(true);
  }, 60_000);

  it('uses an injected clock', async () => {
    let now = 1000;
    const session = await start('normal', () => (now += 2.5));
    session.user('x');
    await session.waitType('result', undefined, 30_000);
    await session.stop(30_000);
    const times = session.records.map((r) => r.t);
    expect(times[0]).toBe(2);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  }, 60_000);
});
