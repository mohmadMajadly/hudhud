import { describe, expect, it } from 'vitest';

import { maySignal, planSweep, selectSignalTarget } from '../../../src/process/tree/select.js';
import { takeSnapshot } from '../../../src/process/tree/snapshot.js';
import type { ProcessRecord, ProcessSnapshot } from '../../../src/process/tree/types.js';
import { fixture, fixtureProcTable } from './support.js';

function rec(pid: number, ppid: number, pgid: number, startTime: string): ProcessRecord {
  return { pid, ppid, pgid, startTime, name: `p${String(pid)}` };
}

function snap(records: ProcessRecord[]): ProcessSnapshot {
  return { source: 'linux-proc', records, rejected: 0 };
}

const HOST = rec(100, 1, 90, '10');
const LAUNCHER = rec(200, 100, 90, '20');
const CLI = rec(201, 200, 90, '21');
const TOOL = rec(300, 201, 300, '30');
const SLEEP = rec(301, 300, 300, '31');
const FOREIGN = rec(400, 1, 400, '40');
const S1 = snap([rec(1, 0, 1, '0'), HOST, LAUNCHER, CLI, TOOL, SLEEP, FOREIGN]);
const spawned = { pid: LAUNCHER.pid, startTime: LAUNCHER.startTime };
const cliIdentity = { pid: CLI.pid, startTime: CLI.startTime };

describe('selectSignalTarget (K1)', () => {
  it('targets initialize.pid behind a launcher when it is a descendant in S1', () => {
    expect(selectSignalTarget({ spawned, initializePid: 201, hostPid: 100, s1: S1 })).toEqual({
      target: cliIdentity,
      source: 'initialize-pid',
      launcherDetected: true,
    });
  });

  it('targets the spawned pid when there is no launcher', () => {
    expect(selectSignalTarget({ spawned, initializePid: 200, hostPid: 100, s1: S1 })).toEqual({
      target: spawned,
      source: 'spawned',
      launcherDetected: false,
    });
    expect(selectSignalTarget({ spawned, initializePid: null, hostPid: 100, s1: S1 })).toEqual({
      target: spawned,
      source: 'spawned',
      launcherDetected: false,
    });
  });

  it('falls back to the spawned pid when initialize.pid is not a descendant in S1', () => {
    for (const initializePid of [400, 999, 100, 1, 0]) {
      expect(selectSignalTarget({ spawned, initializePid, hostPid: 100, s1: S1 })).toEqual({
        target: spawned,
        source: 'spawned',
        launcherDetected: true,
      });
    }
  });

  it('falls back when the spawned start time does not match S1 (pid reused)', () => {
    expect(
      selectSignalTarget({
        spawned: { pid: 200, startTime: '19' },
        initializePid: 201,
        hostPid: 100,
        s1: S1,
      }).source,
    ).toBe('spawned');
  });
});

describe('maySignal', () => {
  it('requires a matching identity and refuses pid 0, pid 1 and the host', () => {
    expect(maySignal(cliIdentity, S1, 100)).toBe(true);
    expect(maySignal({ pid: 201, startTime: '22' }, S1, 100)).toBe(false);
    expect(maySignal({ pid: 999, startTime: '22' }, S1, 100)).toBe(false);
    expect(maySignal({ pid: 100, startTime: '10' }, S1, 100)).toBe(false);
    expect(maySignal({ pid: 1, startTime: '0' }, S1, 100)).toBe(false);
    expect(maySignal({ pid: 0, startTime: '0' }, snap([rec(0, 0, 0, '0')]), 100)).toBe(false);
  });
});

describe('planSweep', () => {
  it('selects verified descendants and the tool group, never the host, launcher or CLI group', () => {
    const plan = planSweep({
      spawned,
      signalTarget: cliIdentity,
      hostPid: 100,
      recorded: [S1],
      latest: S1,
    });
    expect(plan.processes).toEqual([
      cliIdentity,
      { pid: 300, startTime: '30' },
      { pid: 301, startTime: '31' },
    ]);
    expect(plan.groups).toEqual([{ pgid: 300, leader: { pid: 300, startTime: '30' } }]);
    expect(plan.skippedGroups).toEqual([]);
  });

  it('skips exited and reused pids, and admits processes forked after the snapshots', () => {
    const latest = snap([
      rec(1, 0, 1, '0'),
      HOST,
      rec(300, 1, 300, '30'), // reparented to init: still verified by identity
      rec(301, 1, 777, '99'), // pid 301 reused by a foreign process
      rec(302, 300, 300, '50'), // forked by the tool after S2
      rec(303, 302, 300, '51'),
    ]);
    const plan = planSweep({
      spawned,
      signalTarget: cliIdentity,
      hostPid: 100,
      recorded: [S1],
      latest,
    });
    expect(plan.processes.map((identity) => identity.pid)).toEqual([300, 302, 303]);
    expect(plan.skippedProcesses).toEqual([
      { pid: 201, reason: 'exited' },
      { pid: 301, reason: 'identity-changed' },
    ]);
    expect(plan.groups.map((group) => group.pgid)).toEqual([300]);
  });

  it('unions S1 and S2 and prefers a verified record over an earlier mismatch', () => {
    const s2 = snap([HOST, LAUNCHER, CLI, TOOL, rec(301, 300, 300, '35')]);
    const latest = snap([HOST, TOOL, rec(301, 300, 300, '35')]);
    const plan = planSweep({
      spawned,
      signalTarget: cliIdentity,
      hostPid: 100,
      recorded: [S1, s2],
      latest,
    });
    expect(plan.processes).toEqual([
      { pid: 300, startTime: '30' },
      { pid: 301, startTime: '35' },
    ]);
    expect(plan.skippedProcesses).toEqual([{ pid: 201, reason: 'exited' }]);

    const reversed = planSweep({
      spawned,
      signalTarget: cliIdentity,
      hostPid: 100,
      recorded: [s2, S1],
      latest,
    });
    expect(reversed.processes).toEqual(plan.processes);
    expect(reversed.skippedProcesses).toEqual(plan.skippedProcesses);
  });

  it('refuses a group with a member that is not a verified descendant', () => {
    const latest = snap([...S1.records, rec(500, 1, 300, '60')]);
    const plan = planSweep({
      spawned,
      signalTarget: cliIdentity,
      hostPid: 100,
      recorded: [S1],
      latest,
    });
    expect(plan.groups).toEqual([]);
    expect(plan.skippedGroups).toEqual([{ pgid: 300, reason: 'foreign-member' }]);
    expect(plan.processes.map((identity) => identity.pid)).toEqual([201, 300, 301]);
  });

  it('refuses a group when the latest snapshot has a duplicated member pid', () => {
    const latest = snap([...S1.records, rec(301, 300, 300, '31')]);
    expect(
      planSweep({ spawned, signalTarget: cliIdentity, hostPid: 100, recorded: [S1], latest })
        .skippedGroups,
    ).toEqual([{ pgid: 300, reason: 'foreign-member' }]);
  });

  it('withholds every group when the host group is unknown', () => {
    const noHost = snap(S1.records.filter((record) => record.pid !== 100));
    const plan = planSweep({
      spawned,
      signalTarget: cliIdentity,
      hostPid: 100,
      recorded: [noHost],
      latest: noHost,
    });
    expect(plan.groups).toEqual([]);
    expect(plan.skippedGroups).toEqual([{ pgid: 300, reason: 'host-group-unknown' }]);
  });

  it('takes the host group from a recorded snapshot when the latest lacks the host', () => {
    const latest = snap(S1.records.filter((record) => record.pid !== 100));
    const s2 = snap([rec(100, 1, 300, '10'), LAUNCHER, CLI, TOOL, SLEEP]);
    const plan = planSweep({
      spawned,
      signalTarget: cliIdentity,
      hostPid: 100,
      recorded: [s2],
      latest,
    });
    expect(plan.skippedGroups).toEqual([{ pgid: 300, reason: 'protected-group' }]);
  });

  it('never selects the group of the CLI, the launcher or the host, even when led by a descendant', () => {
    // The CLI leads its own group (setsid), and a tool leads the host's group id.
    const cli = rec(201, 200, 201, '21');
    const s = snap([HOST, LAUNCHER, cli, rec(300, 201, 201, '30'), rec(90, 201, 90, '25')]);
    const plan = planSweep({
      spawned,
      signalTarget: cliIdentity,
      hostPid: 100,
      recorded: [s],
      latest: s,
    });
    expect(plan.groups).toEqual([]);
    expect(plan.skippedGroups).toEqual([
      { pgid: 90, reason: 'protected-group' },
      { pgid: 201, reason: 'protected-group' },
    ]);
  });

  it('marks pid 0, pid 1, the host and the spawned pid as protected even if they look like descendants', () => {
    const s = snap([
      HOST,
      LAUNCHER,
      rec(1, 200, 1, '25'),
      rec(0, 200, 0, '25'),
      rec(100, 200, 90, '25'),
    ]);
    const weird = snap([
      rec(100, 200, 90, '25'),
      LAUNCHER,
      rec(1, 200, 1, '25'),
      rec(0, 200, 0, '25'),
    ]);
    const plan = planSweep({
      spawned,
      signalTarget: spawned,
      hostPid: 100,
      recorded: [s, weird],
      latest: weird,
    });
    expect(plan.processes).toEqual([]);
    expect(plan.groups).toEqual([]);
    expect(plan.skippedProcesses).toEqual([
      { pid: 0, reason: 'protected' },
      { pid: 1, reason: 'protected' },
      { pid: 100, reason: 'protected' },
    ]);
  });

  it('protects the spawned pid when it reappears as a forked descendant', () => {
    // pid 200 was reused by a child of the CLI after the launcher exited.
    const plan = planSweep({
      spawned: { pid: 200, startTime: '20' },
      signalTarget: cliIdentity,
      hostPid: 100,
      recorded: [snap([HOST, LAUNCHER, CLI])],
      latest: snap([HOST, rec(500, 1, 90, '1'), CLI, rec(200, 201, 90, '21')]),
    });
    expect(plan.processes).toEqual([cliIdentity]);
    expect(plan.skippedProcesses).toEqual([{ pid: 200, reason: 'protected' }]);
  });

  it('plans nothing for Windows records, which have no groups', () => {
    const win: ProcessSnapshot = {
      source: 'win32-cim',
      records: [
        { pid: 100, ppid: 4, startTime: '10', name: 'host' },
        { pid: 200, ppid: 100, startTime: '20', name: 'cli' },
        { pid: 300, ppid: 200, startTime: '30', name: 'bash' },
      ],
      rejected: 0,
    };
    const plan = planSweep({
      spawned,
      signalTarget: spawned,
      hostPid: 100,
      recorded: [win],
      latest: win,
    });
    expect(plan.processes).toEqual([{ pid: 300, startTime: '30' }]);
    expect(plan.groups).toEqual([]);
    expect(plan.skippedGroups).toEqual([]);
  });

  it('on the recorded Linux tree, selects the job-control groups and never pid 1', async () => {
    const snapshot = await takeSnapshot(fixtureProcTable());
    const root = { pid: 8, startTime: '35280232' };
    const plan = planSweep({
      spawned: root,
      signalTarget: root,
      hostPid: 1,
      recorded: [snapshot],
      latest: snapshot,
    });
    expect(plan.processes.map((identity) => identity.pid)).toEqual([16, 17, 18, 19, 20, 22, 23]);
    expect(plan.groups.map((group) => group.pgid)).toEqual([16, 17, 18, 19, 20]);
  });

  it('on the synthesized macOS tree, targets the CLI and its tool groups only', async () => {
    const snapshot = await takeSnapshot({
      source: 'darwin-ps',
      runPs: () => Promise.resolve(fixture('darwin/ps.synthesized.out')),
    });
    const launcher = snapshot.records.find((record) => record.pid === 501);
    expect(launcher).toBeDefined();
    if (launcher === undefined) return;
    const decision = selectSignalTarget({
      spawned: launcher,
      initializePid: 502,
      hostPid: 500,
      s1: snapshot,
    });
    expect(decision.source).toBe('initialize-pid');
    const plan = planSweep({
      spawned: launcher,
      signalTarget: decision.target,
      hostPid: 500,
      recorded: [snapshot],
      latest: snapshot,
    });
    expect(plan.processes.map((identity) => identity.pid)).toEqual([
      502, 510, 511, 520, 521, 530, 531,
    ]);
    expect(plan.groups.map((group) => group.pgid)).toEqual([510, 520, 530]);
  });
});
