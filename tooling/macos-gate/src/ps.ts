/**
 * The macOS process table through `/bin/ps` and the core parser (ADR-0010
 * "Sweep", plan §1.7), and the harness's cleanup ledger (plan §4.7).
 *
 * Every process the harness spawns is recorded with its identity (pid plus
 * `lstart` start time) in the ledger, together with every snapshot taken
 * while it lived. At the end of each session and of the run, the ledger
 * kills what is left by verified identity only, through the core's pure
 * sweep planner: a pid is signalled only while it still has the start time
 * it was recorded with, and a group only when its leader and every member
 * are verified descendants.
 */

import path from 'node:path';

import {
  descendantsOf,
  findIdentity,
  type DescendantTree,
} from '../../../packages/core/src/process/tree/descendants.js';
import { maySignal, planSweep } from '../../../packages/core/src/process/tree/select.js';
import { takeSnapshot } from '../../../packages/core/src/process/tree/snapshot.js';
import type {
  ProcessIdentity,
  ProcessRecord,
  ProcessSnapshot,
} from '../../../packages/core/src/process/tree/types.js';
import type { GateHost } from './host.js';

/**
 * The `ps` contract of the core (`DarwinPsTableCalls`), confirmed by gate
 * item 2. `-ww` as in the core (review R3-U2): the `comm` column is never
 * cut to a terminal or default width.
 */
export const PS_PATH = '/bin/ps';
export const PS_ARGS: readonly string[] = [
  '-A',
  '-ww',
  '-o',
  'pid=,ppid=,pgid=,stat=,lstart=,comm=',
];
export const PS_ENV: Readonly<Record<string, string>> = { LC_ALL: 'C', TZ: 'UTC0' };

/** One `ps` read through the core parser. Rejects when `ps` fails. */
export async function psSnapshot(host: GateHost): Promise<ProcessSnapshot> {
  return takeSnapshot({
    source: 'darwin-ps',
    runPs: async () => {
      const result = await host.run(PS_PATH, PS_ARGS, { env: PS_ENV, timeoutMs: 15_000 });
      if (result.code !== 0) {
        throw new Error(
          `${PS_PATH} failed: code ${String(result.code)} signal ${String(result.signal)} error ${String(result.error)}`,
        );
      }
      return result.stdout;
    },
  });
}

const MAX_RAW_LINES = 32;

/**
 * Evidence of the exact `ps` format: the raw output lines (padding kept,
 * as JSON strings in the report) of the given pids, at most 32. Rejects when
 * `ps` fails.
 */
export async function psRawLines(host: GateHost, pids: readonly number[]): Promise<string[]> {
  const result = await host.run(PS_PATH, PS_ARGS, { env: PS_ENV, timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(`${PS_PATH} failed: code ${String(result.code)}`);
  const wanted = new Set(pids);
  return new TextDecoder()
    .decode(result.stdout)
    .split('\n')
    .filter((line) => wanted.has(Number(/^ *([0-9]+) /.exec(line)?.[1] ?? '-1')))
    .slice(0, MAX_RAW_LINES);
}

/** `(<p_comm>)`: how macOS `ps` prints a process whose arguments it cannot read. */
const KERNEL_NAME = /^\(([\s\S]*)\)$/;

/**
 * The command name of a `comm` value: the basename without the leading `-`
 * of a login shell, or the kernel name inside the parentheses that macOS
 * `ps` prints when it cannot read the arguments (every zombie; gate run 1
 * saw `(security)`, `(git)`, `(xcodebuild)`). The kernel name is at most 16
 * bytes and has no directory.
 */
export function commandName(name: string): string {
  if (KERNEL_NAME.test(name)) return name.slice(1, -1);
  return path.posix.basename(name).replace(/^-/, '');
}

/** How a record appears in the evidence: its `comm` value, plus ` [zombie]` for a zombie. */
export function recordLabel(record: ProcessRecord): string {
  return record.zombie === true ? `${record.name} [zombie]` : record.name;
}

/**
 * The record of `identity` when it is still present and alive: a zombie
 * holds its pid but runs nothing, so it is not a survivor.
 */
export function liveIdentity(
  records: readonly ProcessRecord[],
  identity: ProcessIdentity,
): ProcessRecord | null {
  const record = findIdentity(records, identity);
  return record?.zombie === true ? null : record;
}

/** `pid@startTime`. */
export function identityLabel(identity: ProcessIdentity): string {
  return `${String(identity.pid)}@${identity.startTime}`;
}

/** Cleanup outcome of one root or of the whole run. */
export interface SweepOutcome {
  readonly signalled: readonly string[];
  readonly survivors: readonly string[];
}

interface RootEntry {
  readonly identity: ProcessIdentity;
  /** Snapshots in which the root was present with descendants (bounded). */
  readonly recorded: ProcessSnapshot[];
  done: boolean;
}

const MAX_RECORDED = 16;
const SETTLE_MS = 500;

/** Spawned roots and their recorded trees; see the module comment. */
export class ProcessLedger {
  private readonly host: GateHost;
  private readonly roots: RootEntry[] = [];

  constructor(host: GateHost) {
    this.host = host;
  }

  /**
   * Records the identity of a freshly spawned pid from a new snapshot, or
   * `null` when it already exited (nothing to clean up then).
   */
  async register(pid: number): Promise<ProcessRecord | null> {
    const snapshot = await psSnapshot(this.host);
    const record = snapshot.records.find((entry) => entry.pid === pid) ?? null;
    if (record !== null) {
      this.roots.push({
        identity: { pid: record.pid, startTime: record.startTime },
        recorded: [snapshot],
        done: false,
      });
    }
    return record;
  }

  /** Records `snapshot` for every live root that has descendants in it. */
  observe(snapshot: ProcessSnapshot): void {
    for (const root of this.roots) {
      if (root.done || descendantsOf(snapshot.records, root.identity).descendants.length === 0) {
        continue;
      }
      root.recorded.push(snapshot);
      if (root.recorded.length > MAX_RECORDED) root.recorded.splice(1, 1);
    }
  }

  /** A new snapshot, observed, plus the tree of `root` in it. */
  async tree(
    root: ProcessIdentity,
  ): Promise<DescendantTree & { readonly snapshot: ProcessSnapshot }> {
    const snapshot = await psSnapshot(this.host);
    this.observe(snapshot);
    return { snapshot, ...descendantsOf(snapshot.records, root) };
  }

  /**
   * Kills what is left of `root` by verified identity: the root itself
   * (SIGKILL, when it still has its recorded start time), then every
   * verified descendant group and process from the recorded snapshots.
   * Returns what was signalled and what survived.
   */
  async sweep(root: ProcessIdentity): Promise<SweepOutcome> {
    const entry = this.roots.find(
      (candidate) =>
        candidate.identity.pid === root.pid && candidate.identity.startTime === root.startTime,
    );
    if (entry === undefined || entry.done) return { signalled: [], survivors: [] };
    const signalled: string[] = [];
    const first = await psSnapshot(this.host);
    if (maySignal(root, first, this.host.pid) && this.host.signal(root.pid, 'SIGKILL') === 'sent') {
      signalled.push(identityLabel(root));
      await this.host.sleep(SETTLE_MS);
    }
    const latest = await psSnapshot(this.host);
    const plan = planSweep({
      spawned: root,
      signalTarget: root,
      hostPid: this.host.pid,
      recorded: entry.recorded,
      latest,
    });
    for (const group of plan.groups) {
      if (this.host.signal(-group.pgid, 'SIGKILL') === 'sent')
        signalled.push(`-${String(group.pgid)}`);
    }
    for (const identity of plan.processes) {
      if (this.host.signal(identity.pid, 'SIGKILL') === 'sent')
        signalled.push(identityLabel(identity));
    }
    if (signalled.length > 0) await this.host.sleep(SETTLE_MS);
    const final = await psSnapshot(this.host);
    const watched = new Map<string, ProcessIdentity>([[identityLabel(root), root]]);
    for (const snapshot of entry.recorded) {
      for (const record of descendantsOf(snapshot.records, root).descendants) {
        watched.set(identityLabel(record), record);
      }
    }
    const survivors = [...watched.entries()]
      .filter(([, identity]) => liveIdentity(final.records, identity) !== null)
      .map(([label]) => label);
    entry.done = survivors.length === 0;
    return { signalled, survivors };
  }

  /** {@link ProcessLedger.sweep} over every root not yet cleaned up. */
  async sweepAll(): Promise<SweepOutcome> {
    const signalled: string[] = [];
    const survivors: string[] = [];
    for (const root of this.roots.filter((entry) => !entry.done)) {
      const outcome = await this.sweep(root.identity);
      signalled.push(...outcome.signalled);
      survivors.push(...outcome.survivors);
    }
    return { signalled, survivors };
  }
}
