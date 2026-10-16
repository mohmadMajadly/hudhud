/**
 * The shipped digest table of the Windows job addon (plan §6.2, §6.4 step 4).
 *
 * @remarks
 * Written by the addon digest tooling (A2, `scripts/addon/write-digests.mjs`)
 * from a local or CI build. Until an addon build exists the table is empty:
 * the loader then refuses every addon file (`digest-mismatch`, missing digest
 * counts as a mismatch) and the host reports `'best-effort'`. The check is
 * defence in depth only; the real guarantees are npm integrity and
 * provenance (ADR-0009).
 *
 * @packageDocumentation
 */

/**
 * sha256 digests (lower-case hex) of the shipped addon files per
 * architecture, plus the addon `version` they were built as (the loader's
 * ABI check).
 *
 * @public
 */
export interface JobAddonDigests {
  /** The addon's `version` constant the digests belong to. */
  readonly version?: string;
  /** sha256 of `@hudhudjs/win32-job-x64/hudhud_win32_job.node`. */
  readonly x64?: string;
}

/**
 * The digest table shipped with this build of the core.
 *
 * @public
 */
export const WIN32_JOB_DIGESTS: JobAddonDigests = Object.freeze({});
