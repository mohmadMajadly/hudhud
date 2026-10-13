#!/usr/bin/env node
// `pnpm fixtures:record`: records the golden-fixture suites of plan 4.3 from
// the verified pinned CLI into packages/claude-code/conformance (W3-T6,
// W3-Z). Lead-run, never in CI. Thin host wrapper; the logic and its tests
// live in src/fixtures/record/ (main.ts documents the options and the
// environment). Needs a prior `pnpm cli:fetch`.

import path from 'node:path';
import process from 'node:process';

import { nodeRecorderHost, runRecorder } from '../dist/fixtures/record/main.js';

process.exitCode = await runRecorder(
  process.argv.slice(2),
  nodeRecorderHost(path.resolve(import.meta.dirname, '..', '..', '..')),
);
