#!/usr/bin/env node
// The integration evidence job of .github/workflows/macos-gate.yml (research
// 11). Thin host wrapper: reads the files the job's steps wrote, calls the
// unit-tested procedures of src/evidence.ts and prints Markdown for the job
// summary. Run as an esbuild bundle, like bin/macos-gate.mjs:
//
//   node <bundle> report <vitest-report.json> <repo-root> <title>
//   node <bundle> shapes <vitest-report.json> <snapshot-dir> <repo-root>
//   node <bundle> samples <samples.jsonl> <name> <minimum>
//
// Exit 0 when the input holds what the job requires, 1 when it does not
// (`report` exits 1 when a test failed), 2 on a usage error.

import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';

import {
  checkShapeUpdate,
  reportMarkdown,
  samplesMarkdown,
  summarizeReport,
  summarizeSamples,
} from '../src/evidence.js';

/**
 * @param {string} file
 * @returns {Promise<import('../src/evidence.js').VitestReport>}
 */
async function readReport(file) {
  /** @type {unknown} */
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error(`${file}: not a JSON object`);
  return /** @type {import('../src/evidence.js').VitestReport} */ (value);
}

const [command, ...args] = process.argv.slice(2);

if (command === 'report' && args.length === 3) {
  const [file = '', repoRoot = '', title = ''] = args;
  const summary = summarizeReport(await readReport(file), repoRoot);
  process.stdout.write(reportMarkdown(title, summary));
  process.exit(summary.failed > 0 || summary.failures.length > 0 || summary.total === 0 ? 1 : 0);
} else if (command === 'shapes' && args.length === 3) {
  const [file = '', snapshotDir = '', repoRoot = ''] = args;
  const report = await readReport(file);
  const problems = checkShapeUpdate(report, await readdir(snapshotDir), repoRoot);
  process.stdout.write(
    problems.length === 0
      ? '### Request-shape update run\n\nOne darwin snapshot written per scenario; every test failed only because it wrote its snapshot.\n'
      : `### Request-shape update run: problems\n\n${problems.map((line) => `- ${line}`).join('\n')}\n`,
  );
  process.exit(problems.length === 0 ? 0 : 1);
} else if (command === 'samples' && args.length === 3) {
  const [file = '', name = '', minimum = ''] = args;
  try {
    const summary = summarizeSamples(await readFile(file, 'utf8'), name, Number(minimum));
    process.stdout.write(samplesMarkdown(summary));
    process.exit(0);
  } catch (error) {
    process.stdout.write(`### Timing samples: ${name}\n\n${String(error)}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write(
    'usage: integration-evidence report <report.json> <repo-root> <title>\n' +
      '       integration-evidence shapes <report.json> <snapshot-dir> <repo-root>\n' +
      '       integration-evidence samples <samples.jsonl> <name> <minimum>\n',
  );
  process.exit(2);
}
