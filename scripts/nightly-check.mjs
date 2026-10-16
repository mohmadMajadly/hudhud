#!/usr/bin/env node
// The `should-run` job of the scheduled canaries (K16, ADR-0014 amendment 3,
// plan 5.9 W7-T2): `node scripts/nightly-check.mjs nightly|weekly`.
// Writes run, mode, version and macos to $GITHUB_OUTPUT and the decision to
// the job summary. `CANARY_MODE=dry-run` (manual dispatch only) runs the
// canary path against the pinned version, labelled as a dry run. Reads only
// tooling/cli-pin.json and the npm registry's public document of the CLI; no
// credentials, no dependencies (it runs before `pnpm install`). Exit codes:
// 0 decided, 1 the registry or the pin could not be read, 2 usage error.

import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { decideWeekly } from './lib/canary-weekly.mjs';
import { decideNightly, runScheduleCheck } from './lib/nightly.mjs';

const DECIDE = { nightly: decideNightly, weekly: decideWeekly };

async function main() {
  const schedule = process.argv[2] ?? '';
  if (process.argv.length !== 3 || !Object.hasOwn(DECIDE, schedule)) {
    process.stderr.write('usage: nightly-check.mjs nightly|weekly\n');
    return 2;
  }
  return runScheduleCheck(
    {
      env: process.env,
      fetch: (url, init) => fetch(url, init),
      readFile: (file) => readFileSync(file, 'utf8'),
      appendFile: (file, text) => {
        appendFileSync(file, text, 'utf8');
      },
      now: () => new Date(),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
    schedule,
    DECIDE[/** @type {'nightly' | 'weekly'} */ (schedule)],
  );
}

process.exitCode = await main();
