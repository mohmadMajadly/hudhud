import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePin } from '../../src/cli/pin.js';
import type { CliPin } from '../../src/cli/pin.js';
import {
  LOOKUP_FILE,
  LOOKUP_PREFIX,
  MIN_LOOKUP_CASES,
  evidenceOf,
  judgeCanary,
  lookupCheck,
  parseResults,
  runCanaryReport,
} from '../../src/canary/report.js';
import type { CanaryInput, CanaryReportHost } from '../../src/canary/report.js';
import type { CanaryResults, RecordedTest } from '../../src/canary/reporter.js';

const INTEGRITY = `sha512-${'B'.repeat(86)}==`;

function pinOf(version: string): CliPin {
  return parsePin(
    {
      version,
      platforms: {
        'linux-x64': {
          package: '@anthropic-ai/claude-code-linux-x64',
          file: 'claude',
          integrity: INTEGRITY,
          sha256: 'c'.repeat(64),
          size: 9,
        },
      },
    },
    'pin',
  );
}

function lookupCases(count = MIN_LOOKUP_CASES): RecordedTest[] {
  return Array.from({ length: count }, (_, index) => ({
    file: LOOKUP_FILE,
    name: `${LOOKUP_PREFIX}case ${String(index)} (08 a${String(index)})`,
    state: 'passed' as const,
    errors: [],
    additive: 0,
  }));
}

const OTHER: RecordedTest = {
  file: 'packages/claude-code/test/integration/lifecycle/turns.test.ts',
  name: 'a turn',
  state: 'passed',
  errors: [],
  additive: 0,
};

function results(tests: RecordedTest[], overrides: Partial<CanaryResults> = {}): CanaryResults {
  return { format: 'hudhud-canary-results/1', reason: 'passed', tests, outside: [], ...overrides };
}

function input(overrides: Partial<CanaryInput> = {}): CanaryInput {
  return {
    mode: 'canary',
    schedule: 'nightly',
    platform: 'linux-x64',
    results: results([...lookupCases(), OTHER]),
    runPin: pinOf('2.2.0'),
    repoPin: pinOf('2.1.296'),
    ...overrides,
  };
}

describe('lookupCheck', () => {
  it('passes when every lookup case ran and passed', () => {
    expect(lookupCheck([...lookupCases(), OTHER])).toMatchObject({
      ok: true,
      cases: MIN_LOOKUP_CASES,
      passed: MIN_LOOKUP_CASES,
      broken: [],
      reason: expect.stringContaining('only where the guard scans') as unknown,
    });
  });

  it('fails on a case that did not pass, naming it', () => {
    const states: Partial<Record<number, RecordedTest['state']>> = { 3: 'failed', 4: 'skipped' };
    const cases = lookupCases().map((test, index) => ({
      ...test,
      state: states[index] ?? test.state,
    }));
    const check = lookupCheck(cases);
    expect(check.ok).toBe(false);
    expect(check.passed).toBe(MIN_LOOKUP_CASES - 2);
    expect(check.broken).toEqual([
      { name: 'case 3 (08 a3)', state: 'failed' },
      { name: 'case 4 (08 a4)', state: 'skipped' },
    ]);
    expect(check.reason).toContain('settings lookup may have changed');
  });

  it('fails when the check was cut down, and ignores look-alikes in other files', () => {
    const check = lookupCheck([
      ...lookupCases(MIN_LOOKUP_CASES - 1),
      { ...OTHER, name: `${LOOKUP_PREFIX}elsewhere` },
    ]);
    expect(check).toMatchObject({ ok: false, cases: MIN_LOOKUP_CASES - 1 });
    expect(check.reason).toContain('expected at least 10');
  });
});

describe('evidenceOf', () => {
  it('maps failures, violations, semantic and additive request-shape findings', () => {
    const evidence = evidenceOf(
      results(
        [
          { ...OTHER, additive: 2 },
          {
            ...OTHER,
            name: 'egress',
            state: 'failed',
            errors: [
              {
                name: 'EgressViolationError',
                message: 'trap',
                violations: [{ kind: 'connect', method: 'CONNECT', target: 'x:443' }],
              },
              { name: 'HudhudError', message: 'p', code: 'PROTOCOL_ERROR' },
            ],
          },
          {
            ...OTHER,
            name: 'shape',
            state: 'failed',
            errors: [{ name: 'RequestShapeError', message: 's' }],
          },
          { ...OTHER, name: 'bare', state: 'failed', errors: [] },
          { ...OTHER, name: 'skip', state: 'skipped' },
          { ...OTHER, name: 'pending', state: 'pending' },
        ],
        { outside: [{ where: 'f.test.ts > s', errors: [{ name: 'Error', message: 'hook' }] }] },
      ),
      { version: '2.2.0', integrity: INTEGRITY, pinnedVersion: '2.1.296' },
      'linux-x64',
    );
    expect(evidence.tests).toEqual({ total: 6, passed: 1, failed: 4, skipped: 2 });
    expect(evidence.violations).toEqual([{ kind: 'connect', method: 'CONNECT', target: 'x:443' }]);
    expect(evidence.snapshots).toEqual({ semantic: 1, additive: 2 });
    expect(evidence.failures).toEqual([
      { test: `${OTHER.file} > egress`, errorName: 'EgressViolationError', message: 'trap' },
      {
        test: `${OTHER.file} > egress`,
        errorName: 'HudhudError',
        message: 'p',
        code: 'PROTOCOL_ERROR',
      },
      { test: `${OTHER.file} > shape`, errorName: 'RequestShapeError', message: 's' },
      { test: `${OTHER.file} > bare`, errorName: 'Error', message: 'failed without an error' },
      { test: 'f.test.ts > s (outside a test)', errorName: 'Error', message: 'hook' },
    ]);
  });
});

describe('judgeCanary', () => {
  it('is green for a clean run of a newer version, with the version and integrity in the summary', () => {
    const judgement = judgeCanary(input());
    expect(judgement.green).toBe(true);
    expect(judgement.problems).toEqual([]);
    expect(judgement.summary).toContain(
      '# nightly canary: Claude Code 2.2.0 on linux-x64 (pinned 2.1.296)',
    );
    expect(judgement.summary).toContain('**GREEN**\n');
    expect(judgement.summary).toContain('PASSED: all 10 lookup cases passed');
    expect(judgement.summary).toContain(
      `| Registry integrity | ${INTEGRITY.replace(/[[\]\\|`<>&]/g, (c) => `&#${String(c.codePointAt(0))};`)} |`,
    );
    expect(judgement.summary).toContain('| Classification | green |');
  });

  it('never accepts a canary run of the pinned version', () => {
    const judgement = judgeCanary(input({ runPin: pinOf('2.1.296') }));
    expect(judgement.green).toBe(false);
    expect(judgement.problems).toEqual([
      'the run tested the pinned version 2.1.296: the canary never re-runs the pinned version (K16)',
    ]);
    expect(judgement.summary).toContain('**RED**\n');
  });

  it('labels a dry run in every heading and requires the pinned version', () => {
    const dry = judgeCanary(
      input({ mode: 'dry-run', schedule: 'weekly', runPin: pinOf('2.1.296') }),
    );
    expect(dry.green).toBe(true);
    expect(dry.summary).toContain(
      '# DRY RUN of the weekly canary against the PINNED CLI 2.1.296 (linux-x64): not a canary result',
    );
    expect(dry.summary).toContain('**GREEN** (dry run)');
    const wrong = judgeCanary(input({ mode: 'dry-run' }));
    expect(wrong.problems).toEqual([
      'a dry run must test the pinned version 2.1.296, but the run pin names 2.2.0',
    ]);
  });

  it('is red for an interrupted or empty run, a broken lookup check and a classified failure', () => {
    const broken = lookupCases().map((test, index) =>
      index === 0
        ? {
            ...test,
            state: 'failed' as const,
            errors: [{ name: 'AssertionError', message: 'expected host' }],
          }
        : test,
    );
    const judgement = judgeCanary(input({ results: results(broken, { reason: 'interrupted' }) }));
    expect(judgement.problems).toEqual([
      'the Vitest run was interrupted',
      expect.stringContaining('settings lookup check: 1 lookup case(s) did not pass') as unknown,
      'degradation classification: protocol-regressed',
    ]);
    expect(judgement.summary).toContain('| Lookup case | State |');
    expect(judgement.summary).toContain('FAILED: 1 lookup case');
    const empty = judgeCanary(input({ results: results([]) }));
    expect(empty.problems).toContain('no test ran');
  });

  it('refuses a run pin without the platform', () => {
    expect(() => judgeCanary(input({ platform: 'win32-x64' }))).toThrow('no pin entry');
  });
});

describe('parseResults', () => {
  it('accepts the reporter format and refuses anything else', () => {
    const good = results([OTHER]);
    expect(parseResults(JSON.stringify(good), 'r.json')).toEqual(good);
    expect(() => parseResults('{', 'r.json')).toThrow('r.json: not valid JSON');
    for (const bad of [
      [],
      { ...good, format: 'other' },
      { ...good, reason: 'maybe' },
      { ...good, tests: {} },
      { ...good, outside: null },
    ]) {
      expect(() => parseResults(JSON.stringify(bad), 'r.json')).toThrow(
        'r.json: not a hudhud-canary-results/1 file',
      );
    }
  });
});

describe('runCanaryReport', () => {
  const ROOT = path.resolve('/repo');
  const RESULTS = path.resolve('/tmp/results.json');

  function host(
    files: Record<string, string>,
    argv: string[],
    env: Record<string, string> = {},
  ): CanaryReportHost & { out: string; err: string; summaries: string[] } {
    const state = { out: '', err: '', summaries: [] as string[] };
    return Object.assign(state, {
      argv,
      env,
      repoRoot: ROOT,
      readFile: (file: string) => {
        const text = files[file];
        return text === undefined
          ? Promise.reject(new Error(`ENOENT ${file}`))
          : Promise.resolve(text);
      },
      appendFile: (file: string, text: string) => {
        state.summaries.push(`${file}:${text}`);
        return Promise.resolve();
      },
      stdout: (text: string) => {
        state.out += text;
      },
      stderr: (text: string) => {
        state.err += text;
      },
    });
  }

  function pinText(version: string): string {
    return JSON.stringify({
      version,
      platforms: {
        'linux-x64': {
          package: '@anthropic-ai/claude-code-linux-x64',
          file: 'claude',
          integrity: INTEGRITY,
          sha256: 'c'.repeat(64),
          size: 9,
        },
      },
    });
  }

  const ARGV = [
    '--results',
    RESULTS,
    '--platform',
    'linux-x64',
    '--mode',
    'canary',
    '--schedule',
    'nightly',
  ];

  function files(
    cache: string,
    runVersion = '2.2.0',
    tests = [...lookupCases(), OTHER],
  ): Record<string, string> {
    return {
      [RESULTS]: JSON.stringify(results(tests)),
      [path.join(cache, 'run-pin.json')]: pinText(runVersion),
      [path.join(ROOT, 'tooling', 'cli-pin.json')]: pinText('2.1.296'),
    };
  }

  it('prints the summary, appends it to the job summary and exits 0 when green', async () => {
    const h = host(files(path.join(ROOT, '.cache', 'claude-cli')), ARGV, {
      GITHUB_STEP_SUMMARY: 'summary.md',
    });
    expect(await runCanaryReport(h)).toBe(0);
    expect(h.out).toContain('**GREEN**');
    expect(h.summaries).toEqual([`summary.md:${h.out}`]);
  });

  it('exits 1 when red; honours HUDHUD_CLI_CACHE and --cache; no summary file outside Actions', async () => {
    const viaEnv = host(files(path.join(ROOT, 'c'), '2.1.296'), ARGV, {
      HUDHUD_CLI_CACHE: 'c',
      GITHUB_STEP_SUMMARY: '',
    });
    expect(await runCanaryReport(viaEnv)).toBe(1);
    expect(viaEnv.out).toContain('**RED**');
    expect(viaEnv.summaries).toEqual([]);
    const viaFlag = host(files(path.resolve('/abs')), [...ARGV, '--cache', path.resolve('/abs')]);
    expect(await runCanaryReport(viaFlag)).toBe(0);
  });

  it('exits 1 with a red job summary when the input cannot be read', async () => {
    const h = host({}, ARGV, { GITHUB_STEP_SUMMARY: 'summary.md' });
    expect(await runCanaryReport(h)).toBe(1);
    expect(h.err).toContain('canary-report: the run cannot be judged: Error: ENOENT');
    expect(h.summaries[0]).toContain('summary.md:# Canary: RED');
    const quiet = host({}, ARGV);
    expect(await runCanaryReport(quiet)).toBe(1);
    expect(quiet.summaries).toEqual([]);
  });

  it.each([
    [['--bogus']],
    [['positional']],
    [['--results', RESULTS, '--platform', 'linux-x64', '--schedule', 'nightly']],
    [['--results', RESULTS, '--platform', 'linux-x64', '--mode', 'other', '--schedule', 'n']],
    [['--platform', 'linux-x64', '--mode', 'canary', '--schedule', 'n']],
    [['--results', RESULTS, '--mode', 'canary', '--schedule', 'n']],
    [['--results', RESULTS, '--platform', 'linux-x64', '--mode', 'canary']],
  ])('rejects %j with exit 2', async (argv) => {
    const h = host({}, argv);
    expect(await runCanaryReport(h)).toBe(2);
    expect(h.err).toContain('usage: canary-report');
  });
});
