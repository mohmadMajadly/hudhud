import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  runWindowsLadder,
  type JobHandle,
  type WindowsOsCalls,
} from '../../../src/process/ladder/windows.js';
import {
  DEFAULT_LADDER_TIMING,
  type InterruptOutcome,
  type LadderHooks,
  type LadderReport,
  type LadderStep,
} from '../../../src/process/ladder/types.js';
import type { TaskkillResult } from '../../../src/process/os/types.js';
import { TaskkillUnavailableError } from '../../../src/process/taskkill.js';
import { fcParams } from '../tree/support.js';
import {
  drive,
  FakeClock,
  fakeCim,
  fakeProcess,
  type CimRow,
  type FakeProcess,
} from './windows-support.js';

const HOST = 100;
const ROOT: CimRow = { pid: 500, ppid: HOST, start: '1000' };
const KID: CimRow = { pid: 600, ppid: 500, start: '2000' };
const HOST_ROW: CimRow = { pid: HOST, ppid: 4, start: '10' };

interface Harness {
  clock: FakeClock;
  proc: FakeProcess;
  os: WindowsOsCalls;
  cim: ReturnType<typeof fakeCim>;
  taskkillPids: number[];
  table: { rows: readonly CimRow[] | Error };
  taskkill: (pid: number) => Promise<TaskkillResult>;
}

function harness(): Harness {
  const clock = new FakeClock();
  const proc = fakeProcess(ROOT.pid, ROOT.start);
  const table: Harness['table'] = { rows: [HOST_ROW, ROOT, KID] };
  const cim = fakeCim(() => table.rows);
  const h: Harness = {
    clock,
    proc,
    cim,
    table,
    taskkillPids: [],
    taskkill: () => {
      proc.exit();
      return Promise.resolve({ exitCode: 0 });
    },
    os: {
      platform: 'win32',
      hostPid: HOST,
      processTable: cim,
      terminate: {
        taskkillTree: (pid) => {
          proc.calls.push(`taskkill:${String(proc.hasExited())}`);
          h.taskkillPids.push(pid);
          return h.taskkill(pid);
        },
      },
    },
  };
  return h;
}

function hooksWith(
  interrupt: () => Promise<InterruptOutcome>,
  onStep?: (step: LadderStep) => void,
): LadderHooks {
  return onStep === undefined ? { interrupt } : { interrupt, onStep };
}

const ack = (): Promise<InterruptOutcome> => Promise.resolve('acknowledged');

function run(
  h: Harness,
  job: JobHandle | null,
  hooks: LadderHooks = hooksWith(ack),
  initializePid: number | null = null,
): Promise<LadderReport<'abort'>> {
  return drive(
    h.clock,
    runWindowsLadder(h.proc, hooks, DEFAULT_LADDER_TIMING, job, {
      intent: 'abort',
      initializePid,
      clock: h.clock,
      os: h.os,
    }),
  );
}

function summary(report: LadderReport): string[] {
  return report.steps.map(
    (step) =>
      `${step.name}@${String(step.atMs)}:${step.outcome}${step.detail === undefined ? '' : `:${step.detail}`}`,
  );
}

function jobThatKills(proc: FakeProcess): JobHandle & { calls: number } {
  const job = {
    calls: 0,
    terminate() {
      job.calls += 1;
      proc.calls.push(`job:${String(proc.hasExited())}`);
      proc.exit();
    },
  };
  return job;
}

describe('runWindowsLadder with a job', () => {
  it('interrupt -> EOF -> 2 s -> TerminateJobObject, intent first', async () => {
    const h = harness();
    const job = jobThatKills(h.proc);
    const report = await run(h, job);
    expect(summary(report)).toEqual([
      'intent@0:done',
      'interrupt@0:done:acknowledged',
      'eof@0:done',
      'terminate-job@2000:done',
    ]);
    expect(report).toMatchObject({
      intent: 'abort',
      platform: 'win32',
      exitedAfter: 'terminate-job',
      signalTarget: null,
      launcherDetected: false,
      sweep: null,
    });
    expect(job.calls).toBe(1);
    expect(h.taskkillPids).toEqual([]);
    expect(h.cim.queries).toBe(0);
    expect(h.clock.pending()).toBe(0);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('falls back to TerminateProcess when the job kill is not observed within the grace', async () => {
    const h = harness();
    const job = { terminate: () => undefined };
    const report = await run(h, job);
    expect(summary(report)).toEqual([
      'intent@0:done',
      'interrupt@0:done:acknowledged',
      'eof@0:done',
      'terminate-job@2000:done',
      'terminate-process@4000:done',
    ]);
    expect(report.exitedAfter).toBe('terminate-process');
    expect(h.taskkillPids).toEqual([]);
  });

  it('falls back to the best-effort steps when TerminateJobObject fails', async () => {
    const h = harness();
    const job = {
      terminate: () => {
        throw Object.assign(new Error('closed'), { code: 'ERR_JOB_CLOSED' });
      },
    };
    const report = await run(h, job);
    expect(summary(report)).toEqual([
      'intent@0:done',
      'interrupt@0:done:acknowledged',
      'eof@0:done',
      'terminate-job@2000:failed:ERR_JOB_CLOSED',
      'taskkill@2000:done',
    ]);
    expect(report.exitedAfter).toBe('taskkill');
    expect(h.taskkillPids).toEqual([ROOT.pid]);
  });

  it('never touches the job when the process exits after EOF', async () => {
    const h = harness();
    const job = jobThatKills(h.proc);
    h.proc.onCloseStdin = () => {
      h.clock.setTimeout(() => {
        h.proc.exit();
      }, 700);
    };
    const report = await run(h, job);
    expect(summary(report)).toEqual([
      'intent@0:done',
      'interrupt@0:done:acknowledged',
      'eof@0:done',
    ]);
    expect(report.exitedAfter).toBe('eof');
    expect(job.calls).toBe(0);
    expect(h.clock.now()).toBe(700);
    expect(h.clock.pending()).toBe(0);
  });
});

describe('runWindowsLadder: interrupt and EOF', () => {
  it('records only the intent when the process had already exited', async () => {
    const h = harness();
    h.proc.exit();
    const interrupt = (): Promise<InterruptOutcome> => {
      throw new Error('must not be called');
    };
    const report = await run(h, null, hooksWith(interrupt));
    expect(summary(report)).toEqual(['intent@0:done']);
    expect(report.exitedAfter).toBe('intent');
    expect(h.proc.calls).toEqual([]);
  });

  it('stops after the interrupt when the process exits during it', async () => {
    const h = harness();
    const report = await run(
      h,
      null,
      hooksWith(() => {
        h.proc.exit();
        return Promise.resolve('acknowledged');
      }),
    );
    expect(summary(report)).toEqual(['intent@0:done', 'interrupt@0:done:acknowledged']);
    expect(report.exitedAfter).toBe('interrupt');
    expect(h.proc.calls).toEqual([]);
  });

  it('waits at most interruptWaitMs for the hook', async () => {
    const h = harness();
    const report = await run(
      h,
      null,
      hooksWith(() => new Promise<InterruptOutcome>(() => undefined)),
    );
    expect(summary(report).slice(0, 3)).toEqual([
      'intent@0:done',
      'interrupt@0:done:timeout',
      'eof@1000:done',
    ]);
    expect(summary(report)[3]).toBe('taskkill@3000:done');
  });

  it('records the timeout the hook reports itself', async () => {
    const h = harness();
    const report = await run(
      h,
      null,
      hooksWith(() => Promise.resolve('timeout')),
    );
    expect(report.steps[1]).toEqual({
      name: 'interrupt',
      atMs: 0,
      outcome: 'done',
      detail: 'timeout',
    });
  });

  it('skips the interrupt when it does not apply', async () => {
    const h = harness();
    const report = await run(
      h,
      null,
      hooksWith(() => Promise.resolve('not-applicable')),
    );
    expect(report.steps[1]).toEqual({
      name: 'interrupt',
      atMs: 0,
      outcome: 'skipped',
      detail: 'not-applicable',
    });
  });

  it('continues when the hook rejects or throws', async () => {
    for (const interrupt of [
      () => Promise.reject(new Error('boom')),
      (): Promise<InterruptOutcome> => {
        throw new Error('sync boom');
      },
    ]) {
      const h = harness();
      const report = await run(h, null, hooksWith(interrupt));
      expect(report.steps[1]).toEqual({
        name: 'interrupt',
        atMs: 0,
        outcome: 'failed',
        detail: 'hook-error',
      });
      expect(report.exitedAfter).toBe('taskkill');
    }
  });

  it('records a failed EOF with the error code only, and continues', async () => {
    const cases: [unknown, string][] = [
      [Object.assign(new Error('x'), { code: 'EPIPE' }), 'EPIPE'],
      [new Error('C:\\secret\\path'), 'error'],
      [Object.assign(new Error('x'), { code: 'C:\\secret' }), 'error'],
      [Object.assign(new Error('x'), { code: 5 }), 'error'],
      ['plain string', 'error'],
    ];
    for (const [error, detail] of cases) {
      const h = harness();
      h.proc.onCloseStdin = () => {
        throw error;
      };
      const report = await run(h, null);
      expect(report.steps[2]).toEqual({ name: 'eof', atMs: 0, outcome: 'failed', detail });
      expect(report.steps[3]?.name).toBe('taskkill');
    }
  });

  it('observes each step and survives a throwing observer', async () => {
    const h = harness();
    const seen: string[] = [];
    const report = await run(
      h,
      null,
      hooksWith(ack, (step) => {
        seen.push(step.name);
        throw new Error('observer');
      }),
    );
    expect(seen).toEqual(['intent', 'interrupt', 'eof', 'taskkill']);
    expect(report.exitedAfter).toBe('taskkill');
  });

  it('reports a launcher when initialize.pid differs from the spawned pid', async () => {
    expect((await run(harness(), null, hooksWith(ack), 777)).launcherDetected).toBe(true);
    expect((await run(harness(), null, hooksWith(ack), ROOT.pid)).launcherDetected).toBe(false);
  });
});

describe('runWindowsLadder best-effort', () => {
  it('interrupt -> EOF -> 2 s -> taskkill /T /F of the verified spawned pid', async () => {
    const h = harness();
    const report = await run(h, null);
    expect(summary(report)).toEqual([
      'intent@0:done',
      'interrupt@0:done:acknowledged',
      'eof@0:done',
      'taskkill@2000:done',
    ]);
    expect(report.exitedAfter).toBe('taskkill');
    expect(h.taskkillPids).toEqual([ROOT.pid]);
    expect(h.cim.queries).toBe(1);
    expect(h.proc.calls).toEqual(['closeStdin:false', 'taskkill:false']);
    expect(h.clock.pending()).toBe(0);
  });

  it('taskkill fails -> 2 s -> TerminateProcess through the child handle', async () => {
    for (const [result, detail] of [
      [{ exitCode: 128 }, 'exit-128'],
      [{ exitCode: 1 }, 'exit-1'],
      [{ exitCode: null }, 'no-exit-code'],
    ] as const) {
      const h = harness();
      h.taskkill = () => Promise.resolve(result);
      const report = await run(h, null);
      expect(summary(report).slice(3)).toEqual([
        `taskkill@2000:failed:${detail}`,
        'terminate-process@4000:done',
      ]);
      expect(report.exitedAfter).toBe('terminate-process');
      expect(h.cim.queries).toBe(2);
    }
  });

  it('records a refused taskkill.exe by its code and still terminates', async () => {
    const h = harness();
    h.taskkill = () => Promise.reject(new TaskkillUnavailableError('redirected'));
    const report = await run(h, null);
    expect(summary(report).slice(3)).toEqual([
      'taskkill@2000:failed:TASKKILL_UNAVAILABLE',
      'terminate-process@4000:done',
    ]);
  });

  it('exits during the taskkill grace', async () => {
    const h = harness();
    h.taskkill = () => {
      h.clock.setTimeout(() => {
        h.proc.exit();
      }, 300);
      return Promise.resolve({ exitCode: 0 });
    };
    const report = await run(h, null);
    expect(report.exitedAfter).toBe('taskkill');
    expect(h.clock.now()).toBe(2300);
    expect(h.proc.calls).not.toContain('terminate:false');
  });

  it('never calls taskkill or TerminateProcess when the start time changed (pid reuse)', async () => {
    const h = harness();
    h.table.rows = [HOST_ROW, { ...ROOT, start: '9999' }];
    h.proc.onTerminate = () => {
      throw new Error('must not be called');
    };
    const report = await run(h, null);
    expect(summary(report).slice(3)).toEqual([
      'taskkill@2000:skipped:identity-changed',
      'terminate-process@2000:skipped:identity-changed',
    ]);
    expect(report.exitedAfter).toBeNull();
    expect(h.taskkillPids).toEqual([]);
    expect(h.proc.calls).toEqual(['closeStdin:false']);
  });

  it('skips taskkill but terminates through the handle when no snapshot can be taken', async () => {
    const h = harness();
    h.table.rows = new Error('cim failed');
    const report = await run(h, null);
    expect(summary(report).slice(3)).toEqual([
      'taskkill@2000:skipped:identity-unverified',
      'terminate-process@2000:done',
    ]);
    expect(report.exitedAfter).toBe('terminate-process');
    expect(h.taskkillPids).toEqual([]);
  });

  it('skips taskkill when the snapshot lacks the pid', async () => {
    const h = harness();
    h.table.rows = [HOST_ROW];
    const report = await run(h, null);
    expect(summary(report).slice(3)).toEqual([
      'taskkill@2000:skipped:identity-absent',
      'terminate-process@2000:done',
    ]);
    expect(h.taskkillPids).toEqual([]);
  });

  it('skips taskkill /T when a foreign process names a tree member as its parent (stale ppid)', async () => {
    for (const foreign of [
      // Started before the root: its ppid names an earlier holder of the pid.
      { pid: 700, ppid: ROOT.pid, start: '500' },
      // Started before the child that its ppid names.
      { pid: 701, ppid: KID.pid, start: '1500' },
    ]) {
      const h = harness();
      h.table.rows = [HOST_ROW, ROOT, KID, foreign];
      const report = await run(h, null);
      expect(summary(report).slice(3)).toEqual([
        'taskkill@2000:skipped:identity-foreign-child',
        'terminate-process@2000:done',
      ]);
      expect(h.taskkillPids).toEqual([]);
    }
  });

  it('never taskkills the host itself', async () => {
    const h = harness();
    const proc = fakeProcess(HOST, HOST_ROW.start);
    h.proc = proc;
    const report = await run(h, null);
    expect(summary(report).slice(3)).toEqual([
      'taskkill@2000:skipped:protected',
      'terminate-process@2000:done',
    ]);
    expect(h.taskkillPids).toEqual([]);
  });

  it('skips taskkill when the exit is observed during the identity check', async () => {
    const h = harness();
    h.table.rows = [HOST_ROW, ROOT, KID];
    const query = h.cim.queryProcesses.bind(h.cim);
    h.cim.queryProcesses = () => {
      h.proc.exit();
      return query();
    };
    const report = await run(h, null);
    expect(summary(report).slice(3)).toEqual(['taskkill@2000:skipped:exited']);
    expect(report.exitedAfter).toBe('eof');
    expect(h.taskkillPids).toEqual([]);
  });

  it('skips TerminateProcess when the exit is observed during its identity check', async () => {
    const h = harness();
    h.taskkill = () => Promise.resolve({ exitCode: 128 });
    const query = h.cim.queryProcesses.bind(h.cim);
    h.cim.queryProcesses = () => {
      if (h.cim.queries === 1) h.proc.exit();
      return query();
    };
    const report = await run(h, null);
    expect(summary(report).slice(3)).toEqual([
      'taskkill@2000:failed:exit-128',
      'terminate-process@4000:skipped:exited',
    ]);
    expect(report.exitedAfter).toBe('taskkill');
    expect(h.proc.calls).not.toContain('terminate:false');
  });

  it('does nothing more when the exit is observed between taskkill and TerminateProcess', async () => {
    const h = harness();
    h.table.rows = [HOST_ROW];
    const report = await run(
      h,
      null,
      hooksWith(ack, (step) => {
        if (step.name === 'taskkill') h.proc.exit();
      }),
    );
    expect(summary(report).slice(3)).toEqual(['taskkill@2000:skipped:identity-absent']);
    expect(report.exitedAfter).toBe('taskkill');
  });

  it('records TerminateProcess that finds the process gone or fails', async () => {
    const cases: [() => boolean, string, string | null][] = [
      [() => false, 'terminate-process@4000:skipped:not-running', null],
      [
        () => {
          throw Object.assign(new Error('x'), { code: 'EPERM' });
        },
        'terminate-process@4000:failed:EPERM',
        null,
      ],
    ];
    for (const [onTerminate, line, exitedAfter] of cases) {
      const h = harness();
      h.taskkill = () => Promise.resolve({ exitCode: 1 });
      h.proc.onTerminate = onTerminate;
      const report = await run(h, null);
      expect(summary(report).at(-1)).toBe(line);
      expect(report.exitedAfter).toBe(exitedAfter);
      expect(h.clock.now()).toBe(6000);
      expect(h.clock.pending()).toBe(0);
    }
  });
});

describe('runWindowsLadder property: no action after the exit', () => {
  it('never acts on the process once its exit was observed, and always ends', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 9000 }),
        fc.boolean(),
        fc.constantFrom<InterruptOutcome>('acknowledged', 'timeout', 'not-applicable'),
        fc.boolean(),
        fc.boolean(),
        async (exitAt, withJob, interruptOutcome, killsWork, identityOk) => {
          const h = harness();
          if (!identityOk) h.table.rows = [HOST_ROW, { ...ROOT, start: '1' }];
          h.clock.setTimeout(() => {
            h.proc.exit();
          }, exitAt);
          h.taskkill = () => {
            if (killsWork) h.proc.exit();
            return Promise.resolve({ exitCode: killsWork ? 0 : 1 });
          };
          h.proc.onTerminate = () => {
            if (killsWork) h.proc.exit();
            return true;
          };
          const job = {
            terminate: () => {
              h.proc.calls.push(`job:${String(h.proc.hasExited())}`);
              if (killsWork) h.proc.exit();
            },
          };
          const report = await run(
            h,
            withJob ? job : null,
            hooksWith(() => Promise.resolve(interruptOutcome)),
          );
          // Every action happened while the process was still running.
          for (const call of h.proc.calls) expect(call.endsWith(':false')).toBe(true);
          expect(report.steps[0]?.name).toBe('intent');
          if (!identityOk) expect(h.taskkillPids).toEqual([]);
          if (report.exitedAfter !== null) expect(h.proc.hasExited()).toBe(true);
        },
      ),
      fcParams(300),
    );
  });
});
