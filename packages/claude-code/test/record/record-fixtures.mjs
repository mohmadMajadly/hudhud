#!/usr/bin/env node
// `pnpm fixtures:record`: records the golden-fixture suites of plan 4.3 from
// the verified pinned CLI into packages/claude-code/conformance (W3-T6,
// W3-Z; single-source launch, W4-T2). Lead-run, never in CI. Composition
// root only: the recorder and its tests live in
// tooling/test-support/src/fixtures/record/ (main.ts documents the options
// and the environment); every case's argv and environment come from the
// adapter's own builders (product-launch.mjs). Needs a prior `pnpm cli:fetch`
// and `pnpm build`.

import path from 'node:path';
import process from 'node:process';

import {
  nodeRecorderHost,
  runRecorder,
} from '../../../../tooling/test-support/dist/fixtures/record/main.js';
import { productLaunch } from './product-launch.mjs';

process.exitCode = await runRecorder(
  process.argv.slice(2),
  nodeRecorderHost(path.resolve(import.meta.dirname, '..', '..', '..', '..'), productLaunch),
);
