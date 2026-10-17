import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Reporter } from 'vitest/node';

import CanaryReporter, {
  MAX_RECORDED_MESSAGE,
  MAX_RECORDED_VIOLATIONS,
  RESULTS_ENV,
  collectResults,
  flattenError,
} from '../../src/canary/reporter.js';
import type {
  ReportedError,
  ReportedLog,
  ReportedModule,
  ReportedSuite,
  ReportedTest,
} from '../../src/canary/reporter.js';

const ROOT = path.resolve('/repo');

function testCase(
  fullName: string,
  state: 'passed' | 'failed' | 'skipped' | 'pending',
  errors?: ReportedError[],
  logs: ReportedLog[] = [],
): ReportedTest {
  return { fullName, result: () => ({ state, errors }), logs: () => logs };
}

function moduleOf(
  file: string,
  tests: ReportedTest[],
  options: { errors?: ReportedError[]; suites?: ReportedSuite[] } = {},
): ReportedModule {
  return {
    moduleId: path.join(ROOT, file),
    errors: () => options.errors ?? [],
    children: { allTests: () => tests, allSuites: () => options.suites ?? [] },
  };
}

describe('the reporter shape', () => {
  it('is a Vitest reporter', () => {
    expectTypeOf<Pick<CanaryReporter, 'onTestRunEnd'>>().toExtend<Pick<Reporter, 'onTestRunEnd'>>();
  });
});

describe('flattenError', () => {
  it('keeps the name, message, code and the egress violations', () => {
    expect(
      flattenError({
        name: 'EgressViolationError',
        message: 'mock egress trap: 1 violation(s)',
        violations: [
          { seq: 1, kind: 'connect', method: 'CONNECT', target: 'example.com:443', detail: 'x' },
          'not a violation',
        ],
      }),
    ).toEqual([
      {
        name: 'EgressViolationError',
        message: 'mock egress trap: 1 violation(s)',
        violations: [{ kind: 'connect', method: 'CONNECT', target: 'example.com:443' }],
      },
    ]);
    expect(flattenError({ name: 'HudhudError', message: 'm', code: 'PROTOCOL_ERROR' })).toEqual([
      { name: 'HudhudError', message: 'm', code: 'PROTOCOL_ERROR' },
    ]);
  });

  it('flattens an AggregateError of the after-test checks into its parts', () => {
    expect(
      flattenError({
        name: 'AggregateError',
        message: '2 post-test checks failed',
        errors: [
          { name: 'EgressViolationError', message: 'a', violations: [] },
          { name: 'AggregateError', message: 'inner', errors: [{ message: 'b' }] },
        ],
      }),
    ).toEqual([
      { name: 'EgressViolationError', message: 'a', violations: [] },
      { name: 'Error', message: 'b' },
    ]);
    // An empty `errors` array is not an aggregate.
    expect(flattenError({ name: 'X', message: 'y', errors: [] })).toEqual([
      { name: 'X', message: 'y' },
    ]);
  });

  it('bounds what it records and tolerates non-error values', () => {
    const [long] = flattenError({ message: 'x'.repeat(MAX_RECORDED_MESSAGE + 5), code: 7 });
    expect(long?.message).toHaveLength(MAX_RECORDED_MESSAGE + 3);
    expect(long).not.toHaveProperty('code');
    const many = Array.from({ length: MAX_RECORDED_VIOLATIONS + 1 }, () => ({
      kind: 'path',
      method: 1,
      target: 'y'.repeat(MAX_RECORDED_MESSAGE + 1),
    }));
    const [capped] = flattenError({ message: 'm', violations: many });
    expect(capped?.violations).toHaveLength(MAX_RECORDED_VIOLATIONS);
    expect(capped?.violations?.[0]?.method).toBe('');
    expect(capped?.violations?.[0]?.target.endsWith('...')).toBe(true);
    expect(flattenError('boom')).toEqual([{ name: 'Error', message: 'boom' }]);
  });
});

describe('collectResults', () => {
  it('records every test, the additive warnings and every error outside a test', () => {
    const results = collectResults(
      ROOT,
      [
        moduleOf('packages/a/test/integration/x.test.ts', [
          testCase('passes', 'passed', undefined, [
            {
              type: 'stderr',
              content:
                'request-shape text-turn: additive change (review at the next CLI bump)\n+ /x',
            },
            { type: 'stdout', content: 'something else' },
          ]),
          testCase('fails', 'failed', [{ name: 'RequestShapeError', message: 'semantic' }]),
          testCase('skipped', 'skipped'),
        ]),
        moduleOf('packages/a/test/integration/y.test.ts', [], {
          errors: [{ name: 'SyntaxError', message: 'bad' }],
          suites: [
            { fullName: 'outer', errors: () => [{ message: 'beforeAll failed' }] },
            { fullName: 'fine', errors: () => [] },
          ],
        }),
      ],
      [{ name: 'Error', message: 'unhandled rejection' }],
      'failed',
    );
    expect(results).toEqual({
      format: 'hudhud-canary-results/1',
      reason: 'failed',
      tests: [
        {
          file: 'packages/a/test/integration/x.test.ts',
          name: 'passes',
          state: 'passed',
          errors: [],
          additive: 1,
        },
        {
          file: 'packages/a/test/integration/x.test.ts',
          name: 'fails',
          state: 'failed',
          errors: [{ name: 'RequestShapeError', message: 'semantic' }],
          additive: 0,
        },
        {
          file: 'packages/a/test/integration/x.test.ts',
          name: 'skipped',
          state: 'skipped',
          errors: [],
          additive: 0,
        },
      ],
      outside: [
        {
          where: 'packages/a/test/integration/y.test.ts',
          errors: [{ name: 'SyntaxError', message: 'bad' }],
        },
        {
          where: 'packages/a/test/integration/y.test.ts > outer',
          errors: [{ name: 'Error', message: 'beforeAll failed' }],
        },
        { where: '(unhandled)', errors: [{ name: 'Error', message: 'unhandled rejection' }] },
      ],
    });
  });

  it('keeps a module outside the root by its own id', () => {
    const outside = path.resolve('/elsewhere/z.test.ts');
    const results = collectResults(
      ROOT,
      [{ ...moduleOf('', [testCase('t', 'passed')]), moduleId: outside }],
      [],
      'passed',
    );
    expect(results.tests[0]?.file).toBe(outside.split(path.sep).join('/'));
    expect(
      collectResults(ROOT, [moduleOf('', [testCase('t', 'pending')])], [], 'interrupted'),
    ).toMatchObject({ reason: 'interrupted', tests: [{ file: ROOT.split(path.sep).join('/') }] });
  });
});

describe('CanaryReporter', () => {
  it('writes the results to the configured file', () => {
    const writes: { file: string; text: string }[] = [];
    const reporter = new CanaryReporter({
      output: 'out.json',
      root: ROOT,
      write: (file, text) => writes.push({ file, text }),
    });
    reporter.onTestRunEnd([moduleOf('t.test.ts', [testCase('t', 'passed')])], [], 'passed');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.file).toBe(path.resolve('out.json'));
    expect(JSON.parse(writes[0]?.text ?? '')).toMatchObject({
      reason: 'passed',
      tests: [{ file: 't.test.ts', name: 't' }],
    });
  });

  it('defaults to the environment, the working directory and a real file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hudhud-canary-'));
    try {
      vi.stubEnv(RESULTS_ENV, path.join(dir, 'results.json'));
      new CanaryReporter().onTestRunEnd([], [], 'passed');
      expect(JSON.parse(await readFile(path.join(dir, 'results.json'), 'utf8'))).toEqual({
        format: 'hudhud-canary-results/1',
        reason: 'passed',
        tests: [],
        outside: [],
      });
      vi.stubEnv(RESULTS_ENV, '');
      expect(() => new CanaryReporter()).toThrow(`the canary reporter needs ${RESULTS_ENV}`);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
