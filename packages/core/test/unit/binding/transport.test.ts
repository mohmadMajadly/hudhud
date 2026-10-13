// The process transport (plan §1.6, W3-Z ruling 5, ADR-0008/0009/0010):
// framing of stdout, write errors, the graceful EOF (snapshot, then EOF;
// after the exit, the sweep of the survivors) and the hand-off to the
// platform ladders. Fake OS calls, fake clocks, a fake process: nothing real
// is spawned or killed.

import { describe, expect, it } from 'vitest';

import type { Clock } from '../../../src/binding/clock.js';
import { createProcessTransport, TransportWriteError } from '../../../src/binding/transport.js';
import type { LadderClock } from '../../../src/process/ladder/types.js';
import type { WindowsOsCalls } from '../../../src/process/ladder/windows.js';
import {
  ProcessStreamError,
  type HarnessProcess,
  type ProcessExit,
} from '../../../src/process/spawn.js';
import type { ProcessIdentity } from '../../../src/process/tree/types.js';
import {
  CLI,
  FakeWorld,
  HOST,
  identity,
  INIT,
  rec,
  runWithClock,
} from '../../process/ladder/fake-os.js';
import {
  drive,
  FakeClock as WinClock,
  fakeCim,
  fakeProcess,
} from '../../process/ladder/windows-support.js';

function clockOf(ladder: LadderClock): Clock {
  return {
    nowMs: () => ladder.now(),
    nowIso: () => new Date(ladder.now()).toISOString(),
    schedule: (ms, callback) => ladder.schedule(ms, callback),
  };
}

const encoder = new TextEncoder();

interface Fake extends HarnessProcess {
  readonly order: string[];
}

function fakeHarness(options: {
  readonly pid: number;
  readonly identity?: ProcessIdentity | null;
  readonly chunks?: readonly (Uint8Array | Error)[];
  readonly write?: (data: string | Uint8Array) => Promise<void>;
  readonly exited?: Promise<ProcessExit>;
  readonly hasExited?: () => boolean;
  readonly endStdin?: () => void;
  readonly kill?: () => boolean;
}): Fake {
  const order: string[] = [];
  const chunks = options.chunks ?? [];
  return {
    order,
    pid: options.pid,
    identity: Promise.resolve(
      options.identity === null || options.identity === undefined
        ? { identity: null, problem: 'read-failed' as const }
        : { identity: options.identity, problem: null },
    ),
    identitySource: 'linux-proc',
    write: options.write ?? (() => Promise.resolve()),
    endStdin: () => {
      order.push('eof');
      options.endStdin?.();
    },
    stdout: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          await Promise.resolve();
          if (chunk instanceof Error) throw chunk;
          yield chunk;
        }
      },
    },
    stderrTail: () => 'the tail',
    exited: options.exited ?? new Promise<ProcessExit>(() => undefined),
    get exitStatus() {
      return options.hasExited?.() === true ? { code: 0, signal: null } : null;
    },
    killViaHandle: options.kill ?? (() => false),
  };
}

describe('output', () => {
  it('frames stdout into lines, oversized and invalid lines, including a partial last line', async () => {
    const world = FakeWorld.standard();
    const transport = createProcessTransport({
      process: fakeHarness({
        pid: 1,
        chunks: [
          encoder.encode('{"a":1}\n{"b"'),
          encoder.encode(':2}\n0123456789\n'),
          new Uint8Array([0xff, 0x0a]),
          encoder.encode('tail'),
        ],
      }),
      os: world.os,
      maxLineBytes: 8,
    });
    const out: unknown[] = [];
    for await (const item of transport.output) out.push(item);
    expect(out).toEqual([
      // Byte counts as the framer reports them (without the LF).
      { type: 'line', text: '{"a":1}', bytes: 7 },
      { type: 'line', text: '{"b":2}', bytes: 7 },
      { type: 'line.oversized', bytes: 9 },
      { type: 'line.invalid-utf8', bytes: 1 },
      { type: 'line', text: 'tail', bytes: 4 },
    ]);
    expect(transport.pid).toBe(1);
    expect(transport.stderrTail()).toBe('the tail');
  });

  it('a stdout failure ends the iteration with that error', async () => {
    const transport = createProcessTransport({
      process: fakeHarness({ pid: 1, chunks: [encoder.encode('x\n'), new Error('pipe')] }),
      os: FakeWorld.standard().os,
    });
    const out: unknown[] = [];
    await expect(
      (async () => {
        for await (const item of transport.output) out.push(item);
      })(),
    ).rejects.toThrow('pipe');
    expect(out).toHaveLength(1);
  });
});

describe('write', () => {
  it.each([
    [new ProcessStreamError('stdin', 'failed', 'EPIPE'), 'EPIPE'],
    [new ProcessStreamError('stdin', 'ended', undefined), 'ENDED'],
    [new ProcessStreamError('stdin', 'failed', undefined), 'EIO'],
    [new Error('other'), 'EIO'],
  ])('maps %s to %s', async (error, code) => {
    const transport = createProcessTransport({
      process: fakeHarness({ pid: 1, write: () => Promise.reject(error) }),
      os: FakeWorld.standard().os,
    });
    const caught = await transport.write('x\n').catch((reason: unknown) => reason);
    expect(caught).toBeInstanceOf(TransportWriteError);
    expect(caught).toMatchObject({ code, cause: error });
  });

  it('writes through the process', async () => {
    const written: unknown[] = [];
    const transport = createProcessTransport({
      process: fakeHarness({
        pid: 1,
        write: (data) => {
          written.push(data);
          return Promise.resolve();
        },
      }),
      os: FakeWorld.standard().os,
    });
    await transport.write('a\n');
    expect(written).toEqual(['a\n']);
  });
});

/** host 100 -> CLI 201 (group 90) -> rg 500 (same group) and a tool group 300 {300, 301}. */
const RG = rec(500, 201, 90, '50', 'rg');
const TOOL = rec(300, 201, 300, '30');
const SLEEP = rec(301, 300, 300, '31');

function closeWorld(): { readonly world: FakeWorld; readonly proc: Fake } {
  const world = new FakeWorld([INIT, HOST, CLI, RG, TOOL, SLEEP], identity(CLI), CLI.pid);
  const proc = fakeHarness({
    pid: CLI.pid,
    identity: identity(CLI),
    exited: world.proc.exited.then(() => ({ code: 0, signal: null })),
    hasExited: () => world.proc.hasExited(),
    endStdin: () => {
      world.proc.endStdin();
    },
  });
  world.beforeRead = () => {
    proc.order.push('read');
  };
  return { world, proc };
}

describe('the graceful EOF and the sweep after the exit (W3-Z ruling 5)', () => {
  it('snapshots before EOF, then sweeps the survivors after the CLI exited by itself', async () => {
    const { world, proc } = closeWorld();
    const transport = createProcessTransport({ process: proc, os: world.os });
    transport.endInput({ graceful: true });
    transport.endInput({ graceful: true });
    await runWithClock(world.clock, Promise.resolve());
    expect(proc.order).toEqual(['read', 'eof']);
    world.remove(CLI.pid);
    expect(await transport.exited).toEqual({ code: 0, signal: null });
    const report = await transport.afterExit();
    expect(report).toMatchObject({ status: 'done' });
    expect(world.records.has(RG.pid)).toBe(false);
    expect(world.records.has(SLEEP.pid)).toBe(false);
    expect(world.records.has(HOST.pid)).toBe(true);
  });

  it('ends at once without a snapshot when not graceful, and then has nothing to sweep', async () => {
    const { world, proc } = closeWorld();
    const transport = createProcessTransport({ process: proc, os: world.os });
    transport.endInput({ graceful: false });
    expect(proc.order).toEqual(['eof']);
    expect(await transport.afterExit()).toBeNull();
  });

  it('without a verified identity there is no snapshot, but EOF still happens', async () => {
    const world = FakeWorld.standard();
    const proc = fakeHarness({ pid: CLI.pid, identity: null });
    const transport = createProcessTransport({ process: proc, os: world.os });
    transport.endInput({ graceful: true });
    await runWithClock(world.clock, Promise.resolve());
    expect(proc.order).toEqual(['eof']);
    expect(await transport.afterExit()).toEqual({ status: 'skipped', reason: 'no-snapshot' });
  });
});

describe('termination hands off to the platform ladder', () => {
  it('POSIX: runs the K1 ladder once; the sweep after a graceful EOF spares the signal target group', async () => {
    const { world, proc } = closeWorld();
    const transport = createProcessTransport({
      process: proc,
      os: world.os,
      clock: clockOf(world.clock),
    });
    transport.endInput({ graceful: true });
    await runWithClock(world.clock, Promise.resolve());
    let interrupts = 0;
    const request = {
      intent: 'close-timeout',
      initializePid: CLI.pid,
      interrupt: () => {
        interrupts += 1;
        return Promise.resolve('not-applicable' as const);
      },
    } as const;
    const ladder = transport.terminate(request);
    expect(transport.terminate(request)).toBe(ladder);
    const report = await runWithClock(world.clock, ladder);
    expect(report).toMatchObject({ intent: 'close-timeout', platform: 'posix' });
    expect(interrupts).toBe(1);
    expect(report?.signalTarget).toEqual(identity(CLI));
    expect(await transport.afterExit()).toMatchObject({ status: expect.any(String) as unknown });
  });

  it('Windows: runs the job ladder with the session job', async () => {
    const proc = fakeProcess(700, '1000');
    const harness = fakeHarness({
      pid: 700,
      identity: { pid: 700, startTime: '1000' },
      exited: proc.exited.then(() => ({ code: 1, signal: null })),
      hasExited: () => proc.hasExited(),
      endStdin: () => {
        proc.closeStdin();
      },
      kill: () => proc.terminate(),
    });
    const clock = new WinClock();
    const terminated: string[] = [];
    const os: WindowsOsCalls = {
      platform: 'win32',
      hostPid: 1,
      processTable: fakeCim(() => [{ pid: 700, ppid: 1, start: '1000' }]),
      terminate: {
        taskkillTree: () => Promise.resolve({ exitCode: 0 }),
        taskkillProcess: () => Promise.resolve({ exitCode: 0 }),
      },
    };
    const transport = createProcessTransport({
      process: harness,
      os,
      clock: clockOf(clock),
      job: {
        terminate: () => {
          terminated.push('job');
          proc.exit();
        },
      },
    });
    const report = await drive(
      clock,
      transport.terminate({
        intent: 'abort',
        initializePid: null,
        interrupt: () => Promise.resolve('acknowledged'),
      }),
    );
    expect(report).toMatchObject({ intent: 'abort', platform: 'win32' });
    expect(terminated).toEqual(['job']);
    expect(harness.order).toEqual(['eof']);
    // Without a job, TerminateProcess goes through the handle.
    const proc2 = fakeProcess(701, '1000');
    const harness2 = fakeHarness({
      pid: 701,
      identity: null,
      exited: proc2.exited.then(() => ({ code: 1, signal: null })),
      hasExited: () => proc2.hasExited(),
      kill: () => proc2.terminate(),
    });
    const clock2 = new WinClock();
    const transport2 = createProcessTransport({ process: harness2, os, clock: clockOf(clock2) });
    await drive(
      clock2,
      transport2.terminate({
        intent: 'abort',
        initializePid: null,
        interrupt: () => Promise.resolve('not-applicable'),
      }),
    );
    expect(proc2.calls).toContain('terminate:false');
  });
});
