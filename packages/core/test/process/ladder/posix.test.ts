import { describe, expect, it, vi } from 'vitest';

import { runPosixLadder } from '../../../src/process/ladder/posix.js';
import {
  DEFAULT_LADDER_TIMING,
  type InterruptOutcome,
  type LadderHooks,
  type LadderReport,
  type LadderStep,
} from '../../../src/process/ladder/types.js';
import {
  CLI,
  FakeWorld,
  HOST,
  identity,
  INIT,
  LAUNCHER,
  rec,
  runWithClock,
  SLEEP,
  TOOL,
} from './fake-os.js';

const TIMING = DEFAULT_LADDER_TIMING;

function hooks(
  outcome: InterruptOutcome = 'timeout',
  onStep?: (step: LadderStep) => void,
): LadderHooks {
  const interrupt = (): Promise<InterruptOutcome> => Promise.resolve(outcome);
  return onStep === undefined ? { interrupt } : { interrupt, onStep };
}

function run(world: FakeWorld, ladderHooks: LadderHooks = hooks()): Promise<LadderReport<'abort'>> {
  return runWithClock(
    world.clock,
    runPosixLadder(world.proc, ladderHooks, TIMING, {
      intent: 'abort',
      os: world.os,
      clock: world.clock,
    }),
  );
}

function names(report: LadderReport): string[] {
  return report.steps.map(
    (step) =>
      `${step.name}@${String(step.atMs)}:${step.outcome}${step.detail === undefined ? '' : `(${step.detail})`}`,
  );
}

function signalLog(world: FakeWorld): string[] {
  return world.calls.map(
    (call) => `${call.kind === 'group' ? '-' : ''}${String(call.id)} ${call.signal}`,
  );
}

describe('runPosixLadder: full path (K1 target behind a launcher)', () => {
  it('runs every step in order, SIGTERMs only the CLI, then SIGKILLs and sweeps the tool group', async () => {
    const world = FakeWorld.standard();
    const observed: string[] = [];
    const report = await run(
      world,
      hooks('timeout', (step) => {
        observed.push(step.name);
      }),
    );

    expect(names(report)).toEqual([
      'intent@0:done',
      'interrupt@0:done(timeout)',
      'eof@0:done',
      'snapshot-s1@2000:done',
      'sigterm@2000:done(initialize-pid)',
      'snapshot-s2@7000:done',
      'sigkill@7000:done(signal-target)',
      'sigkill@7000:done(spawned)',
      'sweep@7000:done',
    ]);
    expect(observed).toEqual(report.steps.map((step) => step.name));
    expect(signalLog(world)).toEqual(['201 SIGTERM', '201 SIGKILL', '200 SIGKILL', '-300 SIGKILL']);
    expect(report).toMatchObject({
      intent: 'abort',
      platform: 'posix',
      exitedAfter: 'sweep',
      signalTarget: identity(CLI),
      launcherDetected: true,
      sweep: { processesSignalled: 0, groupsSignalled: 1, skipped: 1 },
    });
    expect(world.proc.stdinEnded).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('never signals the host, pid 0/1 or the host group (CLI and launcher share it)', async () => {
    const world = FakeWorld.standard();
    await run(world);
    for (const call of world.calls) {
      expect([0, 1, HOST.pid]).not.toContain(call.id);
      if (call.kind === 'group')
        expect([0, 1, HOST.pgid, CLI.pid, LAUNCHER.pid]).not.toContain(call.id);
    }
  });

  it('stops after SIGTERM when the CLI cleans up and the launcher exits (K1 reaches the grandchild)', async () => {
    const world = FakeWorld.standard();
    world.onSignal = ({ world: w, call }) => {
      if (call.signal === 'SIGTERM' && call.id === CLI.pid) {
        w.remove(SLEEP.pid);
        w.remove(TOOL.pid);
        w.remove(CLI.pid);
        w.remove(LAUNCHER.pid); // the launcher exits when its child does
        return 'sent';
      }
      return undefined;
    };
    const report = await run(world);
    expect(signalLog(world)).toEqual(['201 SIGTERM']);
    expect(report.exitedAfter).toBe('sigterm');
    expect(report.sweep).toBeNull();
    expect(report.steps.at(-1)?.name).toBe('sigterm');
  });

  it('reports a process that never exits as exitedAfter null', async () => {
    const world = FakeWorld.standard();
    world.onSignal = ({ call }) => (call.id === LAUNCHER.pid ? 'sent' : undefined);
    const report = await run(world);
    expect(report.exitedAfter).toBeNull();
    expect(report.sweep).not.toBeNull();
  });
});

describe('runPosixLadder: K1 signal target selection', () => {
  it('targets the spawned pid when there is no launcher', async () => {
    for (const initializePid of [LAUNCHER.pid, null]) {
      const world = FakeWorld.standard(initializePid);
      const report = await run(world);
      expect(report.signalTarget).toEqual(identity(LAUNCHER));
      expect(report.launcherDetected).toBe(false);
      expect(signalLog(world).slice(0, 2)).toEqual(['200 SIGTERM', '200 SIGKILL']);
      expect(report.steps.filter((step) => step.name === 'sigkill')).toHaveLength(1);
      expect(report.steps.find((step) => step.name === 'sigterm')?.detail).toBe('spawned');
    }
  });

  it('targets the spawned pid when initialize.pid is not a descendant in S1', async () => {
    const world = FakeWorld.standard(400);
    const report = await run(world);
    expect(report.signalTarget).toEqual(identity(LAUNCHER));
    expect(report.launcherDetected).toBe(true);
    expect(world.calls.some((call) => call.id === 400)).toBe(false);
  });

  it('targets the spawned pid when its start time does not match S1', async () => {
    const world = new FakeWorld(
      [INIT, HOST, LAUNCHER, CLI, TOOL, SLEEP],
      { pid: 200, startTime: '19' },
      CLI.pid,
    );
    const report = await run(world);
    expect(report.signalTarget).toEqual({ pid: 200, startTime: '19' });
    expect(signalLog(world)[0]).toBe('200 SIGTERM');
    // Nothing descends from a root that does not match: no sweep signals.
    expect(world.calls.filter((call) => call.kind === 'group')).toEqual([]);
  });

  it('never targets the host even when it reports itself as initialize.pid', async () => {
    const world = FakeWorld.standard(HOST.pid);
    const report = await run(world);
    expect(report.signalTarget).toEqual(identity(LAUNCHER));
    expect(world.calls.some((call) => call.id === HOST.pid)).toBe(false);
  });
});

describe('runPosixLadder: guards between S1 and S2', () => {
  it('does not SIGKILL a CLI pid reused between S1 and S2', async () => {
    const world = FakeWorld.standard();
    world.beforeRead = (index) => {
      // A foreign process now holds pid 201.
      if (index === 1) world.set(rec(CLI.pid, 1, 777, '99'));
    };
    const report = await run(world);
    expect(
      report.steps
        .filter((step) => step.name === 'sigkill')
        .map((step) => [step.outcome, step.detail]),
    ).toEqual([
      ['skipped', 'signal-target:identity-changed'],
      ['done', 'spawned'],
    ]);
    expect(signalLog(world)).not.toContain('201 SIGKILL');
    expect(world.calls.some((call) => call.id === 777)).toBe(false);
  });

  it('does not SIGKILL a CLI that exited between S1 and S2', async () => {
    const world = FakeWorld.standard();
    world.beforeRead = (index) => {
      if (index === 1) world.records.delete(CLI.pid);
    };
    const report = await run(world);
    expect(report.steps.find((step) => step.name === 'sigkill')?.detail).toBe(
      'signal-target:exited',
    );
    expect(signalLog(world).filter((line) => line.startsWith('201'))).toEqual(['201 SIGTERM']);
  });

  it('does not SIGKILL the CLI without S2, but still kills the spawned pid and sweeps over S1', async () => {
    const world = FakeWorld.standard();
    world.failingReads.add(1);
    const report = await run(world);
    expect(names(report).slice(5)).toEqual([
      'snapshot-s2@7000:failed(error)',
      'sigkill@7000:skipped(signal-target:unverified)',
      'sigkill@7000:done(spawned)',
      'sweep@7000:done',
    ]);
    // S1 still verifies the CLI, which the sweep reaches by identity.
    expect(signalLog(world)).toEqual(['201 SIGTERM', '200 SIGKILL', '-300 SIGKILL', '201 SIGKILL']);
  });

  it('falls back to the spawned pid without S1 and sweeps over S2 only', async () => {
    const world = FakeWorld.standard();
    world.failingReads.add(0);
    const report = await run(world);
    expect(report.signalTarget).toEqual(identity(LAUNCHER));
    expect(names(report)[3]).toBe('snapshot-s1@2000:failed(error)');
    expect(signalLog(world)).toEqual(['200 SIGTERM', '200 SIGKILL', '-300 SIGKILL', '201 SIGKILL']);
  });

  it('skips the sweep when no snapshot was recorded', async () => {
    const world = FakeWorld.standard();
    for (const index of [0, 1, 2]) world.failingReads.add(index);
    const report = await run(world);
    expect(names(report).slice(-1)).toEqual(['sweep@7000:skipped(no-snapshot)']);
    expect(report.sweep).toBeNull();
    expect(signalLog(world)).toEqual(['200 SIGTERM', '200 SIGKILL']);
  });

  it('records a failed sweep when its own snapshot fails, and signals nothing', async () => {
    const world = FakeWorld.standard();
    world.failingReads.add(2);
    const report = await run(world);
    expect(names(report).slice(-1)).toEqual(['sweep@7000:failed(snapshot-failed)']);
    expect(report.sweep).toBeNull();
    expect(world.calls.filter((call) => call.kind === 'group')).toEqual([]);
  });

  it('does not SIGKILL the spawned pid once its exit was observed', async () => {
    const world = FakeWorld.standard();
    world.onSignal = ({ world: w, call }) => {
      if (call.signal === 'SIGKILL' && call.id === CLI.pid) {
        w.proc.exit(); // the launcher's exit is observed at once
        return 'sent';
      }
      return undefined;
    };
    const report = await run(world);
    expect(names(report).slice(-3)).toEqual([
      'sigkill@7000:done(signal-target)',
      'sigkill@7000:skipped(spawned:exited)',
      'sweep@7000:done',
    ]);
    expect(signalLog(world)).not.toContain('200 SIGKILL');
  });
});

describe('runPosixLadder: early exit at each step', () => {
  it('stops right after the intent when the process already exited', async () => {
    const world = FakeWorld.standard();
    world.proc.exit();
    const interrupt = vi.fn(() => Promise.resolve<InterruptOutcome>('acknowledged'));
    const report = await run(world, { interrupt });
    expect(names(report)).toEqual(['intent@0:done']);
    expect(report).toMatchObject({
      exitedAfter: 'intent',
      signalTarget: null,
      sweep: null,
      launcherDetected: true,
    });
    expect(interrupt).not.toHaveBeenCalled();
    expect(world.calls).toEqual([]);
  });

  it('stops after the interrupt when the process exits while it is pending', async () => {
    const world = FakeWorld.standard();
    world.clock.schedule(300, () => {
      world.proc.exit();
    });
    const report = await run(world, {
      interrupt: () => new Promise<InterruptOutcome>(() => undefined),
    });
    expect(names(report)).toEqual(['intent@0:done', 'interrupt@0:done(exited)']);
    expect(report.exitedAfter).toBe('interrupt');
    expect(world.proc.stdinEnded).toBe(false);
  });

  it('stops after the interrupt when its acknowledgement ends the process', async () => {
    const world = FakeWorld.standard();
    const report = await run(world, {
      interrupt: () => {
        world.proc.exit();
        return Promise.resolve('acknowledged');
      },
    });
    expect(report.exitedAfter).toBe('interrupt');
    expect(world.calls).toEqual([]);
  });

  it('stops during the EOF grace period', async () => {
    const world = FakeWorld.standard();
    world.proc.onEndStdin = () => {
      world.clock.schedule(1500, () => {
        world.proc.exit();
      });
    };
    const report = await run(world);
    expect(names(report)).toEqual(['intent@0:done', 'interrupt@0:done(timeout)', 'eof@0:done']);
    expect(report.exitedAfter).toBe('eof');
    expect(world.calls).toEqual([]);
  });

  it('stops when the exit is observed while S1 is read', async () => {
    const world = FakeWorld.standard();
    world.beforeRead = () => {
      world.proc.exit();
    };
    const report = await run(world);
    expect(report.exitedAfter).toBe('snapshot-s1');
    expect(report.signalTarget).toBeNull();
    expect(world.calls).toEqual([]);
  });

  it('stops when the exit is observed while S2 is read', async () => {
    const world = FakeWorld.standard();
    world.beforeRead = (index) => {
      if (index === 1) world.proc.exit();
    };
    const report = await run(world);
    expect(report.exitedAfter).toBe('snapshot-s2');
    expect(signalLog(world)).toEqual(['201 SIGTERM']);
  });
});

describe('runPosixLadder: hooks and failures', () => {
  it('maps every interrupt outcome', async () => {
    const cases: [InterruptOutcome, string][] = [
      ['acknowledged', 'interrupt@0:done(acknowledged)'],
      ['timeout', 'interrupt@0:done(timeout)'],
      ['not-applicable', 'interrupt@0:skipped(not-applicable)'],
    ];
    for (const [outcome, expected] of cases) {
      const report = await run(FakeWorld.standard(), hooks(outcome));
      expect(names(report)[1]).toBe(expected);
    }
  });

  it('bounds a hook that never answers by interruptWaitMs', async () => {
    const world = FakeWorld.standard();
    const report = await run(world, {
      interrupt: () => new Promise<InterruptOutcome>(() => undefined),
    });
    expect(names(report).slice(1, 4)).toEqual([
      'interrupt@0:done(timeout)',
      'eof@1000:done',
      'snapshot-s1@3000:done',
    ]);
  });

  it('goes on when the hook rejects or throws, or the observer throws', async () => {
    const rejecting = await run(FakeWorld.standard(), {
      interrupt: () => Promise.reject(new Error('boom')),
    });
    expect(names(rejecting)[1]).toBe('interrupt@0:failed(hook-error)');
    const throwing = await run(FakeWorld.standard(), {
      interrupt: () => {
        throw new Error('boom');
      },
      onStep: () => {
        throw new Error('observer');
      },
    });
    expect(names(throwing)[1]).toBe('interrupt@0:failed(hook-error)');
    expect(throwing.steps.at(-1)?.name).toBe('sweep');
  });

  it('records a failing EOF and goes on', async () => {
    const world = FakeWorld.standard();
    world.proc.onEndStdin = () => {
      throw new Error('EPIPE');
    };
    const report = await run(world);
    expect(names(report)[2]).toBe('eof@0:failed(error)');
    expect(report.steps.at(-1)?.name).toBe('sweep');
  });

  it('records signal failures with their errno', async () => {
    const outcomes = new Map([
      [`${String(CLI.pid)} SIGTERM`, 'no-such-process' as const],
      [`${String(CLI.pid)} SIGKILL`, 'not-permitted' as const],
    ]);
    const world = FakeWorld.standard();
    world.onSignal = ({ call }) => {
      if (call.kind === 'process' && call.id === LAUNCHER.pid) throw new Error('EINVAL');
      return outcomes.get(`${String(call.id)} ${call.signal}`);
    };
    const report = await run(world);
    expect(
      report.steps
        .filter((step) => step.name === 'sigterm' || step.name === 'sigkill')
        .map((step) => `${step.outcome}(${step.detail ?? ''})`),
    ).toEqual([
      'failed(initialize-pid:ESRCH)',
      'failed(signal-target:EPERM)',
      'failed(spawned:error)',
    ]);
  });
});
