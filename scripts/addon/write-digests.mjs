#!/usr/bin/env node
// The job addon's digest table and staging (plan §6.2; lead rulings on A2).
//
//   node scripts/addon/write-digests.mjs --from-manifest native/win32-job/release/<release>/manifest.json
//
// writes the core's digest table
// (packages/core/src/process/containment/win32-job-digests.ts) from a
// committed release record. It is the only way the table is written: build
// output never writes it, not even locally.
//
//   node scripts/addon/write-digests.mjs --stage --arch x64|arm64 [--addon <file>]
//     [--toolchain <file>] [--version <v>]
//
// stages a build into its platform package: it reads the built
// hudhud_win32_job.node (default: native/win32-job/build/<arch>/Release/, as
// native/win32-job/build.mjs leaves it, with the build's toolchain.json next
// to it; a CI artifact is given with --addon and --toolchain), refuses
// anything but a PE image of the requested architecture, reads the ABI
// `version` (by loading the addon on a Windows host of the same
// architecture, else from --version, which must match when both exist), and
// writes the exact bytes, a SHA256SUMS for them and the toolchain.json into
// packages/win32-job-<arch>/ (all gitignored). Staging never touches the
// table. `pnpm addon:stage` builds and stages x64.
//
// Logic and tests: scripts/lib/addon-digests.mjs, scripts/test/addon-*.test.ts.
//
// Exit codes: 0 written, 1 the input was refused, 2 usage error.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseArgs, UsageError, writeDigests } from '../lib/addon-digests.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

try {
  const options = parseArgs(process.argv.slice(2));
  process.exitCode = writeDigests(options, {
    root: ROOT,
    platform: process.platform,
    hostArch: process.arch,
    readFile: (file) => readFileSync(file),
    writeFile: (file, data) => {
      writeFileSync(file, data);
    },
    loadVersion: (file) => {
      const module = { exports: {} };
      process.dlopen(module, file);
      /** @type {unknown} */
      const version = Reflect.get(module.exports, 'version');
      return version;
    },
    log: (line) => {
      process.stdout.write(`${line}\n`);
    },
    error: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`write-digests: ${error.message}\n`);
  process.exitCode = 2;
}
