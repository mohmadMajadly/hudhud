#!/usr/bin/env node
// The steps of .github/workflows/release.yml that are not the tarball check
// (ADR-0014 amendment 12; logic and tests: scripts/lib/release.mjs,
// scripts/test/release*.test.ts).
//
//   node scripts/release.mjs publish --tarballs <dir> --tag v<version> [--dry-run]
//
// publishes the tarballs release-verify checked (`check-tarball.mjs
// --release-tag … --keep-tarballs <dir>`), in the order of PUBLISH_ORDER:
// the platform package, the core, the adapter, the conformance data, the
// umbrella. It first checks
// that the tarballs are exactly those packages and that the fixed group is
// at the tag's version, then asks the registry which versions it already
// holds: a version that is there with the same bytes (npm integrity) is
// skipped, so a re-run after a partial publish continues where it stopped; a
// tag version that is there with other bytes stops the release before
// anything is published. Each publish is `npm publish <tarball> --access
// public --tag latest|next --provenance` through the npm next to the running
// Node (the pinned npm the job installed). The first failure stops the step;
// the job summary lists every package and, after a partial publish, the
// exact recovery steps. A real publish runs only on a tag in GitHub Actions
// with an OIDC token (npm trusted publishing) and refuses any npm token in
// its environment; the npm configuration files are empty ones. `--dry-run`
// runs everything with `npm publish --dry-run` instead (provenance off: a
// dry run cannot sign) and publishes nothing.
//
//   node scripts/release.mjs gate --tag v<version> [--report-only]
//
// requires the tagged commit (`GITHUB_SHA`) to be on main and its ci.yml
// push run on main to have passed (GitHub REST API, `GITHUB_TOKEN` with
// `actions: read` and `contents: read`). With `--report-only` (dry runs) the
// verdict is printed as a notice and the exit code is 0.
//
//   node scripts/release.mjs simulate-version
//
// the version PR of a dry run, in the working copy only (never on a tag):
// `changeset version` (skipped when no changeset is left: the version PR's own
// branch), and, when the committed release record is not the
// record of the addon version that gives, a record for that version with the
// same builds plus the digest table written from it (`write-digests.mjs
// --from-manifest`). It prints the tag the version PR's commit would get and
// writes `tag=v<version>` to `GITHUB_OUTPUT` when set. Nothing is committed.
//
//   node scripts/release.mjs install-npm [--file <npm tarball>]
//
// installs the npm CLI of `NPM_VERSION` globally (next to the running Node)
// from its registry tarball (or the given file), only after its sha512
// equals `NPM_INTEGRITY`, then requires `npm --version` to report it.
//
// Exit codes: 0 done, 1 refused or failed (the reason is printed), 2 usage
// or setup error.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  DIGESTS_MODULE,
  parseDigestsModule,
  parseManifest,
  releaseOf,
} from './lib/addon-digests.mjs';
import {
  gateProblems,
  integrityOf,
  isolatedNpmEnv,
  orderTarballs,
  packumentUrl,
  parsePackument,
  planPublish,
  publishArgs,
  renderSummary,
  shallowProblem,
  simulatedRecord,
} from './lib/release.mjs';
import { manifestOf, pendingChangesets, readTarGz } from './lib/tarball.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const TIMEOUT_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const X64_DIR = 'packages/win32-job-x64';

const USAGE = [
  'usage: node scripts/release.mjs publish --tarballs <dir> --tag v<version> [--dry-run]',
  '       node scripts/release.mjs gate --tag v<version> [--report-only]',
  '       node scripts/release.mjs simulate-version',
  '       node scripts/release.mjs install-npm [--file <npm tarball>]',
  '',
].join('\n');

/** A usage or setup error (exit code 2). */
class SetupError extends Error {}

/**
 * Parses `--flag value` pairs and bare switches.
 *
 * @param {readonly string[]} args
 * @param {readonly string[]} valued
 * @param {readonly string[]} switches
 * @returns {Map<string, string | true>}
 */
function parseFlags(args, valued, switches) {
  /** @type {Map<string, string | true>} */
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (flags.has(arg)) throw new SetupError(`${arg} given twice`);
    if (switches.includes(arg)) {
      flags.set(arg, true);
    } else if (valued.includes(arg) && index + 1 < args.length) {
      flags.set(arg, String(args[index + 1]));
      index += 1;
    } else {
      throw new SetupError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  return flags;
}

/**
 * @param {Map<string, string | true>} flags
 * @param {string} name
 * @returns {string}
 */
function required(flags, name) {
  const value = flags.get(name);
  if (typeof value !== 'string') throw new SetupError(`${name} is required`);
  return value;
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  return JSON.parse(readFileSync(path.join(REPO, file), 'utf8'));
}

/**
 * One field of a JSON file of the repository.
 *
 * @param {string} file
 * @param {string} key
 * @returns {unknown}
 */
function jsonField(file, key) {
  const value = readJson(file);
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * The changesets `fixed` group (one group, ADR-0004).
 *
 * @returns {string[]}
 */
function fixedGroup() {
  /** @type {unknown} */
  const fixed = jsonField('.changeset/config.json', 'fixed');
  /** @type {unknown} */
  const group = Array.isArray(fixed) && fixed.length === 1 ? fixed[0] : undefined;
  if (!Array.isArray(group) || !group.every((name) => typeof name === 'string')) {
    throw new SetupError('.changeset/config.json must have exactly one fixed group of names');
  }
  return /** @type {string[]} */ (group);
}

/**
 * Appends to the job summary when there is one, and prints it.
 *
 * @param {string} markdown
 * @returns {void}
 */
function summary(markdown) {
  process.stdout.write(markdown);
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (file !== undefined && file !== '') appendFileSync(file, markdown);
}

/**
 * The npm CLI next to the running Node.js: the pinned npm the publish job
 * installed globally replaces the bundled one there.
 *
 * @returns {string}
 */
function npmCli() {
  const bin = path.dirname(process.execPath);
  const found = [
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => existsSync(candidate));
  if (found === undefined) throw new SetupError(`npm is not installed next to ${process.execPath}`);
  return found;
}

/**
 * Writes the two empty npm configuration files into `dir` and returns the
 * environment that makes npm use them (`isolatedNpmEnv`): no ambient
 * `.npmrc` reaches an install or a publish.
 *
 * @param {string} dir
 * @returns {NodeJS.ProcessEnv}
 */
function emptyNpmConfig(dir) {
  const { env, files } = isolatedNpmEnv(process.env, dir);
  for (const file of files) writeFileSync(file, '');
  return env;
}

/** Environment variables that would let npm publish with a token instead of OIDC. */
const TOKEN_VARIABLE = /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|npm_config_.*(?:auth|token).*)$/iu;

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
async function publish(argv) {
  const flags = parseFlags(argv, ['--tarballs', '--tag'], ['--dry-run']);
  const dir = path.resolve(required(flags, '--tarballs'));
  const tag = required(flags, '--tag');
  const dryRun = flags.get('--dry-run') === true;
  if (!dryRun) {
    const env = process.env;
    if (
      env['GITHUB_ACTIONS'] !== 'true' ||
      env['GITHUB_REF_TYPE'] !== 'tag' ||
      env['GITHUB_REF_NAME'] !== tag ||
      (env['ACTIONS_ID_TOKEN_REQUEST_URL'] ?? '') === ''
    ) {
      throw new SetupError(
        `a real publish runs only in the release workflow on the tag ${tag} with an OIDC token (id-token: write); use --dry-run anywhere else`,
      );
    }
    const tokens = Object.keys(env).filter((key) => TOKEN_VARIABLE.test(key));
    if (tokens.length > 0) {
      throw new SetupError(
        `npm trusted publishing only: unset ${tokens.join(', ')} (no npm token may reach a publish)`,
      );
    }
  }

  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    throw new SetupError(
      `cannot read ${dir} (${String(/** @type {{ code?: unknown }} */ (error).code ?? error)})`,
    );
  }
  const tarballs = names.map((name) => {
    const file = path.join(dir, name);
    const bytes = readFileSync(file);
    /** @type {import('./lib/tarball.mjs').PackageJson | undefined} */
    let manifest;
    try {
      manifest = name.endsWith('.tgz') ? manifestOf(readTarGz(bytes)) : undefined;
    } catch {
      manifest = undefined;
    }
    return {
      file,
      name: typeof manifest?.name === 'string' ? manifest.name : undefined,
      version: typeof manifest?.version === 'string' ? manifest.version : undefined,
      integrity: integrityOf(bytes),
    };
  });
  const { ordered, problems } = orderTarballs({ tag, fixed: fixedGroup(), tarballs });
  /** @type {Map<string, import('./lib/release.mjs').StepResult>} */
  const results = new Map();
  if (problems.length > 0) {
    summary(renderSummary({ tag, dryRun, steps: [], results, problems, warnings: [] }));
    return 1;
  }

  /** @type {Map<string, import('./lib/release.mjs').RegistryState>} */
  const registry = new Map();
  for (const tarball of ordered) {
    /** @type {Response} */
    let response;
    try {
      response = await fetch(packumentUrl(tarball.name), {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      problems.push(`${tarball.name}: the registry could not be read (${String(error)})`);
      continue;
    }
    const state = parsePackument(response.status, await response.text(), tarball.version);
    if (typeof state === 'string') {
      problems.push(`${tarball.name}: ${state}`);
    } else {
      registry.set(tarball.name, state);
      process.stdout.write(
        `${tarball.name}@${tarball.version}: ${state.kind === 'absent' ? 'not on the registry' : `on the registry (${String(state.integrity)})`}; this release ${tarball.integrity}\n`,
      );
    }
  }
  const plan = planPublish({ tag, ordered, registry });
  problems.push(...plan.problems);
  for (const warning of plan.warnings) process.stdout.write(`::warning::${warning}\n`);
  if (problems.length > 0) {
    summary(
      renderSummary({ tag, dryRun, steps: plan.steps, results, problems, warnings: plan.warnings }),
    );
    return 1;
  }

  const npm = npmCli();
  const config = mkdtempSync(path.join(process.env['RUNNER_TEMP'] ?? os.tmpdir(), 'hudhud-npmrc-'));
  const env = emptyNpmConfig(config);
  try {
    runPublish(npm, env, config, plan.steps, dryRun, results, problems);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
  summary(
    renderSummary({ tag, dryRun, steps: plan.steps, results, problems, warnings: plan.warnings }),
  );
  return problems.length > 0 ? 1 : 0;
}

/**
 * Publishes the steps in order and stops at the first failure.
 *
 * @param {string} npm The npm CLI script.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd A directory without npm configuration.
 * @param {readonly import('./lib/release.mjs').PublishStep[]} steps
 * @param {boolean} dryRun
 * @param {Map<string, import('./lib/release.mjs').StepResult>} results Filled in.
 * @param {string[]} problems Appended to.
 * @returns {void}
 */
function runPublish(npm, env, cwd, steps, dryRun, results, problems) {
  const version = spawnSync(process.execPath, [npm, '--version'], { encoding: 'utf8', env, cwd });
  process.stdout.write(`npm ${version.stdout.trim()} (${npm})\n`);
  for (const step of steps) {
    if (step.action === 'skip') {
      results.set(step.name, 'skipped');
      process.stdout.write(`skip ${step.name}@${step.version}: ${step.note}\n`);
      continue;
    }
    const args = publishArgs({ file: step.file, version: step.version, dryRun });
    process.stdout.write(`npm ${args.join(' ')}\n`);
    const result = spawnSync(process.execPath, [npm, ...args], {
      cwd,
      env,
      stdio: 'inherit',
      timeout: TIMEOUT_MS,
    });
    if (result.status !== 0) {
      results.set(step.name, 'failed');
      problems.push(
        `npm publish of ${step.name}@${step.version} failed (${result.error === undefined ? `exit code ${String(result.status)}` : String(result.error)})`,
      );
      return;
    }
    results.set(step.name, dryRun ? 'checked (dry run)' : 'published');
  }
}

/**
 * @param {string} url
 * @param {string} token
 * @returns {Promise<unknown>}
 */
async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new SetupError(`GitHub API ${url}: HTTP ${String(response.status)}`);
  return response.json();
}

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
async function gate(argv) {
  const flags = parseFlags(argv, ['--tag'], ['--report-only']);
  const tag = required(flags, '--tag');
  const reportOnly = flags.get('--report-only') === true;
  const env = process.env;
  const sha = env['GITHUB_SHA'] ?? '';
  const repository = env['GITHUB_REPOSITORY'] ?? '';
  const token = env['GITHUB_TOKEN'] ?? '';
  const api = env['GITHUB_API_URL'] ?? 'https://api.github.com';
  if (!/^[0-9a-f]{40}$/u.test(sha) || !/^[\w.-]+\/[\w.-]+$/u.test(repository) || token === '') {
    throw new SetupError('the gate needs GITHUB_SHA, GITHUB_REPOSITORY and GITHUB_TOKEN');
  }
  const compare = await githubJson(`${api}/repos/${repository}/compare/main...${sha}`, token);
  const runs = await githubJson(
    `${api}/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=50`,
    token,
  );
  /** @type {unknown} */
  const status = Reflect.get(Object(compare), 'status');
  /** @type {unknown} */
  const list = Reflect.get(Object(runs), 'workflow_runs');
  const problems = gateProblems({
    sha,
    compareStatus: typeof status === 'string' ? status : undefined,
    runs: Array.isArray(list) ? list : [],
  });
  if (problems.length === 0) {
    process.stdout.write(
      `gate passed for ${tag}: ${sha} is on main and its ci.yml push run passed\n`,
    );
    return 0;
  }
  for (const problem of problems) {
    process.stdout.write(
      `${reportOnly ? '::notice::dry run, a tag would stop here: ' : '::error::'}${problem}\n`,
    );
  }
  return reportOnly ? 0 : 1;
}

/**
 * @param {readonly string[]} argv
 * @returns {number}
 */
function simulateVersion(argv) {
  parseFlags(argv, [], []);
  if (process.env['GITHUB_REF_TYPE'] === 'tag') {
    throw new SetupError(
      'simulate-version never runs on a tag: a release tag checks the committed versions',
    );
  }
  // On the version PR's own branch every changeset is consumed and the
  // committed versions are the ones to check; `changeset version` would exit
  // 1 there ("No unreleased changesets found", release dry run 39157797892).
  if (pendingChangesets(readdirSync(path.join(REPO, '.changeset'))).length === 0) {
    process.stdout.write(
      'no changeset left: the committed versions are the ones the version PR made\n',
    );
  } else {
    // The changelog generator reads the commit that added each changeset; in
    // a shallow clone it tries to deepen it, which needs credentials (release
    // dry run 39109685744). The version PR runs on a full clone; so must this.
    const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
    const history = shallowProblem(shallow.status, shallow.stdout);
    if (history !== null) throw new SetupError(history);
    const changeset = path.join(REPO, 'node_modules', '@changesets', 'cli', 'bin.js');
    const versioned = spawnSync(process.execPath, [changeset, 'version'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
    });
    process.stdout.write(versioned.stdout);
    if (versioned.status !== 0) {
      process.stderr.write(versioned.stderr);
      throw new SetupError(`changeset version failed (exit code ${String(versioned.status)})`);
    }
  }

  /** @type {Map<string, string>} */
  const versions = new Map();
  for (const entry of readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })) {
    const file = `packages/${entry.name}/package.json`;
    if (!entry.isDirectory() || !existsSync(path.join(REPO, file))) continue;
    versions.set(String(jsonField(file, 'name')), String(jsonField(file, 'version')));
  }
  const group = [...new Set(fixedGroup().map((name) => versions.get(name)))];
  const libraryVersion = group[0];
  if (group.length !== 1 || libraryVersion === undefined) {
    throw new SetupError(
      `the fixed group came out at versions ${group.join(', ')}, not one version`,
    );
  }
  const addonVersion = String(jsonField(`${X64_DIR}/package.json`, 'version'));

  const table = parseDigestsModule(readFileSync(path.join(REPO, DIGESTS_MODULE), 'utf8'));
  if (table === null) throw new SetupError(`${DIGESTS_MODULE} is not a generated digest table`);
  const current = releaseOf(table.manifest);
  if (current !== addonVersion) {
    const target = `native/win32-job/release/${addonVersion}/manifest.json`;
    if (releaseOf(target) === null) throw new SetupError(`${addonVersion} is not a release name`);
    if (existsSync(path.join(REPO, target))) {
      process.stdout.write(`the record ${target} exists; the table is written from it\n`);
    } else {
      const manifest = parseManifest(readFileSync(path.join(REPO, table.manifest), 'utf8'));
      if (typeof manifest === 'string') throw new SetupError(`${table.manifest}: ${manifest}`);
      const dir = path.join(REPO, path.dirname(target));
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(simulatedRecord(manifest, addonVersion))) {
        writeFileSync(path.join(dir, name), text);
      }
      process.stdout.write(
        `simulated the record ${target} from ${table.manifest} (same builds; the real record comes from addon-prebuild phase 1)\n`,
      );
    }
    const written = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'addon', 'write-digests.mjs'), '--from-manifest', target],
      { cwd: REPO, encoding: 'utf8', timeout: TIMEOUT_MS },
    );
    process.stdout.write(written.stdout);
    if (written.status !== 0) {
      process.stderr.write(written.stderr);
      throw new SetupError(`write-digests --from-manifest ${target} failed`);
    }
  }
  const tag = `v${libraryVersion}`;
  process.stdout.write(
    `simulated version PR: the fixed group at ${libraryVersion}, ${X64_DIR} at ${addonVersion}; tag ${tag}\n`,
  );
  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') appendFileSync(output, `tag=${tag}\n`);
  return 0;
}

/**
 * Installs the pinned npm globally after checking its tarball against the
 * pinned integrity.
 *
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
async function installNpm(argv) {
  const flags = parseFlags(argv, ['--file'], []);
  const version = process.env['NPM_VERSION'] ?? '';
  const integrity = process.env['NPM_INTEGRITY'] ?? '';
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) {
    throw new SetupError('install-npm needs NPM_VERSION (x.y.z) and NPM_INTEGRITY (sha512-…)');
  }
  const given = flags.get('--file');
  /** @type {Uint8Array} */
  let bytes;
  if (typeof given === 'string') {
    bytes = readFileSync(given);
  } else {
    const url = `https://registry.npmjs.org/npm/-/npm-${version}.tgz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      process.stderr.write(`release: ${url}: HTTP ${String(response.status)}\n`);
      return 1;
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const actual = integrityOf(bytes);
  if (actual !== integrity) {
    process.stderr.write(
      `release: the npm ${version} tarball is ${actual}, the pin is ${integrity}; nothing installed\n`,
    );
    return 1;
  }
  const dir = mkdtempSync(path.join(process.env['RUNNER_TEMP'] ?? os.tmpdir(), 'hudhud-npm-'));
  try {
    const file = path.join(dir, `npm-${version}.tgz`);
    writeFileSync(file, bytes);
    const env = emptyNpmConfig(dir);
    const npm = npmCli();
    const installed = spawnSync(
      process.execPath,
      [npm, 'install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', file],
      { cwd: dir, env, stdio: 'inherit', timeout: TIMEOUT_MS },
    );
    if (installed.status !== 0) {
      process.stderr.write(`release: npm install --global ${file} failed\n`);
      return 1;
    }
    const reported = spawnSync(process.execPath, [npmCli(), '--version'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    }).stdout.trim();
    if (reported !== version) {
      process.stderr.write(
        `release: npm reports ${reported} after the install, the pin is ${version}\n`,
      );
      return 1;
    }
    process.stdout.write(`npm ${version} installed (${integrity})\n`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @returns {Promise<number>} */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'install-npm') return installNpm(rest);
  if (command === 'publish') return publish(rest);
  if (command === 'gate') return gate(rest);
  if (command === 'simulate-version') return simulateVersion(rest);
  throw new SetupError(command === undefined ? 'no command' : `unknown command ${command}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof SetupError) {
    process.stderr.write(`release: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`release: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
