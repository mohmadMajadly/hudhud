import { afterEach, describe, expect, it } from 'vitest';

import { ProcessLedger } from '../src/ps.js';
import { createSandbox, mockMarker, sandboxEnv, SESSION_ARGS } from '../src/sandbox.js';
import {
  CliSession,
  field,
  frameKind,
  runScenario,
  SHUTDOWN_GRACE_MS,
  type SessionContext,
} from '../src/session.js';
import { clearSessions, SimCli, SimHost, type CliFlags, type SimChild } from './sim.js';

afterEach(() => {
  clearSessions();
});

function setup(flags: CliFlags = {}): { sim: SimHost; context: SessionContext } {
  const sim = new SimHost({ cli: (child, host) => new SimCli(child, host, flags) });
  return { sim, context: { host: sim, ledger: new ProcessLedger(sim), binary: '/cache/claude' } };
}

async function open(sim: SimHost): Promise<{ session: CliSession; child: SimChild }> {
  const sandbox = await createSandbox(sim.fs, sim.tmpdir);
  const mock = await sim.startMock();
  const child = sim.spawn('/cache/claude', SESSION_ARGS, {
    cwd: sandbox.work,
    env: sandboxEnv({ sandbox, mockUrl: mock.url, user: 'runner' }),
  }) as SimChild;
  return { session: new CliSession(sim, child), child };
}

describe('frame helpers', () => {
  it('reads fields and kinds defensively', () => {
    expect(field({ a: 1 }, 'a')).toBe(1);
    expect(field([1], 'a')).toBeUndefined();
    expect(field(null, 'a')).toBeUndefined();
    expect(frameKind({ at: 0, value: { type: 'system', subtype: 'init' } })).toBe('system/init');
    expect(frameKind({ at: 0, value: { type: 'result', subtype: 3 } })).toBe('result');
  });
});

describe('CliSession', () => {
  it('frames stdout, counts noise, keeps stderr and answers can_use_tool with allow', async () => {
    const { sim } = setup({ noise: true });
    const { session, child } = await open(sim);
    expect(session.startedAt).toBeUndefined();
    session.initialize();
    expect(session.startedAt).toBe(sim.time);
    session.user(`${mockMarker('bash', { cmd: Buffer.from('echo hi').toString('base64') })} go`);
    expect(session.toolRunning).toBe(true);
    const result = await session.waitKind('result', 5_000);
    expect(field(result?.value, 'result')).toBe('Tool finished. RESULT<<hi>>');
    expect(session.toolRunning).toBe(false);
    expect(session.watchdogInput().turnOpen).toBe(false);
    expect(session.findKind('control_response')).toBeDefined();
    expect(session.nonFrames).toBe(2);
    expect(session.stderr).toBe('warning: simulated\n');
    child.emitRaw('\xff\n');
    child.emitRaw(`${'{"type":"x"}'.padEnd(10, ' ')}\n`);
    child.emitRaw(new TextDecoder().decode(new Uint8Array([0x7b])) + '\n');
    expect(session.nonFrames).toBe(4);
    expect(session.frames.at(-1)?.value).toEqual({ type: 'x' });
    expect(session.pid).toBe(child.pid);
  });

  it('counts an invalid UTF-8 line as noise and caps stderr', async () => {
    const { sim } = setup();
    const { session, child } = await open(sim);
    const bytes = new Uint8Array([0xc3, 0x28, 0x0a]);
    // Through the raw listener path: invalid UTF-8 is reported by the framer.
    (child as unknown as { stdout: ((chunk: Uint8Array) => void)[] }).stdout.forEach((listener) => {
      listener(bytes);
    });
    expect(session.nonFrames).toBe(1);
    child.emitStderr('e'.repeat(70 * 1024));
    child.emitStderr('more');
    expect(session.stderr).toHaveLength(64 * 1024);
  });

  it('waits with timeouts on the injected clock', async () => {
    const { sim } = setup({ silent: true });
    const { session } = await open(sim);
    session.initialize();
    const start = sim.time;
    expect(await session.waitKind('result', 1_000)).toBeUndefined();
    expect(sim.time - start).toBeGreaterThanOrEqual(1_000);
    expect(await session.waitExit(500)).toBeUndefined();
    expect(session.watchdogInput()).toEqual({
      now: sim.time,
      startedAt: start,
      lastFrameAt: undefined,
      turnOpen: false,
    });
  });

  it('stops waiting when the process exits', async () => {
    const { sim } = setup({ silent: true });
    const { session, child } = await open(sim);
    sim.at(300, () => {
      child.exit(1, null);
    });
    const start = sim.time;
    expect(await session.waitFor(() => false, 60_000)).toBeUndefined();
    expect(sim.time - start).toBeLessThan(1_000);
    expect(session.exit).toEqual({ code: 1, signal: null, error: undefined });
    expect(await session.waitExit(10)).toEqual(session.exit);
  });

  it('reports the watchdog view before the first input', async () => {
    const { sim } = setup();
    const { session } = await open(sim);
    expect(session.watchdogInput().startedAt).toBe(session.spawnedAt);
  });
});

describe('shutdown ladder', () => {
  it.each([
    [{}, 'eof'],
    [{ ignoreEof: true }, 'sigterm'],
    [{ ignoreEof: true, ignoreTerm: true }, 'sigkill'],
  ] as const)('%o ends by %s and sweeps the tree', async (flags, endedBy) => {
    const { sim, context } = setup(flags);
    const { session } = await open(sim);
    session.identity = await context.ledger.register(session.pid ?? 0);
    const report = await session.shutdown(context.ledger);
    expect(report.endedBy).toBe(endedBy);
    expect(report.sweep.survivors).toEqual([]);
    expect(sim.descendantsOf(sim.pid)).toEqual([]);
  });

  it('reports an exited process without signalling it', async () => {
    const { sim, context } = setup();
    const { session, child } = await open(sim);
    child.exit(0, null);
    await sim.sleep(1);
    const report = await session.shutdown(context.ledger);
    expect(report).toEqual({
      exit: { code: 0, signal: null, error: undefined },
      endedBy: 'exited',
      sweep: { signalled: [], survivors: [] },
    });
  });

  it('does not signal a child without a pid', async () => {
    const { sim, context } = setup();
    sim.spawnFails = true;
    const { session } = await open(sim);
    expect(session.pid).toBeUndefined();
    await sim.sleep(1);
    expect((await session.shutdown(context.ledger)).endedBy).toBe('exited');
    expect(sim.signals).toEqual([]);
  });

  it('gives up signalling a pid that never exits after EOF', async () => {
    const { sim, context } = setup({ ignoreEof: true, ignoreTerm: true });
    const { session } = await open(sim);
    const start = sim.time;
    const report = await session.shutdown(context.ledger);
    expect(report.endedBy).toBe('sigkill');
    expect(sim.time - start).toBeGreaterThanOrEqual(2 * SHUTDOWN_GRACE_MS);
  });
});

describe('runScenario', () => {
  it('runs the body with a sandbox, the mock and the CLI, then shuts down and closes the mock', async () => {
    const { sim, context } = setup();
    let prepared = '';
    const outcome = await runScenario(
      context,
      {
        base: '/custom',
        tmpName: 'tmpx',
        apiKey: false,
        args: ['--resume=x'],
        cwd: (sandbox) => `${sandbox.root}/elsewhere`,
        prepare: (sandbox) => {
          prepared = sandbox.root;
          return Promise.resolve();
        },
      },
      async ({ session, sandbox, mock, cwd }) => {
        session.initialize();
        await session.waitKind('control_response', 1_000);
        return { root: sandbox.root, tmp: sandbox.tmp, cwd, url: mock.url };
      },
    );
    expect(outcome.value.root).toBe(prepared);
    expect(outcome.value.tmp).toBe(`${prepared}/tmpx`);
    expect(outcome.value.cwd).toBe(`${prepared}/elsewhere`);
    const child = sim.spawned[0];
    expect(child?.args).toEqual([...SESSION_ARGS, '--resume=x']);
    expect(child?.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(outcome.shutdown.endedBy).toBe('eof');
    expect(outcome.violations).toBe(0);
    expect(sim.mocks[0]?.closed).toBe(true);
  });

  it('defaults to a fresh sandbox under the host temp dir and reuses a given sandbox', async () => {
    const { sim, context } = setup();
    const first = await runScenario(context, {}, ({ sandbox, cwd }) =>
      Promise.resolve({ sandbox, cwd }),
    );
    expect(first.value.sandbox.root.startsWith(`${sim.tmpdir}/hhg-`)).toBe(true);
    expect(first.value.cwd).toBe(first.value.sandbox.work);
    expect(sim.spawned[0]?.env['ANTHROPIC_API_KEY']).toBeDefined();
    const second = await runScenario(context, { sandbox: first.value.sandbox }, ({ sandbox }) =>
      Promise.resolve(sandbox),
    );
    expect(second.value).toBe(first.value.sandbox);
  });

  it('shuts the CLI down and closes the mock when the body throws', async () => {
    const { sim, context } = setup({ ignoreEof: true });
    await expect(
      runScenario(context, {}, () => Promise.reject(new Error('body failed'))),
    ).rejects.toThrow('body failed');
    expect(sim.descendantsOf(sim.pid)).toEqual([]);
    expect(sim.mocks[0]?.closed).toBe(true);
  });

  it('works when the spawn fails (no identity to register)', async () => {
    const { sim, context } = setup();
    sim.spawnFails = true;
    const outcome = await runScenario(context, {}, ({ session }) =>
      Promise.resolve(session.identity),
    );
    expect(outcome.value).toBeNull();
  });
});
