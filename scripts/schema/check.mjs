#!/usr/bin/env node
// schema:check — regenerates every schema and validator in memory and fails
// on any byte difference from the working tree, and on committed schema
// files that no source produces (plan §1.3).
//
//   node scripts/schema/check.mjs
//
// Exit codes: 0 up to date, 1 differences or a failing source.

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildOutputs, compareOutputs } from '../lib/schema/pipeline.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

try {
  const problems = compareOutputs(root, await buildOutputs(root));
  if (problems.length > 0) {
    process.stderr.write(
      `schema:check: FAILED (run node scripts/schema/build.mjs and review the diff)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('schema:check: up to date\n');
  }
} catch (error) {
  process.stderr.write(`schema:check: FAILED\n${String(error)}\n`);
  process.exitCode = 1;
}
