// Per-session containment (plan §6.4, K2): assignment through the spawn's
// start-time reader before the handle exists, fallback with a diagnostic,
// the job for the Windows ladder, the close after the exit.

import process from 'node:process';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  createSessionContainment,
  type ContainedProcess,
} from '../../../src/process/containment/session.js';
import {
  loadJobAddon,
  type JobAddon,
  type JobAddonLoad,
  type JobObject,
} from '../../../src/process/containment/win32-job.js';
import { DEFAULT_LADDER_TIMING } from '../../../src/process/ladder/types.js';
import { runWindowsLadder } from '../../../src/process/ladder/windows.js';
import type { StartTimeReader } from '../../../src/process/spawn.js';
import { ChildTracker } from '../../unit/process/spawn-support.js';
import { drive, FakeClock, fakeCim, fakeProcess } from '../ladder/windows-support.js';
import { FakeJobAddon, fakeDeps } from './fake-addon.js';

const UNAVAILABLE: JobAddonLoad = { status: 'unavailable', reason: 'not-windows', detail: 'linux' };

/** A fallback reader that records the pids it was asked for. */
function fallbackReader(
  value: string | null = '999',
): StartTimeReader & { readonly asked: number[] } {
  const asked: number[] = [];
  return {
    source: 'win32-cim',
    asked,
    read(pid) {
      asked.push(pid);
      return Promise.resolve(value);
    },
  };
}

function loadedWith(fake: FakeJobAddon): JobAddonLoad {
  const load = loadJobAddon(fakeDeps(fake.exports()));
  expect(load.status).toBe('loaded');
  return load;
}

/** A process stand-in whose exit the test controls. */
function processStub(pid = 4242, exited = false): ContainedProcess & { exit(): void } {
  let exit = (): void => undefined;
  const done = new Promise<null>((resolve) => {
    exit = () => {
      resolve(null);
    };
  });
  const stub = {
    pid,
    exitStatus: exited ? { code: 0, signal: null } : null,
    exited: done,
    exit,
  };
  return stub;
}

describe('createSessionContainment', () => {
  it('assigns synchronously inside read and reports the addon start time in microseconds', async () => {
    const fake = new FakeJobAddon({ processes: new Map([[4242, '133000000001234567']]) });
    const fallback = fallbackReader();
    const containment = createSessionContainment(loadedWith(fake), fallback);
    expect(containment.startTime.source).toBe('win32-cim');

    const read = containment.startTime.read(4242);
    // Done before the promise settles: the job exists and holds the pid.
    expect(fake.jobs[0]?.pids.has(4242)).toBe(true);
    await expect(read).resolves.toBe('13300000000123456');
    // A second read of the same pid neither assigns again nor asks the table.
    await expect(containment.startTime.read(4242)).resolves.toBe('13300000000123456');
    expect(fake.jobs).toHaveLength(1);
    expect(fallback.asked).toEqual([]);

    const proc = processStub();
    const result = containment.attach(proc);
    expect(result.containment).toBe('job');
    expect(result.diagnostics).toEqual([]);
    expect(result.job).not.toBeNull();

    // The job stays open until the process exited, then it is closed.
    let released = false;
    void result.released.then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(fake.jobs[0]?.closed).toBe(false);
    proc.exit();
    await expect(result.released).resolves.toBe('closed');
    expect(fake.jobs[0]?.closed).toBe(true);
  });

  it('hands the ladder a job it can terminate', async () => {
    const fake = new FakeJobAddon();
    const containment = createSessionContainment(loadedWith(fake), fallbackReader());
    await containment.startTime.read(4242);
    const { job } = containment.attach(processStub());
    job?.terminate();
    expect(fake.jobs[0]?.terminations).toBe(1);
    expect(fake.processes.has(4242)).toBe(false);
  });

  it('reads through the fallback and reports best-effort without a loaded addon, with no diagnostic', async () => {
    const fallback = fallbackReader('777');
    const containment = createSessionContainment(UNAVAILABLE, fallback);
    await expect(containment.startTime.read(5)).resolves.toBe('777');
    expect(fallback.asked).toEqual([5]);
    const result = containment.attach(processStub(5));
    expect(result).toMatchObject({ containment: 'best-effort', job: null, diagnostics: [] });
    await expect(result.released).resolves.toBe('no-job');
  });

  it('keeps the session when createJob fails: best-effort plus containment.fallback (K2)', async () => {
    const fake = new FakeJobAddon({ fail: { createJob: 1455 } });
    const fallback = fallbackReader('888');
    const containment = createSessionContainment(loadedWith(fake), fallback);
    await expect(containment.startTime.read(4242)).resolves.toBe('888');
    const result = containment.attach(processStub());
    expect(result.containment).toBe('best-effort');
    expect(result.job).toBeNull();
    expect(result.diagnostics).toEqual([
      {
        code: 'containment.fallback',
        message:
          'job containment failed (create-job: WIN32_1455); the session continues with best-effort containment',
        data: { step: 'create-job', code: 'WIN32_1455' },
      },
    ]);
    await expect(result.released).resolves.toBe('no-job');
  });

  it('keeps the session when the assignment fails and closes that job only after the exit', async () => {
    const fake = new FakeJobAddon({ fail: { assignProcess: 5 } });
    const containment = createSessionContainment(loadedWith(fake), fallbackReader('888'));
    await expect(containment.startTime.read(4242)).resolves.toBe('888');
    const proc = processStub();
    const result = containment.attach(proc);
    expect(result).toMatchObject({ containment: 'best-effort', job: null });
    expect(result.diagnostics.map((diagnostic) => diagnostic.data)).toEqual([
      { step: 'assign-process', code: 'WIN32_5' },
    ]);
    expect(fake.jobs[0]?.closed).toBe(false);
    proc.exit();
    await expect(result.released).resolves.toBe('closed');
    expect(fake.jobs[0]?.closed).toBe(true);
  });

  it('reports a failed close after the exit', async () => {
    const fake = new FakeJobAddon({ fail: { closeJob: 6 } });
    const containment = createSessionContainment(loadedWith(fake), fallbackReader());
    await containment.startTime.read(4242);
    const proc = processStub();
    const result = containment.attach(proc);
    proc.exit();
    await expect(result.released).resolves.toBe('close-failed');
  });

  it('uses ERR_JOB_ADDON for a failure that is not a JobAddonError', async () => {
    const job: JobObject = {
      closed: false,
      assign: () => {
        throw new Error('plain');
      },
      terminate: () => undefined,
      listPids: () => [],
      close: () => undefined,
    };
    const addon: JobAddon = {
      version: '1',
      file: 'C:\\x.node',
      createJob: () => job,
      processTimes: (pid) => ({ pid, startTime: '1' }),
    };
    const containment = createSessionContainment({ status: 'loaded', addon }, fallbackReader());
    await containment.startTime.read(1);
    expect(containment.attach(processStub(1)).diagnostics[0]?.data).toEqual({
      step: 'assign-process',
      code: 'ERR_JOB_ADDON',
    });
  });

  it('assigns at attach when the reader did not run', async () => {
    const fake = new FakeJobAddon();
    const containment = createSessionContainment(loadedWith(fake), fallbackReader());
    const result = containment.attach(processStub());
    expect(result.containment).toBe('job');
    expect(fake.jobs[0]?.pids.has(4242)).toBe(true);
    // The reader then serves the identity from that assignment.
    await expect(containment.startTime.read(4242)).resolves.toBe('13300000000123456');
  });

  it('never assigns a process that already exited when the reader did not run', () => {
    const fake = new FakeJobAddon();
    const containment = createSessionContainment(loadedWith(fake), fallbackReader());
    const result = containment.attach(processStub(4242, true));
    expect(result.containment).toBe('best-effort');
    expect(result.diagnostics.map((diagnostic) => diagnostic.data)).toEqual([
      { step: 'exited', code: 'exited' },
    ]);
    expect(fake.jobs).toHaveLength(0);
    // Without an addon an exited process gets no diagnostic.
    const plain = createSessionContainment(UNAVAILABLE, fallbackReader());
    expect(plain.attach(processStub(4242, true)).diagnostics).toEqual([]);
  });

  it('serves one process and attaches once', async () => {
    const containment = createSessionContainment(UNAVAILABLE, fallbackReader());
    await containment.startTime.read(1);
    expect(() => containment.startTime.read(2)).toThrow('serves one process');
    expect(() => containment.attach(processStub(2))).toThrow('serves one process');
    const other = createSessionContainment(UNAVAILABLE, fallbackReader());
    other.attach(processStub(3));
    expect(() => other.attach(processStub(3))).toThrow('already attached');
  });
});

describe('integration with spawnHarnessProcess (no spawn.ts hook needed)', () => {
  const tracker = new ChildTracker();

  afterEach(async () => {
    await tracker.assertNoLeaks();
  }, 60_000);

  afterAll(async () => {
    await tracker.assertNoneListed();
  }, 60_000);

  it('assigns before spawnHarnessProcess resolves, so before any write', async () => {
    const fake = new FakeJobAddon({ processes: new Map() });
    const order: string[] = [];
    const exports = fake.exports();
    const assign = exports['assignProcess'] as (job: unknown, pid: number) => unknown;
    exports['assignProcess'] = (job: unknown, pid: number) => {
      order.push('assign');
      fake.processes.set(pid, '133000000001234560');
      return assign(job, pid);
    };
    const load = loadJobAddon(fakeDeps(exports));
    const containment = createSessionContainment(load, fallbackReader());

    const child = await tracker.node(
      "process.stdin.on('data', (d) => process.stdout.write(d)); process.stdin.on('end', () => process.exit(0));",
      { spec: { startTime: containment.startTime } },
    );
    order.push('spawned');
    const result = containment.attach(child);
    expect(order).toEqual(['assign', 'spawned']);
    expect(result.containment).toBe('job');
    await expect(child.identity).resolves.toEqual({
      identity: { pid: child.pid, startTime: '13300000000123456' },
      problem: null,
    });
    await child.write('ping\n');
    child.endStdin();
    await child.exited;
    await expect(result.released).resolves.toBe('closed');
  }, 60_000);

  it('hands runWindowsLadder a job that ends the tree with TerminateJobObject', async () => {
    const fake = new FakeJobAddon({ processes: new Map([[500, '10000']]) });
    const proc = fakeProcess(500, '1000');
    const exports = fake.exports();
    const terminate = exports['terminateJob'] as (job: unknown, code: number) => unknown;
    exports['terminateJob'] = (job: unknown, code: number) => {
      terminate(job, code);
      proc.exit();
    };
    const containment = createSessionContainment(loadJobAddon(fakeDeps(exports)), fallbackReader());
    await expect(containment.startTime.read(500)).resolves.toBe('1000');
    const { job } = containment.attach({ pid: proc.pid, exitStatus: null, exited: proc.exited });
    const clock = new FakeClock();
    const report = await drive(
      clock,
      runWindowsLadder(
        proc,
        { interrupt: () => Promise.resolve('acknowledged') },
        DEFAULT_LADDER_TIMING,
        job,
        {
          intent: 'abort',
          initializePid: null,
          clock,
          os: {
            platform: 'win32',
            hostPid: process.pid,
            processTable: fakeCim(() => []),
            terminate: {
              taskkillTree: () => Promise.reject(new Error('not expected')),
              taskkillProcess: () => Promise.reject(new Error('not expected')),
            },
          },
        },
      ),
    );
    expect(report.exitedAfter).toBe('terminate-job');
    expect(fake.jobs[0]?.terminations).toBe(1);
    expect(fake.calls).toContain('exit-code-0');
  });
});
