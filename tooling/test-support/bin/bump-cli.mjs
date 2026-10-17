#!/usr/bin/env node
// `pnpm cli:bump <version>`: the lead's local helper for the CLI version-bump
// PR (K16, plan 1.11 and 5.9 W7-T2). Thin host wrapper; the logic and its
// tests live in src/canary/ (bump.ts documents the options and the
// follow-up steps it prints). Needs a prior build of @hudhudjs/test-support,
// which the `cli:bump` script runs first.
//
// Downloads and verifies the binaries (never executes them) and rewrites
// tooling/cli-pin.json only after every platform verified. Never pushes.

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { runBump } from '../dist/canary/bump.js';

process.exitCode = await runBump({
  argv: process.argv.slice(2),
  env: process.env,
  repoRoot: path.resolve(import.meta.dirname, '..', '..', '..'),
  fetch: (url, init) => fetch(url, init),
  platform: process.platform,
  now: () => new Date(),
  readFile: (file) => readFile(file, 'utf8'),
  replaceFile: async (file, text) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
