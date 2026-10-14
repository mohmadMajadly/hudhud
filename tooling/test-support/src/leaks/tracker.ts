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
 *   the parent pid of an orphan keeps naming its dead parent, orphans too;
 *   not a child of another process that now holds the known parent's pid);
 * - every process whose command line contains the marker, normally the
 *   sandbox root (`command-line`, the 07 §13 sweep).
 *
 * On Windows the `conhost.exe` of a recorded root that has exited gets a
 * bounded settle window first ({@link CONHOST_SETTLE_MS}): it is a leak
 * only if a fresh read after the window still lists it. Every other
 * survivor is a leak at once.
 *
 * Leaks fail the test and are then killed, each only after its pid and
 * start time were confirmed again in a fresh snapshot, within one deadline
 * per leak ({@link KILL_DEADLINE_MS}); the {@link LeakError} names what
 * happened to each one. The tracker never reports or kills its own process.
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

/** Outcome of one verified kill ({@link killVerified}). */
export type KillOutcome = 'killed' | 'gone' | 'survived' | 'unconfirmed' | 'unverified';

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
  /** The clock of the kill deadline, in milliseconds. Default `Date.now`. */
  readonly now?: (() => number) | undefined;
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

/**
 * The one deadline of a {@link killVerified}: the identity check, the kill
 * and every check that the process is gone run within it.
 *
 * @remarks
 * Sized from measurements: a table read took 0.3 to 1.3 s on GitHub-hosted
 * Windows runners (the CIM query), well under 0.1 s on Linux, and a process
 * ended by `SIGKILL` or `TerminateProcess` leaves the table within one read.
 * 15 s leaves room for ten reads at the slowest measured speed, with
 * {@link KILL_CHECK_MS} between them. Each read is cut off at the time left
 * (a read cut off keeps running in the background, bounded by its own read
 * limits, `process-table.ts`).
 */
export const KILL_DEADLINE_MS = 15_000;
/** The wait after a check that still lists the process (or less, at the deadline). */
export const KILL_CHECK_MS = 100;

/**
 * The settle window of a root's own console host on Windows (W6-Z ruling 2):
 * a `conhost.exe` whose parent is a recorded root that has exited is a leak
 * only if a table read taken this long after the leak check still lists it.
 *
 * @remarks
 * Sized as 3x the slowest measured teardown, rounded up to whole
 * milliseconds (W6-Z, Windows 11, the core's spawn): after Node observed a
 * root's exit, its own `conhost.exe` was gone within 0.28 ms for the pinned
 * CLI (n=79, the whole integration project) and within 0.2 ms for a Node
 * child (n=40); 3 x 0.28 ms = 0.84 ms. One confirming read follows the
 * window (a CIM query of 1.2 s or more there), so the window is a floor,
 * not a budget. Every other survivor is a leak at once.
 */
export const CONHOST_SETTLE_MS = 1;

function key(identity: ProcessIdentity): string {
  return `${String(identity.pid)}@${identity.startTime}`;
}

function startedNoEarlier(child: ProcessIdentity, parent: ProcessIdentity): boolean {
  return BigInt(child.startTime) >= BigInt(parent.startTime);
}

/**
 * Whether `row`'s parent pid now names another process than the known
 * `parent`, one that may be `row`'s real parent: the table lists that pid
 * with another start time (the known process exited and its pid was
 * reused), and `row` started no earlier than the new holder. Measured on
 * Windows (W6-Z): a spawned root exits, the harness's own process-table
 * query (`powershell.exe`) receives its pid, and that query's
 * `conhost.exe` would otherwise count as the root's descendant. A row that
 * started before the new holder cannot be its child and stays a descendant
 * of the known process (a Windows orphan keeps naming its dead parent).
 */
function reusedBy(
  holder: ProcessRow | undefined,
  parent: ProcessIdentity,
  row: ProcessIdentity,
): boolean {
  return (
    holder !== undefined && holder.startTime !== parent.startTime && startedNoEarlier(row, holder)
  );
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

/** Resolves with `promise`, or with `undefined` after `ms` (a real timer, cleared on settle). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kills `identity` only if a fresh snapshot still shows that pid with that
 * start time, then waits until it is gone, all within `deadlineMs`
 * ({@link KILL_DEADLINE_MS}).
 *
 * @returns `gone` (not listed, or the host itself: nothing killed),
 * `killed` (listed, killed, then no longer listed), `survived` (still
 * listed by the last read at the deadline), `unconfirmed` (killed, but no
 * read answered before the deadline), `unverified` (no read answered before
 * the deadline, so nothing was killed). Only `gone` and `killed` mean the
 * process is not running.
 * @throws whatever a table read throws
 */
export async function killVerified(
  identity: ProcessIdentity,
  host: LeakHost,
  deadlineMs: number = KILL_DEADLINE_MS,
): Promise<KillOutcome> {
  const kill = host.kill ?? defaultKill;
  const sleep = host.sleep ?? defaultSleep;
  const now = host.now ?? Date.now;
  const end = now() + deadlineMs;
  /** Whether the identity is listed; `undefined` when the read did not answer by the deadline. */
  const listed = async (): Promise<boolean | undefined> => {
    const rows = await within(host.table.read(), end - now());
    return rows?.some((row) => row.pid === identity.pid && row.startTime === identity.startTime);
  };
  if (identity.pid === (host.selfPid ?? process.pid)) return 'gone';
  const before = await listed();
  if (before === undefined) return 'unverified';
  if (!before) return 'gone';
  try {
    kill(identity.pid);
  } catch {
    // exited between the check and the kill; confirmed below
  }
  for (;;) {
    const after = await listed();
    if (after === undefined) return 'unconfirmed';
    if (!after) return 'killed';
    // Listed: wait, but never past the deadline; at the deadline it survived.
    await sleep(Math.max(0, Math.min(KILL_CHECK_MS, end - now())));
    if (now() >= end) return 'survived';
  }
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
  /** Roots recorded by the identity their spawn read ({@link LeakTracker.recordIdentity}). */
  readonly #roots = new Map<string, ProcessIdentity>();
  /** Every recorded root, by either record method. */
  readonly #rootIds = new Map<string, ProcessIdentity>();
  #sampling: SamplingState | undefined;

  constructor(options: LeakTrackerOptions) {
    this.#host = options;
    this.#matches = markerMatcher(options.table, options.marker);
    this.#self = options.selfPid ?? process.pid;
  }

  /**
   * The processes tracked so far as table rows (roots recorded by
   * {@link LeakTracker.recordRoot} and sampled descendants); roots recorded
   * by {@link LeakTracker.recordIdentity} are in {@link LeakTracker.roots}.
   */
  get tracked(): readonly ProcessRow[] {
    return [...this.#known.values()];
  }

  /** The roots recorded by {@link LeakTracker.recordIdentity}. */
  get roots(): readonly ProcessIdentity[] {
    return [...this.#roots.values()];
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
    this.#rootIds.set(key(row), row);
    return row;
  }

  /**
   * Records a spawned root by the identity its spawn read (the core's
   * `HarnessProcess.identity`, plan §4.7: "Every spawned CLI is recorded
   * (pid, start time)"), without a table read: the identity was read while
   * the child was provably not yet reaped, so a root that exits at once is
   * still recorded. Its start time must be in the unit of this tracker's
   * table source (the caller compares the sources).
   *
   * @throws Error for the host process itself.
   */
  recordIdentity(identity: ProcessIdentity): void {
    if (identity.pid === this.#self) {
      throw new Error(`pid ${String(identity.pid)} is the host process, not a spawned root`);
    }
    const root = { pid: identity.pid, startTime: identity.startTime };
    this.#roots.set(key(identity), root);
    this.#rootIds.set(key(identity), root);
  }

  /** Adds every current descendant of a known process. Returns how many are known. */
  async sample(): Promise<number> {
    this.#absorb(await this.#host.table.read(), () => true);
    return this.#known.size + this.#roots.size;
  }

  #absorb(rows: readonly ProcessRow[], eligible: (row: ProcessRow) => boolean): ProcessRow[] {
    const added: ProcessRow[] = [];
    const listed = new Map(rows.map((row) => [row.pid, row]));
    let grew = true;
    while (grew) {
      grew = false;
      const byPid = new Map<number, ProcessIdentity>();
      for (const root of this.#roots.values()) byPid.set(root.pid, root);
      for (const known of this.#known.values()) byPid.set(known.pid, known);
      for (const row of rows) {
        const id = key(row);
        if (row.pid === this.#self || this.#known.has(id) || this.#roots.has(id)) continue;
        if (!eligible(row)) continue;
        const parent = byPid.get(row.ppid);
        if (parent === undefined || !startedNoEarlier(row, parent)) continue;
        if (reusedBy(listed.get(row.ppid), parent, row)) continue;
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
    const tracked = new Set([...this.#known.keys(), ...this.#roots.keys()]);
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
    const found = await this.findLeaks();
    const settling = found.filter((leak) => this.#isExitedRootsConhost(leak, found));
    let leaks = found;
    if (settling.length > 0) {
      // A root's own console host gets the settle window, then one fresh read.
      await (this.#host.sleep ?? defaultSleep)(CONHOST_SETTLE_MS);
      const rows = await this.#host.table.read();
      const settled = settling.filter((leak) => !rows.some((row) => key(row) === key(leak)));
      leaks = found.filter((leak) => !settled.includes(leak));
    }
    if (leaks.length === 0) return;
    throw new LeakError(leaks, await killAll(leaks, this.#host));
  }

  /**
   * Whether `leak` is the `conhost.exe` of a recorded root that is no longer
   * listed (Windows only; see {@link CONHOST_SETTLE_MS}). `rows` are the
   * leak check's survivors: a root among them has not exited.
   */
  #isExitedRootsConhost(leak: LeakedProcess, rows: readonly ProcessRow[]): boolean {
    if (this.#host.table.source !== 'win32-cim' || !/^conhost\.exe$/i.test(leak.name)) return false;
    if (leak.reason === 'command-line') return false;
    const root = [...this.#rootIds.values()].find((candidate) => candidate.pid === leak.ppid);
    return (
      root !== undefined &&
      startedNoEarlier(leak, root) &&
      !rows.some((row) => key(row) === key(root))
    );
  }
}
