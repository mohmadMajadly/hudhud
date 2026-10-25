// The release record of the job addon and the committed digest table (plan
// §6.2, §6.3; lead rulings on A2).
//
// - On every OS: the table is exactly the generator's output for the
//   release manifest it names (the manifest is its only source), and the
//   record's SHA256SUMS and toolchain.json are the ones derived from the
//   manifest.
// - On Windows x64, the record check: the staged addon must equal the
//   committed table, and load through the exact product path ('host' mode,
//   the committed WIN32_JOB_DIGESTS), ONLY when it was built with the
//   toolchain of record (the staged toolchain.json equals the record's in
//   every field that can change the bytes; the generator is reported only,
//   lead ruling on A3). On any other toolchain the bytes legitimately
//   differ, and the test is skipped with a reason naming the differing
//   fields; never silently.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  hostJobAddonDeps,
  jobContainmentCapability,
  loadJobAddon,
  type JobAddon,
} from '../../packages/core/src/process/containment/win32-job.js';
import { WIN32_JOB_DIGESTS } from '../../packages/core/src/process/containment/win32-job-digests.js';
import { readStagedAddon } from '../../tooling/test-support/src/launcher/staged-addon.js';
import {
  checkToolchain,
  DIGESTS_MODULE,
  parseDigestsModule,
  parseManifest,
  releaseOf,
  renderDigestsModule,
  renderReleaseSums,
  renderReleaseToolchains,
  informationalDifferences,
  toolchainDifferences,
  type Manifest,
  type ReleaseArch,
} from '../lib/addon-digests.mjs';
import { renderManifest } from '../lib/addon-manifest.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

function read(file: string): string {
  return readFileSync(path.join(REPO, file), 'utf8');
}

const tableText = read(DIGESTS_MODULE);
const table = parseDigestsModule(tableText);
const manifestPath = table?.manifest ?? '';
const parsed = parseManifest(read(manifestPath));
const manifest: Manifest | undefined = typeof parsed === 'string' ? undefined : parsed;
/** Why the manifest was refused (empty when it was read). */
const refused = typeof parsed === 'string' ? parsed : '';
const recordX64: ReleaseArch | undefined = manifest?.arches['x64'];

describe('the release record and the committed table', () => {
  it('names a release manifest and is exactly the generator output for it', () => {
    expect(table, `${DIGESTS_MODULE} is not generated`).not.toBeNull();
    expect(parsed).not.toBeTypeOf('string');
    expect(manifest?.release).toBe(releaseOf(manifestPath));
    expect(table).toEqual({
      version: manifest?.version,
      x64: recordX64?.sha256,
      manifest: manifestPath,
    });
    expect(
      renderDigestsModule({
        version: String(manifest?.version),
        x64: String(recordX64?.sha256),
        manifest: manifestPath,
      }),
    ).toBe(tableText);
    expect(WIN32_JOB_DIGESTS).toEqual({ version: manifest?.version, x64: recordX64?.sha256 });
  });

  it("holds the record's SHA256SUMS and toolchain.json as derived from the manifest", () => {
    if (manifest === undefined) throw new Error(`${manifestPath}: ${refused}`);
    const dir = path.posix.dirname(manifestPath);
    expect(read(`${dir}/SHA256SUMS`)).toBe(renderReleaseSums(manifest));
    expect(read(`${dir}/toolchain.json`)).toBe(renderReleaseToolchains(manifest));
    expect(read(`${dir}/manifest.json`)).toBe(renderManifest(manifest));
  });
});

describe.runIf(process.platform === 'win32' && process.arch === 'x64')(
  'the record check (Windows x64)',
  () => {
    it("the staged addon is the build of record and loads through the product path ('host')", (ctx) => {
      if (recordX64 === undefined) throw new Error(`${manifestPath}: ${refused}`);
      const staged = readStagedAddon(REPO);
      const toolchain = checkToolchain(JSON.parse(read('packages/win32-job-x64/toolchain.json')));
      if (typeof toolchain === 'string') {
        throw new Error(`packages/win32-job-x64/toolchain.json: ${toolchain}`);
      }
      // Informational fields (the generator, shown not to change the bytes:
      // Addon prebuild run 38947897592) are reported, never a reason to skip.
      for (const field of informationalDifferences(recordX64.toolchain, toolchain)) {
        process.stderr.write(
          `record check: ${field} ${String(toolchain[field])} (record ${String(recordX64.toolchain[field])}), information only: it does not change the bytes\n`,
        );
      }
      const differs = toolchainDifferences(recordX64.toolchain, toolchain);
      if (differs.length > 0) {
        const reason = `the staged addon was not built with the toolchain of record (${manifestPath}); differing fields: ${differs
          .map(
            (field) =>
              `${field} ${String(toolchain[field])} (record ${String(recordX64.toolchain[field])})`,
          )
          .join(', ')}`;
        process.stderr.write(`record check skipped: ${reason}\n`);
        ctx.skip(reason);
      }

      // The toolchain of record must reproduce the record exactly.
      expect(staged.sha256).toBe(recordX64.sha256);
      expect(staged.sha256).toBe(WIN32_JOB_DIGESTS.x64);

      // 'host' mode: the exact product path with the committed table.
      const load = loadJobAddon(hostJobAddonDeps());
      expect(load.status === 'loaded' ? 'loaded' : `${load.reason} (${load.detail})`).toBe(
        'loaded',
      );
      const addon = (load as { readonly addon: JobAddon }).addon;
      expect(addon.version).toBe(WIN32_JOB_DIGESTS.version);
      expect(jobContainmentCapability(load)).toEqual({ processContainment: 'job', reasons: {} });
      const job = addon.createJob();
      expect(job.listPids()).toEqual([]);
      job.close();
    });
  },
);
