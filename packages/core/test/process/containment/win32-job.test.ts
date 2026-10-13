// Loader of the Windows job addon (plan §6.4, §6.5 "loader unit tests"): every
// outcome on every OS through injected deps and the fake addon; never throws.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  hostJobAddonDeps,
  JOB_MAX_LISTED_PIDS,
  jobContainmentCapability,
  JobAddonError,
  loadHostJobAddon,
  loadJobAddon,
  WIN32_JOB_ADDON_SPECIFIER,
  type JobAddon,
  type JobAddonLoad,
  type JobContainment,
} from '../../../src/process/containment/win32-job.js';
import { WIN32_JOB_DIGESTS } from '../../../src/process/containment/win32-job-digests.js';
import type { ProcessContainment } from '../../../src/protocol/capabilities.js';
import { FAKE_ADDON_PATH, FAKE_VERSION, FakeJobAddon, fakeDeps } from './fake-addon.js';

function loaded(load: JobAddonLoad): JobAddon {
  if (load.status !== 'loaded') throw new Error(`not loaded: ${load.reason} (${load.detail})`);
  return load.addon;
}

function codeError(code: unknown): Error {
  return Object.assign(new Error('boom'), { code });
}

function thrown(run: () => unknown): JobAddonError {
  try {
    run();
  } catch (error) {
    if (error instanceof JobAddonError) return error;
    throw error;
  }
  throw new Error('did not throw');
}

describe('loadJobAddon outcomes', () => {
  it('reports not-windows off win32 without touching anything', () => {
    for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
      const deps = fakeDeps(new FakeJobAddon().exports(), {
        platform,
        requireResolve: () => {
          throw new Error('must not resolve');
        },
      });
      expect(loadJobAddon(deps)).toEqual({
        status: 'unavailable',
        reason: 'not-windows',
        detail: platform,
      });
      expect(deps.opened).toEqual([]);
    }
  });

  it('reports arm64 as not first-class (K17) and other architectures as unsupported', () => {
    const fake = new FakeJobAddon().exports();
    expect(loadJobAddon(fakeDeps(fake, { arch: 'arm64' }))).toEqual({
      status: 'unavailable',
      reason: 'arm64-not-first-class',
      detail: 'arm64',
    });
    for (const arch of ['ia32', 'arm', 'riscv64']) {
      const deps = fakeDeps(fake, { arch });
      expect(loadJobAddon(deps)).toEqual({
        status: 'unavailable',
        reason: 'unsupported-arch',
        detail: arch,
      });
      expect(deps.opened).toEqual([]);
    }
  });

  it('resolves only the fixed x64 specifier', () => {
    const asked: string[] = [];
    const load = loadJobAddon(
      fakeDeps(new FakeJobAddon().exports(), {
        requireResolve: (specifier) => {
          asked.push(specifier);
          return FAKE_ADDON_PATH;
        },
      }),
    );
    expect(load.status).toBe('loaded');
    expect(asked).toEqual(['@hudhud/win32-job-x64/hudhud_win32_job.node']);
    expect(WIN32_JOB_ADDON_SPECIFIER).toBe(asked[0]);
  });

  it('reports package-missing when resolution fails, with the error code', () => {
    const fake = new FakeJobAddon().exports();
    const missing = (code: unknown) =>
      loadJobAddon(
        fakeDeps(fake, {
          requireResolve: () => {
            throw codeError(code);
          },
        }),
      );
    expect(missing('MODULE_NOT_FOUND')).toEqual({
      status: 'unavailable',
      reason: 'package-missing',
      detail: 'MODULE_NOT_FOUND',
    });
    // A code that is not a short identifier is not echoed.
    expect(missing('a b')).toMatchObject({ reason: 'package-missing', detail: 'not-resolved' });
    expect(missing(7)).toMatchObject({ reason: 'package-missing', detail: 'not-resolved' });
  });

  it('refuses a resolution that is relative or not the addon file (never cwd or PATH)', () => {
    const fake = new FakeJobAddon().exports();
    for (const resolved of [
      'hudhud_win32_job.node',
      '.\\hudhud_win32_job.node',
      'C:hudhud_win32_job.node',
      'C:\\repo\\node_modules\\@hudhud\\win32-job-x64\\other.node',
      'C:\\repo\\node_modules\\@hudhud\\win32-job-x64\\hudhud_win32_job.node.js',
    ]) {
      const deps = fakeDeps(fake, { requireResolve: () => resolved });
      expect(loadJobAddon(deps)).toEqual({
        status: 'unavailable',
        reason: 'package-missing',
        detail: 'unexpected-resolution',
      });
      expect(deps.opened).toEqual([]);
    }
    expect(
      loadJobAddon(fakeDeps(fake, { requireResolve: () => 42 as unknown as string })),
    ).toMatchObject({ reason: 'package-missing', detail: 'unexpected-resolution' });
    // Windows file names are case-insensitive.
    const upper = fakeDeps(fake, {
      requireResolve: () => 'C:\\repo\\node_modules\\@hudhud\\win32-job-x64\\HUDHUD_WIN32_JOB.NODE',
    });
    expect(loadJobAddon(upper).status).toBe('loaded');
  });

  it('reports package-missing when the file cannot be read', () => {
    const fake = new FakeJobAddon().exports();
    const unreadable = (code: unknown) =>
      loadJobAddon(
        fakeDeps(fake, {
          readFile: () => {
            throw codeError(code);
          },
        }),
      );
    expect(unreadable('EACCES')).toMatchObject({ reason: 'package-missing', detail: 'EACCES' });
    expect(unreadable(undefined)).toMatchObject({
      reason: 'package-missing',
      detail: 'unreadable',
    });
    const notBytes = fakeDeps(fake, { readFile: () => 'bytes' as unknown as Uint8Array });
    expect(loadJobAddon(notBytes)).toMatchObject({
      reason: 'package-missing',
      detail: 'unreadable',
    });
    expect(notBytes.opened).toEqual([]);
  });

  it('reports digest-mismatch for a missing, malformed or different digest and never opens the file', () => {
    const fake = new FakeJobAddon().exports();
    const cases: [Parameters<typeof fakeDeps>[1], string][] = [
      [{ digests: { version: FAKE_VERSION } }, 'no-shipped-digest'],
      [{ digests: {} }, 'no-shipped-digest'],
      [{ digests: { x64: 'ABC', version: FAKE_VERSION } }, 'no-shipped-digest'],
      [
        {
          digests: { x64: fakeDeps(fake).digests.x64?.toUpperCase() ?? '', version: FAKE_VERSION },
        },
        'no-shipped-digest',
      ],
      [{ digests: { x64: '0'.repeat(64), version: FAKE_VERSION } }, 'sha256-differs'],
      [{ readFile: () => new TextEncoder().encode('tampered') }, 'sha256-differs'],
    ];
    for (const [overrides, detail] of cases) {
      const deps = fakeDeps(fake, overrides);
      expect(loadJobAddon(deps)).toEqual({
        status: 'unavailable',
        reason: 'digest-mismatch',
        detail,
      });
      expect(deps.opened).toEqual([]);
    }
  });

  it('ships an empty digest table until an addon build exists, so nothing loads', () => {
    expect(WIN32_JOB_DIGESTS).toEqual({});
    expect(Object.isFrozen(WIN32_JOB_DIGESTS)).toBe(true);
    const deps = fakeDeps(new FakeJobAddon().exports(), { digests: WIN32_JOB_DIGESTS });
    expect(loadJobAddon(deps)).toMatchObject({ reason: 'digest-mismatch' });
  });

  it('reports dlopen-failed when dlopen throws', () => {
    const fail = (error: unknown) =>
      loadJobAddon(
        fakeDeps(null, {
          dlopen: () => {
            throw error;
          },
        }),
      );
    expect(fail(codeError('ERR_DLOPEN_FAILED'))).toEqual({
      status: 'unavailable',
      reason: 'dlopen-failed',
      detail: 'ERR_DLOPEN_FAILED',
    });
    expect(fail('not an error')).toMatchObject({ reason: 'dlopen-failed', detail: 'error' });
  });

  it('opens the same path it hashed, into a fresh module object', () => {
    const seen: unknown[] = [];
    const exports = new FakeJobAddon().exports();
    const deps = fakeDeps(exports, {
      dlopen: (module, file) => {
        seen.push(file, module.exports);
        module.exports = exports;
      },
    });
    loaded(loadJobAddon(deps));
    expect(seen).toEqual([FAKE_ADDON_PATH, {}]);
  });

  it('reports abi-mismatch for a wrong shape or version', () => {
    const good = new FakeJobAddon().exports();
    const cases: [unknown, string][] = [
      [null, 'exports is not an object'],
      ['module', 'exports is not an object'],
      [{ ...good, listPids: 1 }, 'listPids is not a function'],
      [{ ...good, createJob: undefined }, 'createJob is not a function'],
      [{ ...good, version: 2 }, 'version is not a string'],
      [{ ...good, version: '2.0.0' }, 'version-differs'],
    ];
    for (const [exports, detail] of cases) {
      expect(loadJobAddon(fakeDeps(exports))).toEqual({
        status: 'unavailable',
        reason: 'abi-mismatch',
        detail,
      });
    }
    // A digest table without a version cannot vouch for any ABI.
    const noVersion = fakeDeps(good, {
      digests: { x64: fakeDeps(good).digests.x64 ?? '' },
    });
    expect(loadJobAddon(noVersion)).toMatchObject({
      reason: 'abi-mismatch',
      detail: 'version-differs',
    });
  });

  it('loads a correct addon', () => {
    const addon = loaded(loadJobAddon(fakeDeps(new FakeJobAddon().exports())));
    expect(addon.version).toBe(FAKE_VERSION);
    expect(addon.file).toBe(FAKE_ADDON_PATH);
  });

  it('never throws, whatever the deps do', () => {
    const outcome = fc.oneof(
      fc.constant('ok'),
      fc.constant('throw'),
      fc.anything().map((value) => ({ value })),
    );
    fc.assert(
      fc.property(
        fc.constantFrom<NodeJS.Platform>('win32', 'linux'),
        fc.constantFrom('x64', 'arm64', 'ia32'),
        outcome,
        outcome,
        outcome,
        fc.anything(),
        (platform, arch, resolve, read, open, exports) => {
          const pick = <T>(choice: typeof resolve, ok: T): T => {
            if (choice === 'ok') return ok;
            if (choice === 'throw') throw codeError('X');
            return choice.value as T;
          };
          const load = loadJobAddon(
            fakeDeps(exports, {
              platform,
              arch,
              requireResolve: () => pick(resolve, FAKE_ADDON_PATH),
              readFile: () => pick(read, new TextEncoder().encode('fake hudhud_win32_job.node')),
              dlopen: (module) => {
                module.exports = pick(open, exports);
              },
            }),
          );
          expect(['loaded', 'unavailable']).toContain(load.status);
        },
      ),
    );
  });
});

describe('the loaded addon', () => {
  function addonWith(fake: FakeJobAddon, exports = fake.exports()): JobAddon {
    return loaded(loadJobAddon(fakeDeps(exports)));
  }

  it('creates a job, assigns a pid and reports its start time in microseconds', () => {
    const fake = new FakeJobAddon({ processes: new Map([[4242, '133000000001234567']]) });
    const job = addonWith(fake).createJob();
    expect(job.assign(4242)).toBe('13300000000123456');
    expect(job.listPids()).toEqual([4242]);
    expect(Object.isFrozen(job.listPids())).toBe(true);
    expect(job.closed).toBe(false);
  });

  it('reports processTimes in microseconds', () => {
    const fake = new FakeJobAddon({ processes: new Map([[7, '5']]) });
    expect(addonWith(fake).processTimes(7)).toEqual({ pid: 7, startTime: '0' });
    expect(thrown(() => addonWith(fake).processTimes(8))).toMatchObject({
      code: 'WIN32_87',
      api: 'processTimes',
    });
  });

  it('terminates with exit code 0, idempotently', () => {
    const fake = new FakeJobAddon();
    const job = addonWith(fake).createJob();
    job.assign(4242);
    job.terminate();
    job.terminate();
    expect(fake.jobs[0]?.terminations).toBe(2);
    expect(fake.calls.filter((name) => name === 'exit-code-0')).toHaveLength(2);
    expect(job.listPids()).toEqual([]);
  });

  it('closes once, idempotently, and refuses every later use with ERR_JOB_CLOSED', () => {
    const fake = new FakeJobAddon();
    const job = addonWith(fake).createJob();
    job.assign(4242);
    job.close();
    job.close();
    expect(job.closed).toBe(true);
    expect(fake.calls.filter((name) => name === 'closeJob')).toHaveLength(1);
    // KILL_ON_JOB_CLOSE: the assigned process is gone.
    expect(fake.processes.has(4242)).toBe(false);
    for (const [api, run] of [
      [
        'terminateJob',
        () => {
          job.terminate();
        },
      ],
      ['assignProcess', () => job.assign(4242)],
      ['listPids', () => job.listPids()],
    ] as const) {
      const error = thrown(run);
      expect(error).toMatchObject({ code: 'ERR_JOB_CLOSED', api, name: 'JobAddonError' });
      expect(error.message).toBe(`${api} failed: ERR_JOB_CLOSED`);
    }
  });

  it('never retries a failed close', () => {
    const fake = new FakeJobAddon({ fail: { closeJob: 6 } });
    const job = addonWith(fake).createJob();
    expect(
      thrown(() => {
        job.close();
      }),
    ).toMatchObject({ code: 'WIN32_6', api: 'closeJob' });
    expect(job.closed).toBe(true);
    job.close();
    expect(fake.calls.filter((name) => name === 'closeJob')).toHaveLength(1);
  });

  it('surfaces native failures as JobAddonError with the native code and cause', () => {
    for (const api of ['createJob', 'assignProcess', 'terminateJob', 'listPids'] as const) {
      const fake = new FakeJobAddon({ fail: { [api]: 5 } });
      const addon = addonWith(fake);
      const error = thrown(() => {
        if (api === 'createJob') addon.createJob();
        const job = addon.createJob();
        if (api === 'assignProcess') job.assign(4242);
        if (api === 'terminateJob') job.terminate();
        job.listPids();
      });
      expect(error).toMatchObject({ code: 'WIN32_5', api });
      expect(error.cause).toBeInstanceOf(Error);
    }
  });

  it('uses ERR_JOB_ADDON when a native error has no usable code', () => {
    const fake = new FakeJobAddon();
    const exports = {
      ...fake.exports(),
      createJob: () => {
        throw codeError('not a code!');
      },
    };
    expect(thrown(() => addonWith(fake, exports).createJob())).toMatchObject({
      code: 'ERR_JOB_ADDON',
      api: 'createJob',
    });
  });

  it('calls the native functions on the module object', () => {
    const receivers: unknown[] = [];
    const fake = new FakeJobAddon();
    const base = fake.exports();
    const exports: Record<string, unknown> = {
      ...base,
      processTimes(this: unknown) {
        receivers.push(this);
        return { creationTime: '10' };
      },
    };
    addonWith(fake, exports).processTimes(1);
    expect(receivers).toEqual([exports]);
  });

  it('refuses results that break the contract (ERR_JOB_ADDON_OUTPUT)', () => {
    const fake = new FakeJobAddon();
    const base = fake.exports();
    const output = (overrides: Record<string, unknown>, run: (addon: JobAddon) => unknown) =>
      thrown(() => run(addonWith(fake, { ...base, ...overrides })));

    for (const job of [null, undefined, 1, 'job']) {
      expect(output({ createJob: () => job }, (addon) => addon.createJob())).toMatchObject({
        code: 'ERR_JOB_ADDON_OUTPUT',
        api: 'createJob',
      });
    }
    for (const result of [
      null,
      'x',
      {},
      { creationTime: 5 },
      { creationTime: '-1' },
      { creationTime: '01' },
    ]) {
      expect(
        output({ assignProcess: () => result }, (addon) => addon.createJob().assign(1)),
      ).toMatchObject({ code: 'ERR_JOB_ADDON_OUTPUT', api: 'assignProcess' });
      expect(
        output({ processTimes: () => result }, (addon) => addon.processTimes(1)),
      ).toMatchObject({ code: 'ERR_JOB_ADDON_OUTPUT', api: 'processTimes' });
    }
    for (const pids of [
      null,
      'x',
      [0],
      [-1],
      [1.5],
      ['1'],
      [Number.MAX_SAFE_INTEGER + 1],
      Array.from({ length: JOB_MAX_LISTED_PIDS + 1 }, (_, i) => i + 1),
    ]) {
      expect(
        output({ listPids: () => pids }, (addon) => addon.createJob().listPids()),
      ).toMatchObject({ code: 'ERR_JOB_ADDON_OUTPUT', api: 'listPids' });
    }
    const most = Array.from({ length: JOB_MAX_LISTED_PIDS }, (_, i) => i + 1);
    expect(
      addonWith(fake, { ...base, listPids: () => most })
        .createJob()
        .listPids(),
    ).toHaveLength(JOB_MAX_LISTED_PIDS);
  });
});

describe('jobContainmentCapability (K2)', () => {
  it("is 'job' only when the addon loaded", () => {
    const load = loadJobAddon(fakeDeps(new FakeJobAddon().exports()));
    expect(jobContainmentCapability(load)).toEqual({ processContainment: 'job', reasons: {} });
  });

  it("is 'best-effort' with a reasons entry otherwise", () => {
    expect(
      jobContainmentCapability({
        status: 'unavailable',
        reason: 'arm64-not-first-class',
        detail: 'arm64',
      }),
    ).toEqual({
      processContainment: 'best-effort',
      reasons: { processContainment: 'job addon unavailable: arm64-not-first-class (arm64)' },
    });
  });

  it('is a subset of ProcessContainment', () => {
    expectTypeOf<JobContainment>().toExtend<ProcessContainment>();
  });
});

describe('the host loader', () => {
  it('loads once per process and never claims a job without a shipped digest', () => {
    const first = loadHostJobAddon();
    expect(loadHostJobAddon()).toBe(first);
    // No addon build is shipped yet: every host is best-effort.
    expect(first.status).toBe('unavailable');
    if (first.status === 'unavailable') {
      expect([
        'not-windows',
        'arm64-not-first-class',
        'unsupported-arch',
        'package-missing',
        'digest-mismatch',
      ]).toContain(first.reason);
    }
  });

  it('reads the host and resolves from this package', async () => {
    const deps = hostJobAddonDeps();
    expect(deps.platform).toBe(process.platform);
    expect(deps.arch).toBe(process.arch);
    expect(deps.digests).toBe(WIN32_JOB_DIGESTS);
    expect(deps.requireResolve('node:path')).toBe('node:path');

    const dir = await mkdtemp(path.join(tmpdir(), 'hudhud-job-addon-'));
    try {
      const file = path.join(dir, 'not-an-addon.node');
      await writeFile(file, 'not a native module');
      expect(new TextDecoder().decode(deps.readFile(file))).toBe('not a native module');
      expect(() => {
        deps.dlopen({ exports: {} }, file);
      }).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
