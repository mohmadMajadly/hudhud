/**
 * Property tests of the tree and identity invariants against a generated
 * ground truth: a process history with known ancestry, pid reuse and
 * reparenting, from which snapshots are derived. The functions under test
 * see only the snapshots; the assertions use the truth.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { descendantsOf } from '../../../src/process/tree/descendants.js';
import { planSweep, selectSignalTarget } from '../../../src/process/tree/select.js';
import type {
  ProcessIdentity,
  ProcessRecord,
  ProcessSnapshot,
} from '../../../src/process/tree/types.js';
import { fcParams } from './support.js';

/** `linux`: a dead parent's children are reparented to pid 1. `win32`: ppid stays stale, no groups. */
type Mode = 'linux' | 'win32';

interface TrueProcess {
  readonly pid: number;
  /** Index of the parent in the history, or null for a child of init. */
  readonly parent: number | null;
  readonly birth: number;
  readonly death: number;
  readonly pgid: number;
}

/**
 * Records injected directly into one snapshot, beyond what the history
 * produces: `stale-foreign` is a foreign process older than the record whose
 * pid its ppid names (a stale Windows ppid, or an adversarial table), in any
 * group; `protected-child` is a true child of a record that reuses pid 0, the
 * root's pid or the host's pid.
 */
interface Injection {
  readonly kind: 'stale-foreign' | 'protected-child';
  readonly snapshot: number;
  readonly targetPick: number;
  readonly groupPick: number;
  readonly pidPick: number;
  readonly age: number;
}

interface World {
  readonly mode: Mode;
  readonly history: readonly TrueProcess[];
  readonly hostPid: number;
  readonly times: readonly number[];
  readonly initializePid: number;
  readonly injections: readonly Injection[];
}

const HOST = 0;
const ROOT = 1;
const HOST_PID = 100;
const FOREVER = Number.MAX_SAFE_INTEGER;
/**
 * Small pid pool, so pids are reused often. It holds the root's pid (2) and
 * the host's group id (90), so descendants can reuse both.
 */
const POOL = [2, 3, 4, 5, 6, 7, 8, 90];

/** `items[index]`, which the generator guarantees to exist. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}

function alive(process: TrueProcess, time: number): boolean {
  return process.birth <= time && time < process.death;
}

const processSpec = fc.record({
  parentPick: fc.nat(),
  pidPick: fc.nat(),
  lifetime: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null, freq: 4 }),
  leader: fc.boolean(),
  orphanOfInit: fc.boolean(),
  /** Adversarial `setpgid` into any group alive at birth (the kernel is stricter). */
  adoptPgid: fc.option(fc.nat(), { nil: null }),
});

const worldArbitrary: fc.Arbitrary<World> = fc
  .record({
    mode: fc.constantFrom<Mode>('linux', 'win32'),
    hostLeads: fc.boolean(),
    rootLifetime: fc.option(fc.integer({ min: 1, max: 200 }), { nil: null, freq: 3 }),
    specs: fc.array(processSpec, { maxLength: 40 }),
    timePicks: fc.array(fc.nat(), { minLength: 3, maxLength: 3 }),
    initializePick: fc.nat(),
    injections: fc.array(
      fc.record({
        kind: fc.constantFrom<Injection['kind']>('stale-foreign', 'protected-child'),
        snapshot: fc.constantFrom(0, 1, 2, 2, 2),
        targetPick: fc.nat(),
        groupPick: fc.nat(),
        pidPick: fc.nat(),
        age: fc.integer({ min: 1, max: 30 }),
      }),
      { maxLength: 6 },
    ),
  })
  .map(({ mode, hostLeads, rootLifetime, specs, timePicks, initializePick, injections }) => {
    const hostPgid = hostLeads ? HOST_PID : 90;
    const history: TrueProcess[] = [
      { pid: HOST_PID, parent: null, birth: 10, death: FOREVER, pgid: hostPgid },
    ];
    const rootBirth = 20;
    const rootPid = at(POOL, 0);
    history.push({
      pid: rootPid,
      parent: HOST,
      birth: rootBirth,
      death: rootLifetime === null ? FOREVER : rootBirth + rootLifetime,
      pgid: hostPgid,
    });
    specs.forEach((spec, index) => {
      // Strictly increasing births: a child never shares a start time with a reused pid.
      const birth = 30 + index * 10;
      const death = spec.lifetime === null ? FOREVER : birth + spec.lifetime;
      const parentIndex = spec.parentPick % history.length;
      const parentProcess = at(history, parentIndex);
      const parent = spec.orphanOfInit || !alive(parentProcess, birth) ? null : parentIndex;
      const free = POOL.filter((pid) =>
        history.every((other) => other.pid !== pid || other.death <= birth || other.birth >= death),
      );
      const pid = free.length > 0 ? at(free, spec.pidPick % free.length) : 1000 + index;
      const groupsAlive = history.filter((other) => alive(other, birth)).map((other) => other.pgid);
      const pgid =
        spec.adoptPgid !== null
          ? at(groupsAlive, spec.adoptPgid % groupsAlive.length)
          : spec.leader
            ? pid
            : parent === null
              ? 1
              : at(history, parent).pgid;
      history.push({ pid, parent, birth, death, pgid });
    });
    const horizon = 30 + specs.length * 10 + 10;
    const times = timePicks.map((pick) => 20 + (pick % horizon)).sort((a, b) => a - b);
    const pids = [...new Set(history.map((process) => process.pid)), 1, 0, 999];
    return {
      mode,
      history,
      hostPid: HOST_PID,
      times,
      initializePid: at(pids, initializePick % pids.length),
      injections,
    };
  });

/**
 * The snapshot at `world.times[index]`, with the injections of the given
 * kinds for that index; injected true descendants are added to `truth`.
 */
function snapshotAt(
  world: World,
  index: number,
  kinds: readonly Injection['kind'][] = [],
  truth?: Set<string>,
): ProcessSnapshot {
  const time = at(world.times, index);
  const records: ProcessRecord[] = [{ pid: 1, ppid: 0, pgid: 1, startTime: '0', name: 'init' }];
  for (const process of world.history) {
    if (!alive(process, time)) continue;
    const parent = process.parent === null ? null : at(world.history, process.parent);
    const ppid =
      parent === null ? 1 : world.mode === 'win32' || alive(parent, time) ? parent.pid : 1;
    const base = { pid: process.pid, ppid, startTime: String(process.birth), name: 'x' };
    records.push(world.mode === 'linux' ? { ...base, pgid: process.pgid } : base);
  }
  const real = [...records];
  world.injections.forEach((injection, n) => {
    if (injection.snapshot !== index || !kinds.includes(injection.kind)) return;
    const target = at(real, injection.targetPick % real.length);
    const group = at(real, injection.groupPick % real.length).pgid;
    const start = Number(target.startTime);
    let injected: ProcessRecord;
    if (injection.kind === 'stale-foreign') {
      if (start === 0) return;
      injected = {
        pid: 5000 + n,
        ppid: target.pid,
        startTime: String(Math.max(0, start - injection.age)),
        name: 'stale',
      };
    } else {
      const protectedPids = [0, 0, at(world.history, ROOT).pid, world.hostPid];
      const pid = at(protectedPids, injection.pidPick % protectedPids.length);
      injected = { pid, ppid: target.pid, startTime: String(start + injection.age), name: 'reuse' };
      const parentIsDescendant =
        truth?.has(key(target)) === true || key(target) === key(rootIdentity(world));
      if (parentIsDescendant) truth?.add(key(injected));
    }
    records.push(
      world.mode === 'linux' && group !== undefined ? { ...injected, pgid: group } : injected,
    );
  });
  return { source: world.mode === 'linux' ? 'linux-proc' : 'win32-cim', records, rejected: 0 };
}

function key(identity: ProcessIdentity): string {
  return `${String(identity.pid)}@${identity.startTime}`;
}

/** Identities of every process whose true ancestry reaches the root. */
function trueDescendants(world: World): Set<string> {
  const result = new Set<string>();
  world.history.forEach((process, index) => {
    for (let cursor = process.parent; cursor !== null; cursor = at(world.history, cursor).parent) {
      if (cursor === ROOT && index !== ROOT) {
        result.add(key({ pid: process.pid, startTime: String(process.birth) }));
        return;
      }
    }
  });
  return result;
}

function rootIdentity(world: World): ProcessIdentity {
  const root = at(world.history, ROOT);
  return { pid: root.pid, startTime: String(root.birth) };
}

describe('tree and identity invariants (property)', () => {
  it('descendantsOf returns only true descendants, and all whose chain is alive', () => {
    fc.assert(
      fc.property(worldArbitrary, (world) => {
        const truth = trueDescendants(world);
        world.times.forEach((time, index) => {
          const snapshot = snapshotAt(world, index, ['stale-foreign']);
          const { descendants } = descendantsOf(snapshot.records, rootIdentity(world));
          for (const record of descendants) expect(truth.has(key(record))).toBe(true);

          // Completeness: a descendant whose whole chain up to the root is alive is found.
          const found = new Set(descendants.map(key));
          world.history.forEach((process, index) => {
            let chainAlive = alive(process, time);
            let cursor = process.parent;
            while (chainAlive && cursor !== null && cursor !== ROOT) {
              const ancestor = at(world.history, cursor);
              chainAlive = alive(ancestor, time);
              cursor = ancestor.parent;
            }
            const root = at(world.history, ROOT);
            if (index !== ROOT && cursor === ROOT && chainAlive && alive(root, time)) {
              expect(found.has(key({ pid: process.pid, startTime: String(process.birth) }))).toBe(
                true,
              );
            }
          });
        });
      }),
      fcParams(),
    );
  });

  it('the sweep never selects a foreign process, a changed start time, or a protected pid or group', () => {
    fc.assert(
      fc.property(worldArbitrary, fc.boolean(), (world, withS2) => {
        const truth = trueDescendants(world);
        const kinds = ['stale-foreign', 'protected-child'] as const;
        const s1 = snapshotAt(world, 0, kinds, truth);
        const s2 = snapshotAt(world, 1, kinds, truth);
        const latest = snapshotAt(world, 2, kinds, truth);
        const spawned = rootIdentity(world);

        const decision = selectSignalTarget({
          spawned,
          initializePid: world.initializePid,
          hostPid: world.hostPid,
          s1,
        });
        if (decision.source === 'initialize-pid') {
          expect(decision.target.pid).toBe(world.initializePid);
          expect(truth.has(key(decision.target))).toBe(true);
          expect(s1.records.some((record) => key(record) === key(decision.target))).toBe(true);
        } else {
          expect(decision.target).toEqual(spawned);
        }

        const plan = planSweep({
          spawned,
          signalTarget: decision.target,
          hostPid: world.hostPid,
          recorded: withS2 ? [s1, s2] : [s1],
          latest,
        });
        const latestKeys = new Set(latest.records.map(key));
        for (const identity of plan.processes) {
          expect(truth.has(key(identity))).toBe(true);
          expect(latestKeys.has(key(identity))).toBe(true);
          expect([0, 1, world.hostPid, spawned.pid]).not.toContain(identity.pid);
        }

        const host = at(world.history, HOST);
        const root = at(world.history, ROOT);
        const target = world.history.find(
          (process) =>
            process.pid === decision.target.pid &&
            String(process.birth) === decision.target.startTime,
        );
        if (target === undefined) throw new Error('the signal target is not in the history');
        for (const group of plan.groups) {
          expect([0, 1, host.pgid, root.pgid, target.pgid]).not.toContain(group.pgid);
          expect(group.leader.pid).toBe(group.pgid);
          expect(truth.has(key(group.leader))).toBe(true);
          for (const member of latest.records.filter((record) => record.pgid === group.pgid)) {
            expect(truth.has(key(member))).toBe(true);
          }
        }
        if (world.mode === 'win32') expect(plan.groups).toEqual([]);
      }),
      fcParams(1000),
    );
  });
});
