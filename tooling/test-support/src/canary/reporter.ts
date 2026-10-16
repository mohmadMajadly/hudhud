/**
 * Vitest reporter of the canary (K16, plan §5.9 W7-T2): writes what the
 * integration run did as plain data (`CanaryResults`) for `report.ts`, which
 * classifies it (`classify.ts`) and writes the job summary.
 *
 * @remarks
 * The canary workflows run the integration project with
 * `--reporter=default --reporter=./tooling/test-support/src/canary/reporter.ts`
 * and `HUDHUD_CANARY_RESULTS=<file>`. Only `onTestRunEnd` is used: it walks
 * every module, suite and test once the run is over and records, per test,
 * its state, its errors (name, message, a hudhud `code`, the egress trap's
 * `violations`; an `AggregateError` of the harness's after-test checks is
 * flattened into its parts) and the request-shape warnings it printed
 * (additive changes, `request-shape/support.ts`). Errors outside a test (a
 * failed `beforeAll`, a module that did not load, an unhandled error) are
 * recorded too, so a run cannot look green because its tests never ran.
 *
 * The Vitest types are mirrored structurally (the subset read here, checked
 * against Vitest's `Reporter` in the unit test), so the test-support build
 * does not depend on Vitest.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** Format tag of the results file. */
export const RESULTS_FORMAT = 'hudhud-canary-results/1';

/** The environment variable naming the results file. */
export const RESULTS_ENV = 'HUDHUD_CANARY_RESULTS';

/** Upper bound of one recorded message, in characters. */
export const MAX_RECORDED_MESSAGE = 2000;

/** Upper bound of egress violations recorded per error. */
export const MAX_RECORDED_VIOLATIONS = 50;

/** What a request-shape test prints for an additive change (`enforceVerdict`). */
const ADDITIVE_WARNING = /^request-shape \S+: additive change\b/m;

// ---- the Vitest subset ------------------------------------------------------

/** A serialized error as Vitest reports it (`SerializedError`). */
export interface ReportedError {
  readonly name?: string | undefined;
  readonly message: string;
  readonly [key: string]: unknown;
}

/** A console write of a test (`UserConsoleLog`). */
export interface ReportedLog {
  readonly content: string;
  readonly type: 'stdout' | 'stderr';
}

/** A test (`TestCase`). */
export interface ReportedTest {
  readonly fullName: string;
  result(): {
    readonly state: 'passed' | 'failed' | 'skipped' | 'pending';
    readonly errors?: readonly ReportedError[] | undefined;
  };
  logs(): readonly ReportedLog[];
}

/** A suite (`TestSuite`). */
export interface ReportedSuite {
  readonly fullName: string;
  errors(): readonly ReportedError[];
}

/** A test file (`TestModule`). */
export interface ReportedModule {
  readonly moduleId: string;
  errors(): readonly ReportedError[];
  readonly children: {
    allTests(): Iterable<ReportedTest>;
    allSuites(): Iterable<ReportedSuite>;
  };
}

// ---- the results ------------------------------------------------------------

/** An egress violation as recorded (kind, method, target; no credentials). */
export interface RecordedViolation {
  readonly kind: string;
  readonly method: string;
  readonly target: string;
}

/** One error, flattened out of any `AggregateError`. */
export interface RecordedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly violations?: readonly RecordedViolation[];
}

/** One test. */
export interface RecordedTest {
  /** Test file, relative to the repository root, with `/`. */
  readonly file: string;
  readonly name: string;
  readonly state: 'passed' | 'failed' | 'skipped' | 'pending';
  readonly errors: readonly RecordedError[];
  /** Request-shape additive-change warnings the test printed. */
  readonly additive: number;
}

/** Errors outside any test. */
export interface RecordedOutside {
  /** The file and suite, or `(unhandled)`. */
  readonly where: string;
  readonly errors: readonly RecordedError[];
}

/** The results file. */
export interface CanaryResults {
  readonly format: typeof RESULTS_FORMAT;
  /** Vitest's run end reason. */
  readonly reason: 'passed' | 'failed' | 'interrupted';
  readonly tests: readonly RecordedTest[];
  readonly outside: readonly RecordedOutside[];
}

function bounded(text: string): string {
  return text.length > MAX_RECORDED_MESSAGE ? `${text.slice(0, MAX_RECORDED_MESSAGE)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function violationsOf(value: unknown): readonly RecordedViolation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(isRecord)
    .slice(0, MAX_RECORDED_VIOLATIONS)
    .map((item) => ({
      kind: stringOf(item['kind']),
      method: stringOf(item['method']),
      target: bounded(stringOf(item['target'])),
    }));
}

/** Flattens one reported error (and the parts of an `AggregateError`). */
export function flattenError(error: unknown): RecordedError[] {
  if (!isRecord(error)) return [{ name: 'Error', message: bounded(String(error)) }];
  const nested = error['errors'];
  if (Array.isArray(nested) && nested.length > 0) return nested.flatMap(flattenError);
  const code = error['code'];
  const violations = violationsOf(error['violations']);
  return [
    {
      name: stringOf(error['name']) || 'Error',
      message: bounded(stringOf(error['message'])),
      ...(typeof code === 'string' ? { code } : {}),
      ...(violations === undefined ? {} : { violations }),
    },
  ];
}

function fileOf(root: string, moduleId: string): string {
  const relative = path.relative(root, moduleId);
  return (relative === '' || relative.startsWith('..') ? moduleId : relative)
    .split(path.sep)
    .join('/');
}

/** The results of a finished run. */
export function collectResults(
  root: string,
  modules: readonly ReportedModule[],
  unhandled: readonly ReportedError[],
  reason: CanaryResults['reason'],
): CanaryResults {
  const tests: RecordedTest[] = [];
  const outside: RecordedOutside[] = [];
  for (const module of modules) {
    const file = fileOf(root, module.moduleId);
    const moduleErrors = module.errors().flatMap(flattenError);
    if (moduleErrors.length > 0) outside.push({ where: file, errors: moduleErrors });
    for (const suite of module.children.allSuites()) {
      const errors = suite.errors().flatMap(flattenError);
      if (errors.length > 0) outside.push({ where: `${file} > ${suite.fullName}`, errors });
    }
    for (const test of module.children.allTests()) {
      const result = test.result();
      tests.push({
        file,
        name: test.fullName,
        state: result.state,
        errors: (result.errors ?? []).flatMap(flattenError),
        additive: test.logs().filter((log) => ADDITIVE_WARNING.test(log.content)).length,
      });
    }
  }
  const strays = unhandled.flatMap(flattenError);
  if (strays.length > 0) outside.push({ where: '(unhandled)', errors: strays });
  return { format: RESULTS_FORMAT, reason, tests, outside };
}

/** Where and how the reporter writes. */
export interface CanaryReporterOptions {
  /** Results file; default `$HUDHUD_CANARY_RESULTS`. */
  readonly output?: string | undefined;
  /** Repository root the test files are named relative to; default the working directory. */
  readonly root?: string | undefined;
  readonly write?: ((file: string, text: string) => void) | undefined;
}

/** The reporter (Vitest instantiates the default export). */
export default class CanaryReporter {
  readonly #output: string;
  readonly #root: string;
  readonly #write: (file: string, text: string) => void;

  constructor(options: CanaryReporterOptions = {}) {
    const output = options.output ?? process.env[RESULTS_ENV];
    if (output === undefined || output === '') {
      throw new Error(`the canary reporter needs ${RESULTS_ENV} (the results file)`);
    }
    this.#output = path.resolve(output);
    this.#root = path.resolve(options.root ?? process.cwd());
    this.#write =
      options.write ??
      ((file, text) => {
        writeFileSync(file, text, 'utf8');
      });
  }

  onTestRunEnd(
    modules: readonly ReportedModule[],
    unhandled: readonly ReportedError[],
    reason: CanaryResults['reason'],
  ): void {
    const results = collectResults(this.#root, modules, unhandled, reason);
    this.#write(this.#output, `${JSON.stringify(results, null, 2)}\n`);
  }
}
