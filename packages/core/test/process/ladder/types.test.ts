import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  DEFAULT_LADDER_TIMING,
  type LadderReport,
  type LadderStepName,
} from '../../../src/process/ladder/types.js';

describe('ladder types', () => {
  it('ships the plan defaults (§1.7, H5), frozen', () => {
    expect(DEFAULT_LADDER_TIMING).toEqual({
      interruptWaitMs: 1000,
      eofGraceMs: 2000,
      termGraceMs: 5000,
      taskkillGraceMs: 2000,
    });
    expect(Object.isFrozen(DEFAULT_LADDER_TIMING)).toBe(true);
  });

  it('keeps reports JSON data', () => {
    const report: LadderReport<'abort'> = {
      intent: 'abort',
      platform: 'posix',
      steps: [
        { name: 'intent', atMs: 0, outcome: 'done' },
        { name: 'sigterm', atMs: 3000, outcome: 'failed', detail: 'ESRCH' },
      ],
      exitedAfter: 'sigterm',
      signalTarget: { pid: 201, startTime: '21' },
      launcherDetected: true,
      sweep: { processesSignalled: 2, groupsSignalled: 1, skipped: 0 },
    };
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expectTypeOf<LadderStepName>().toExtend<string>();
  });
});
