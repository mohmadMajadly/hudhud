// Timing samples of the integration suites' time bounds (plan §4.4 flake
// policy, K15; W7-T1). A test with an upper time bound records the measured
// value before asserting it. With `HUDHUD_TIMING_LOG` set to an absolute file
// path, each sample is appended there as one JSON line; without it nothing is
// written. `.github/workflows/timing.yml` runs the bounded tests repeatedly
// on the CI runners and summarizes the log (`scripts/ci-timing.mjs`): the
// bounds are 3x the maximum measured on the platform that runs them.

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** One line of the timing log. */
export interface TimingSample {
  /** Stable name of the measured quantity, for example `close-abort.overrun`. */
  readonly sample: string;
  readonly ms: number;
  readonly platform: NodeJS.Platform;
}

/**
 * Appends `ms` for `sample` to the timing log, when one is configured.
 *
 * @throws Error when `HUDHUD_TIMING_LOG` is set but not an absolute path, so
 *   a misconfigured measurement run fails instead of losing its samples.
 */
export function recordTiming(sample: string, ms: number): void {
  const log = process.env['HUDHUD_TIMING_LOG'];
  if (log === undefined || log === '') return;
  if (!path.isAbsolute(log)) {
    throw new Error(`HUDHUD_TIMING_LOG must be an absolute path, got ${JSON.stringify(log)}`);
  }
  const line: TimingSample = { sample, ms, platform: process.platform };
  appendFileSync(log, `${JSON.stringify(line)}\n`, 'utf8');
}
