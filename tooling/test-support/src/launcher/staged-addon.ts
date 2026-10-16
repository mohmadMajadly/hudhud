/**
 * The staged Windows job addon as the integration suites load it (plan
 * §6.2; lead rulings on A2, harness mode `'staged'`).
 *
 * @remarks
 * `pnpm addon:stage` builds the addon with whatever supported toolchain the
 * host has and stages its bytes in `packages/win32-job-x64` with a
 * `SHA256SUMS` for them. Those bytes equal the committed digest table only
 * on the toolchain of record, so the suites run the real loader with the
 * x64 digest taken from the staged `SHA256SUMS` instead. Two guards keep
 * that honest:
 *
 * - {@link readStagedAddon} proves that `SHA256SUMS` names the staged bytes
 *   (it hashes them itself), so an injected digest can never be stale;
 * - the ABI `version` stays the committed table's, so a stale table still
 *   fails every run.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { JobAddonDeps } from '@hudhudjs/core/process';

/** The x64 platform package, relative to the repository root. */
export const STAGED_ADDON_DIR = 'packages/win32-job-x64';

/** The addon's file name in the platform package. */
export const STAGED_ADDON_FILE = 'hudhud_win32_job.node';

/** What a contributor runs to stage the addon. */
const HINT = 'stage it with `pnpm addon:stage` (prerequisites in CONTRIBUTING.md)';

/** The staged addon is missing, unreadable or does not match its `SHA256SUMS`. */
export class StagedAddonError extends Error {
  override readonly name = 'StagedAddonError';
}

/** The staged addon: its file and the sha256 its `SHA256SUMS` names (and its bytes have). */
export interface StagedAddon {
  readonly file: string;
  readonly sha256: string;
}

/** Reads a file whole; injected for tests. */
export type ReadFile = (file: string) => Uint8Array;

/**
 * Reads the staged x64 addon and its `SHA256SUMS`, and proves that the
 * single line of `SHA256SUMS` names the sha256 of the staged bytes.
 *
 * @throws StagedAddonError naming what is wrong and how to stage the addon.
 */
export function readStagedAddon(
  repoRoot: string,
  readFile: ReadFile = (file) => readFileSync(file),
): StagedAddon {
  const dir = path.join(repoRoot, STAGED_ADDON_DIR);
  const file = path.join(dir, STAGED_ADDON_FILE);
  let bytes: Uint8Array;
  let sums: string;
  try {
    bytes = readFile(file);
    sums = new TextDecoder().decode(readFile(path.join(dir, 'SHA256SUMS')));
  } catch (error) {
    throw new StagedAddonError(`the job addon is not staged in ${STAGED_ADDON_DIR}; ${HINT}`, {
      cause: error,
    });
  }
  const named = /^([0-9a-f]{64}) {2}hudhud_win32_job\.node\n$/u.exec(sums)?.[1];
  if (named === undefined) {
    throw new StagedAddonError(`${STAGED_ADDON_DIR}/SHA256SUMS is malformed; ${HINT}`);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== named) {
    throw new StagedAddonError(
      `${STAGED_ADDON_DIR}/SHA256SUMS names ${named}, the staged addon is ${sha256}; ${HINT}`,
    );
  }
  return { file, sha256 };
}

/**
 * The loader deps of harness mode `'staged'`: `host` (the product's
 * `hostJobAddonDeps()`) with the x64 digest of the staged, verified addon.
 * The ABI `version` stays the committed table's. Off Windows x64 the host
 * deps are returned unchanged and nothing is read (the loader stops before
 * the digest there).
 */
export function stagedJobAddonDeps(
  repoRoot: string,
  host: JobAddonDeps,
  readFile?: ReadFile,
): JobAddonDeps {
  if (host.platform !== 'win32' || host.arch !== 'x64') return host;
  const staged = readStagedAddon(repoRoot, readFile);
  return { ...host, digests: { ...host.digests, x64: staged.sha256 } };
}
