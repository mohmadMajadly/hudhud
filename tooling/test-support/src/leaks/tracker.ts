/**
 * Leak assertions: no process outlives its test (plan §4.7; 07 §13).
 *
 * @remarks
 * A {@link LeakTracker} takes a process snapshot before the test, records
 * every spawned root by pid plus start time, samples the descendants of
 * everything it knows while the test runs, and after the test reports as a
 * leak:
 *
 * - every recorded root or sampled descendant still alive with the same
 *   pid and start time (`tracked`);
 * - every process absent from the before snapshot whose parent is a known
 *   process and which started no earlier than that parent (`descendant`;
 *   catches children spawned after the last sample, and on Windows, where
 *   the parent pid of an orphan keeps naming its dead parent, orphans too);
 * - every process whose command line contains the marker, normally the
 *   sandbox root (`command-line`, the 07 §13 sweep).
 *
 * Leaks fail the test and are then killed, each only after its pid and
 * start time were confirmed again in a fresh snapshot. The tracker never
 * reports or kills its own process.
 */

import type { ProcessRow, ProcessTable } from './process-table.js';

/** Why a process counts as leaked. */
export type LeakReason = 'tracked' | 'descendant' | 'command-line';

/** A leaked process. */
export interface LeakedProcess extends ProcessRow {
  readonly reason: LeakReason;
}

/** The identity of a process: pid plus start time. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
}

/** Outcome of one verified kill. */
export type KillOutcome = 'killed' | 'gone' | 'survived';

/** Thrown by {@link LeakTracker.assertNoLeaks} and {@link assertNoSurvivors}. */
export class LeakError extends Error {
  override readonly name = 'LeakError';
  readonly leaks: readonly LeakedProcess[];
  /** What the verified kill did to each leak, in the same order. */
  readonly outcomes: readonly KillOutcome[];

  constructor(leaks: readonly LeakedProcess[], outcomes: readonly KillOutcome[]) {
    const lines = leaks.map(
      (leak, index) =>
        `  pid ${String(leak.pid)} start ${leak.startTime} ${leak.reason} ${JSON.stringify(leak.name)} ${JSON.stringify(leak.commandLine.slice(0, 200))} -> ${String(outcomes[index])}`,
    );
    super(`${String(leaks.length)} leaked process(es)\n${lines.join('\n')}`);
    this.leaks = leaks;
    this.outcomes = outcomes;
  }
}

/** Host operations of the tracker, injected for tests. */
export interface LeakHost {
  readonly table: ProcessTable;
  /** The host process's pid; never reported, never killed. Default `process.pid`. */
  readonly selfPid?: number | undefined;
  /** Forcefully terminates `pid`. Default `process.kill(pid, 'SIGKILL')`. */
  readonly kill?: ((pid: number) => void) | undefined;
  /** Waits between the post-kill checks. Default a real timer. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Options of {@link LeakTracker}. */
export interface LeakTrackerOptions extends LeakHost {
  /**
   * Text whose presence in a command line marks a process as belonging to
   * the test (the sandbox root). At least 8 characters. Compared
   * case-insensitively on Windows.
   */
  readonly marker?: string | undefined;
}

const KILL_CHECKS = 20;
const KILL_CHECK_MS = 100;

function key(identity: ProcessIdentity): string {
  return `${String(identity.pid)}@${identity.startTime}`;
}

function startedNoEarlier(child: ProcessRow, parent: ProcessRow): boolean {
  return BigInt(child.startTime) >= BigInt(parent.startTime);
}

function defaultKill(pid: number): void {
  process.kill(pid, 'SIGKILL');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markerMatcher(
  table: ProcessTable,
  marker: string | undefined,
): (row: ProcessRow) => boolean {
  if (marker === undefined) return () => false;
  if (marker.length < 8) throw new Error(`leak marker ${JSON.stringify(marker)} is too short`);
  if (table.source !== 'win32-cim') return (row) => row.commandLine.includes(marker);
  const variants = [marker.toLowerCase(), marker.toLowerCase().replaceAll('\\', '/')];
  return (row) => {
    const line = row.commandLine.toLowerCase();
    return variants.some((variant) => line.includes(variant));
  };
}

/**
 * Kills `identity` only if a fresh snapshot still shows that pid with that
 * start time, then waits until it is gone.
 */
export async function killVerified(
  identity: ProcessIdentity,
  host: LeakHost,
): Promise<KillOutcome> {
  const kill = host.kill ?? defaultKill;
  const sleep = host.sleep ?? defaultSleep;
  const alive = async (): Promise<boolean> =>
    (await host.table.read()).some(
      (row) => row.pid === identity.pid && row.startTime === identity.startTime,
    );
  if (identity.pid === (host.selfPid ?? process.pid) || !(await alive())) return 'gone';
  try {
    kill(identity.pid);
  } catch {
    // exited between the check and the kill; confirmed below
  }
  for (let check = 0; check < KILL_CHECKS; check += 1) {
    if (!(await alive())) return 'killed';
    await sleep(KILL_CHECK_MS);
  }
  return 'survived';
}

async function killAll(leaks: readonly LeakedProcess[], host: LeakHost): Promise<KillOutcome[]> {
  const outcomes: KillOutcome[] = [];
  for (const leak of leaks) outcomes.push(await killVerified(leak, host));
  return outcomes;
}

/**
 * The 07 §13 sweep: every process (except the host's) whose command line
 * contains `marker`.
 */
export async function findSurvivors(
  host: LeakHost,
  marker: string,
): Promise<readonly LeakedProcess[]> {
  const matches = markerMatcher(host.table, marker);
  const self = host.selfPid ?? process.pid;
  return (await host.table.read())
    .filter((row) => row.pid !== self && matches(row))
    .map((row) => ({ ...row, reason: 'command-line' as const }));
}

/**
 * Suite-level assertion (`afterAll`, plan §4.7): fails when any process
 * still names `marker` in its command line, after killing each by verified
 * identity.
 *
 * @throws LeakError
 */
export async function assertNoSurvivors(host: LeakHost, marker: string): Promise<void> {
  const survivors = await findSurvivors(host, marker);
  if (survivors.length === 0) return;
  throw new LeakError(survivors, await killAll(survivors, host));
}

interface SamplingState {
  stop: boolean;
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;
  error: Error | undefined;
}

/** Records spawned roots, samples their trees and reports leaks (see the module comment). */
export class LeakTracker {
  readonly #host: LeakHost;
  readonly #matches: (row: ProcessRow) => boolean;
  readonly #self: number;
  #before: ReadonlySet<string> = new Set();
  readonly #known = new Map<string, ProcessRow>();
  #sampling: SamplingState | undefined;

  constructor(options: LeakTrackerOptions) {
    this.#host = options;
    this.#matches = markerMatcher(options.table, options.marker);
    this.#self = options.selfPid ?? process.pid;
  }

  /** The processes tracked so far (roots and sampled descendants). */
  get tracked(): readonly ProcessRow[] {
    return [...this.#known.values()];
  }

  /** Takes the before snapshot. Call before the test spawns anything. */
  async begin(): Promise<void> {
    this.#before = new Set((await this.#host.table.read()).map(key));
  }

  /**
   * Records a spawned root by its pid; its start time comes from a fresh
   * snapshot, so call this right after the spawn.
   *
   * @throws Error when the pid is not in the table (already exited).
   */
  async recordRoot(pid: number): Promise<ProcessRow> {
    const row = (await this.#host.table.read()).find((candidate) => candidate.pid === pid);
    if (row === undefined)
      throw new Error(`root pid ${String(pid)} is not running; record it right after the spawn`);
    this.#known.set(key(row), row);
    return row;
  }

  /** Adds every current descendant of a known process. Returns how many are known. */
  async sample(): Promise<number> {
    this.#absorb(await this.#host.table.read(), () => true);
    return this.#known.size;
  }

  #absorb(rows: readonly ProcessRow[], eligible: (row: ProcessRow) => boolean): ProcessRow[] {
    const added: ProcessRow[] = [];
    let grew = true;
    while (grew) {
      grew = false;
      const byPid = new Map<number, ProcessRow>();
      for (const known of this.#known.values()) byPid.set(known.pid, known);
      for (const row of rows) {
        if (row.pid === this.#self || this.#known.has(key(row)) || !eligible(row)) continue;
        const parent = byPid.get(row.ppid);
        if (parent === undefined || !startedNoEarlier(row, parent)) continue;
        this.#known.set(key(row), row);
        added.push(row);
        grew = true;
      }
    }
    return added;
  }

  /**
   * Samples every `intervalMs` until the returned function is called (plan
   * §4.7: Linux 250 ms, Windows 1 s). The stop function waits for an
   * in-flight sample and rejects with the first sampling error.
   */
  startSampling(intervalMs: number): () => Promise<void> {
    if (this.#sampling !== undefined) throw new Error('sampling already started');
    const state: SamplingState = {
      stop: false,
      timer: undefined,
      running: undefined,
      error: undefined,
    };
    this.#sampling = state;
    const tick = (): void => {
      state.running = this.sample()
        .then(
          () => undefined,
          (error: unknown) => {
            state.error ??= new Error('process sampling failed', { cause: error });
          },
        )
        .then(() => {
          if (!state.stop) state.timer = setTimeout(tick, intervalMs);
        });
    };
    tick();
    return async () => {
      state.stop = true;
      clearTimeout(state.timer);
      await state.running;
      this.#sampling = undefined;
      if (state.error !== undefined) throw state.error;
    };
  }

  /** Current leaks per the module comment, without killing anything. */
  async findLeaks(): Promise<readonly LeakedProcess[]> {
    const rows = (await this.#host.table.read()).filter((row) => row.pid !== this.#self);
    const tracked = new Set(this.#known.keys());
    const descendants = new Set(this.#absorb(rows, (row) => !this.#before.has(key(row))).map(key));
    const leaks: LeakedProcess[] = [];
    for (const row of rows) {
      const id = key(row);
      if (tracked.has(id)) leaks.push({ ...row, reason: 'tracked' });
      else if (descendants.has(id)) leaks.push({ ...row, reason: 'descendant' });
      else if (this.#matches(row)) leaks.push({ ...row, reason: 'command-line' });
    }
    return leaks;
  }

  /**
   * `afterEach` assertion: fails when anything leaked, after killing every
   * leak by verified identity.
   *
   * @throws LeakError
   */
  async assertNoLeaks(): Promise<void> {
    const leaks = await this.findLeaks();
    if (leaks.length === 0) return;
    throw new LeakError(leaks, await killAll(leaks, this.#host));
  }
}
