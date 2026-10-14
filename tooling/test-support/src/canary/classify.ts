/**
 * Degradation classifier of the canary (plan §1.11, §5.9 W7-T2; ADR-0013
 * §8, §12).
 *
 * @remarks
 * When the canary (the integration suite against the newest published CLI)
 * goes red, the question for the lead is whose side moved:
 *
 * - `mock-inadequate`: the CLI sent something the mock cannot answer, for
 *   example a new endpoint or host (egress violation), a changed request
 *   shape (request-shape snapshot) or a request whose reply the CLI
 *   rejected (a new required response field). The fix is in the mock and
 *   the snapshots, usually together with the version bump.
 * - `protocol-regressed`: the mock was adequate and hudhud's expectations
 *   about the CLI's frames are broken (a protocol, handshake or control
 *   error, or a failure without any mock-side evidence). The fix is in the
 *   adapter and its fixtures.
 *
 * Failures are judged one by one by rules in a fixed order (first match
 * wins); the run's verdict is `protocol-regressed` when any failure is one
 * (it needs product work whatever else moved), else `mock-inadequate`. A
 * red run no rule can place is `protocol-regressed` by default and says so.
 *
 * The input is plain data (`CanaryEvidence`) so that the scheduled
 * workflow's glue (W7-T2) maps the Vitest JSON report and the mock's
 * violation log onto it; this module does no I/O except the job summary
 * append, and holds no clock.
 */

import { appendFileSync } from 'node:fs';

/** Which side moved. */
export type CanaryVerdict = 'mock-inadequate' | 'protocol-regressed';

/** The CLI under test. */
export interface CanaryCli {
  /** The newest published version, which this run tested. */
  readonly version: string;
  /** Its registry `dist.integrity`, recorded for the run (K16). */
  readonly integrity: string;
  /** The version pinned in `tooling/cli-pin.json`. */
  readonly pinnedVersion: string;
}

/** One failed test. */
export interface CanaryFailure {
  /** Full test name. */
  readonly test: string;
  /** Class name of the error the test failed with, when known. */
  readonly errorName?: string;
  /** hudhud error code, when the error carried one. */
  readonly code?: string;
  readonly message: string;
}

/** An egress violation the mock recorded (kind, method, target; no credentials). */
export interface CanaryViolation {
  readonly kind: string;
  readonly method: string;
  readonly target: string;
}

/** Everything the classifier looks at. */
export interface CanaryEvidence {
  readonly cli: CanaryCli;
  /** For example `linux-x64`. */
  readonly platform: string;
  readonly tests: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
  };
  readonly failures: readonly CanaryFailure[];
  /** Violations recorded by the mocks of the run. */
  readonly violations: readonly CanaryViolation[];
  /** Findings of the request-shape snapshots across the run. */
  readonly snapshots: { readonly semantic: number; readonly additive: number };
}

/** The rules, in the order they are tried. */
export type CanaryRule =
  | 'egress-violation'
  | 'request-shape-changed'
  | 'protocol-code'
  | 'cli-rejected-reply'
  | 'no-mock-evidence';

/** The verdict on one failure and why. */
export interface FailureVerdict {
  readonly test: string;
  readonly verdict: CanaryVerdict;
  readonly rule: CanaryRule;
  /** The failure's message, as given (bounded and escaped only in the summary). */
  readonly message: string;
}

/** The classification of a run. */
export interface CanaryClassification {
  /** `green` when nothing failed and the mock saw nothing wrong. */
  readonly verdict: CanaryVerdict | 'green';
  readonly failures: readonly FailureVerdict[];
  /** Run-level reasons for `mock-inadequate`, apart from failed tests. */
  readonly mockEvidence: readonly string[];
  /** Why the verdict is the one reported, one sentence. */
  readonly reason: string;
}

/** Error class names that prove the mock side moved. */
const EGRESS_ERROR = 'EgressViolationError';
const SHAPE_ERROR = 'RequestShapeError';

/** hudhud error codes of a broken frame protocol (plan §3.1). */
const PROTOCOL_CODES: ReadonlySet<string> = new Set([
  'CONTROL_REQUEST_FAILED',
  'HANDSHAKE_FAILED',
  'HANDSHAKE_TIMEOUT',
  'OUTBOUND_FRAME_TOO_LARGE',
  'OVERSIZED_FRAME',
  'PROTOCOL_ERROR',
  'SESSION_POISONED',
]);

/** How the CLI words an API error it got from the (mock) server. */
const REJECTED_REPLY =
  /\bAPI Error\b|api_error_status|apiErrorStatus|invalid_request_error|unexpected (?:event|response)|overloaded_error/i;

function ruleOf(failure: CanaryFailure): CanaryRule {
  if (failure.errorName === EGRESS_ERROR) return 'egress-violation';
  if (failure.errorName === SHAPE_ERROR) return 'request-shape-changed';
  if (failure.code !== undefined && PROTOCOL_CODES.has(failure.code)) return 'protocol-code';
  if (REJECTED_REPLY.test(failure.message)) return 'cli-rejected-reply';
  return 'no-mock-evidence';
}

const SIDE: Readonly<Record<CanaryRule, CanaryVerdict>> = {
  'egress-violation': 'mock-inadequate',
  'request-shape-changed': 'mock-inadequate',
  'protocol-code': 'protocol-regressed',
  'cli-rejected-reply': 'mock-inadequate',
  'no-mock-evidence': 'protocol-regressed',
};

/** Judges one failed test. */
export function classifyFailure(failure: CanaryFailure): FailureVerdict {
  const rule = ruleOf(failure);
  return { test: failure.test, verdict: SIDE[rule], rule, message: failure.message };
}

/** Classifies a canary run (see the module comment). */
export function classifyCanary(evidence: CanaryEvidence): CanaryClassification {
  const failures = evidence.failures.map(classifyFailure);
  const mockEvidence: string[] = [];
  if (evidence.violations.length > 0) {
    mockEvidence.push(`${String(evidence.violations.length)} egress violation(s)`);
  }
  if (evidence.snapshots.semantic > 0) {
    mockEvidence.push(`${String(evidence.snapshots.semantic)} semantic request-shape change(s)`);
  }
  const red = evidence.tests.failed > 0 || failures.length > 0 || mockEvidence.length > 0;
  if (!red) {
    return {
      verdict: 'green',
      failures,
      mockEvidence,
      reason: 'No test failed and the mock saw nothing wrong.',
    };
  }
  if (failures.some((item) => item.verdict === 'protocol-regressed')) {
    return {
      verdict: 'protocol-regressed',
      failures,
      mockEvidence,
      reason: 'At least one failure has no mock-side explanation or is a protocol error.',
    };
  }
  if (failures.length === 0 && mockEvidence.length === 0) {
    return {
      verdict: 'protocol-regressed',
      failures,
      mockEvidence,
      reason: 'The run failed without any failure detail; treated as protocol-regressed.',
    };
  }
  return {
    verdict: 'mock-inadequate',
    failures,
    mockEvidence,
    reason:
      'Every failure traces to something the mock cannot answer or the request shape changed.',
  };
}

// ---- job summary -----------------------------------------------------------

/** Longest failure message line in the summary. */
export const MAX_MESSAGE = 200;

const SECRET_SHAPES = /sk-ant-[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** One line of untrusted text made safe for a Markdown table cell. */
export function cell(text: string): string {
  const first = text.split(/\r?\n/, 1).join('');
  const clean = first.replace(SECRET_SHAPES, '<redacted>');
  const bounded = clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE)}...` : clean;
  return bounded.replace(/[\\|`<>&[\]]/g, (char) => `&#${String(char.codePointAt(0))};`);
}

const NEXT_STEP: Readonly<Record<CanaryVerdict | 'green', string>> = {
  green: 'Nothing to do.',
  'mock-inadequate':
    'The mock or the request-shape snapshots need updating for this CLI version: extend the mock, review the snapshot diff (`HUDHUD_REQUEST_SHAPE_UPDATE=1`), then prepare the bump (`pnpm cli:bump`).',
  'protocol-regressed':
    "hudhud's expectations about this CLI version's frames are broken: reproduce locally with the newest CLI, fix the adapter and its fixtures, then prepare the bump (`pnpm cli:bump`).",
};

/** The GitHub job summary (Markdown) of a classified run. */
export function renderSummary(evidence: CanaryEvidence, result: CanaryClassification): string {
  const { cli, tests } = evidence;
  const lines = [
    `## Canary ${cell(cli.version)} on ${cell(evidence.platform)}: ${result.verdict}`,
    '',
    '| | |',
    '|---|---|',
    `| CLI version | ${cell(cli.version)} (pinned: ${cell(cli.pinnedVersion)}) |`,
    `| Registry integrity | ${cell(cli.integrity)} |`,
    `| Tests | ${String(tests.passed)} passed, ${String(tests.failed)} failed, ${String(tests.skipped)} skipped, ${String(tests.total)} total |`,
    `| Request-shape findings | ${String(evidence.snapshots.semantic)} semantic, ${String(evidence.snapshots.additive)} additive |`,
    `| Egress violations | ${String(evidence.violations.length)} |`,
    `| Classification | ${result.verdict} |`,
    '',
    result.reason,
    '',
    NEXT_STEP[result.verdict],
  ];
  if (result.mockEvidence.length > 0) {
    lines.push('', 'Mock-side evidence:', ...result.mockEvidence.map((item) => `- ${cell(item)}`));
  }
  if (evidence.violations.length > 0) {
    lines.push(
      '',
      '| Violation | Method | Target |',
      '|---|---|---|',
      ...evidence.violations.map(
        (item) => `| ${cell(item.kind)} | ${cell(item.method)} | ${cell(item.target)} |`,
      ),
    );
  }
  if (result.failures.length > 0) {
    lines.push('', '| Test | Verdict | Rule | Message |', '|---|---|---|---|');
    for (const judged of result.failures) {
      lines.push(
        `| ${cell(judged.test)} | ${judged.verdict} | ${judged.rule} | ${cell(judged.message)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Appends `text` to the file named by `GITHUB_STEP_SUMMARY`.
 *
 * @returns whether the variable was set (outside GitHub Actions it is not,
 * and nothing is written).
 */
export function writeJobSummary(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const file = env['GITHUB_STEP_SUMMARY'];
  if (file === undefined || file === '') return false;
  appendFileSync(file, text, 'utf8');
  return true;
}
