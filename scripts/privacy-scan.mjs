#!/usr/bin/env node
// Privacy gate. Blocks home-directory paths, personal e-mail addresses,
// common credential formats and private denylist terms.
//
//   node scripts/privacy-scan.mjs --staged   added lines and new file names of the index
//   node scripts/privacy-scan.mjs --tree     every tracked and unignored untracked file
//
// Denylist (never committed): the file named by HUDHUD_PRIVACY_DENYLIST, or
// <git common dir>/info/privacy-denylist. Exit codes: 0 clean, 1 findings,
// 2 usage or configuration error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  formatFindings,
  parseAddedLines,
  parseDenylist,
  scanAddedLines,
  scanPathName,
  scanText,
} from './lib/privacy.mjs';

const DENYLIST_ENV = 'HUDHUD_PRIVACY_DENYLIST';
const MAX_BUFFER = 256 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

/**
 * @param {readonly string[]} args
 * @param {string} [cwd]
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * @param {string} output NUL-separated git output.
 * @returns {string[]}
 */
function splitNul(output) {
  return output.split('\0').filter((entry) => entry !== '');
}

/** @returns {string[]} */
function loadDenylist() {
  const fromEnv = process.env[DENYLIST_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!existsSync(fromEnv)) {
      throw new Error(`${DENYLIST_ENV} points to a missing file`);
    }
    return parseDenylist(readFileSync(fromEnv, 'utf8'));
  }
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const file = path.join(commonDir, 'info', 'privacy-denylist');
  if (!existsSync(file)) {
    process.stderr.write(
      `privacy-scan: no denylist configured (set ${DENYLIST_ENV} or create .git/info/privacy-denylist)\n`,
    );
    return [];
  }
  return parseDenylist(readFileSync(file, 'utf8'));
}

/**
 * @param {readonly string[]} denylist
 * @returns {import('./lib/privacy.mjs').Finding[]}
 */
function scanStaged(denylist) {
  const diff = git([
    'diff',
    '--cached',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '--unified=0',
  ]);
  const newFiles = splitNul(
    git(['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=A']),
  );
  return [
    ...newFiles.flatMap((file) => scanPathName(file, denylist)),
    ...scanAddedLines(parseAddedLines(diff), denylist),
  ];
}

/**
 * @param {readonly string[]} denylist
 * @returns {import('./lib/privacy.mjs').Finding[]}
 */
function scanTree(denylist) {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const files = splitNul(
    git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root),
  );
  /** @type {import('./lib/privacy.mjs').Finding[]} */
  const findings = [];
  for (const file of new Set(files)) {
    findings.push(...scanPathName(file, denylist));
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) continue; // deleted in the working tree
    // An untracked nested repository is listed as a directory; its contents
    // belong to that repository and cannot be committed here (only a gitlink).
    if (statSync(absolute).isDirectory()) continue;
    const content = readFileSync(absolute);
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue; // binary
    findings.push(...scanText(file, content.toString('utf8'), denylist));
  }
  return findings;
}

function main() {
  const mode = process.argv[2];
  if (mode !== '--staged' && mode !== '--tree') {
    process.stderr.write('usage: privacy-scan.mjs --staged | --tree\n');
    return 2;
  }
  let findings;
  try {
    const denylist = loadDenylist();
    findings = mode === '--staged' ? scanStaged(denylist) : scanTree(denylist);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`privacy-scan: ${message}\n`);
    return 2;
  }
  if (findings.length > 0) {
    process.stderr.write(
      `privacy-scan: ${String(findings.length)} finding(s); remove them before committing:\n${formatFindings(findings)}\n`,
    );
    return 1;
  }
  process.stdout.write(`privacy-scan (${mode.slice(2)}): clean\n`);
  return 0;
}

process.exitCode = main();
