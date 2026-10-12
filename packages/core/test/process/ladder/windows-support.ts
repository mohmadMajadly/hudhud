import type { Win32CimTableCalls } from '../../../src/process/os/types.js';
import type { LadderClock } from '../../../src/process/ladder/types.js';
import type { WindowsLadderProcess } from '../../../src/process/ladder/windows.js';

/** A manual clock: timers fire only when {@link drive} advances time. */
export class FakeClock implements LadderClock {
  private time = 0;
  private readonly timers: { at: number; seq: number; callback: () => void; live: boolean }[] = [];
  private seq = 0;

  now(): number {
    return this.time;
  }

  schedule(ms: number, callback: () => void): () => void {
    const timer = { at: this.time + ms, seq: this.seq++, callback, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  /** Live timers still pending. */
  pending(): number {
    return this.timers.filter((timer) => timer.live).length;
  }

  /** Fires the earliest live timer; false when none is pending. */
  fireNext(): boolean {
    const live = this.timers
      .filter((timer) => timer.live)
      .sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = live[0];
    if (next === undefined) return false;
    next.live = false;
    this.time = Math.max(this.time, next.at);
    next.callback();
    return true;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Runs `promise` to completion, advancing the fake clock whenever everything else is idle. */
export async function drive<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  const state = { settled: false };
  const settle = (): void => {
    state.settled = true;
  };
  void promise.then(settle, settle);
  for (let i = 0; i < 1000; i += 1) {
    await flush();
    if (state.settled) return promise;
    if (!clock.fireNext()) throw new Error('stuck: no timer pending and the promise is unsettled');
  }
  throw new Error('did not settle');
}

/** A fake spawned child. `exit()` marks it exited and settles `exited`. */
export interface FakeProcess extends WindowsLadderProcess {
  exit(): void;
  readonly calls: string[];
  onCloseStdin: () => void;
  onTerminate: () => boolean;
}

export function fakeProcess(pid = 500, startTime = '1000'): FakeProcess {
  let exited = false;
  let resolveExited: (value: unknown) => void = () => undefined;
  const exitedPromise = new Promise<unknown>((resolve) => {
    resolveExited = resolve;
  });
  const proc: FakeProcess = {
    identity: { pid, startTime },
    calls: [],
    hasExited: () => exited,
    exited: exitedPromise,
    exit() {
      if (exited) return;
      exited = true;
      resolveExited(undefined);
    },
    onCloseStdin: () => undefined,
    onTerminate: () => {
      proc.exit();
      return true;
    },
    closeStdin() {
      proc.calls.push(`closeStdin:${String(exited)}`);
      proc.onCloseStdin();
    },
    terminate() {
      proc.calls.push(`terminate:${String(exited)}`);
      return proc.onTerminate();
    },
  };
  return proc;
}

export interface CimRow {
  readonly pid: number;
  readonly ppid: number;
  /** Start time in microseconds. */
  readonly start: string;
}

/** Encodes rows as the CIM query's JSON (FILETIME 100 ns strings). */
export function cimJson(rows: readonly CimRow[]): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(rows.map((row) => ({ p: row.pid, pp: row.ppid, t: `${row.start}0`, n: 'x' }))),
  );
}

/** A CIM table whose content the test sets; counts queries. */
export function fakeCim(rows: () => readonly CimRow[] | Error): Win32CimTableCalls & {
  queries: number;
} {
  const table = {
    source: 'win32-cim' as const,
    queries: 0,
    queryProcesses(): Promise<Uint8Array> {
      table.queries += 1;
      const value = rows();
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(cimJson(value));
    },
  };
  return table;
}
