/**
 * Per-session containment: one job object per spawned harness process
 * (ADR-0009 "Containment", plan §6.4, K2).
 *
 * @remarks
 * Integration with `spawn.ts` without a new hook: {@link SessionContainment.startTime}
 * is passed as `SpawnSpec.startTime`. `spawnHarnessProcess` calls the
 * reader's `read(pid)` synchronously right after the child started, inside
 * the construction of the handle it then resolves with, so the job is
 * created and the child assigned (synchronous native calls, while Node holds
 * the child handle: the pid cannot be reused) before anyone holds the handle,
 * so before the first stdin write and before `process.started` reaches the
 * machine (05 §10). The start time the addon reports for the assigned
 * process becomes the session's identity; without an assignment the
 * fallback reader (the host process table) reads it.
 *
 * Right after the spawn resolved, the binding calls
 * {@link SessionContainment.attach} with the process. It returns what the
 * session got (`info.containment`, K2), the {@link JobHandle} for
 * `runWindowsLadder` (`null` for best-effort) and the diagnostics to emit,
 * and closes the job after the process exited. Should the reader not have
 * run (another `startTime` was passed), `attach` assigns then, which is
 * still before the first write.
 *
 * An assignment failure keeps the session: `'best-effort'` plus one
 * `containment.fallback` diagnostic. Nothing reports `'job'` unless the
 * assignment succeeded. A job whose assignment failed is still closed only
 * after the exit: should the process have entered it after all, closing it
 * earlier would kill the session.
 *
 * @packageDocumentation
 */

import type { JobHandle } from '../ladder/windows.js';
import type { StartTimeReader } from '../spawn.js';
import type { JobAddonLoad, JobContainment, JobObject } from './win32-job.js';
import { JobAddonError } from './win32-job.js';

/**
 * A `containment.fallback` diagnostic (K2), as data for the binding's
 * `diagnostic` event.
 *
 * @public
 */
export interface ContainmentFallbackDiagnostic {
  readonly code: 'containment.fallback';
  readonly message: string;
  readonly data: {
    /** The step that failed: creating the job, assigning the process, or the process had already exited. */
    readonly step: 'create-job' | 'assign-process' | 'exited';
    /** The error code (`WIN32_<n>`, `ERR_JOB_ADDON_OUTPUT`, ...), or `exited`. */
    readonly code: string;
  };
}

/**
 * What a session got.
 *
 * @public
 */
export interface SessionContainmentResult {
  /** `info.containment` (K2). */
  readonly containment: JobContainment;
  /** The job for `runWindowsLadder`; `null` for best-effort. */
  readonly job: JobHandle | null;
  /** To emit as `diagnostic` events. */
  readonly diagnostics: readonly ContainmentFallbackDiagnostic[];
  /**
   * Settles after the process exited and the job handle was closed (`'closed'`
   * or `'close-failed'`), or at once when there is no job (`'no-job'`).
   * Never rejects.
   */
  readonly released: Promise<'closed' | 'close-failed' | 'no-job'>;
}

/**
 * The process as {@link SessionContainment.attach} needs it (a `HarnessProcess`).
 *
 * @public
 */
export interface ContainedProcess {
  readonly pid: number;
  /** `HarnessProcess.exitStatus`: `null` while the process runs. */
  readonly exitStatus: object | null;
  /** `HarnessProcess.exited`; never rejects. */
  readonly exited: Promise<unknown>;
}

/**
 * Containment of one session's process.
 *
 * @public
 */
export interface SessionContainment {
  /** Pass as `SpawnSpec.startTime` (see the module remarks). Serves one pid. */
  readonly startTime: StartTimeReader;
  /** Call once, right after the spawn resolved and before the first write. */
  attach(proc: ContainedProcess): SessionContainmentResult;
}

interface Assignment {
  readonly pid: number;
  /** The job the process is in; `null` without a successful assignment. */
  readonly assigned: JobObject | null;
  /** A job to close after the exit (also one whose assignment failed). */
  readonly job: JobObject | null;
  /** Start time from the addon, canonical microseconds. */
  readonly startTime: string | null;
  readonly diagnostic: ContainmentFallbackDiagnostic | null;
}

function fallback(
  pid: number,
  job: JobObject | null,
  step: ContainmentFallbackDiagnostic['data']['step'],
  code: string,
): Assignment {
  return {
    pid,
    assigned: null,
    job,
    startTime: null,
    diagnostic: {
      code: 'containment.fallback',
      message: `job containment failed (${step}: ${code}); the session continues with best-effort containment`,
      data: { step, code },
    },
  };
}

/** Error codes that leave the wrapper are always {@link JobAddonError}s. */
function codeOf(error: unknown): string {
  return error instanceof JobAddonError ? error.code : 'ERR_JOB_ADDON';
}

/** Creates the job and assigns `pid`, synchronously; never throws. */
function assignNow(load: JobAddonLoad, pid: number): Assignment {
  if (load.status !== 'loaded') {
    return { pid, assigned: null, job: null, startTime: null, diagnostic: null };
  }
  let job: JobObject;
  try {
    job = load.addon.createJob();
  } catch (error) {
    return fallback(pid, null, 'create-job', codeOf(error));
  }
  try {
    const startTime = job.assign(pid);
    return { pid, assigned: job, job, startTime, diagnostic: null };
  } catch (error) {
    return fallback(pid, job, 'assign-process', codeOf(error));
  }
}

async function closeAfterExit(
  job: JobObject,
  exited: Promise<unknown>,
): Promise<'closed' | 'close-failed'> {
  await exited;
  try {
    job.close();
    return 'closed';
  } catch {
    return 'close-failed';
  }
}

class Containment implements SessionContainment {
  readonly startTime: StartTimeReader;
  readonly #load: JobAddonLoad;
  #assignment: Assignment | undefined;
  #attached = false;

  constructor(load: JobAddonLoad, reader: StartTimeReader) {
    this.#load = load;
    this.startTime = {
      source: reader.source,
      read: (pid) => {
        // Synchronous up to here: the assignment is done before `read` returns.
        const assignment = this.#assign(pid);
        return assignment.startTime === null
          ? reader.read(pid)
          : Promise.resolve(assignment.startTime);
      },
    };
  }

  #assign(pid: number): Assignment {
    if (this.#assignment === undefined) {
      this.#assignment = assignNow(this.#load, pid);
    } else if (this.#assignment.pid !== pid) {
      throw new Error('a session containment serves one process');
    }
    return this.#assignment;
  }

  attach(proc: ContainedProcess): SessionContainmentResult {
    if (this.#attached) throw new Error('session containment already attached');
    this.#attached = true;
    let assignment = this.#assignment;
    if (assignment === undefined) {
      // The reader did not run. An exited child is never assigned: its
      // handle may be gone, and the pid with it.
      assignment =
        proc.exitStatus !== null && this.#load.status === 'loaded'
          ? fallback(proc.pid, null, 'exited', 'exited')
          : this.#assign(proc.pid);
      this.#assignment = assignment;
    } else if (assignment.pid !== proc.pid) {
      throw new Error('a session containment serves one process');
    }
    const { assigned, job, diagnostic } = assignment;
    return {
      containment: assigned === null ? 'best-effort' : 'job',
      job: assigned,
      diagnostics: diagnostic === null ? [] : [diagnostic],
      released: job === null ? Promise.resolve('no-job') : closeAfterExit(job, proc.exited),
    };
  }
}

/**
 * Containment for one session, from the host's addon load and the fallback
 * start-time reader (normally `processTableStartTime` over the host's
 * process table). Works on every platform: without a loaded addon it reads
 * through the fallback and reports `'best-effort'`.
 *
 * @public
 */
export function createSessionContainment(
  load: JobAddonLoad,
  fallbackStartTime: StartTimeReader,
): SessionContainment {
  return new Containment(load, fallbackStartTime);
}
