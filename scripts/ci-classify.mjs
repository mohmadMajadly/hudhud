#!/usr/bin/env node
// CI tier classifier entry point (ADR-0014). Reads the GitHub Actions
// context, computes the changed files for pull requests and writes `tier`
// and `linux-node` to $GITHUB_OUTPUT. Any error yields FULL.
//
// Local use: node scripts/ci-classify.mjs --files <path>...

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { LINUX_NODE_VERSIONS, classify, classifyPaths, parseNameList } from './lib/ci-classify.mjs';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {unknown} root
 * @param {readonly string[]} keys
 * @returns {unknown}
 */
function dig(root, keys) {
  let node = root;
  for (const key of keys) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * @param {string} base
 * @param {string} head
 * @returns {string[] | null}
 */
function changedFiles(base, head) {
  try {
    const output = execFileSync(
      'git',
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        `${base}...${head}`,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    return parseNameList(output);
  } catch {
    return null;
  }
}

/** @returns {import('./lib/ci-classify.mjs').Classification} */
function classifyFromGitHub() {
  const event = process.env['GITHUB_EVENT_NAME'] ?? '';
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  /** @type {unknown} */
  const payload = eventPath === undefined ? {} : JSON.parse(readFileSync(eventPath, 'utf8'));
  const fullRequested = process.env['CI_FULL_REQUESTED'] === 'true';
  const ref = process.env['GITHUB_REF'] ?? '';

  if (event !== 'pull_request') {
    return classify({ event, files: null, ref, fullRequested });
  }
  const base = dig(payload, ['pull_request', 'base', 'sha']);
  const head = dig(payload, ['pull_request', 'head', 'sha']);
  const draft = dig(payload, ['pull_request', 'draft']);
  const labels = dig(payload, ['pull_request', 'labels']);
  const files =
    typeof base === 'string' && typeof head === 'string' ? changedFiles(base, head) : null;
  return classify({
    event,
    files,
    ref,
    fullRequested,
    ...(typeof draft === 'boolean' ? { draft } : {}),
    labels: Array.isArray(labels)
      ? labels.map((label) => dig(label, ['name'])).filter((name) => typeof name === 'string')
      : [],
  });
}

function main() {
  /** @type {import('./lib/ci-classify.mjs').Classification} */
  let result;
  if (process.argv[2] === '--files') {
    result = classifyPaths(process.argv.slice(3));
  } else {
    try {
      result = classifyFromGitHub();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { tier: 'FULL', reason: `classifier error: ${message}` };
    }
  }
  const linuxNode = JSON.stringify(LINUX_NODE_VERSIONS[result.tier]);
  process.stdout.write(`tier=${result.tier}\nreason=${result.reason}\nlinux-node=${linuxNode}\n`);
  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') {
    appendFileSync(output, `tier=${result.tier}\nlinux-node=${linuxNode}\n`);
  }
}

main();
