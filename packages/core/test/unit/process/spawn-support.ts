import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';

import { expect, vi } from 'vitest';

import {
  osCallsFor,
  spawnHarnessProcess,
  type HarnessProcess,
  type IdentityRead,
  type SpawnSpec,
} from '../../../src/process/spawn.js';
import { findIdentity } from '../../../src/process/tree/descendants.js';
import { takeSnapshot } from '../../../src/process/tree/snapshot.js';
import type { ProcessIdentity, ProcessSnapshot } from '../../../src/process/tree/types.js';

/** A cwd every test child can use: the realpath of the OS temp directory. */
export const CHILD_CWD = realpathSync(tmpdir());

/**
 * The smallest environment a test child runs with: nothing on POSIX; on
 * Windows the host's `SYSTEMROOT`, which spawn requires (every other libuv
 * required name is passed empty by spawn).
 */
export const BASE_ENV: Readonly<Record<string, string>> =
  process.platform === 'win32' ? { SYSTEMROOT: process.env['SystemRoot'] ?? '' } : {};

/** The host's process table (Linux `/proc`, macOS `ps`, Windows CIM). */
export function hostTable(): ReturnType<typeof osCallsFor>['processTable'] {
  return osCallsFor(process.platform, process.pid).processTable;
}

export function hostSnapshot(): Promise<ProcessSnapshot> {
  return takeSnapshot(hostTable());
}

/**
 * The real `setTimeout`, captured when this module loads: a test that fakes
 * the timers of the code under test (`vi.useFakeTimers`) can still wait.
 */
const realSetTimeout = setTimeout;

/** Waits `ms` of real time, also while a test fakes the global timers. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/**
 * Runs `start` with faked one-shot timers and hands it a function that
 * advances them, so a timeout of the code under test fires exactly when the
 * test says, after it recorded what it needs (no race with a slow
 * process-table read, no real wait). Real timers are restored afterwards.
 */
export async function withFakeTimeouts<T>(
  start: (advance: (ms: number) => Promise<void>) => Promise<T>,
): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    return await start(async (ms) => {
      vi.advanceTimersByTime(ms);
      // Let the I/O that the fired timers caused (a kill, a close) arrive.
      await sleep(50);
    });
  } finally {
    vi.useRealTimers();
  }
}

/** Resolves with `promise`, or rejects after `ms`. */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${String(ms)} ms: ${what}`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The identity of a direct child of this process that wrote its pid to
 * `file`: pid plus the start time from the host process table, verified by
 * the parent pid. Used for children started by code that does not hand out
 * a handle (the OS adapters' command runners).
 */
export async function identityFromPidFile(file: string, ms = 15_000): Promise<ProcessIdentity> {
  const deadline = Date.now() + ms;
  for (;;) {
    const pid = Number(await readFile(file, 'utf8').catch(() => ''));
    if (Number.isSafeInteger(pid) && pid > 0) {
      const record = (await hostSnapshot()).records.find((entry) => entry.pid === pid);
      if (record?.ppid === process.pid) return { pid, startTime: record.startTime };
    }
    if (Date.now() > deadline) throw new Error(`no child identity from ${file}`);
    await sleep(50);
  }
}

/**
 * A child script for runners without a handle: writes its pid to `argv[1]`,
 * waits until `argv[1] + '.go'` exists, then floods stdout if `argv[2]` is
 * `flood`, and idles. The gate lets a test record the identity first.
 */
export const PID_FILE_IDLER =
  "const fs = require('node:fs'); const f = process.argv[1];" +
  'fs.writeFileSync(f, String(process.pid));' +
  'const t = setInterval(() => { if (!fs.existsSync(f + ".go")) return; clearInterval(t);' +
  "if (process.argv[2] === 'flood') process.stdout.write('x'.repeat(100000));" +
  'setInterval(() => {}, 1000); }, 20);';

/** Collects all of stdout as bytes. */
export async function readAll(child: HarnessProcess): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of child.stdout) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Every child a test spawns, plus every descendant it learned of, checked by
 * pid and start time (plan §4.7).
 *
 * After each test ({@link ChildTracker.assertNoLeaks}): every child must have
 * exited, observed through its own handle (which is bound to that process,
 * so this is exact); every recorded descendant must be absent from a fresh
 * snapshot. After the file ({@link ChildTracker.assertNoneListed}): no child
 * identity read in the file is still listed in one final snapshot. The
 * identity reads run in the background from each spawn and are awaited only
 * there, so no test waits for one it does not use (on Windows each is a
 * process-table query), and one read per file keeps the CIM cost bounded.
 *
 * A leak fails the test and is then ended: a running child through its own
 * handle, a listed identity by `process.kill` right after it was verified in
 * that snapshot.
 */
export class ChildTracker {
  readonly #children: HarnessProcess[] = [];
  readonly #descendants: ProcessIdentity[] = [];
  readonly #reads: Promise<IdentityRead>[] = [];

  /** Spawns a `node -e <script>` child with exactly `env`. */
  async node(
    script: string,
    options: {
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly spec?: Partial<SpawnSpec>;
    } = {},
  ): Promise<HarnessProcess> {
    const child = await spawnHarnessProcess({
      file: process.execPath,
      args: ['-e', script, ...(options.args ?? [])],
      cwd: CHILD_CWD,
      env: { ...BASE_ENV, ...options.env },
      ...options.spec,
    });
    this.track(child);
    return child;
  }

  track(child: HarnessProcess): void {
    this.#children.push(child);
  }

  trackDescendant(identity: ProcessIdentity): void {
    this.#descendants.push(identity);
  }

  /** Every child exited (by its handle); no recorded descendant is still listed. */
  async assertNoLeaks(): Promise<void> {
    const children = this.#children.splice(0);
    const descendants = this.#descendants.splice(0);
    const running: number[] = [];
    for (const child of children) {
      child.endStdin();
      try {
        await within(child.exited, 10_000, `exit of ${String(child.pid)}`);
      } catch {
        running.push(child.pid);
        child.killViaHandle('SIGKILL');
        await within(child.exited, 10_000, `forced exit of ${String(child.pid)}`);
      }
      this.#reads.push(child.identity);
    }
    const leaked = await listedAndEnded(descendants);
    expect({ running, leaked }).toEqual({ running: [], leaked: [] });
  }

  /** No child identity read in this file is still listed. */
  async assertNoneListed(): Promise<void> {
    const reads = await Promise.all(this.#reads.splice(0));
    const identities = reads.flatMap((read) => (read.identity === null ? [] : [read.identity]));
    const leaked = await listedAndEnded(identities);
    expect(leaked).toEqual([]);
  }
}

/** The identities still listed in one fresh snapshot; each is ended right away. */
async function listedAndEnded(identities: readonly ProcessIdentity[]): Promise<ProcessIdentity[]> {
  if (identities.length === 0) return [];
  const snapshot = await hostSnapshot();
  const leaked = identities.filter((identity) => findIdentity(snapshot.records, identity) !== null);
  for (const identity of leaked) {
    // Verified in this snapshot by pid and start time; only test processes get here.
    process.kill(identity.pid, 'SIGKILL');
  }
  return leaked;
}
