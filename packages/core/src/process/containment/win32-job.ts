/**
 * Loader of the Windows job-object addon, with fallback (ADR-0009, plan
 * §6.4, K2, K17).
 *
 * @remarks
 * {@link loadJobAddon} never throws. It walks the steps of plan §6.4 and
 * stops at the first that fails:
 *
 * 1. not win32: `not-windows`;
 * 2. `arm64`: `arm64-not-first-class` (K17: not shipped first-class in v1);
 *    any other architecture but `x64`: `unsupported-arch`;
 * 3. resolve the fixed specifier {@link WIN32_JOB_ADDON_SPECIFIER} through
 *    the module resolution of this package (never the working directory,
 *    never `PATH`); not found, not absolute, not the expected file name, or
 *    unreadable: `package-missing`;
 * 4. sha256 of the bytes read against the shipped digest table; a missing
 *    digest counts as a mismatch: `digest-mismatch`. Defence in depth only:
 *    the real guarantees are npm integrity and provenance. Residual: the
 *    file is hashed, then opened again by `dlopen`; whoever can swap the
 *    file in between can already write to the installed packages;
 * 5. `process.dlopen` of the same path into a fresh module object:
 *    `dlopen-failed`;
 * 6. the module's shape and its `version` against the digest table's:
 *    `abi-mismatch`.
 *
 * Only an addon that passed every step is `loaded`; nothing else ever
 * reports `'job'` ({@link jobContainmentCapability}).
 *
 * The loaded addon is wrapped ({@link JobAddon}): every native result is
 * checked before it is used, start times leave in the canonical Windows
 * unit (the addon reports FILETIME 100 ns units; they are truncated to
 * microseconds, `tree/start-time.ts`), and every native failure surfaces as
 * a {@link JobAddonError} with a string `code`.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

import { errnoCode } from '../cwd.js';
import type { JobHandle } from '../ladder/windows.js';
import { filetimeToMicroseconds, isCanonicalStartTime } from '../tree/start-time.js';
import type { ProcessIdentity } from '../tree/types.js';
import { WIN32_JOB_DIGESTS, type JobAddonDigests } from './win32-job-digests.js';

/**
 * The only specifier the loader resolves (x64, the one first-class
 * architecture in v1, K17).
 *
 * @beta
 */
export const WIN32_JOB_ADDON_SPECIFIER = '@hudhudjs/win32-job-x64/hudhud_win32_job.node';

const ADDON_FILE_NAME = 'hudhud_win32_job.node';

/**
 * Upper bound of `listPids` (the addon's buffer bound, plan §6.1).
 *
 * @beta
 */
export const JOB_MAX_LISTED_PIDS = 65_536;

/**
 * The exit code `TerminateJobObject` gives every process of the job. 0, as a
 * job close does (05 §9): exit codes prove nothing, the termination intent
 * recorded before the kill does (ADR-0008 E8).
 *
 * @beta
 */
export const JOB_TERMINATE_EXIT_CODE = 0;

/**
 * Why the addon was not loaded (plan §6.4).
 *
 * @beta
 */
export type JobAddonUnavailableReason =
  | 'not-windows'
  | 'arm64-not-first-class'
  | 'unsupported-arch'
  | 'package-missing'
  | 'digest-mismatch'
  | 'dlopen-failed'
  | 'abi-mismatch';

/**
 * The module object `dlopen` fills (`process.dlopen`'s first argument).
 *
 * @beta
 */
export interface JobAddonModuleObject {
  exports: unknown;
}

/**
 * What {@link loadJobAddon} reads from the host; injected for tests.
 *
 * @beta
 */
export interface JobAddonDeps {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Module resolution from this package (`createRequire(import.meta.url).resolve`); throws when not found. */
  readonly requireResolve: (specifier: string) => string;
  /** Reads the whole file. */
  readonly readFile: (file: string) => Uint8Array;
  /** `process.dlopen`. */
  readonly dlopen: (module: JobAddonModuleObject, file: string) => void;
  /** The shipped digest table. */
  readonly digests: JobAddonDigests;
}

/**
 * A job object created by the addon. The handle the Windows ladder takes
 * ({@link JobHandle}).
 *
 * @beta
 */
export interface JobObject extends JobHandle {
  /**
   * `assignProcess`: assigns the process to the job. Call it only while the
   * spawned child's handle is held (no pid reuse). Returns the process's
   * start time in canonical microseconds.
   */
  assign(pid: number): string;
  /** `TerminateJobObject` with {@link JOB_TERMINATE_EXIT_CODE}; idempotent. */
  terminate(): void;
  /** The pids in the job (`JobObjectBasicProcessIdList`). */
  listPids(): readonly number[];
  /**
   * Closes the handle (`KILL_ON_JOB_CLOSE`: every process still in the job
   * dies). Idempotent; never retried, even when it failed. Every later call
   * of the other methods throws `ERR_JOB_CLOSED`.
   */
  close(): void;
  /** True once {@link JobObject.close} was called. */
  readonly closed: boolean;
}

/**
 * The loaded, checked addon.
 *
 * @beta
 */
export interface JobAddon {
  /** The addon's `version` constant. */
  readonly version: string;
  /** The file it was loaded from. */
  readonly file: string;
  /** `createJob`: a new job with `KILL_ON_JOB_CLOSE`, not inheritable. */
  createJob(): JobObject;
  /** `processTimes`: the pid with its start time in canonical microseconds. */
  processTimes(pid: number): ProcessIdentity;
}

/**
 * Result of {@link loadJobAddon}.
 *
 * @beta
 */
export type JobAddonLoad =
  | { readonly status: 'loaded'; readonly addon: JobAddon }
  | {
      readonly status: 'unavailable';
      readonly reason: JobAddonUnavailableReason;
      /** Short, path-free explanation (an error code, which digest). */
      readonly detail: string;
    };

/**
 * A failure of the job addon: a native error (`WIN32_<n>`, `ERR_JOB_CLOSED`,
 * any other code the addon set) or a result the loader refused
 * (`ERR_JOB_ADDON_OUTPUT`). `ERR_JOB_ADDON` when the native error had no
 * usable code.
 *
 * @beta
 */
export class JobAddonError extends Error {
  override readonly name = 'JobAddonError';
  readonly code: string;
  /** The addon function that failed. */
  readonly api: string;

  constructor(code: string, api: string, options?: { readonly cause?: unknown }) {
    super(`${api} failed: ${code}`, options);
    this.code = code;
    this.api = api;
  }
}

/**
 * Containment a job addon load can give (a subset of `ProcessContainment`).
 *
 * @beta
 */
export type JobContainment = 'job' | 'best-effort';

/**
 * The Harness capability part that depends on the addon (K2).
 *
 * @beta
 */
export interface JobContainmentCapability {
  readonly processContainment: JobContainment;
  /** `HarnessCapabilities.reasons` entries; empty when the addon loaded. */
  readonly reasons: Readonly<Record<string, string>>;
}

const CODE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The error's `code` when it is a short identifier, else `fallback`. */
function codeOf(error: unknown, fallback: string): string {
  const code = errnoCode(error);
  return code !== undefined && CODE.test(code) ? code : fallback;
}

type NativeFunction = (this: unknown, ...args: unknown[]) => unknown;

function isFunction(value: unknown): value is NativeFunction {
  return typeof value === 'function';
}

const NATIVE_FUNCTIONS = [
  'createJob',
  'assignProcess',
  'terminateJob',
  'closeJob',
  'listPids',
  'processTimes',
] as const;

type NativeName = (typeof NATIVE_FUNCTIONS)[number];

/** The native module after its shape was checked. */
interface NativeAddon {
  readonly self: object;
  readonly version: string;
  readonly functions: Readonly<Record<NativeName, NativeFunction>>;
}

/** The checked native module, or why its shape is refused. */
function nativeAddon(exports: unknown): NativeAddon | string {
  if (typeof exports !== 'object' || exports === null) return 'exports is not an object';
  const functions: Partial<Record<NativeName, NativeFunction>> = {};
  for (const name of NATIVE_FUNCTIONS) {
    const value: unknown = Reflect.get(exports, name);
    if (!isFunction(value)) return `${name} is not a function`;
    functions[name] = value;
  }
  const version: unknown = Reflect.get(exports, 'version');
  if (typeof version !== 'string') return 'version is not a string';
  return { self: exports, version, functions: functions as Record<NativeName, NativeFunction> };
}

/** Calls a native function; any throw becomes a {@link JobAddonError}. */
function call(native: NativeAddon, name: NativeName, args: unknown[]): unknown {
  try {
    return native.functions[name].call(native.self, ...args);
  } catch (error) {
    throw new JobAddonError(codeOf(error, 'ERR_JOB_ADDON'), name, { cause: error });
  }
}

/** A `{ creationTime }` result as canonical microseconds. */
function creationTimeOf(result: unknown, api: NativeName): string {
  const value: unknown =
    typeof result === 'object' && result !== null ? Reflect.get(result, 'creationTime') : undefined;
  if (typeof value !== 'string' || !isCanonicalStartTime(value)) {
    throw new JobAddonError('ERR_JOB_ADDON_OUTPUT', api);
  }
  return filetimeToMicroseconds(value);
}

class AddonJob implements JobObject {
  readonly #native: NativeAddon;
  readonly #job: object;
  #closed = false;

  constructor(native: NativeAddon, job: object) {
    this.#native = native;
    this.#job = job;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #open(api: NativeName): void {
    if (this.#closed) throw new JobAddonError('ERR_JOB_CLOSED', api);
  }

  assign(pid: number): string {
    this.#open('assignProcess');
    return creationTimeOf(call(this.#native, 'assignProcess', [this.#job, pid]), 'assignProcess');
  }

  terminate(): void {
    this.#open('terminateJob');
    call(this.#native, 'terminateJob', [this.#job, JOB_TERMINATE_EXIT_CODE]);
  }

  listPids(): readonly number[] {
    this.#open('listPids');
    const pids = call(this.#native, 'listPids', [this.#job]);
    if (
      !Array.isArray(pids) ||
      pids.length > JOB_MAX_LISTED_PIDS ||
      !pids.every((pid: unknown) => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0)
    ) {
      throw new JobAddonError('ERR_JOB_ADDON_OUTPUT', 'listPids');
    }
    return Object.freeze([...(pids as number[])]);
  }

  close(): void {
    if (this.#closed) return;
    // Marked first: a failed CloseHandle is never retried (the handle value
    // may already name another object).
    this.#closed = true;
    call(this.#native, 'closeJob', [this.#job]);
  }
}

class LoadedJobAddon implements JobAddon {
  readonly version: string;
  readonly file: string;
  readonly #native: NativeAddon;

  constructor(native: NativeAddon, file: string) {
    this.#native = native;
    this.version = native.version;
    this.file = file;
  }

  createJob(): JobObject {
    const job = call(this.#native, 'createJob', []);
    if (typeof job !== 'object' || job === null) {
      throw new JobAddonError('ERR_JOB_ADDON_OUTPUT', 'createJob');
    }
    return new AddonJob(this.#native, job);
  }

  processTimes(pid: number): ProcessIdentity {
    return {
      pid,
      startTime: creationTimeOf(call(this.#native, 'processTimes', [pid]), 'processTimes'),
    };
  }
}

function unavailable(reason: JobAddonUnavailableReason, detail: string): JobAddonLoad {
  return { status: 'unavailable', reason, detail };
}

/**
 * Loads the job addon, or says why not (plan §6.4; see the module remarks).
 * Never throws.
 *
 * @beta
 */
export function loadJobAddon(deps: JobAddonDeps): JobAddonLoad {
  if (deps.platform !== 'win32') return unavailable('not-windows', deps.platform);
  if (deps.arch === 'arm64') return unavailable('arm64-not-first-class', deps.arch);
  if (deps.arch !== 'x64') return unavailable('unsupported-arch', deps.arch);

  let file: string;
  try {
    file = deps.requireResolve(WIN32_JOB_ADDON_SPECIFIER);
  } catch (error) {
    return unavailable('package-missing', codeOf(error, 'not-resolved'));
  }
  if (
    typeof file !== 'string' ||
    !path.win32.isAbsolute(file) ||
    path.win32.basename(file).toLowerCase() !== ADDON_FILE_NAME
  ) {
    return unavailable('package-missing', 'unexpected-resolution');
  }
  let bytes: Uint8Array;
  try {
    bytes = deps.readFile(file);
  } catch (error) {
    return unavailable('package-missing', codeOf(error, 'unreadable'));
  }
  if (!(bytes instanceof Uint8Array)) return unavailable('package-missing', 'unreadable');

  const expected = deps.digests.x64;
  if (expected === undefined || !SHA256.test(expected)) {
    return unavailable('digest-mismatch', 'no-shipped-digest');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    return unavailable('digest-mismatch', 'sha256-differs');
  }

  const module: JobAddonModuleObject = { exports: {} };
  try {
    deps.dlopen(module, file);
  } catch (error) {
    return unavailable('dlopen-failed', codeOf(error, 'error'));
  }

  const native = nativeAddon(module.exports);
  if (typeof native === 'string') return unavailable('abi-mismatch', native);
  if (deps.digests.version === undefined || native.version !== deps.digests.version) {
    return unavailable('abi-mismatch', 'version-differs');
  }
  return { status: 'loaded', addon: new LoadedJobAddon(native, file) };
}

/**
 * The host's {@link JobAddonDeps}: this process's platform and architecture,
 * resolution from this package, `readFileSync`, `process.dlopen` and the
 * shipped digest table. Creating them loads nothing.
 *
 * @beta
 */
export function hostJobAddonDeps(): JobAddonDeps {
  const require = createRequire(import.meta.url);
  return {
    platform: process.platform,
    arch: process.arch,
    requireResolve: (specifier) => require.resolve(specifier),
    readFile: (file) => readFileSync(file),
    dlopen: (module, file) => {
      process.dlopen(module, file);
    },
    digests: WIN32_JOB_DIGESTS,
  };
}

let hostLoad: JobAddonLoad | undefined;

/**
 * {@link loadJobAddon} with {@link hostJobAddonDeps}, once per process (a
 * native module is opened once). Never throws.
 *
 * @beta
 */
export function loadHostJobAddon(): JobAddonLoad {
  hostLoad ??= loadJobAddon(hostJobAddonDeps());
  return hostLoad;
}

/**
 * The Harness capability `processContainment` for a load (K2): `'job'` only
 * when the addon loaded, else `'best-effort'` with a `reasons` entry.
 *
 * @beta
 */
export function jobContainmentCapability(load: JobAddonLoad): JobContainmentCapability {
  if (load.status === 'loaded') return { processContainment: 'job', reasons: {} };
  return {
    processContainment: 'best-effort',
    reasons: {
      processContainment: `job addon unavailable: ${load.reason} (${load.detail})`,
    },
  };
}
