import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cell,
  classifyCanary,
  classifyFailure,
  MAX_MESSAGE,
  renderSummary,
  writeJobSummary,
  type CanaryEvidence,
  type CanaryFailure,
} from '../../src/canary/classify.js';
import { EgressViolationError } from '../../src/mock/egress-trap.js';
import { RequestShapeError } from '../../src/snapshots/request-shape.js';

// Assembled at run time: the privacy scan refuses the key shape in source.
const KEY_SHAPED = ['sk', 'ant', 'api03', 'abc_DEF'].join('-');

function evidence(overrides: Partial<CanaryEvidence> = {}): CanaryEvidence {
  return {
    cli: { version: '2.1.300', integrity: 'sha512-abc', pinnedVersion: '2.1.296' },
    platform: 'linux-x64',
    tests: { total: 40, passed: 40, failed: 0, skipped: 0 },
    failures: [],
    violations: [],
    snapshots: { semantic: 0, additive: 0 },
    ...overrides,
  };
}

const failure = (overrides: Partial<CanaryFailure>): CanaryFailure => ({
  test: 'suite > test',
  message: 'boom',
  ...overrides,
});

describe('classifyFailure', () => {
  it.each([
    [{ errorName: 'EgressViolationError' }, 'egress-violation', 'mock-inadequate'],
    [{ errorName: 'RequestShapeError' }, 'request-shape-changed', 'mock-inadequate'],
    [{ code: 'PROTOCOL_ERROR' }, 'protocol-code', 'protocol-regressed'],
    [{ code: 'HANDSHAKE_TIMEOUT' }, 'protocol-code', 'protocol-regressed'],
    [{ code: 'OVERSIZED_FRAME' }, 'protocol-code', 'protocol-regressed'],
    [{ message: 'turn failed: API Error: 404 not found' }, 'cli-rejected-reply', 'mock-inadequate'],
    [{ message: 'apiErrorStatus 400' }, 'cli-rejected-reply', 'mock-inadequate'],
    [{ message: 'Unexpected event: foo' }, 'cli-rejected-reply', 'mock-inadequate'],
    [{ message: 'expected 1 to be 2' }, 'no-mock-evidence', 'protocol-regressed'],
    [{ code: 'ABORTED', message: 'aborted' }, 'no-mock-evidence', 'protocol-regressed'],
  ] as const)('judges %j as %s', (input, rule, verdict) => {
    const judged = failure(input);
    expect(classifyFailure(judged)).toEqual({
      test: 'suite > test',
      verdict,
      rule,
      message: judged.message,
    });
  });

  it('recognizes the real error classes of the mock side by their names', () => {
    for (const error of [new EgressViolationError([], 0), new RequestShapeError('x')]) {
      const judged = classifyFailure(failure({ errorName: error.name }));
      expect(judged.verdict).toBe('mock-inadequate');
    }
  });

  it('prefers the structural mock evidence over a protocol code, and a code over message text', () => {
    expect(
      classifyFailure(failure({ errorName: 'EgressViolationError', code: 'PROTOCOL_ERROR' })).rule,
    ).toBe('egress-violation');
    expect(classifyFailure(failure({ code: 'PROTOCOL_ERROR', message: 'API Error' })).rule).toBe(
      'protocol-code',
    );
  });
});

describe('classifyCanary', () => {
  it('is green when nothing failed', () => {
    expect(classifyCanary(evidence())).toEqual({
      verdict: 'green',
      failures: [],
      mockEvidence: [],
      reason: 'No test failed and the mock saw nothing wrong.',
    });
  });

  it('is mock-inadequate when every failure traces to the mock side', () => {
    const result = classifyCanary(
      evidence({
        tests: { total: 40, passed: 38, failed: 2, skipped: 0 },
        failures: [
          failure({ test: 'a', errorName: 'EgressViolationError' }),
          failure({ test: 'b', errorName: 'RequestShapeError' }),
        ],
        violations: [{ kind: 'path', method: 'POST', target: '/v1/new' }],
        snapshots: { semantic: 3, additive: 1 },
      }),
    );
    expect(result.verdict).toBe('mock-inadequate');
    expect(result.mockEvidence).toEqual([
      '1 egress violation(s)',
      '3 semantic request-shape change(s)',
    ]);
    expect(result.failures.map((item) => item.rule)).toEqual([
      'egress-violation',
      'request-shape-changed',
    ]);
  });

  it('is mock-inadequate on run-level mock evidence alone', () => {
    expect(classifyCanary(evidence({ snapshots: { semantic: 1, additive: 0 } })).verdict).toBe(
      'mock-inadequate',
    );
    expect(
      classifyCanary(
        evidence({ violations: [{ kind: 'connect', method: 'CONNECT', target: 'x.example:443' }] }),
      ).verdict,
    ).toBe('mock-inadequate');
  });

  it('is protocol-regressed when any failure is, whatever else moved', () => {
    const result = classifyCanary(
      evidence({
        tests: { total: 40, passed: 38, failed: 2, skipped: 0 },
        failures: [
          failure({ errorName: 'RequestShapeError' }),
          failure({ message: 'expected frame' }),
        ],
        snapshots: { semantic: 1, additive: 0 },
      }),
    );
    expect(result.verdict).toBe('protocol-regressed');
    expect(result.reason).toContain('protocol error');
  });

  it('treats a red run without detail as protocol-regressed and says so', () => {
    const result = classifyCanary(
      evidence({ tests: { total: 40, passed: 39, failed: 1, skipped: 0 } }),
    );
    expect(result.verdict).toBe('protocol-regressed');
    expect(result.reason).toContain('without any failure detail');
  });

  it('counts a skipped or additive-only run as green', () => {
    expect(
      classifyCanary(
        evidence({
          tests: { total: 40, passed: 30, failed: 0, skipped: 10 },
          snapshots: { semantic: 0, additive: 4 },
        }),
      ).verdict,
    ).toBe('green');
  });
});

describe('cell', () => {
  it('keeps the first line, redacts keys, escapes markup and bounds the length', () => {
    expect(cell('a | b\nsecond line')).toBe('a &#124; b');
    expect(cell('x\r\ny')).toBe('x');
    expect(cell(`key ${KEY_SHAPED} and Bearer abc.def`)).toBe(
      'key &#60;redacted&#62; and &#60;redacted&#62;',
    );
    expect(cell('<script>`x`[y]\\&')).toBe('&#60;script&#62;&#96;x&#96;&#91;y&#93;&#92;&#38;');
    const long = cell('z'.repeat(MAX_MESSAGE + 50));
    expect(long).toBe(`${'z'.repeat(MAX_MESSAGE)}...`);
    expect(cell('')).toBe('');
  });
});

describe('renderSummary', () => {
  it('summarizes a green run without tables of failures', () => {
    const text = renderSummary(evidence(), classifyCanary(evidence()));
    expect(text).toContain('## Canary 2.1.300 on linux-x64: green');
    expect(text).toContain('| CLI version | 2.1.300 (pinned: 2.1.296) |');
    expect(text).toContain('| Registry integrity | sha512-abc |');
    expect(text).toContain('40 passed, 0 failed, 0 skipped, 40 total');
    expect(text).toContain('Nothing to do.');
    expect(text).not.toContain('| Test |');
    expect(text).not.toContain('Mock-side evidence');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('lists the failures, the violations and the mock-side evidence of a red run', () => {
    const red = evidence({
      tests: { total: 40, passed: 38, failed: 2, skipped: 0 },
      failures: [
        failure({
          test: 'lifecycle > resume | x',
          errorName: 'EgressViolationError',
          message: 'trap\nmore',
        }),
        failure({ test: 'turn', message: `no: ${KEY_SHAPED}` }),
      ],
      violations: [{ kind: 'path', method: 'GET', target: '/v1/models' }],
      snapshots: { semantic: 1, additive: 2 },
    });
    const text = renderSummary(red, classifyCanary(red));
    expect(text).toContain('## Canary 2.1.300 on linux-x64: protocol-regressed');
    expect(text).toContain(
      '| lifecycle &#62; resume &#124; x | mock-inadequate | egress-violation | trap |',
    );
    expect(text).toContain('| Violation | Method | Target |');
    expect(text).toContain('| path | GET | /v1/models |');
    expect(text).toContain('| Test | Verdict | Rule | Message |');
    expect(text).toContain(
      '| turn | protocol-regressed | no-mock-evidence | no: &#60;redacted&#62; |',
    );
    expect(text).toContain(
      'Mock-side evidence:\n- 1 egress violation(s)\n- 1 semantic request-shape change(s)',
    );
    expect(text).toContain('1 semantic, 2 additive');
    expect(text).not.toContain(KEY_SHAPED);
  });

  it('gives the next step of each verdict', () => {
    const mock = evidence({ snapshots: { semantic: 1, additive: 0 } });
    expect(renderSummary(mock, classifyCanary(mock))).toContain('HUDHUD_REQUEST_SHAPE_UPDATE=1');
    const proto = evidence({ tests: { total: 1, passed: 0, failed: 1, skipped: 0 } });
    expect(renderSummary(proto, classifyCanary(proto))).toContain('fix the adapter');
  });
});

describe('writeJobSummary', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hudhud-classify-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends to the file named by GITHUB_STEP_SUMMARY', () => {
    const file = path.join(dir, 'summary.md');
    expect(writeJobSummary('one\n', { GITHUB_STEP_SUMMARY: file })).toBe(true);
    expect(writeJobSummary('two\n', { GITHUB_STEP_SUMMARY: file })).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  it('writes nothing outside GitHub Actions', () => {
    expect(writeJobSummary('x', {})).toBe(false);
    expect(writeJobSummary('x', { GITHUB_STEP_SUMMARY: '' })).toBe(false);
  });
});
