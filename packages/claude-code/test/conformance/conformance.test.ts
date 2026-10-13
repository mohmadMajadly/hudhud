// The Claude Code conformance runner (plan §4.3, §5.6 W4-T2; ADR-0006,
// ADR-0013 §10): every recorded variant of every suite replayed through
// the session machine with a fake clock, the machine-kit contract checked
// on every step, every state and effect round-tripped through JSON, the
// declared outcome (`declarations.ts`) and the exact expect blocks asserted.
// Runs in `pnpm check` (Vitest project `conformance`) on every OS.
//
// Update mode: `HUDHUD_CONFORMANCE_UPDATE=1 pnpm test:conformance` writes
// each variant's expect file from its replay and then FAILS that variant on
// purpose, so expectations change only through a reviewed diff and a run
// with the mode set can never pass. Everything except the comparison with
// the expect file is still asserted in that mode.

import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { planSuites, roundTrips, schemaIssues } from './checks.js';
import { formatExpect, projectReplay, staleExpectations } from './expect.js';
import { loadConformanceSuites, type ConformanceVariant } from './loader.js';
import { replayVariant } from './replay.js';
import { summarize } from './summary.js';

const UPDATE = process.env['HUDHUD_CONFORMANCE_UPDATE'] === '1';

const suites = loadConformanceSuites({ expectations: UPDATE ? 'ignored' : 'required' });

describe('the conformance suite set', () => {
  // Read from the plan itself: the list after "Suites:" and every
  // "suite `<name>`" of §4.3 (its as-built additions). A suite added to the
  // data or the plan without the other fails here.
  it('is exactly the plan §4.3 list, in order, then its documented additions', () => {
    const { list, additions } = planSuites();
    expect(list).toHaveLength(31);
    expect(additions).toEqual(['auth-token-source', 'resume-duplicate-uuid']);
    expect(suites.map((suite) => suite.name)).toEqual([...list, ...additions]);
  });

  it('records every suite on Linux and Windows', () => {
    for (const suite of suites) {
      const platforms = [...new Set(suite.variants.map((variant) => variant.platform))];
      expect(platforms, suite.name).toEqual(['linux', 'win32']);
    }
  });

  it('declares every case of every suite, and nothing else', () => {
    for (const suite of suites) {
      expect(Object.keys(suite.declaration.declared).sort(), suite.name).toEqual(
        [...suite.declaration.cases].sort(),
      );
    }
  });

  it('counts 74 recorded variants', () => {
    expect(suites.flatMap((suite) => suite.variants)).toHaveLength(74);
  });
});

function replayAndCheck(variant: ConformanceVariant): void {
  const result = replayVariant(variant);
  // The machine-kit contract, then the replay itself.
  expect(result.violations, 'machine-kit contract').toEqual([]);
  expect(result.problems, 'replay').toEqual([]);
  expect(result.ended).toBe(true);
  // Every state and effect survives JSON (ADR-0006); the kit checks it too.
  for (const step of result.steps) {
    expect(roundTrips(step.state), `state after ${step.input.type}`).toBe(true);
    expect(roundTrips(step.effects), `effects of ${step.input.type}`).toBe(true);
  }
  // Every event, error and write against the committed schemas.
  expect(schemaIssues(result.effects.flat()), 'schema issues').toEqual([]);
  const suite = suites.find((item) => item.name === variant.suite);
  const declared = suite?.declaration.declared[variant.case];
  expect(declared, `declaration of ${variant.id}`).toBeDefined();
  expect(summarize(result.effects.flat()), 'declared outcome').toEqual(declared?.summary);
  expect(
    { recorded: result.unpairedRecorded, machine: result.unpairedMachine },
    'declared write differences',
  ).toEqual(declared?.writes);

  const actual = projectReplay(result);
  if (UPDATE) {
    writeFileSync(variant.expectFile, formatExpect(actual));
    throw new Error(
      `${variant.id}: expect file written; review the diff, then run without HUDHUD_CONFORMANCE_UPDATE`,
    );
  }
  // The first stale line in full (a readable diff), then every stale line:
  // the normal mode fails on any stale expect file.
  const expected = variant.expect ?? [];
  actual.forEach((block, index) => {
    const record = variant.records[index];
    expect(block, `${variant.id}:${String(index + 1)} (${String(record?.dir)})`).toEqual(
      expected[index],
    );
  });
  expect(staleExpectations(actual, variant.expect, variant.records), 'stale expect file').toEqual(
    [],
  );
}

for (const suite of suites) {
  describe(suite.name, () => {
    for (const variant of suite.variants) {
      it(`${variant.platform} ${variant.case}`, () => {
        replayAndCheck(variant);
      });
    }
  });
}
