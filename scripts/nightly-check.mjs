#!/usr/bin/env node
// Cheap Linux pre-check of the nightly workflow (ADR-0014, G3, amendment 2).
// Writes `run=true|false` to $GITHUB_OUTPUT: true only when a new Claude Code
// CLI version was published in the window, or on manual dispatch. Reads only
// the npm registry's public abbreviated document; no credentials. Exits 1 when
// the registry cannot be read, so an outage is visible rather than silent.

import { appendFileSync } from 'node:fs';
import process from 'node:process';

import { CLI_PACKAGE, decideNightly, parseTime } from './lib/nightly.mjs';

const REGISTRY = 'https://registry.npmjs.org/';
const TIMEOUT_MS = 30_000;

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
    registryModified: await registryModified(),
    forced: process.env['NIGHTLY_FORCED'] === 'true',
  });
  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') {
    appendFileSync(output, `run=${String(decision.run)}\n`);
  }
  if (decision.error !== undefined) {
    process.stderr.write(`nightly-check: ${decision.error}\n`);
    return 1;
  }
  const reason = decision.reasons.length > 0 ? decision.reasons.join(', ') : 'no new CLI release';
  process.stdout.write(`run=${String(decision.run)} (${reason})\n`);
  return 0;
}

process.exitCode = await main();
