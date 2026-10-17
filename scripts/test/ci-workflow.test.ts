// Structure of .github/workflows/ci.yml that the tier rules rely on
// (ADR-0014). The workflow is read as text: a job is the block from its
// two-space-indented key to the next one, and a step command is a
// `run: <command>` line inside it.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

/**
 * The text of one job of the workflow.
 *
 * @param name The job's key under `jobs:`.
 */
function job(name: string): string {
  const lines = WORKFLOW.replaceAll('\r\n', '\n').split('\n');
  const jobs = lines.indexOf('jobs:');
  const start = lines.indexOf(`  ${name}:`, jobs);
  if (jobs < 0 || start < 0) throw new Error(`ci.yml has no job ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][\w-]*:$/u.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The single-line `run:` commands of a job, in order. */
function commands(name: string): string[] {
  return [...job(name).matchAll(/^ +run: (.+)$/gmu)].map((match) => String(match[1]));
}

describe('ci.yml', () => {
  it('the LIGHT job runs every check a docs-only change can fail in FULL (R7-1)', () => {
    expect(job('docs')).toContain("if: needs.classify.outputs.tier == 'LIGHT'");
    expect(commands('docs')).toEqual([
      'pnpm run format:check',
      'pnpm run lint:md',
      'pnpm run privacy:tree',
    ]);
  });

  it('every OS job of STANDARD and FULL runs the whole check', () => {
    for (const name of ['linux', 'windows', 'macos']) {
      expect(commands(name)).toEqual(
        expect.arrayContaining([
          'pnpm run check',
          'pnpm run check:tarball',
          'pnpm run test:integration',
        ]),
      );
    }
  });
});
