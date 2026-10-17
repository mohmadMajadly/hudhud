#!/usr/bin/env node
// Summarizes an integration timing log (scripts/lib/ci-timing.mjs; W7-T1,
// K15) for `.github/workflows/timing.yml`: prints the Markdown table, appends
// it to $GITHUB_STEP_SUMMARY when set, and exits 1 when the log is unreadable
// or malformed, holds no sample, or a quantity has fewer than the required
// samples.
//
//   node scripts/ci-timing.mjs <timing-log.jsonl>

import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { MIN_SAMPLES, parseSamples, renderSummary, summarize } from './lib/ci-timing.mjs';

function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (file === undefined || rest.length > 0) {
    process.stderr.write('usage: ci-timing <timing-log.jsonl>\n');
    return 2;
  }
  let stats;
  try {
    stats = summarize(parseSamples(readFileSync(file, 'utf8')));
  } catch (error) {
    process.stderr.write(
      `ci-timing: ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const summary = renderSummary(stats);
  process.stdout.write(summary);
  const target = process.env['GITHUB_STEP_SUMMARY'];
  if (target !== undefined && target !== '') {
    appendFileSync(target, `## Integration timing samples\n\n${summary}`, 'utf8');
  }
  if (stats.length === 0 || stats.some((row) => row.n < MIN_SAMPLES)) return 1;
  return 0;
}

process.exitCode = main();
