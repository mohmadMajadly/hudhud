// The opt-in timing-sample recorder of the integration suites (plan §4.4).

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordTimingSample,
  TIMING_SAMPLES_ENV,
} from '../../integration/support/timing-samples.js';

describe('recordTimingSample', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hudhud-samples-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing when the variable is unset or empty', async () => {
    recordTimingSample('x', 1, {});
    recordTimingSample('x', 1, { [TIMING_SAMPLES_ENV]: '' });
    await expect(readFile(path.join(dir, 'samples.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('appends one JSON line per sample to the named file', async () => {
    const file = path.join(dir, 'samples.jsonl');
    const env = { [TIMING_SAMPLES_ENV]: file };
    recordTimingSample('close-abort/close-deadline-overrun', 23.45678, env);
    recordTimingSample('close-abort/close-deadline-overrun', 401, env);
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        name: 'close-abort/close-deadline-overrun',
        valueMs: 23.457,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
      {
        name: 'close-abort/close-deadline-overrun',
        valueMs: 401,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
    ]);
  });

  it('refuses a relative path', () => {
    expect(() => {
      recordTimingSample('x', 1, { [TIMING_SAMPLES_ENV]: 'samples.jsonl' });
    }).toThrow(/absolute path/);
  });
});
