/**
 * Spawning the harness process and its handle (ADR-0009, ADR-0010,
 * ADR-0011 §"Spawn", ADR-0007, ADR-0016 §6; plan §1.7).
 *
 * @remarks
 * Guarantees of {@link spawnHarnessProcess}:
 *
 * - No shell: `child_process.spawn` with `shell: false` and
 *   `windowsVerbatimArguments: false`, so every argv entry reaches the child
 *   as one argument, byte for byte (`&`, `|`, `^`, `%VAR%`, `$(...)`, quotes
 *   and spaces included; on Windows libuv quotes each entry by the
 *   CreateProcess / MSVCRT rules). `.bat`/`.cmd` files and relative paths are
 *   refused before the call (BatBadBut, binary planting).
 * - Explicit environment: the child gets `spec.env` and nothing from the
 *   host. On Windows libuv would copy each of `WIN32_REQUIRED_ENV_NAMES` (`win32-env.ts`)
 *   from the host into the child when the map lacks it; spawn prevents that
 *   by passing every such name the map lacks with an empty value (measured:
 *   libuv then adds nothing and a node child runs), and refuses a map without
 *   a non-empty `SYSTEMROOT`, the one variable a child cannot run without
 *   (an empty value aborts a node child at start). Names that would change
 *   meaning are refused: empty, `=` or NUL in a name, NUL in a value, and on
 *   Windows two names equal ignoring case (Node would silently keep one).
 * - Hygiene: `windowsHide: true`, not detached (the child stays in the host's
 *   process group on POSIX and in libuv's job on Windows; ADR-0009, ADR-0010),
 *   exactly three pipes and no IPC channel, so nothing else is inherited
 *   (libuv opens every other handle non-inheritable / close-on-exec). stdin
 *   is private to the handle: only {@link HarnessProcess.write} and
 *   {@link HarnessProcess.endStdin} reach it.
 * - Identity: the pid plus its start time are read right after the spawn and
 *   before the promise resolves, so before the caller can write anything. The
 *   read counts only while the child is provably not yet reaped (an unreaped
 *   pid cannot be reused); otherwise {@link HarnessProcess.identity} is `null`.
 * - Backpressure (ADR-0007): writes are serialized and each resolves only
 *   after its bytes were handed to the OS, so the host buffers at most one
 *   pending write. stdout is pulled: while the consumer does not read, the
 *   pipe fills and the child blocks; nothing is buffered without bound.
 * - stderr is always drained into a bounded {@link StderrTail}, redacted with
 *   the secrets of `spec.env` (ADR-0016 §6).
 * - Errors: a spawn failure rejects with {@link ProcessSpawnError}; pipe
 *   errors never escape as unhandled events (`ENOTCONN` on the pipes after a
 *   failed spawn, 07 §6; `EPIPE` on stdin after the child exited).
 *
 * @packageDocumentation
 */

import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

import { secretsFromEnv } from '../observability/redact.js';
import { StderrTail, type StderrTailOptions } from '../observability/stderr-tail.js';
import { checkExecutablePath } from './binary-path.js';
import { errnoCode, hostPlatform, pathProblem, type ProcessPlatform } from './cwd.js';
import { createDarwinPsTableCalls } from './os/darwin.js';
import { createLinuxProcTableCalls, createPosixSignalCalls } from './os/posix.js';
import type { OsCalls, ProcessTableCalls } from './os/types.js';
import { createWin32CimTableCalls } from './os/win32.js';
import { createTaskkillCalls, nodeTaskkillDeps } from './taskkill.js';
import { parseProcStat } from './tree/proc-stat.js';
import { takeSnapshot } from './tree/snapshot.js';
import type { ProcessIdentity, ProcessTableSource } from './tree/types.js';
import { childEnv } from './win32-env.js';

/**
 * Reads the start time of a pid, in the unit of {@link StartTimeReader.source}.
 *
 * @public
 */
export interface StartTimeReader {
  readonly source: ProcessTableSource;
  /** The canonical start time, or `null` when no such process is listed. */
  read(pid: number): Promise<string | null>;
}

/**
 * What {@link spawnHarnessProcess} starts.
 *
 * @public
 */
export interface SpawnSpec {
  /** Absolute path of the executable, normally `resolveExecutable(...).path`. */
  readonly file: string;
  /** Argv after the executable; each entry is passed as one argument, never through a shell. */
  readonly args: readonly string[];
  /** Absolute working directory, normally the result of `validateCwd`. */
  readonly cwd: string;
  /** The child's complete environment (see the module remarks for the Windows exception). */
  readonly env: Readonly<Record<string, string>>;
  /** More secret values to mask in the stderr tail, besides those of `env`. */
  readonly secrets?: readonly string[];
  /** Size limits of the stderr tail. */
  readonly stderrTail?: Omit<StderrTailOptions, 'secrets'>;
  /** Start-time source for the identity; the host process table by default. */
  readonly startTime?: StartTimeReader;
}

/**
 * Why a {@link SpawnSpec} was refused before anything was started.
 *
 * @public
 */
export type SpawnSpecProblem =
  | 'file-refused'
  | 'cwd-refused'
  | 'arg-nul'
  | 'env-name'
  | 'env-value'
  | 'env-duplicate-name'
  | 'env-missing-required';

/**
 * Thrown by {@link spawnHarnessProcess} for a spec it refuses; nothing was
 * started. Messages name variables, never values.
 *
 * @public
 */
export class SpawnSpecError extends Error {
  override readonly name = 'SpawnSpecError';
  readonly problem: SpawnSpecProblem;
  /** The refused env name or argv index; the file or cwd problem otherwise. */
  readonly subject: string;

  constructor(problem: SpawnSpecProblem, subject: string) {
    super(`spawn refused: ${problem} (${subject})`);
    this.problem = problem;
    this.subject = subject;
  }
}

/**
 * Cause of a failed spawn (plan §3.1 `SpawnError.details.cause`; the
 * `'gatekeeper'` cause needs the macOS gate's evidence and is mapped by the
 * adapter).
 *
 * @public
 */
export type SpawnFailureCause = 'enoent' | 'eacces' | 'eperm' | 'unknown';

/**
 * The OS refused to start the process (child `error` before `spawn`). The
 * adapter maps it to the public `SpawnError` (`SPAWN_FAILED`).
 *
 * @public
 */
export class ProcessSpawnError extends Error {
  override readonly name = 'ProcessSpawnError';
  readonly code = 'SPAWN_FAILED';
  readonly reason: SpawnFailureCause;
  /** The errno name, such as `ENOENT`, when one was reported. */
  readonly errno: string | undefined;

  constructor(errno: string | undefined, options?: { readonly cause?: unknown }) {
    const reason = SPAWN_CAUSES.get(errno ?? '') ?? 'unknown';
    super(`spawn failed: ${errno ?? 'unknown error'}`, options);
    this.reason = reason;
    this.errno = errno;
  }
}

const SPAWN_CAUSES: ReadonlyMap<string, SpawnFailureCause> = new Map([
  ['ENOENT', 'enoent'],
  ['EACCES', 'eacces'],
  ['EPERM', 'eperm'],
]);

/**
 * A write to stdin or a read of stdout failed.
 *
 * @public
 */
export class ProcessStreamError extends Error {
  override readonly name = 'ProcessStreamError';
  readonly stream: 'stdin' | 'stdout';
  /** `ended`: stdin was ended by this handle; `failed`: the pipe reported an error. */
  readonly reason: 'ended' | 'failed';
  readonly errno: string | undefined;

  constructor(
    stream: 'stdin' | 'stdout',
    reason: 'ended' | 'failed',
    errno: string | undefined,
    options?: { readonly cause?: unknown },
  ) {
    super(
      reason === 'ended' ? `${stream} was ended` : `${stream} failed: ${errno ?? 'unknown error'}`,
      options,
    );
    this.stream = stream;
    this.reason = reason;
    this.errno = errno;
  }
}

/**
 * How the process ended.
 *
 * @public
 */
export interface ProcessExit {
  /** Exit code; `null` when ended by a signal. Windows codes are unsigned (`4294967295`). */
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Why {@link HarnessProcess.identity} is `null`.
 *
 * @public
 */
export type IdentityProblem = 'exited' | 'not-listed' | 'read-failed';

/**
 * The spawned harness process.
 *
 * @public
 */
export interface HarnessProcess {
  /** The spawned pid (never `initialize.pid`, ADR-0011 J9). */
  readonly pid: number;
  /** Pid plus start time, read right after the spawn; `null` when it could not be read safely. */
  readonly identity: ProcessIdentity | null;
  /** Unit of `identity.startTime`. */
  readonly identitySource: ProcessTableSource;
  /** Set when `identity` is `null`. */
  readonly identityProblem: IdentityProblem | null;
  /**
   * Writes to stdin. Writes are serialized; each resolves once its bytes
   * were handed to the OS and rejects with {@link ProcessStreamError} when
   * stdin was ended or the pipe failed (for example `EPIPE` after the child
   * exited). Strings are encoded as UTF-8.
   */
  write(data: string | Uint8Array): Promise<void>;
  /** Ends stdin (EOF) now; idempotent. Later writes reject with reason `ended`. */
  endStdin(): void;
  /**
   * The stdout bytes. Single consumer: a second iteration throws. Reading is
   * the backpressure: an unread pipe blocks the child. A pipe error ends the
   * iteration with {@link ProcessStreamError}, except `ENOTCONN`, which ends it
   * normally.
   */
  readonly stdout: AsyncIterable<Uint8Array>;
  /** The redacted, bounded stderr tail (ADR-0016 §6). */
  stderrTail(): string;
  /** Resolves when the process exited (stdio may still hold data). */
  readonly exited: Promise<ProcessExit>;
  /** The exit, once observed; `null` while the process runs. */
  readonly exitStatus: ProcessExit | null;
  /**
   * Signals the spawned process through its own handle, never by a bare pid,
   * so a reused pid cannot be hit. On Windows any signal is
   * `TerminateProcess`. Returns `false` after the exit or when the OS refused.
   */
  killViaHandle(signal: 'SIGTERM' | 'SIGKILL'): boolean;
}

/** `child_process.spawn` as used here; injectable for tests. */
export type SpawnFunction = typeof spawn;

function checkSpec(spec: SpawnSpec, platform: ProcessPlatform): void {
  const fileProblem = checkExecutablePath(spec.file, platform);
  if (fileProblem !== undefined) throw new SpawnSpecError('file-refused', fileProblem);
  const cwdProblem = pathProblem(spec.cwd, platform);
  if (cwdProblem !== undefined) throw new SpawnSpecError('cwd-refused', cwdProblem);
  spec.args.forEach((arg, index) => {
    if (arg.includes('\0')) throw new SpawnSpecError('arg-nul', String(index));
  });
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(spec.env as Readonly<Record<string, unknown>>)) {
    if (name === '' || name.includes('=') || name.includes('\0')) {
      throw new SpawnSpecError('env-name', JSON.stringify(name));
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new SpawnSpecError('env-value', name);
    }
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (seen.has(key)) throw new SpawnSpecError('env-duplicate-name', name);
    seen.add(key);
  }
  if (platform === 'win32' && windowsValue(spec.env, 'SYSTEMROOT') === '') {
    throw new SpawnSpecError('env-missing-required', 'SYSTEMROOT');
  }
}

/** The value of `name` in `env`, compared case-insensitively as Windows does; `''` when absent. */
function windowsValue(env: Readonly<Record<string, string>>, name: string): string {
  const found = Object.keys(env).find((key) => key.toUpperCase() === name);
  return found === undefined ? '' : String(env[found]);
}

/** Waits for `spawn` or `error`, whichever comes first. */
function started(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      reject(new ProcessSpawnError(errnoCode(error), { cause: error }));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** Listener that marks stdout as consumed without reading it. */
function keepForConsumer(): void {
  // Intentionally empty: reading is the consumer's job (backpressure).
}

function exitOf(child: ChildProcess): ProcessExit | null {
  if (child.exitCode === null && child.signalCode === null) return null;
  return { code: child.exitCode, signal: child.signalCode };
}

class SpawnedProcess implements HarnessProcess {
  readonly pid: number;
  readonly identity: ProcessIdentity | null;
  readonly identitySource: ProcessTableSource;
  readonly identityProblem: IdentityProblem | null;
  readonly exited: Promise<ProcessExit>;
  readonly #child: ChildProcess;
  readonly #stdin: Writable;
  readonly #stdout: Readable;
  readonly #tail: StderrTail;
  #writes: Promise<void> = Promise.resolve();
  #stdinFailure: ProcessStreamError | undefined;
  #ended = false;
  #stdoutTaken = false;

  constructor(
    child: ChildProcess,
    pipes: { readonly stdin: Writable; readonly stdout: Readable },
    tail: StderrTail,
    identity: {
      readonly pid: number;
      readonly source: ProcessTableSource;
      readonly startTime: string | null;
      readonly problem: IdentityProblem | null;
    },
  ) {
    this.#child = child;
    this.#stdin = pipes.stdin;
    this.#stdout = pipes.stdout;
    this.#tail = tail;
    this.pid = identity.pid;
    this.identitySource = identity.source;
    this.identityProblem = identity.problem;
    this.identity =
      identity.startTime === null ? null : { pid: identity.pid, startTime: identity.startTime };
    pipes.stdin.on('error', (error) => {
      this.failStdin(error);
    });
    const now = exitOf(child);
    this.exited =
      now === null
        ? new Promise((resolve) => {
            child.once('exit', (code, signal) => {
              resolve({ code, signal });
            });
          })
        : Promise.resolve(now);
  }

  get exitStatus(): ProcessExit | null {
    return exitOf(this.#child);
  }

  get stdout(): AsyncIterable<Uint8Array> {
    return { [Symbol.asyncIterator]: () => this.#readStdout() };
  }

  async *#readStdout(): AsyncGenerator<Uint8Array, void, undefined> {
    if (this.#stdoutTaken) throw new Error('stdout has a single consumer');
    this.#stdoutTaken = true;
    try {
      for await (const chunk of this.#stdout as AsyncIterable<Buffer>) {
        yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
    } catch (error) {
      const errno = errnoCode(error);
      if (errno === 'ENOTCONN') return;
      throw new ProcessStreamError('stdout', 'failed', errno, { cause: error });
    }
  }

  stderrTail(): string {
    return this.#tail.read();
  }

  /** Records a stdin pipe error (from the persistent listener or a write callback). */
  failStdin(error: Error): ProcessStreamError {
    this.#stdinFailure ??= new ProcessStreamError('stdin', 'failed', errnoCode(error), {
      cause: error,
    });
    return this.#stdinFailure;
  }

  write(data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const next = this.#writes.then(() => this.#writeNow(bytes));
    this.#writes = next.catch(() => undefined);
    return next;
  }

  #writeNow(bytes: Uint8Array): Promise<void> {
    if (this.#ended) {
      return Promise.reject(new ProcessStreamError('stdin', 'ended', undefined));
    }
    if (this.#stdinFailure !== undefined) return Promise.reject(this.#stdinFailure);
    return new Promise((resolve, reject) => {
      const stdin = this.#stdin;
      let settled = false;
      const settle = (error: Error | null | undefined): void => {
        if (settled) return;
        settled = true;
        stdin.off('close', onClose);
        if (error === null || error === undefined) resolve();
        else reject(this.failStdin(error));
      };
      const onClose = (): void => {
        settle(new Error('stdin closed before the write was flushed'));
      };
      stdin.once('close', onClose);
      stdin.write(bytes, settle);
    });
  }

  endStdin(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#stdin.end();
  }

  killViaHandle(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    if (this.exitStatus !== null) return false;
    return this.#child.kill(signal);
  }
}

/**
 * The start-time reader over a process table: one `/proc/<pid>/stat` read on
 * Linux, one full table read (`ps`, CIM) elsewhere.
 *
 * @public
 */
export function processTableStartTime(table: ProcessTableCalls): StartTimeReader {
  if (table.source === 'linux-proc') {
    return {
      source: table.source,
      async read(pid) {
        const stat = await table.readStat(pid);
        return stat === null ? null : (parseProcStat(stat, pid)?.startTime ?? null);
      },
    };
  }
  return {
    source: table.source,
    async read(pid) {
      const snapshot = await takeSnapshot(table);
      return snapshot.records.find((record) => record.pid === pid)?.startTime ?? null;
    },
  };
}

/**
 * The OS adapters of `platform`, composed into {@link OsCalls} (Linux:
 * `/proc` and `kill(2)`; macOS: `/bin/ps` and `kill(2)`; Windows: CIM and
 * `taskkill.exe` through `taskkill.ts`). Creating them runs nothing. This is
 * the seam through which the ladders, the sweep and the snapshots reach the
 * operating system.
 *
 * @throws Error for a platform hudhud does not support
 * @public
 */
export function osCallsFor(platform: NodeJS.Platform, hostPid: number): OsCalls {
  if (platform === 'win32') {
    return {
      platform,
      hostPid,
      processTable: createWin32CimTableCalls(),
      terminate: createTaskkillCalls({ env: process.env, ...nodeTaskkillDeps }),
    };
  }
  if (platform === 'darwin') {
    return {
      platform,
      hostPid,
      processTable: createDarwinPsTableCalls(),
      signals: createPosixSignalCalls(),
    };
  }
  if (platform === 'linux') {
    return {
      platform,
      hostPid,
      processTable: createLinuxProcTableCalls(),
      signals: createPosixSignalCalls(),
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

async function readIdentity(
  child: ChildProcess,
  pid: number,
  reader: StartTimeReader,
): Promise<{ readonly startTime: string | null; readonly problem: IdentityProblem | null }> {
  let startTime: string | null;
  try {
    startTime = await reader.read(pid);
  } catch {
    return { startTime: null, problem: 'read-failed' };
  }
  // Valid only if the child was still unreaped after the read: an unreaped
  // pid cannot have been reused while it was read.
  if (exitOf(child) !== null) return { startTime: null, problem: 'exited' };
  return startTime === null ? { startTime, problem: 'not-listed' } : { startTime, problem: null };
}

/**
 * {@link spawnHarnessProcess} with an injected `spawn` and platform (tests).
 *
 * @internal
 */
export async function spawnProcess(
  spec: SpawnSpec,
  deps: {
    readonly spawn: SpawnFunction;
    readonly platform: NodeJS.Platform;
    readonly startTime: StartTimeReader;
  },
): Promise<HarnessProcess> {
  const platform = hostPlatform(deps.platform);
  checkSpec(spec, platform);
  const tail = new StderrTail({
    ...spec.stderrTail,
    secrets: [...secretsFromEnv(spec.env), ...(spec.secrets ?? [])],
  });

  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    child = deps.spawn(spec.file, [...spec.args], {
      cwd: spec.cwd,
      env: childEnv(spec.env, platform),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new ProcessSpawnError(errnoCode(error), { cause: error });
  }

  const { stdin, stdout, stderr } = child;
  const destroyPipes = (): void => {
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  };

  // Listeners first: no pipe error may ever be unhandled (ENOTCONN after a
  // failed spawn, 07 §6; EPIPE on stdin after the child exited).
  let earlyStdinError: Error | undefined;
  const recordEarly = (error: Error): void => {
    earlyStdinError ??= error;
  };
  stdin.on('error', recordEarly);
  stdout.on('error', () => {
    // Surfaced to the consumer by the stdout iterator.
  });
  // A 'readable' listener that never reads: Node then buffers stdout up to
  // its high-water mark and stops (the pipe backpressures the child), and on
  // the child's exit it keeps unread stdout for the consumer instead of
  // discarding it (`flushStdio` resumes only streams nobody listens to).
  stdout.on('readable', keepForConsumer);
  stderr.on('error', () => {
    // The tail keeps what arrived; a stderr failure is not a session failure.
  });
  stderr.on('data', (chunk: Buffer) => {
    tail.push(chunk);
  });
  stderr.once('close', () => {
    tail.end();
  });
  // Errors after the spawn (a refused kill) are reported by return values.
  const onLateError = (): void => undefined;

  try {
    await started(child);
  } catch (error) {
    destroyPipes();
    throw error;
  }
  child.on('error', onLateError);

  const pid = child.pid;
  if (pid === undefined) {
    // Node sets the pid before it emits 'spawn'; refuse rather than guess.
    destroyPipes();
    throw new ProcessSpawnError(undefined);
  }
  const identity = await readIdentity(child, pid, deps.startTime);
  const handle = new SpawnedProcess(child, { stdin, stdout }, tail, {
    pid,
    source: deps.startTime.source,
    ...identity,
  });
  // The handle listens to stdin errors now; hand over anything seen before.
  stdin.off('error', recordEarly);
  if (earlyStdinError !== undefined) handle.failStdin(earlyStdinError);
  return handle;
}

/**
 * Starts the harness process. See the module remarks for the guarantees.
 *
 * @throws {@link SpawnSpecError} for a refused spec (nothing started)
 * @throws {@link ProcessSpawnError} when the OS refused to start it
 * @public
 */
export function spawnHarnessProcess(spec: SpawnSpec): Promise<HarnessProcess> {
  return spawnProcess(spec, {
    spawn,
    platform: process.platform,
    startTime:
      spec.startTime ??
      processTableStartTime(osCallsFor(process.platform, process.pid).processTable),
  });
}
