#!/usr/bin/env node
// Documentation snippet check (W7-T3; part of `pnpm lint:md`). Every
// TypeScript or JavaScript code block of the user documentation (the root
// README, the package READMEs, docs/guide/ and examples/) must be a
// contiguous excerpt of an example program under examples/. The examples
// are type-checked by `pnpm build` and linted by `pnpm lint`, so a snippet
// that passes here is code that compiles against the current API. Offline;
// reads tracked and unignored files only.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { checkSnippets } from './lib/doc-snippets.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/**
 * Tracked and unignored files matching the pathspecs, relative to the root.
 *
 * @param {string[]} pathspecs
 * @returns {string[]}
 */
function listFiles(pathspecs) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...pathspecs,
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => file !== '' && existsSync(path.join(root, file)));
}

/** @param {string} file */
const read = (file) => ({ path: file, text: readFileSync(path.join(root, file), 'utf8') });

const documents = listFiles([
  'README.md',
  'packages/*/README.md',
  'docs/guide/*.md',
  'docs/guide/**/*.md',
  'examples/*.md',
  'examples/**/*.md',
]).map(read);
const examples = listFiles(['examples/*.ts', 'examples/**/*.ts']).map(read);

const { problems, checked } = checkSnippets(documents, examples);
if (problems.length > 0) {
  process.stderr.write(
    `check-doc-snippets: ${String(problems.length)} problem(s)\n${problems.join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `check-doc-snippets: ${String(checked)} code block(s) in ${String(documents.length)} file(s) are excerpts of ${String(examples.length)} example(s)\n`,
  );
}
