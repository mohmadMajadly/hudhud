// The real job addon through the real loader, harness mode 'staged' (plan
// §6.2, §6.5; lead rulings on A2; Windows x64 only). `pnpm addon:stage`
// builds the addon with the host's supported toolchain and stages its bytes
// with a SHA256SUMS for them. The loader runs with the x64 digest taken from
// that SHA256SUMS, which test-support's `readStagedAddon` first proves to
// name the staged bytes, and with the committed table's ABI `version`. A
// match loads it ('job'); a tampered copy is refused before dlopen and the
// host falls back to 'best-effort'. Whether the staged addon is the build of
// record is `addon-record.test.ts`.
//
// Every Windows x64 test run needs the addon staged. A missing or
// inconsistent one fails here, naming the staging command; it is never
// skipped.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  hostJobAddonDeps,
  jobContainmentCapability,
  loadJobAddon,
  type JobAddon,
} from '../../packages/core/src/process/containment/win32-job.js';
import { WIN32_JOB_DIGESTS } from '../../packages/core/src/process/containment/win32-job-digests.js';
import {
  readStagedAddon,
  stagedJobAddonDeps,
} from '../../tooling/test-support/src/launcher/staged-addon.js';
import { ADDON_FILE, checkToolchain } from '../lib/addon-digests.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const STAGED = path.join(REPO, 'packages', 'win32-job-x64', ADDON_FILE);
/**
 * Hang guard of the native suite: it took 2.3 s on the A2 host (eight
 * cases, each with its own `node` children); 60 s, the repository's hang
 * guard (vitest.config.ts), stops a hang only.
 */
const SMOKE_GUARD_MS = 60_000;

describe.runIf(process.platform === 'win32' && process.arch === 'x64')(
  'the staged job addon through the real loader (Windows x64)',
  () => {
    let dir: string;

    beforeAll(() => {
      dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-addon-')));
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    });

    it('is staged with a SHA256SUMS that names its bytes and the toolchain that built it', () => {
      // Throws, naming `pnpm addon:stage`, when it is missing or inconsistent.
      const staged = readStagedAddon(REPO);
      expect(realpathSync(staged.file)).toBe(realpathSync(STAGED));
      const toolchain = checkToolchain(
        JSON.parse(readFileSync(path.join(path.dirname(STAGED), 'toolchain.json'), 'utf8')),
      );
      expect(typeof toolchain === 'string' ? toolchain : toolchain['arch']).toBe('x64');
    });

    it("loads it from the platform package with the committed version ('staged' mode)", () => {
      const load = loadJobAddon(stagedJobAddonDeps(REPO, hostJobAddonDeps()));
      expect(load.status === 'loaded' ? 'loaded' : `${load.reason} (${load.detail})`).toBe(
        'loaded',
      );
      const addon = (load as { readonly addon: JobAddon }).addon;
      expect(realpathSync(addon.file)).toBe(realpathSync(STAGED));
      // The ABI version is the committed table's in every mode.
      expect(addon.version).toBe(WIN32_JOB_DIGESTS.version);
      expect(jobContainmentCapability(load)).toEqual({ processContainment: 'job', reasons: {} });

      // The loaded addon works: an empty job, and this process's identity.
      const job = addon.createJob();
      expect(job.listPids()).toEqual([]);
      job.terminate();
      job.close();
      expect(job.closed).toBe(true);
      expect(addon.processTimes(process.pid).pid).toBe(process.pid);
    });

    it('refuses a staged addon whose version is not the committed one (a stale table)', () => {
      const deps = stagedJobAddonDeps(REPO, hostJobAddonDeps());
      const load = loadJobAddon({ ...deps, digests: { ...deps.digests, version: '0.0.0-stale' } });
      expect(load).toEqual({
        status: 'unavailable',
        reason: 'abi-mismatch',
        detail: 'version-differs',
      });
    });

    it('passes the native suite of plan §6.5 as the staged file', () => {
      // native/win32-job/smoke.mjs (A1) against the staged addon: the rows
      // "create/assign/list/terminate with node child + grandchild", "handle
      // not inherited", "host crash" and "idempotency", plus argument
      // validation, ERR_SELF_ASSIGN, the finalizer and a host not named
      // node.exe. It kills only processes it spawned (see its header).
      const result = spawnSync(
        process.execPath,
        [path.join(REPO, 'native', 'win32-job', 'smoke.mjs'), '--addon', STAGED],
        { encoding: 'utf8', timeout: SMOKE_GUARD_MS, windowsHide: true },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain(`version ${String(WIN32_JOB_DIGESTS.version)}`);
      for (const row of [
        'create/assign/list/terminate, idempotency, ERR_JOB_CLOSED',
        'kill on close, handle not inherited',
        'host crash ends the tree',
      ]) {
        expect(output).toContain(`ok   ${row}`);
      }
      expect(output).toContain('smoke: all cases passed');
    });

    it('refuses a tampered copy before dlopen and falls back to best-effort', () => {
      const tampered = path.join(dir, ADDON_FILE);
      copyFileSync(STAGED, tampered);
      const bytes = readFileSync(tampered);
      // One byte of the DOS stub: the image would still load if it were opened.
      bytes[0x4e] = (bytes[0x4e] ?? 0) ^ 0x01;
      writeFileSync(tampered, bytes);

      const opened: string[] = [];
      const deps = stagedJobAddonDeps(REPO, hostJobAddonDeps());
      const load = loadJobAddon({
        ...deps,
        requireResolve: () => tampered,
        dlopen: (module, file) => {
          opened.push(file);
          deps.dlopen(module, file);
        },
      });
      expect(load).toEqual({
        status: 'unavailable',
        reason: 'digest-mismatch',
        detail: 'sha256-differs',
      });
      expect(opened).toEqual([]);
      expect(jobContainmentCapability(load)).toEqual({
        processContainment: 'best-effort',
        reasons: { processContainment: 'job addon unavailable: digest-mismatch (sha256-differs)' },
      });
    });
  },
);
