#!/usr/bin/env node
// Digest table and staging of the Windows job addon (plan §6.2; run:
// node scripts/addon/write-digests.mjs --arch x64|arm64 [--addon <file>]
//   [--version <v>] [--check]).
//
// Reads a built hudhud_win32_job.node (default: the build tree of
// native/win32-job/build.mjs, native/win32-job/build/<arch>/Release/; or a CI
// artifact given with --addon), refuses anything but a PE image of the
// requested architecture, computes its sha256 and reads its ABI `version`:
// by loading it on Windows when the host has the same architecture, else
// from --version (which, when also given on Windows, must match). Then:
//
// - without --check (x64): writes the digest table the core's loader checks,
//   packages/core/src/process/containment/win32-job-digests.ts;
// - with --check, and always for arm64 (not in the table, K17): verifies the
//   build against the committed table (sha256 for x64, version for both) and
//   writes nothing there.
//
// Then it stages the bytes it hashed into the platform package
// (packages/win32-job-<arch>/hudhud_win32_job.node, never committed) with a
// SHA256SUMS file. Windows test runs need the staged x64 addon: the core
// resolves it through its optional dependency @hudhudjs/win32-job-x64, so
// the loader's digest check runs in every Windows test. Logic and tests:
// scripts/lib/addon-digests.mjs, scripts/test/addon-*.test.ts.
//
// Exit codes: 0 written or verified and staged, 1 the build was refused,
// 2 usage error.

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
