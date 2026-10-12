import { describe, expect, it } from 'vitest';

import { sweep, type SweepRequest } from '../../src/process/sweep.js';
import { takeSnapshot } from '../../src/process/tree/snapshot.js';
import type { ProcessSnapshot } from '../../src/process/tree/types.js';
import {
  CLI,
  FakeWorld,
  FOREIGN,
  HOST,
  identity,
  INIT,
  LAUNCHER,
  rec,
  SLEEP,
  TOOL,
} from './ladder/fake-os.js';

async function recordS1(world: FakeWorld): Promise<ProcessSnapshot> {
  return takeSnapshot(world.processTable);
}

function request(recorded: readonly ProcessSnapshot[]): SweepRequest {
  return { spawned: identity(LAUNCHER), signalTarget: identity(CLI), recorded };
}

function deps(world: FakeWorld): Parameters<typeof sweep>[1] {
  return { hostPid: world.hostPid, processTable: world.processTable, signals: world.signals };
}

function log(world: FakeWorld): string[] {
  return world.calls.map(
    (call) => `${call.kind === 'group' ? '-' : ''}${String(call.id)} ${call.signal}`,
  );
}

describe('sweep', () => {
  it('kills the verified tool group first and does not re-signal its members by pid', async () => {
    const world = FakeWorld.standard();
    const s1 = await recordS1(world);
    world.remove(LAUNCHER.pid);
    world.remove(CLI.pid);
    const result = await sweep(request([s1]), deps(world));
    expect(log(world)).toEqual(['-300 SIGKILL']);
    expect(result.groups).toEqual([{ pgid: 300, outcome: 'sent' }]);
    expect(result.processes).toEqual([]);
    expect(result.coveredByGroup).toEqual([300, 301]);
    expect(result.summary).toEqual({ processesSignalled: 0, groupsSignalled: 1, skipped: 1 });
    expect(world.records.has(TOOL.pid) || world.records.has(SLEEP.pid)).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('signals members by pid when the group kill fails, and records adapter errors', async () => {
    const world = FakeWorld.standard();
    const s1 = await recordS1(world);
    world.onSignal = ({ call }) => {
      if (call.kind === 'group') return 'not-permitted';
      if (call.id === SLEEP.pid) throw new Error('EINVAL');
      return undefined;
    };
    const result = await sweep(request([s1]), deps(world));
    expect(log(world)).toEqual(['-300 SIGKILL', '201 SIGKILL', '300 SIGKILL', '301 SIGKILL']);
    expect(result.groups).toEqual([{ pgid: 300, outcome: 'not-permitted' }]);
    expect(result.processes).toEqual([
      { pid: 201, outcome: 'sent' },
      { pid: 300, outcome: 'sent' },
      { pid: 301, outcome: 'error' },
    ]);
    expect(result.summary).toEqual({ processesSignalled: 2, groupsSignalled: 0, skipped: 0 });
  });

  it('never signals a pid reused since the recorded snapshot', async () => {
    const world = FakeWorld.standard();
    const s1 = await recordS1(world);
    world.remove(LAUNCHER.pid);
    world.remove(CLI.pid);
    world.records.delete(SLEEP.pid);
    world.set(rec(SLEEP.pid, 1, 777, '99')); // a foreign process now holds pid 301
    const result = await sweep(request([s1]), deps(world));
    expect(world.calls.some((call) => call.id === SLEEP.pid || call.id === 777)).toBe(false);
    expect(result.plan?.skippedProcesses).toContainEqual({
      pid: SLEEP.pid,
      reason: 'identity-changed',
    });
    // The group still has only verified members (the reused pid left it).
    expect(log(world)).toEqual(['-300 SIGKILL']);
  });

  it('never kills a group that has a foreign member, but kills its verified members by pid', async () => {
    const world = FakeWorld.standard();
    const s1 = await recordS1(world);
    world.remove(LAUNCHER.pid);
    world.remove(CLI.pid);
    world.set(rec(500, 1, 300, '60')); // foreign process joined pgid 300
    const result = await sweep(request([s1]), deps(world));
    expect(result.plan?.skippedGroups).toEqual([{ pgid: 300, reason: 'foreign-member' }]);
    expect(log(world)).toEqual(['300 SIGKILL', '301 SIGKILL']);
    expect(world.records.has(500)).toBe(true);
  });

  it('withholds every group kill when the host group is unknown', async () => {
    const world = new FakeWorld(
      [INIT, LAUNCHER, CLI, TOOL, SLEEP, FOREIGN],
      identity(LAUNCHER),
      CLI.pid,
    );
    const s1 = await recordS1(world);
    const result = await sweep(request([s1]), deps(world));
    expect(result.plan?.skippedGroups).toEqual([{ pgid: 300, reason: 'host-group-unknown' }]);
    expect(world.calls.every((call) => call.kind === 'process')).toBe(true);
    expect(log(world)).toEqual(['201 SIGKILL', '300 SIGKILL', '301 SIGKILL']);
  });

  it('never kills the host group, even when a descendant leads a group with its id', async () => {
    // A descendant whose pid equals the host's pgid leads that group.
    const world = new FakeWorld(
      [INIT, HOST, LAUNCHER, CLI, rec(90, CLI.pid, 90, '25'), TOOL, SLEEP],
      identity(LAUNCHER),
      CLI.pid,
    );
    const s1 = await recordS1(world);
    const result = await sweep(request([s1]), deps(world));
    expect(result.plan?.skippedGroups).toEqual([{ pgid: 90, reason: 'protected-group' }]);
    expect(world.calls.filter((call) => call.kind === 'group').map((call) => call.id)).toEqual([
      300,
    ]);
    expect(world.records.has(HOST.pid)).toBe(true);
  });

  it('signals nothing when its own snapshot fails', async () => {
    const world = FakeWorld.standard();
    const s1 = await recordS1(world);
    world.failingReads.add(1);
    const result = await sweep(request([s1]), deps(world));
    expect(result).toEqual({
      plan: null,
      groups: [],
      processes: [],
      coveredByGroup: [],
      summary: { processesSignalled: 0, groupsSignalled: 0, skipped: 0 },
    });
    expect(world.calls).toEqual([]);
  });
});
