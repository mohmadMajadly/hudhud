#!/usr/bin/env node
// CI tier classifier entry point (ADR-0014). Reads the GitHub Actions
// context, computes the changed files (scripts/lib/ci-diff.mjs: a pull
// request from the merge commit GitHub tests, checked out at depth 2; a push
// to main from `before..after`, the workflow fetches `before` at depth 1) and
// writes `tier` and `linux-node` to $GITHUB_OUTPUT. A change set that cannot
// be computed is reported as a warning naming its cause; any error yields
// FULL.
//
// Local use: node scripts/ci-classify.mjs --files <path>...

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { LINUX_NODE_VERSIONS, classify, classifyPaths } from './lib/ci-classify.mjs';
import { pullRequestChanges, pushChanges } from './lib/ci-diff.mjs';

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

/** @type {import('./lib/ci-diff.mjs').Git} */
function git(args) {
  return execFileSync('git', [...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * @param {import('./lib/ci-diff.mjs').ChangeSet} changes
 * @returns {string[] | null}
 */
function filesOf(changes) {
  if (changes.problem !== undefined) {
    process.stdout.write(`::warning::changed files unknown: ${changes.problem}\n`);
  }
  return changes.files;
}

/** @returns {import('./lib/ci-classify.mjs').Classification} */
function classifyFromGitHub() {
  const event = process.env['GITHUB_EVENT_NAME'] ?? '';
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  /** @type {unknown} */
  const payload = eventPath === undefined ? {} : JSON.parse(readFileSync(eventPath, 'utf8'));
  const fullRequested = process.env['CI_FULL_REQUESTED'] === 'true';
  const ref = process.env['GITHUB_REF'] ?? '';
  const sha = process.env['GITHUB_SHA'];

  if (event === 'push') {
    // Only a push to main is classified by its change set; tags and any
    // other ref are FULL whatever they change.
    const files =
      ref === 'refs/heads/main'
        ? filesOf(pushChanges(git, dig(payload, ['before']), sha ?? dig(payload, ['after'])))
        : null;
    return classify({ event, files, ref, fullRequested });
  }
  if (event !== 'pull_request') {
    return classify({ event, files: null, ref, fullRequested });
  }
  const draft = dig(payload, ['pull_request', 'draft']);
  const labels = dig(payload, ['pull_request', 'labels']);
  const head = dig(payload, ['pull_request', 'head', 'sha']);
  const files = filesOf(pullRequestChanges(git, sha, head));
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
