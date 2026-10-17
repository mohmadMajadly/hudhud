import { describe, expect, it } from 'vitest';

import {
  checkShapeUpdate,
  reportMarkdown,
  samplesMarkdown,
  summarizeReport,
  summarizeSamples,
  type VitestReport,
} from '../src/evidence.js';

const ROOT = '/Users/runner/work/hudhud/hudhud';
const SHAPES = `${ROOT}/packages/claude-code/test/integration/request-shape/request-shape.test.ts`;

function report(
  tests: readonly { name: string; status: string; message?: string }[],
  file = SHAPES,
): VitestReport {
  const count = (status: string): number => tests.filter((test) => test.status === status).length;
  return {
    numTotalTests: tests.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    numPendingTests: count('skipped') + count('pending'),
    testResults: [
      {
        name: file,
        message: '',
        assertionResults: tests.map((test) => ({
          fullName: test.name,
          status: test.status,
          failureMessages: test.message === undefined ? [] : [test.message],
        })),
      },
    ],
  };
}

const written = (scenario: string): string =>
  `RequestShapeError: request-shape ${scenario}: snapshot written to packages/claude-code/test/integration/request-shape/snapshots/${scenario}.darwin.shape; review the diff, then run without HUDHUD_REQUEST_SHAPE_UPDATE\n    at checkRequestShape (support.ts:120:11)`;

const LINUX = ['text-turn', 'tool-use'].map((name) => `${name}.linux.shape`);
const WIN32 = ['text-turn', 'tool-use'].map((name) => `${name}.win32.shape`);
const DARWIN = ['text-turn', 'tool-use'].map((name) => `${name}.darwin.shape`);

describe('summarizeReport', () => {
  it('counts verdicts and lists each failure with the first line of its message, paths relative', () => {
    const summary = summarizeReport(
      report([
        { name: 'a passes', status: 'passed' },
        {
          name: 'b fails',
          status: 'failed',
          message: '\nAssertionError: expected 2300 to be less than 2135\n  at x',
        },
        { name: 'c skipped', status: 'skipped' },
      ]),
      ROOT,
    );
    expect(summary).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      failures: [
        {
          file: 'packages/claude-code/test/integration/request-shape/request-shape.test.ts',
          test: 'b fails',
          message: 'AssertionError: expected 2300 to be less than 2135',
        },
      ],
    });
    expect(reportMarkdown('Integration', summary)).toContain(
      '| packages/claude-code/test/integration/request-shape/request-shape.test.ts | b fails | AssertionError: expected 2300 to be less than 2135 |',
    );
  });

  it('reports a file that failed before its tests ran', () => {
    const failed: VitestReport = {
      numTotalTests: 0,
      testResults: [
        { name: `${ROOT}/x.test.ts`, message: 'Error: hook timed out', assertionResults: [] },
      ],
    };
    expect(summarizeReport(failed, ROOT).failures).toEqual([
      { file: 'x.test.ts', test: '(file)', message: 'Error: hook timed out' },
    ]);
  });

  it('tolerates the fields a report may leave out', () => {
    expect(summarizeReport({}, ROOT)).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      failures: [],
    });
    const sparse: VitestReport = {
      testResults: [
        {},
        { name: '/elsewhere/y.test.ts', assertionResults: [{ status: 'failed' }] },
        {
          name: `${ROOT}/z.test.ts`,
          assertionResults: [{ fullName: 'z', status: 'failed', failureMessages: ['\n  \n'] }],
        },
      ],
    };
    expect(summarizeReport(sparse, `${ROOT}/`).failures).toEqual([
      { file: '/elsewhere/y.test.ts', test: '', message: '' },
      { file: 'z.test.ts', test: 'z', message: '' },
    ]);
  });

  it('writes no table when nothing failed', () => {
    const summary = summarizeReport(report([{ name: 'a', status: 'passed' }]), ROOT);
    expect(reportMarkdown('Green', summary)).toBe(
      '### Green\n\n1 tests: 1 passed, 0 failed, 0 skipped\n\n',
    );
  });

  it('escapes table separators in the Markdown', () => {
    const summary = summarizeReport(
      report([{ name: 'a | b', status: 'failed', message: 'x | y' }]),
      ROOT,
    );
    expect(reportMarkdown('T', summary)).toContain('| a \\| b | x \\| y |');
  });
});

describe('checkShapeUpdate', () => {
  it('accepts a run where every test failed after writing its snapshot', () => {
    const run = report([
      { name: 'text-turn', status: 'failed', message: written('text-turn') },
      { name: 'tool-use', status: 'failed', message: written('tool-use') },
    ]);
    expect(checkShapeUpdate(run, [...LINUX, ...WIN32, ...DARWIN], ROOT)).toEqual([]);
  });

  it('names every problem: a pass, another failure, a missing snapshot, an empty run', () => {
    const run = report([
      { name: 'text-turn', status: 'passed' },
      {
        name: 'tool-use',
        status: 'failed',
        message: 'request-shape tool-use: the CLI sent 1 request(s), the scenario expects 2',
      },
    ]);
    expect(checkShapeUpdate(run, [...LINUX, 'text-turn.darwin.shape'], ROOT)).toEqual([
      '1 passed and 0 skipped: in update mode every test must fail after writing',
      'tool-use: failed for another reason: request-shape tool-use: the CLI sent 1 request(s), the scenario expects 2',
      'darwin snapshots [text-turn] differ from the Linux scenarios [text-turn, tool-use]',
    ]);
    expect(checkShapeUpdate(report([]), LINUX, ROOT)).toEqual([
      'the update run reported no test',
      'darwin snapshots [] differ from the Linux scenarios [text-turn, tool-use]',
    ]);
  });
});

describe('summarizeSamples', () => {
  const line = (sample: string, ms: number): string =>
    JSON.stringify({ sample, ms, platform: 'darwin' });
  const NAME = 'close-abort.overrun';

  it('summarizes the samples of one name and reports 3x the maximum', () => {
    const text = [line(NAME, 40), line('other', 9999), line(NAME, 10), line(NAME, 25.5), ''].join(
      '\n',
    );
    const summary = summarizeSamples(text, NAME, 3);
    expect(summary).toEqual({
      name: NAME,
      count: 3,
      minMs: 10,
      medianMs: 25.5,
      maxMs: 40,
      threeTimesMaxMs: 120,
      valuesMs: [40, 10, 25.5],
    });
    expect(samplesMarkdown(summary)).toContain('3 x max = 120 ms');
    expect(summarizeSamples([line(NAME, 1), line(NAME, 4)].join('\n'), NAME, 2).medianMs).toBe(2.5);
  });

  it('refuses too few samples, a malformed line and a minimum that is not a positive integer', () => {
    expect(() => summarizeSamples(line(NAME, 1), NAME, 20)).toThrow(
      '1 samples of close-abort.overrun, at least 20 required',
    );
    expect(() => summarizeSamples('{"sample":"x"}', NAME, 1)).toThrow(
      /lacks a sample name or a finite ms/,
    );
    expect(() => summarizeSamples('[]', NAME, 1)).toThrow(/lacks/);
    expect(() => summarizeSamples('null', NAME, 1)).toThrow(/not an object/);
    for (const minimum of [Number.NaN, 0, 1.5]) {
      expect(() => summarizeSamples(line(NAME, 1), NAME, minimum)).toThrow(/positive integer/);
    }
  });
});
