/**
 * The integration evidence job of the macOS gate workflow (research 11):
 * pure checks and summaries over what the job's steps wrote. The thin
 * wrapper is `bin/integration-evidence.mjs`; nothing here reads files.
 *
 * - {@link summarizeReport}: the verdicts of a Vitest JSON report (the
 *   integration project on darwin-arm64), every failed test with the first
 *   line of its first failure message.
 * - {@link checkShapeUpdate}: the request-shape suite ran in update mode
 *   (`HUDHUD_REQUEST_SHAPE_UPDATE=1`), which fails every test on purpose
 *   after writing its snapshot; the run counts only when every test failed
 *   for exactly that reason and one darwin snapshot exists per scenario that
 *   has a committed Linux snapshot.
 * - {@link summarizeSamples}: the close-abort overrun samples
 *   (`HUDHUD_TIMING_LOG`, written by the integration suites' recorder
 *   `support/timing.ts`), at least the required number, with their
 *   minimum, median and maximum and the bound 3x the maximum would give
 *   (plan §4.4); the closer sizes the bound, this only reports it.
 */

/** The parts of a Vitest JSON report (Jest-compatible) that are read. */
export interface VitestReport {
  readonly numTotalTests?: number;
  readonly numPassedTests?: number;
  readonly numFailedTests?: number;
  readonly numPendingTests?: number;
  readonly testResults?: readonly {
    readonly name?: string;
    readonly message?: string;
    readonly assertionResults?: readonly {
      readonly fullName?: string;
      readonly status?: string;
      readonly failureMessages?: readonly string[];
    }[];
  }[];
}

/** A failed test (or a file that failed before its tests ran). */
export interface FailedTest {
  readonly file: string;
  readonly test: string;
  readonly message: string;
}

/** Verdict counts and failures of a report. */
export interface ReportSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failures: readonly FailedTest[];
}

const FIRST_LINE_CHARS = 400;

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split(/\r?\n/).find((value) => value.trim() !== '') ?? '';
  return line.trim().slice(0, FIRST_LINE_CHARS);
}

/** Paths in the report relative to the repository, POSIX separators. */
function relative(file: string | undefined, repoRoot: string): string {
  const value = (file ?? '').replaceAll('\\', '/');
  const root = repoRoot.replaceAll('\\', '/').replace(/\/$/, '');
  return value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value;
}

/** The verdicts of a Vitest JSON report. */
export function summarizeReport(report: VitestReport, repoRoot: string): ReportSummary {
  const failures: FailedTest[] = [];
  for (const file of report.testResults ?? []) {
    const name = relative(file.name, repoRoot);
    const assertions = file.assertionResults ?? [];
    for (const test of assertions) {
      if (test.status === 'failed') {
        failures.push({
          file: name,
          test: test.fullName ?? '',
          message: firstLine(test.failureMessages?.[0]),
        });
      }
    }
    // A file that failed to load or failed in a hook has a message and may
    // have no failed assertion.
    if (file.message !== undefined && file.message !== '') {
      failures.push({ file: name, test: '(file)', message: firstLine(file.message) });
    }
  }
  return {
    total: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: report.numPendingTests ?? 0,
    failures,
  };
}

/** Markdown of a {@link ReportSummary}. */
export function reportMarkdown(title: string, summary: ReportSummary): string {
  const lines = [
    `### ${title}`,
    '',
    `${String(summary.total)} tests: ${String(summary.passed)} passed, ${String(summary.failed)} failed, ${String(summary.skipped)} skipped`,
    '',
  ];
  if (summary.failures.length > 0) {
    lines.push('| File | Test | First line of the failure |', '|---|---|---|');
    for (const failure of summary.failures) {
      const cell = (value: string): string => value.replaceAll('|', '\\|');
      lines.push(`| ${cell(failure.file)} | ${cell(failure.test)} | ${cell(failure.message)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** The message `checkRequestShape` fails with after writing a snapshot. */
const WRITTEN = /request-shape \S+: snapshot written to /;

/** Scenario names of `<scenario>.<platform>.shape` file names. */
function scenarios(files: readonly string[], platform: string): string[] {
  const suffix = `.${platform}.shape`;
  return files
    .filter((file) => file.endsWith(suffix))
    .map((file) => file.slice(0, -suffix.length))
    .sort();
}

/**
 * Problems of an update-mode run of the request-shape suite; empty when it
 * wrote one darwin snapshot per Linux scenario and every test failed only
 * because it wrote its snapshot.
 */
export function checkShapeUpdate(
  report: VitestReport,
  snapshotFiles: readonly string[],
  repoRoot: string,
): string[] {
  const problems: string[] = [];
  const summary = summarizeReport(report, repoRoot);
  if (summary.total === 0) problems.push('the update run reported no test');
  if (summary.passed > 0 || summary.skipped > 0) {
    problems.push(
      `${String(summary.passed)} passed and ${String(summary.skipped)} skipped: in update mode every test must fail after writing`,
    );
  }
  for (const failure of summary.failures) {
    if (!WRITTEN.test(failure.message)) {
      problems.push(`${failure.test}: failed for another reason: ${failure.message}`);
    }
  }
  const expected = scenarios(snapshotFiles, 'linux');
  const written = scenarios(snapshotFiles, 'darwin');
  if (expected.join(',') !== written.join(',')) {
    problems.push(
      `darwin snapshots [${written.join(', ')}] differ from the Linux scenarios [${expected.join(', ')}]`,
    );
  }
  return problems;
}

/** One `HUDHUD_TIMING_LOG` line (`{ sample, ms, platform }`), as read here. */
interface Sample {
  readonly name: string;
  readonly valueMs: number;
}

function parseSample(line: string, index: number): Sample {
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null) {
    throw new Error(`sample line ${String(index + 1)} is not an object`);
  }
  const name: unknown = Reflect.get(value, 'sample');
  const valueMs: unknown = Reflect.get(value, 'ms');
  if (typeof name !== 'string' || typeof valueMs !== 'number' || !Number.isFinite(valueMs)) {
    throw new Error(`sample line ${String(index + 1)} lacks a sample name or a finite ms`);
  }
  return { name, valueMs };
}

/** Statistics of the samples of one name. */
export interface SampleSummary {
  readonly name: string;
  readonly count: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly maxMs: number;
  /** 3x the maximum, rounded up to a whole millisecond (plan §4.4). */
  readonly threeTimesMaxMs: number;
  readonly valuesMs: readonly number[];
}

/**
 * Summarizes the samples named `name` in a JSON-lines text.
 *
 * @throws Error on a malformed line, a `minimum` that is not a positive
 *   integer, or when fewer than `minimum` samples of `name` were recorded
 */
export function summarizeSamples(text: string, name: string, minimum: number): SampleSummary {
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new Error(`the minimum sample count must be a positive integer, not ${String(minimum)}`);
  }
  const values = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map(parseSample)
    .filter((sample) => sample.name === name)
    .map((sample) => sample.valueMs);
  if (values.length < minimum) {
    throw new Error(
      `${String(values.length)} samples of ${name}, at least ${String(minimum)} required`,
    );
  }
  const sorted = [...values].sort((a, b) => a - b);
  // The one or two middle values (odd or even count).
  const last = sorted.length - 1;
  const middle = sorted.slice(Math.floor(last / 2), Math.ceil(last / 2) + 1);
  const max = Math.max(...values);
  return {
    name,
    count: values.length,
    minMs: Math.min(...values),
    medianMs: middle.reduce((sum, value) => sum + value, 0) / middle.length,
    maxMs: max,
    threeTimesMaxMs: Math.ceil(3 * max),
    valuesMs: values,
  };
}

/** Markdown of a {@link SampleSummary}. */
export function samplesMarkdown(summary: SampleSummary): string {
  return [
    `### Timing samples: ${summary.name}`,
    '',
    `${String(summary.count)} samples: min ${String(summary.minMs)} ms, median ${String(summary.medianMs)} ms, max ${String(summary.maxMs)} ms; 3 x max = ${String(summary.threeTimesMaxMs)} ms (plan §4.4; the bound is sized by the closer, not here)`,
    '',
    `Values (ms, in run order): ${summary.valuesMs.join(', ')}`,
    '',
  ].join('\n');
}
