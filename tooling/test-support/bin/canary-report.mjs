#!/usr/bin/env node
// `canary-report`: judges one canary run of the integration suite (K16, plan
// 5.9 W7-T2) from the canary reporter's results file, the run-local pin and
// the repository pin, and writes the job summary. Thin host wrapper; the
// logic and its tests live in src/canary/ (report.ts documents the checks).
// Needs a prior build of @hudhudjs/test-support (`pnpm build`).
//
//   node tooling/test-support/bin/canary-report.mjs --results <file> \
//     --platform linux-x64 --mode canary|dry-run --schedule nightly|weekly

import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { runCanaryReport } from '../dist/canary/report.js';

process.exitCode = await runCanaryReport({
  argv: process.argv.slice(2),
  env: process.env,
  repoRoot: path.resolve(import.meta.dirname, '..', '..', '..'),
  readFile: (file) => readFile(file, 'utf8'),
  appendFile: (file, text) => appendFile(file, text, 'utf8'),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
