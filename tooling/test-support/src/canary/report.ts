/**
 * The canary's verdict on one integration run (K16, plan §5.9 W7-T2;
 * ADR-0013 §8): reads the results the canary reporter wrote
 * (`reporter.ts`), the run-local pin and the repository pin, judges the run
 * and writes the job summary.
 *
 * @remarks
 * A run is green only when every check holds:
 *
 * 1. Version: a canary run tested a version other than the pinned one (it
 *    never re-runs the pinned version); a dry run tested exactly the pinned
 *    one and says so in every heading.
 * 2. The run: Vitest finished (not interrupted), at least one test ran, and
 *    no error was raised outside a test.
 * 3. The settings lookup check (research 08 §7 condition 1, the t21
 *    equivalent, L1): every `guard vs CLI lookup` case of
 *    `security/project-credential-env.test.ts` ran and passed, and there are
 *    at least {@link MIN_LOOKUP_CASES} of them. A failed case means the CLI
 *    reads project settings from a location the guard's scan set does not
 *    match: the canary fails whatever else happened.
 * 4. The degradation classification (`classify.ts`) is `green`.
 *
 * The summary always states the version, the registry integrity of the run
 * pin, the results, the lookup check and the classification with the next
 * step, so the lead can act on a red run from the summary alone.
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { parsePin, requirePinned } from '../cli/pin.js';
import type { CliPin } from '../cli/pin.js';
import { classifyCanary, cell, renderSummary } from './classify.js';
import type { CanaryEvidence, CanaryFailure, CanaryViolation } from './classify.js';
import { RESULTS_FORMAT } from './reporter.js';
import type { CanaryResults, RecordedError, RecordedTest } from './reporter.js';

/** The test file of the settings lookup check. */
export const LOOKUP_FILE =
  'packages/claude-code/test/integration/security/project-credential-env.test.ts';

/** The name prefix of its lookup cases. */
export const LOOKUP_PREFIX = 'guard vs CLI lookup: ';

/**
 * The lookup cases research 08 §2 covers (10 at the 2.1.296 pin: cwd x2,
 * git root x2, main worktree root x2, non-git ancestor, ancestor above the
 * git root, outer repository, `--add-dir`). Fewer means the check was cut
 * down, which fails the canary.
 */
export const MIN_LOOKUP_CASES = 10;

/** What kind of run this is. */
export type CanaryMode = 'canary' | 'dry-run';

/** The verdict on the settings lookup check. */
export interface LookupCheck {
  readonly ok: boolean;
  readonly cases: number;
  readonly passed: number;
  /** Cases that failed, were skipped or never finished. */
  readonly broken: readonly { readonly name: string; readonly state: string }[];
  readonly reason: string;
}

/** Judges the settings lookup check. */
export function lookupCheck(tests: readonly RecordedTest[]): LookupCheck {
  const cases = tests.filter(
    (test) => test.file === LOOKUP_FILE && test.name.startsWith(LOOKUP_PREFIX),
  );
  const broken = cases
    .filter((test) => test.state !== 'passed')
    .map((test) => ({ name: test.name.slice(LOOKUP_PREFIX.length), state: test.state }));
  const passed = cases.length - broken.length;
  let reason: string;
  if (cases.length < MIN_LOOKUP_CASES) {
    reason = `only ${String(cases.length)} lookup case(s) ran, expected at least ${String(MIN_LOOKUP_CASES)}: the check was cut down or did not run`;
  } else if (broken.length > 0) {
    reason = `${String(broken.length)} lookup case(s) did not pass: the CLI's settings lookup may have changed (research 08 §7); a location the guard does not scan fails the canary`;
  } else {
    reason = `all ${String(cases.length)} lookup cases passed: the CLI reads project settings only where the guard scans (L1)`;
  }
  return {
    ok: cases.length >= MIN_LOOKUP_CASES && broken.length === 0,
    cases: cases.length,
    passed,
    broken,
    reason,
  };
}

function failureOf(test: string, error: RecordedError): CanaryFailure {
  return {
    test,
    errorName: error.name,
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
  };
}

/** Maps the reporter's results onto the classifier's evidence. */
export function evidenceOf(
  results: CanaryResults,
  cli: CanaryEvidence['cli'],
  platform: string,
): CanaryEvidence {
  const failures: CanaryFailure[] = [];
  const violations: CanaryViolation[] = [];
  let semantic = 0;
  let additive = 0;
  const record = (where: string, errors: readonly RecordedError[]): void => {
    for (const error of errors) {
      failures.push(failureOf(where, error));
      violations.push(...(error.violations ?? []));
      if (error.name === 'RequestShapeError') semantic += 1;
    }
  };
  for (const test of results.tests) {
    additive += test.additive;
    if (test.state === 'failed') {
      record(
        `${test.file} > ${test.name}`,
        test.errors.length > 0
          ? test.errors
          : [{ name: 'Error', message: 'failed without an error' }],
      );
    }
  }
  for (const outside of results.outside)
    record(`${outside.where} (outside a test)`, outside.errors);
  const count = (state: RecordedTest['state']): number =>
    results.tests.filter((test) => test.state === state).length;
  return {
    cli,
    platform,
    tests: {
      total: results.tests.length,
      passed: count('passed'),
      failed: count('failed') + results.outside.length,
      skipped: count('skipped') + count('pending'),
    },
    failures,
    violations,
    snapshots: { semantic, additive },
  };
}

/** Everything {@link judgeCanary} needs. */
export interface CanaryInput {
  readonly mode: CanaryMode;
  /** `nightly`, `weekly` or another label for the heading. */
  readonly schedule: string;
  readonly platform: string;
  readonly results: CanaryResults;
  /** The run-local pin (`run-pin.json`). */
  readonly runPin: CliPin;
  /** The repository pin (`tooling/cli-pin.json`). */
  readonly repoPin: CliPin;
}

/** The judgement: exit code and job summary. */
export interface CanaryJudgement {
  readonly green: boolean;
  /** Every reason the run is red; empty when green. */
  readonly problems: readonly string[];
  readonly summary: string;
}

/** Judges one run (see the module comment). */
export function judgeCanary(input: CanaryInput): CanaryJudgement {
  const { mode, results, runPin, repoPin } = input;
  const entry = requirePinned(runPin, input.platform);
  const problems: string[] = [];
  if (mode === 'canary' && runPin.version === repoPin.version) {
    problems.push(
      `the run tested the pinned version ${repoPin.version}: the canary never re-runs the pinned version (K16)`,
    );
  }
  if (mode === 'dry-run' && runPin.version !== repoPin.version) {
    problems.push(
      `a dry run must test the pinned version ${repoPin.version}, but the run pin names ${runPin.version}`,
    );
  }
  if (results.reason === 'interrupted') problems.push('the Vitest run was interrupted');
  if (results.tests.length === 0) problems.push('no test ran');
  const lookup = lookupCheck(results.tests);
  if (!lookup.ok) problems.push(`settings lookup check: ${lookup.reason}`);
  const evidence = evidenceOf(
    results,
    { version: runPin.version, integrity: entry.integrity, pinnedVersion: repoPin.version },
    input.platform,
  );
  const classification = classifyCanary(evidence);
  if (classification.verdict !== 'green') {
    problems.push(`degradation classification: ${classification.verdict}`);
  }
  const green = problems.length === 0;
  const heading =
    mode === 'dry-run'
      ? `# DRY RUN of the ${cell(input.schedule)} canary against the PINNED CLI ${cell(runPin.version)} (${cell(input.platform)}): not a canary result`
      : `# ${cell(input.schedule)} canary: Claude Code ${cell(runPin.version)} on ${cell(input.platform)} (pinned ${cell(repoPin.version)})`;
  const lines = [
    heading,
    '',
    `**${green ? 'GREEN' : 'RED'}**${mode === 'dry-run' ? ' (dry run)' : ''}`,
    '',
  ];
  if (!green) lines.push(...problems.map((problem) => `- ${cell(problem)}`), '');
  lines.push(
    '### Settings lookup check (research 08 §7, L1)',
    '',
    `${lookup.ok ? 'PASSED' : 'FAILED'}: ${cell(lookup.reason)} (${String(lookup.passed)} of ${String(lookup.cases)} passed)`,
    '',
  );
  if (lookup.broken.length > 0) {
    lines.push(
      '| Lookup case | State |',
      '|---|---|',
      ...lookup.broken.map((item) => `| ${cell(item.name)} | ${cell(item.state)} |`),
      '',
    );
  }
  lines.push(renderSummary(evidence, classification));
  return { green, problems, summary: `${lines.join('\n')}\n` };
}

// ---- command line -----------------------------------------------------------

/** Host access of {@link runCanaryReport}, injected. */
export interface CanaryReportHost {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute repository root. */
  readonly repoRoot: string;
  readonly readFile: (file: string) => Promise<string>;
  readonly appendFile: (file: string, text: string) => Promise<void>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const USAGE =
  'usage: canary-report --results <file> --platform <key> --mode canary|dry-run --schedule <name> [--cache <dir>]\n';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the results file's outer shape (it is written by this repository's reporter). */
export function parseResults(text: string, source: string): CanaryResults {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source}: not valid JSON`);
  }
  if (
    !isRecord(parsed) ||
    parsed['format'] !== RESULTS_FORMAT ||
    !['passed', 'failed', 'interrupted'].includes(String(parsed['reason'])) ||
    !Array.isArray(parsed['tests']) ||
    !Array.isArray(parsed['outside'])
  ) {
    throw new Error(`${source}: not a ${RESULTS_FORMAT} file`);
  }
  return parsed as unknown as CanaryResults;
}

async function readPin(host: CanaryReportHost, file: string): Promise<CliPin> {
  const text = await host.readFile(file);
  return parsePin(JSON.parse(text) as unknown, file);
}

/**
 * `canary-report`: judges the run, appends the summary to
 * `$GITHUB_STEP_SUMMARY` (when set) and prints it. Exit codes: 0 green,
 * 1 red or unreadable input, 2 usage error.
 */
export async function runCanaryReport(host: CanaryReportHost): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...host.argv],
      options: {
        results: { type: 'string' },
        platform: { type: 'string' },
        mode: { type: 'string' },
        schedule: { type: 'string' },
        cache: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    host.stderr(`canary-report: ${String(error)}\n${USAGE}`);
    return 2;
  }
  const { results: resultsFile, platform, mode, schedule } = values;
  if (
    resultsFile === undefined ||
    platform === undefined ||
    schedule === undefined ||
    (mode !== 'canary' && mode !== 'dry-run')
  ) {
    host.stderr(
      `canary-report: --results, --platform, --mode and --schedule are required\n${USAGE}`,
    );
    return 2;
  }
  const configured = values.cache ?? host.env['HUDHUD_CLI_CACHE'];
  const cacheRoot = path.resolve(
    host.repoRoot,
    configured === undefined || configured === '' ? '.cache/claude-cli' : configured,
  );
  let judgement: CanaryJudgement;
  try {
    judgement = judgeCanary({
      mode,
      schedule,
      platform,
      results: parseResults(await host.readFile(resultsFile), resultsFile),
      runPin: await readPin(host, path.join(cacheRoot, 'run-pin.json')),
      repoPin: await readPin(host, path.join(host.repoRoot, 'tooling', 'cli-pin.json')),
    });
  } catch (error) {
    const message = `canary-report: the run cannot be judged: ${String(error)}`;
    host.stderr(`${message}\n`);
    const summaryFile = host.env['GITHUB_STEP_SUMMARY'];
    if (summaryFile !== undefined && summaryFile !== '') {
      await host.appendFile(summaryFile, `# Canary: RED\n\n${cell(message)}\n`);
    }
    return 1;
  }
  host.stdout(judgement.summary);
  const summaryFile = host.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile !== undefined && summaryFile !== '') {
    await host.appendFile(summaryFile, judgement.summary);
  }
  return judgement.green ? 0 : 1;
}
