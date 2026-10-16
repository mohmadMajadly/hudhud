#!/usr/bin/env node
// The job addon's release record tooling (plan §6.3; lead ruling on A2).
// .github/workflows/addon-prebuild.yml runs it in CI; the lead runs `compare`
// after an independent local build:
//
//   node scripts/addon/manifest.mjs components --arch x64|arm64
//   node scripts/addon/manifest.mjs collect --arch x64|arm64 --out <dir>
//   node scripts/addon/manifest.mjs check-toolchain --toolchain <toolchain.json>
//   node scripts/addon/manifest.mjs verify --dir <artifact dir> --record native/win32-job/release/<release>/manifest.json
//   node scripts/addon/manifest.mjs write --release <release> --dir <artifacts dir> --out <dir>
//   node scripts/addon/manifest.mjs compare --manifest <CI manifest.json>
//
// What each command does and refuses: scripts/lib/addon-manifest.mjs (logic,
// covered by scripts/test/addon-manifest.test.ts). Relative paths resolve
// against the repository root. Nothing is ever installed or published.
//
// Exit codes: 0 done, 1 refused or a comparison failed (the reason names
// both values), 2 usage error.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { UsageError } from '../lib/addon-digests.mjs';
import { parseArgs, runManifest } from '../lib/addon-manifest.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

try {
  const options = parseArgs(process.argv.slice(2));
  process.exitCode = runManifest(options, {
    root: ROOT,
    platform: process.platform,
    hostArch: process.arch,
    readFile: (file) => readFileSync(file),
    writeFile: (file, data) => {
      writeFileSync(file, data);
    },
    makeDir: (dir) => {
      mkdirSync(dir, { recursive: true });
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
  process.stderr.write(`manifest: ${error.message}\n`);
  process.exitCode = 2;
}
