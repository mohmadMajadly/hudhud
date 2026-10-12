#!/usr/bin/env node
// Cheap Linux pre-check of the nightly workflow (ADR-0014, G3). Writes
// `run=true|false` to $GITHUB_OUTPUT. Reads only public data: the head commit
// of the checked-out main branch and the npm registry's abbreviated document
// of the Claude Code CLI. No credentials.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

import { CLI_PACKAGE, decideNightly, parseTime } from './lib/nightly.mjs';

const REGISTRY = 'https://registry.npmjs.org/';
const TIMEOUT_MS = 30_000;

/** @returns {Date | null} */
function mainCommitTime() {
  try {
    return parseTime(
      execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], { encoding: 'utf8' }),
    );
  } catch {
    return null;
  }
}

/** @returns {Promise<Date | null>} */
async function registryModified() {
  try {
    const response = await fetch(new URL(CLI_PACKAGE.replace('/', '%2F'), REGISTRY), {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    /** @type {unknown} */
    const body = await response.json();
    return typeof body === 'object' && body !== null
      ? parseTime(Reflect.get(body, 'modified'))
      : null;
  } catch {
    return null;
  }
}

async function main() {
  const decision = decideNightly({
    now: new Date(),
    mainCommitTime: mainCommitTime(),
    registryModified: await registryModified(),
    forced: process.env['NIGHTLY_FORCED'] === 'true',
  });
  const reason = decision.reasons.length > 0 ? decision.reasons.join(', ') : 'nothing changed';
  process.stdout.write(`run=${String(decision.run)} (${reason})\n`);
  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '')
    appendFileSync(output, `run=${String(decision.run)}\n`);
}

await main();
