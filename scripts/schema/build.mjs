#!/usr/bin/env node
// schema:build — regenerates the committed JSON Schemas and the precompiled
// validators of every package from their TypeBox sources (plan §1.3).
//
//   node scripts/schema/build.mjs
//
// Exit codes: 0 done, 1 a source or the pipeline failed.

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildOutputs, writeOutputs } from '../lib/schema/pipeline.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

try {
  const changed = writeOutputs(root, await buildOutputs(root));
  process.stdout.write(
    changed.length === 0
      ? 'schema:build: up to date\n'
      : `schema:build: wrote\n${changed.map((file) => `  ${file}`).join('\n')}\n`,
  );
} catch (error) {
  process.stderr.write(`schema:build: FAILED\n${String(error)}\n`);
  process.exitCode = 1;
}
