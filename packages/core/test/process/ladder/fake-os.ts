import type { PosixLadderProcess, PosixOsCalls } from '../../../src/process/ladder/posix.js';
import type { LadderClock } from '../../../src/process/ladder/types.js';
import type {
  LinuxProcTableCalls,
  PosixSignal,
  PosixSignalCalls,
  SignalOutcome,
} from '../../../src/process/os/types.js';
import type { ProcessIdentity, ProcessRecord } from '../../../src/process/tree/types.js';

/**
 * A fake POSIX world for the ladder and sweep tests: a virtual clock, a
 * mutable process table served as `/proc/<pid>/stat` bytes, and a signal
 * adapter that records every call and applies its default effect. No real
 * timers, no real processes.
 */

interface Timer {
  readonly at: number;
  readonly seq: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/** Virtual time: timers fire only when the test lets the clock run. */
export class FakeClock implements LadderClock {
  private time = 0;
  private seq = 0;
  private timers: Timer[] = [];

  now(): number {
    return this.time;
  }

  schedule(ms: number, callback: () => void): () => void {
    const timer: Timer = { at: this.time + ms, seq: this.seq++, callback, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** Fires the earliest live timer, advancing time to it; false when none is left. */
  fireNext(): boolean {
    this.timers = this.timers
      .filter((timer) => !timer.cancelled)
      .sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = this.timers.shift();
    if (next === undefined) return false;
    this.time = Math.max(this.time, next.at);
    next.callback();
    return true;
  }
}

/** Lets every pending promise reaction run (not a timer: no time passes). */
function drain(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Runs `promise` to completion, firing virtual timers whenever nothing else can progress. */
export async function runWithClock<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  const state = { settled: false };
  const onSettled = (): void => {
    state.settled = true;
  };
  promise.then(onSettled, onSettled);
  for (;;) {
    await drain();
    if (state.settled) return promise;
    if (!clock.fireNext())
      throw new Error('stuck: nothing left to fire and the promise is pending');
  }
}

/** The spawned process as the ladder sees it. */
export class FakeProcess implements PosixLadderProcess {
  readonly exited: Promise<void>;
  stdinEnded = false;
  /** Called when stdin is closed; may throw to simulate a failing `end()`. */
  onEndStdin: () => void = () => undefined;
  private done = false;
  private resolveExit: () => void = () => undefined;

  readonly spawned: ProcessIdentity;
  readonly initializePid: number | null;

  constructor(spawned: ProcessIdentity, initializePid: number | null) {
    this.spawned = spawned;
    this.initializePid = initializePid;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  hasExited(): boolean {
    return this.done;
  }

  endStdin(): void {
    this.onEndStdin();
    this.stdinEnded = true;
  }

  /** The host observes the exit (sets the flag and settles `exited`). */
  exit(): void {
    if (this.done) return;
    this.done = true;
    this.resolveExit();
  }
}

/** One recorded `kill(2)` call. */
export interface SignalCall {
  readonly kind: 'process' | 'group';
  /** pid for `process`, pgid for `group`. */
  readonly id: number;
  readonly signal: PosixSignal;
  readonly at: number;
  /** Whether the host had already observed the spawned process's exit. */
  readonly afterExit: boolean;
}

export function rec(
  pid: number,
  ppid: number,
  pgid: number,
  startTime: string,
  name = `p${String(pid)}`,
): ProcessRecord {
  return { pid, ppid, pgid, startTime, name };
}

export function identity(record: ProcessIdentity): ProcessIdentity {
  return { pid: record.pid, startTime: record.startTime };
}

function statBytes(record: ProcessRecord): Uint8Array {
  const pgid = record.pgid ?? record.pid;
  const line = `${String(record.pid)} (${record.name}) S ${String(record.ppid)} ${String(pgid)} 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 ${record.startTime} 0 0\n`;
  return new Uint8Array(Buffer.from(line, 'utf8'));
}

/** The standard tree: host 100 (group 90) -> launcher 200 -> CLI 201 -> tool group 300 {300, 301}. */
export const HOST = rec(100, 1, 90, '10');
export const LAUNCHER = rec(200, 100, 90, '20');
export const CLI = rec(201, 200, 90, '21');
export const TOOL = rec(300, 201, 300, '30');
export const SLEEP = rec(301, 300, 300, '31');
export const FOREIGN = rec(400, 1, 400, '40');
export const INIT = rec(1, 0, 1, '0');

export interface SignalContext {
  readonly world: FakeWorld;
  readonly call: SignalCall;
}

/**
 * A mutable process table plus a recording signal adapter. Default effects:
 * SIGKILL removes the process (or every member of the group) and reparents
 * its children to pid 1; SIGKILL of the spawned pid makes the host observe
 * the exit on the next microtask; SIGTERM has no effect. `onSignal`
 * overrides the outcome and effect of any call.
 */
export class FakeWorld {
  readonly hostPid: number;
  readonly records = new Map<number, ProcessRecord>();
  readonly calls: SignalCall[] = [];
  readonly clock = new FakeClock();
  readonly proc: FakeProcess;
  /** Index of each table read (0-based) that must fail. */
  readonly failingReads = new Set<number>();
  reads = 0;
  /** Called at the start of each table read with its index (0-based); may change the world. */
  beforeRead: (index: number) => void = () => undefined;
  onSignal: ((context: SignalContext) => SignalOutcome | undefined) | undefined;

  constructor(
    records: readonly ProcessRecord[],
    spawned: ProcessIdentity,
    initializePid: number | null,
    hostPid = HOST.pid,
  ) {
    this.hostPid = hostPid;
    for (const record of records) this.records.set(record.pid, record);
    this.proc = new FakeProcess(spawned, initializePid);
  }

  static standard(initializePid: number | null = CLI.pid): FakeWorld {
    return new FakeWorld(
      [INIT, HOST, LAUNCHER, CLI, TOOL, SLEEP, FOREIGN],
      identity(LAUNCHER),
      initializePid,
    );
  }

  set(record: ProcessRecord): void {
    this.records.set(record.pid, record);
  }

  /** Removes a process and reparents its children to pid 1. */
  remove(pid: number): void {
    this.records.delete(pid);
    for (const record of [...this.records.values()]) {
      if (record.ppid === pid) this.records.set(record.pid, { ...record, ppid: 1 });
    }
    if (pid === this.proc.spawned.pid) {
      queueMicrotask(() => {
        this.proc.exit();
      });
    }
  }

  readonly processTable: LinuxProcTableCalls = {
    source: 'linux-proc',
    listPids: () => {
      const index = this.reads++;
      this.beforeRead(index);
      if (this.failingReads.has(index)) return Promise.reject(new Error('EIO'));
      return Promise.resolve([...this.records.keys()]);
    },
    readStat: (pid) => {
      const record = this.records.get(pid);
      return Promise.resolve(record === undefined ? null : statBytes(record));
    },
  };

  readonly signals: PosixSignalCalls = {
    signalProcess: (pid, signal) => this.signal('process', pid, signal),
    signalGroup: (pgid, signal) => this.signal('group', pgid, signal),
  };

  get os(): PosixOsCalls {
    return {
      platform: 'linux',
      hostPid: this.hostPid,
      processTable: this.processTable,
      signals: this.signals,
    };
  }

  private signal(kind: SignalCall['kind'], id: number, signal: PosixSignal): SignalOutcome {
    const call: SignalCall = {
      kind,
      id,
      signal,
      at: this.clock.now(),
      afterExit: this.proc.hasExited(),
    };
    this.calls.push(call);
    const custom = this.onSignal?.({ world: this, call });
    if (custom !== undefined) return custom;
    const targets =
      kind === 'process'
        ? [...this.records.values()].filter((record) => record.pid === id)
        : [...this.records.values()].filter((record) => record.pgid === id);
    if (targets.length === 0) return 'no-such-process';
    if (signal === 'SIGKILL') for (const target of targets) this.remove(target.pid);
    return 'sent';
  }
}
