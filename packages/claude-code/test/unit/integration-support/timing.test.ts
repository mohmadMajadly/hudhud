// The opt-in timing recorder of the integration suites (plan §4.4): the one
// recorder behind both the CI timing workflow and the macOS gate's evidence
// job (W7-Z merged W7-T4's recorder into W7-T1's).

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordTiming } from '../../integration/support/timing.js';

describe('recordTiming', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hudhud-timing-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing when HUDHUD_TIMING_LOG is unset or empty', async () => {
    vi.stubEnv('HUDHUD_TIMING_LOG', undefined);
    recordTiming('x', 1);
    vi.stubEnv('HUDHUD_TIMING_LOG', '');
    recordTiming('x', 1);
    await expect(readFile(path.join(dir, 'timing.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('appends one JSON line per sample to the named file', async () => {
    const file = path.join(dir, 'timing.jsonl');
    vi.stubEnv('HUDHUD_TIMING_LOG', file);
    recordTiming('close-abort.overrun', 23.45678);
    recordTiming('close-abort.overrun', 401);
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { sample: 'close-abort.overrun', ms: 23.45678, platform: process.platform },
      { sample: 'close-abort.overrun', ms: 401, platform: process.platform },
    ]);
  });

  it('refuses a relative path', () => {
    vi.stubEnv('HUDHUD_TIMING_LOG', 'timing.jsonl');
    expect(() => {
      recordTiming('x', 1);
    }).toThrow(/must be an absolute path/);
  });
});
