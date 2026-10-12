#!/usr/bin/env node
// Offline link checker for every tracked (or unignored) Markdown file:
// relative links must point to existing files, and #anchors to existing
// headings. URLs with a scheme are not fetched (checks stay network-free).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { anchorsOf, extractLinks, isLocalTarget, splitTarget } from './lib/markdown-links.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync(
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
    '*.md',
  ],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter((file) => file !== '' && existsSync(path.join(root, file)));

/** @type {Map<string, Set<string>>} */
const anchorCache = new Map();

/**
 * @param {string} absolute
 * @returns {Set<string>}
 */
function anchors(absolute) {
  let set = anchorCache.get(absolute);
  if (set === undefined) {
    set = anchorsOf(readFileSync(absolute, 'utf8'));
    anchorCache.set(absolute, set);
  }
  return set;
}

/** @type {string[]} */
const problems = [];
let checked = 0;
for (const file of files) {
  const absolute = path.join(root, file);
  for (const link of extractLinks(readFileSync(absolute, 'utf8'))) {
    if (!isLocalTarget(link.target)) continue;
    checked += 1;
    const where = `${file}:${String(link.line)}`;
    let target;
    try {
      target = splitTarget(link.target);
    } catch {
      problems.push(`${where}: malformed link ${link.target}`);
      continue;
    }
    const resolved =
      target.path === '' ? absolute : path.resolve(path.dirname(absolute), target.path);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      problems.push(`${where}: link leaves the repository: ${link.target}`);
      continue;
    }
    if (!existsSync(resolved)) {
      problems.push(`${where}: missing file ${link.target}`);
      continue;
    }
    if (target.anchor !== undefined && target.anchor !== '') {
      if (statSync(resolved).isDirectory() || !resolved.endsWith('.md')) {
        problems.push(`${where}: anchor on a non-Markdown target ${link.target}`);
      } else if (!anchors(resolved).has(target.anchor.toLowerCase())) {
        problems.push(`${where}: missing anchor ${link.target}`);
      }
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `check-links: ${String(problems.length)} broken link(s)\n${problems.join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `check-links: ${String(checked)} local link(s) in ${String(files.length)} file(s) OK\n`,
  );
}
