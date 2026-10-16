// Timing samples of the integration suites (plan §4.4 flake policy: a timing
// bound is 3x the slowest measurement on the platform that runs it).
//
// A test that asserts a timing bound records the measured value here before
// it asserts, so a measurement run collects every sample, the ones that
// break the current bound included. Off by default: only when
// HUDHUD_IT_TIMING_SAMPLES names an absolute file is one JSON line appended
// per sample. Used by the macOS gate's integration evidence job
// (.github/workflows/macos-gate.yml, research 11) to size the macOS bounds;
// recording changes no bound and no assertion.

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** The variable that turns recording on: an absolute file path. */
export const TIMING_SAMPLES_ENV = 'HUDHUD_IT_TIMING_SAMPLES';

/** One recorded sample (one JSON line). */
export interface TimingSample {
  readonly name: string;
  readonly valueMs: number;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly node: string;
}

/**
 * Appends a sample when {@link TIMING_SAMPLES_ENV} is set; does nothing
 * otherwise.
 *
 * @throws Error when the variable is set to a relative path (a sample must
 *   never land in the working directory by accident)
 */
export function recordTimingSample(
  name: string,
  valueMs: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const file = env[TIMING_SAMPLES_ENV];
  if (file === undefined || file === '') return;
  if (!path.isAbsolute(file)) {
    throw new Error(`${TIMING_SAMPLES_ENV} must be an absolute path`);
  }
  const sample: TimingSample = {
    name,
    valueMs: Math.round(valueMs * 1000) / 1000,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
  appendFileSync(file, `${JSON.stringify(sample)}\n`);
}
