#!/usr/bin/env node
// Entry point of the `ci-gate` job. Expects CI_TIER (classify output) and
// CI_NEEDS (`toJSON(needs)`) in the environment.

import process from 'node:process';

import { evaluateGate } from './lib/ci-gate.mjs';

function main() {
  /** @type {unknown} */
  const needs = JSON.parse(process.env['CI_NEEDS'] ?? '{}');
  /** @type {Record<string, string>} */
  const results = {};
  if (typeof needs === 'object' && needs !== null) {
    for (const [job, value] of Object.entries(needs)) {
      /** @type {unknown} */
      const result =
        typeof value === 'object' && value !== null ? Reflect.get(value, 'result') : undefined;
      results[job] = typeof result === 'string' ? result : 'missing';
    }
  }
  const tier = process.env['CI_TIER'];
  const { ok, problems } = evaluateGate(tier, results);
  process.stdout.write(`tier=${String(tier)} results=${JSON.stringify(results)}\n`);
  if (!ok) {
    process.stderr.write(`ci-gate: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write('ci-gate: passed\n');
  return 0;
}

process.exitCode = main();
