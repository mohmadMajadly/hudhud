// The staged job addon of harness mode 'staged' (plan §6.2; lead rulings on
// A2): SHA256SUMS must name the staged bytes, and only the x64 digest is
// replaced; everything here runs on every OS through an in-memory reader.

import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { JobAddonDeps } from '@hudhudjs/core/process';

import {
  readStagedAddon,
  STAGED_ADDON_DIR,
  STAGED_ADDON_FILE,
  StagedAddonError,
  stagedJobAddonDeps,
} from '../../src/launcher/staged-addon.js';

const ROOT = path.resolve('/repo');
const BYTES = new TextEncoder().encode('staged addon bytes');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const ADDON = path.join(ROOT, STAGED_ADDON_DIR, STAGED_ADDON_FILE);
const SUMS = path.join(ROOT, STAGED_ADDON_DIR, 'SHA256SUMS');

function reader(files: Record<string, string | Uint8Array>): (file: string) => Uint8Array {
  return (file) => {
    const data = files[file];
    if (data === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
  };
}

function host(overrides: Partial<JobAddonDeps> = {}): JobAddonDeps {
  return {
    platform: 'win32',
    arch: 'x64',
    requireResolve: () => ADDON,
    readFile: () => BYTES,
    dlopen: () => undefined,
    digests: { version: '0.1.0', x64: '0'.repeat(64) },
    ...overrides,
  };
}

describe('readStagedAddon', () => {
  it('returns the staged file and the sha256 its SHA256SUMS names and its bytes have', () => {
    const read = reader({ [ADDON]: BYTES, [SUMS]: `${SHA}  hudhud_win32_job.node\n` });
    expect(readStagedAddon(ROOT, read)).toEqual({ file: ADDON, sha256: SHA });
  });

  it('refuses a missing addon or SHA256SUMS, naming the staging command', () => {
    for (const files of [{ [SUMS]: `${SHA}  hudhud_win32_job.node\n` }, { [ADDON]: BYTES }]) {
      const run = () => readStagedAddon(ROOT, reader(files));
      expect(run).toThrow(StagedAddonError);
      expect(run).toThrow(
        /is not staged in packages\/win32-job-x64; stage it with `pnpm addon:stage`/u,
      );
    }
  });

  it('refuses a malformed SHA256SUMS', () => {
    for (const sums of [
      '',
      `${SHA}  hudhud_win32_job.node`,
      `${SHA} hudhud_win32_job.node\n`,
      `${SHA.toUpperCase()}  hudhud_win32_job.node\n`,
      `${SHA}  other.node\n`,
    ]) {
      expect(() => readStagedAddon(ROOT, reader({ [ADDON]: BYTES, [SUMS]: sums }))).toThrow(
        /SHA256SUMS is malformed/u,
      );
    }
  });

  it('refuses a SHA256SUMS that does not name the staged bytes (a stale injected digest)', () => {
    const other = 'f'.repeat(64);
    expect(() =>
      readStagedAddon(
        ROOT,
        reader({ [ADDON]: BYTES, [SUMS]: `${other}  hudhud_win32_job.node\n` }),
      ),
    ).toThrow(`SHA256SUMS names ${other}, the staged addon is ${SHA}`);
  });

  it('reads the real files by default', () => {
    // Nothing is staged under a root that does not exist.
    expect(() => readStagedAddon(path.join(ROOT, 'missing'))).toThrow(StagedAddonError);
  });
});

describe('stagedJobAddonDeps', () => {
  it('replaces only the x64 digest on Windows x64, keeping the committed version', () => {
    const read = reader({ [ADDON]: BYTES, [SUMS]: `${SHA}  hudhud_win32_job.node\n` });
    const base = host();
    const deps = stagedJobAddonDeps(ROOT, base, read);
    expect(deps.digests).toEqual({ version: '0.1.0', x64: SHA });
    expect({ ...deps, digests: base.digests }).toEqual(base);
  });

  it('reads nothing off Windows x64', () => {
    const fail = () => {
      throw new Error('must not read');
    };
    for (const overrides of [{ platform: 'linux' as const }, { arch: 'arm64' }]) {
      const base = host(overrides);
      expect(stagedJobAddonDeps(ROOT, base, fail)).toBe(base);
    }
  });

  it('propagates a missing staged addon instead of falling back', () => {
    expect(() => stagedJobAddonDeps(ROOT, host(), reader({}))).toThrow(StagedAddonError);
  });
});
