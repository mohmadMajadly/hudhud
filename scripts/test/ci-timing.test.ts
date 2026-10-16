import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MIN_SAMPLES,
  nearestRank,
  parseSamples,
  renderSummary,
  summarize,
} from '../lib/ci-timing.mjs';

const line = (sample: string, ms: number, platform = 'linux') =>
  JSON.stringify({ sample, ms, platform });

describe('parseSamples', () => {
  it('reads one sample per line and skips blank lines', () => {
    expect(parseSamples(`${line('a.b', 1.5)}\n\n${line('a.b', 2, 'win32')}\n`)).toEqual([
      { sample: 'a.b', ms: 1.5, platform: 'linux' },
      { sample: 'a.b', ms: 2, platform: 'win32' },
    ]);
  });

  it.each([
    ['{', 'line 2: not JSON'],
    ['[1]', 'line 2: not an object'],
    ['null', 'line 2: not an object'],
    [JSON.stringify({ sample: 'Bad Name', ms: 1, platform: 'linux' }), 'line 2: bad sample name'],
    [JSON.stringify({ ms: 1, platform: 'linux' }), 'line 2: bad sample name'],
    [JSON.stringify({ sample: 'a', ms: -1, platform: 'linux' }), 'line 2: bad ms'],
    [JSON.stringify({ sample: 'a', ms: '1', platform: 'linux' }), 'line 2: bad ms'],
    [JSON.stringify({ sample: 'a', ms: 1, platform: 'Linux OS' }), 'line 2: bad platform'],
    [JSON.stringify({ sample: 'a', ms: 1 }), 'line 2: bad platform'],
  ])('refuses %s', (bad, message) => {
    expect(() => parseSamples(`${line('a', 1)}\n${bad}\n`)).toThrow(message);
  });

  it('refuses a non-finite ms written as a huge literal', () => {
    expect(() => parseSamples('{"sample":"a","ms":1e999,"platform":"linux"}')).toThrow(
      'line 1: bad ms',
    );
  });
});

describe('nearestRank', () => {
  it('takes the value at rank ceil(q * n)', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(nearestRank(values, 0.95)).toBe(19);
    expect(nearestRank(values, 0.5)).toBe(10);
    expect(nearestRank([7], 0.95)).toBe(7);
    expect(nearestRank([7, 8], 0)).toBe(7);
  });
});

describe('summarize and renderSummary', () => {
  it('groups per platform and sample, sorted, with the bound at 3x the maximum', () => {
    const samples = parseSamples(
      [
        line('z.last', 10, 'win32'),
        line('b', 3),
        line('a', 1.25),
        line('a', 3),
        line('a', 2),
        line('a.win', 4, 'win32'),
      ].join('\n'),
    );
    const stats = summarize(samples);
    expect(stats).toEqual([
      { platform: 'linux', sample: 'a', n: 3, min: 1.25, median: 2, p95: 3, max: 3, bound: 9 },
      { platform: 'linux', sample: 'b', n: 1, min: 3, median: 3, p95: 3, max: 3, bound: 9 },
      { platform: 'win32', sample: 'a.win', n: 1, min: 4, median: 4, p95: 4, max: 4, bound: 12 },
      {
        platform: 'win32',
        sample: 'z.last',
        n: 1,
        min: 10,
        median: 10,
        p95: 10,
        max: 10,
        bound: 30,
      },
    ]);
    const text = renderSummary(stats);
    expect(text).toContain('| linux | a | 3 | 1.3 | 2.0 | 3.0 | 3.0 | 9 |');
    expect(text).toContain(
      `Too few samples: linux a has 3, at least ${String(MIN_SAMPLES)} are needed.`,
    );
  });

  it('rounds the bound up to a whole millisecond', () => {
    expect(summarize(parseSamples(line('a', 45.2)))[0]?.bound).toBe(136);
  });

  it('says when nothing was recorded', () => {
    expect(renderSummary([])).toContain('No samples were recorded.');
  });

  it('names no shortfall when every quantity has enough samples', () => {
    const lines = Array.from({ length: MIN_SAMPLES }, (_, i) => line('a', i)).join('\n');
    expect(renderSummary(summarize(parseSamples(lines)))).not.toContain('Too few samples');
  });
});

describe('ci-timing.mjs', () => {
  const script = fileURLToPath(new URL('../ci-timing.mjs', import.meta.url));
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hudhud-ci-timing-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  function run(args: readonly string[], summary?: string) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        SYSTEMROOT: process.env['SYSTEMROOT'] ?? '',
        ...(summary === undefined ? {} : { GITHUB_STEP_SUMMARY: summary }),
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('passes with enough samples and appends the table to the step summary', () => {
    const log = path.join(dir, 'samples.jsonl');
    const summary = path.join(dir, 'summary.md');
    writeFileSync(log, Array.from({ length: MIN_SAMPLES }, (_, i) => line('a', i)).join('\n'));
    writeFileSync(summary, '');
    const result = run([log], summary);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('| linux | a | 15 |');
    expect(readFileSync(summary, 'utf8')).toMatch(/^## Integration timing samples\n\n\| platform/u);
  });

  it('fails with too few samples, an empty log, a malformed log or a missing file', () => {
    const log = path.join(dir, 'samples.jsonl');
    writeFileSync(log, line('a', 1));
    expect(run([log]).status).toBe(1);
    writeFileSync(log, '');
    expect(run([log]).status).toBe(1);
    writeFileSync(log, '{');
    const malformed = run([log]);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('line 1: not JSON');
    const missing = run([path.join(dir, 'absent.jsonl')]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('absent.jsonl');
  });

  it('refuses a wrong argument count', () => {
    expect(run([]).status).toBe(2);
    expect(run(['a', 'b']).stderr).toContain('usage: ci-timing');
  });
});
