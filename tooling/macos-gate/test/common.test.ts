import { describe, expect, it } from 'vitest';

import {
  addBounded,
  errorMessage,
  frameLabel,
  isSuccess,
  MAX_SEEN,
  pollUntil,
  shellSnapshotReady,
} from '../src/items/common.js';
import { createSandbox } from '../src/sandbox.js';
import { SimHost } from './sim.js';

describe('item helpers', () => {
  it('detects a written shell snapshot', async () => {
    const sim = new SimHost();
    const sandbox = await createSandbox(sim.fs, sim.tmpdir);
    expect(await shellSnapshotReady(sim, sandbox)).toBe(false);
    await sim.fs.writeFile(`${sandbox.config}/shell-snapshots/other.txt`, '');
    expect(await shellSnapshotReady(sim, sandbox)).toBe(false);
    await sim.fs.writeFile(`${sandbox.config}/shell-snapshots/snapshot-zsh-1.sh`, '');
    expect(await shellSnapshotReady(sim, sandbox)).toBe(true);
  });

  it('polls with a sample until done or timed out', async () => {
    const sim = new SimHost();
    let samples = 0;
    expect(
      await pollUntil(
        sim,
        () => samples >= 3,
        10_000,
        () => {
          samples += 1;
          return Promise.resolve();
        },
      ),
    ).toBe(true);
    expect(
      await pollUntil(
        sim,
        () => false,
        250,
        () => Promise.resolve(),
      ),
    ).toBe(false);
  });

  it('reads results defensively', () => {
    expect(isSuccess(undefined)).toBe(false);
    expect(
      isSuccess({ at: 0, value: { type: 'result', subtype: 'success', is_error: true } }),
    ).toBe(false);
    expect(isSuccess({ at: 0, value: { type: 'result', subtype: 'success' } })).toBe(true);
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage(7)).toBe('7');
  });

  it('bounds evidence lists at MAX_SEEN distinct names', () => {
    const set = new Set<string>();
    for (let index = 0; index < MAX_SEEN + 10; index += 1) addBounded(set, `n${String(index)}`);
    expect(set.size).toBe(MAX_SEEN);
    expect(set.has(`n${String(MAX_SEEN)}`)).toBe(false);
  });

  it('labels command_lifecycle frames with their state', () => {
    expect(frameLabel({ at: 0, value: { type: 'command_lifecycle', state: 'queued' } })).toBe(
      'command_lifecycle:queued',
    );
    expect(frameLabel({ at: 0, value: { type: 'command_lifecycle' } })).toBe('command_lifecycle');
    expect(frameLabel({ at: 0, value: { type: 'system', subtype: 'init', state: 'x' } })).toBe(
      'system/init',
    );
  });
});
