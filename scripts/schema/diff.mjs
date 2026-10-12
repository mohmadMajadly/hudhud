#!/usr/bin/env node
// schema:diff — additive-only linter: compares each package's schemas/ with
// schemas/.baseline/ (plan §1.3, ADR-0005 §5).
//
//   node scripts/schema/diff.mjs                     lint
//   node scripts/schema/diff.mjs --update-baseline   copy schemas/*.schema.json to
//                                                    schemas/.baseline/ (release task)
//
// Exit codes: 0 additive only, 1 a forbidden change, 2 usage error.

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { diffPackages, formatViolations, updateBaseline } from '../lib/schema/diff.mjs';
import { PIPELINES } from '../lib/schema/pipeline.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const packageDirs = [...new Set(PIPELINES.map((p) => p.packageDir))];
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--update-baseline') {
  const written = updateBaseline(root, packageDirs);
  process.stdout.write(
    `schema:diff: baseline updated\n${written.map((f) => `  ${f}`).join('\n')}\n`,
  );
} else if (args.length > 0) {
  process.stderr.write('usage: node scripts/schema/diff.mjs [--update-baseline]\n');
  process.exitCode = 2;
} else {
  const { violations, compared } = diffPackages(root, packageDirs);
  if (violations.length > 0) {
    process.stderr.write(`schema:diff: FAILED (not additive)\n${formatViolations(violations)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`schema:diff: ${String(compared)} schemas, additive only\n`);
  }
}
