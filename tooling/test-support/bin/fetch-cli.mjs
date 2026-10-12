#!/usr/bin/env node
// `pnpm cli:fetch`: fetch, verify and cache the pinned Claude Code CLI for the
// integration tests (plan 4.6). Thin host wrapper; the logic and its tests
// live in src/cli/ (main.ts documents the options). Needs a prior build of
// @hudhud/test-support (`tsc --build`), which `pnpm check` runs first.
//
// The binary is fetched at test time only, never redistributed (ADR-0015),
// and never executed by this command.
//
// Opt-in real check of the pin against the registry (downloads ~170 MB):
//   node tooling/test-support/bin/fetch-cli.mjs --platform linux-x64 --platform win32-x64

import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { runFetchCli } from '../dist/cli/main.js';

process.exitCode = await runFetchCli({
  argv: process.argv.slice(2),
  env: process.env,
  repoRoot: path.resolve(import.meta.dirname, '..', '..', '..'),
  fetch: (url, init) => fetch(url, init),
  platform: process.platform,
  arch: process.arch,
  now: () => new Date(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  appendFile: (file, text) => appendFile(file, text, 'utf8'),
});
