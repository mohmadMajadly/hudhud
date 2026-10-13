// A fake of the native job addon (plan §6.1 contract) for tests on every OS:
// `createJob`, `assignProcess`, `terminateJob`, `closeJob`, `listPids`,
// `processTimes`, `version`. Idempotent terminate and close, `ERR_JOB_CLOSED`
// after close, `WIN32_<n>` failures on demand, creation times in FILETIME
// 100 ns units like the real addon.

import { createHash } from 'node:crypto';

import type {
  JobAddonDeps,
  JobAddonModuleObject,
} from '../../../src/process/containment/win32-job.js';

export const FAKE_VERSION = '1.0.0';

/** Bytes standing in for the `.node` file, and their digest. */
export const FAKE_ADDON_BYTES = new TextEncoder().encode('fake hudhud_win32_job.node');
export const FAKE_ADDON_SHA256 = createHash('sha256').update(FAKE_ADDON_BYTES).digest('hex');
export const FAKE_ADDON_PATH =
  'C:\\repo\\node_modules\\@hudhud\\win32-job-x64\\hudhud_win32_job.node';

function win32Error(api: string, code: number): Error {
  return Object.assign(new Error(`${api} failed`), { code: `WIN32_${String(code)}` });
}

function closedError(api: string): Error {
  return Object.assign(new Error(`${api}: job closed`), { code: 'ERR_JOB_CLOSED' });
}

interface FakeJob {
  readonly id: number;
  closed: boolean;
  terminations: number;
  readonly pids: Set<number>;
}

export interface FakeAddonOptions {
  /** FILETIME creation times (100 ns, decimal) of the processes that exist. */
  readonly processes?: ReadonlyMap<number, string>;
  /** Win32 error codes to fail with, per function. */
  readonly fail?: Partial<
    Record<'createJob' | 'assignProcess' | 'terminateJob' | 'closeJob' | 'listPids', number>
  >;
}

/** The fake's state, for assertions. */
export class FakeJobAddon {
  readonly jobs: FakeJob[] = [];
  readonly calls: string[] = [];
  readonly processes: Map<number, string>;
  readonly #fail: NonNullable<FakeAddonOptions['fail']>;
  readonly #handles = new WeakMap<object, FakeJob>();

  constructor(options: FakeAddonOptions = {}) {
    this.processes = new Map(options.processes ?? [[4242, '133000000001234567']]);
    this.#fail = options.fail ?? {};
  }

  #check(api: keyof NonNullable<FakeAddonOptions['fail']>): void {
    this.calls.push(api);
    const code = this.#fail[api];
    if (code !== undefined) throw win32Error(api, code);
  }

  #job(handle: unknown, api: string): FakeJob {
    const job =
      typeof handle === 'object' && handle !== null ? this.#handles.get(handle) : undefined;
    if (job === undefined)
      throw Object.assign(new TypeError(`${api}: not a job`), { code: 'EINVAL' });
    return job;
  }

  /** The module exports, as `process.dlopen` would set them. */
  exports(): Record<string, unknown> {
    return {
      version: FAKE_VERSION,
      createJob: (): object => {
        this.#check('createJob');
        const job: FakeJob = {
          id: this.jobs.length,
          closed: false,
          terminations: 0,
          pids: new Set(),
        };
        this.jobs.push(job);
        const handle = Object.freeze({});
        this.#handles.set(handle, job);
        return handle;
      },
      assignProcess: (handle: unknown, pid: number): { creationTime: string } => {
        const job = this.#job(handle, 'assignProcess');
        if (job.closed) throw closedError('assignProcess');
        this.#check('assignProcess');
        const creationTime = this.processes.get(pid);
        if (creationTime === undefined) throw win32Error('OpenProcess', 87);
        job.pids.add(pid);
        return { creationTime };
      },
      terminateJob: (handle: unknown, exitCode: number): void => {
        const job = this.#job(handle, 'terminateJob');
        if (job.closed) throw closedError('terminateJob');
        this.#check('terminateJob');
        this.calls.push(`exit-code-${String(exitCode)}`);
        job.terminations += 1;
        for (const pid of job.pids) this.processes.delete(pid);
        job.pids.clear();
      },
      closeJob: (handle: unknown): void => {
        const job = this.#job(handle, 'closeJob');
        if (job.closed) return;
        this.#check('closeJob');
        job.closed = true;
        for (const pid of job.pids) this.processes.delete(pid);
        job.pids.clear();
      },
      listPids: (handle: unknown): number[] => {
        const job = this.#job(handle, 'listPids');
        if (job.closed) throw closedError('listPids');
        this.#check('listPids');
        return [...job.pids];
      },
      processTimes: (pid: number): { creationTime: string } => {
        this.calls.push('processTimes');
        const creationTime = this.processes.get(pid);
        if (creationTime === undefined) throw win32Error('OpenProcess', 87);
        return { creationTime };
      },
    };
  }
}

/** Loader deps that find `exports` as a correctly digested, loadable addon on win32 x64. */
export function fakeDeps(
  exports: unknown,
  overrides: Partial<JobAddonDeps> = {},
): JobAddonDeps & { readonly opened: string[] } {
  const opened: string[] = [];
  return {
    platform: 'win32',
    arch: 'x64',
    requireResolve: () => FAKE_ADDON_PATH,
    readFile: () => FAKE_ADDON_BYTES,
    dlopen: (module: JobAddonModuleObject, file: string) => {
      opened.push(file);
      module.exports = exports;
    },
    digests: { x64: FAKE_ADDON_SHA256, version: FAKE_VERSION },
    opened,
    ...overrides,
  };
}
