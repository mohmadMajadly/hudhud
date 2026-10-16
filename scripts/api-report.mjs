#!/usr/bin/env node
// Runs API Extractor for every public entry point (ADR-0017).
//
//   node scripts/api-report.mjs           check: fails when a committed report
//                                         under packages/*/api/ is out of date
//   node scripts/api-report.mjs --local   update the committed reports
//
// Also fails when an `exports` subpath has no API Extractor config, or a
// committed report has no config, so no entry point escapes review.
// Packages without an `exports` field have no entry point and are skipped,
// unless they carry API Extractor configs or reports, which then fail. JSON
// subpaths (committed schemas) are data, not API, and native addon subpaths
// (`.node`, the prebuilt platform packages) have no TypeScript API; both are
// skipped. Requires a prior `pnpm build`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATTERN = /^api-extractor(?:\.[\w-]+)?\.json$/u;

/**
 * Every leaf target string of an `exports` entry (a string or nested
 * condition objects).
 *
 * @param {unknown} target
 * @returns {string[]}
 */
function leafTargets(target) {
  if (typeof target === 'string') return [target];
  if (typeof target !== 'object' || target === null) return [];
  return Object.values(target).flatMap(leafTargets);
}

/**
 * True for a subpath that exports JSON data only, such as
 * `"./schemas/*": "./schemas/*.json"` or `"./package.json"`.
 *
 * @param {unknown} target
 * @returns {boolean}
 */
export function isJsonSubpath(target) {
  const leaves = leafTargets(target);
  return leaves.length > 0 && leaves.every((leaf) => leaf.endsWith('.json'));
}

/**
 * True for a subpath that exports a native addon only, such as
 * `"./hudhud_win32_job.node": "./hudhud_win32_job.node"`.
 *
 * @param {unknown} target
 * @returns {boolean}
 */
export function isNativeSubpath(target) {
  const leaves = leafTargets(target);
  return leaves.length > 0 && leaves.every((leaf) => leaf.endsWith('.node'));
}

/**
 * Maps an `exports` target such as `./dist/raw/index.js` to its declaration file.
 *
 * @param {unknown} target
 * @returns {string | undefined}
 */
function declarationOf(target) {
  if (typeof target !== 'object' || target === null) return undefined;
  /** @type {unknown} */
  const types = Reflect.get(target, 'types');
  return typeof types === 'string' ? types : undefined;
}

/**
 * @param {string} packageDir
 * @returns {string[] | undefined} Absolute declaration paths of every public
 *   entry point, or `undefined` when the package has no `exports` field.
 */
export function entryPoints(packageDir) {
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  /** @type {unknown} */
  const exportsField =
    typeof manifest === 'object' && manifest !== null
      ? Reflect.get(manifest, 'exports')
      : undefined;
  if (exportsField === undefined) return undefined;
  if (typeof exportsField !== 'object' || exportsField === null) {
    throw new Error(`${path.basename(packageDir)}: "exports" must be a subpath map`);
  }
  /** @type {string[]} */
  const entries = [];
  for (const [subpath, target] of Object.entries(exportsField)) {
    if (isJsonSubpath(target) || isNativeSubpath(target)) continue;
    const declaration = declarationOf(target);
    if (declaration === undefined) {
      throw new Error(`${path.basename(packageDir)}: export ${subpath} has no "types" condition`);
    }
    entries.push(path.resolve(packageDir, declaration));
  }
  return entries;
}

/**
 * @typedef {object} ReportResult
 * @property {string[]} problems
 * @property {number} checked Number of API Extractor runs.
 */

/**
 * Checks (or with `localBuild` updates) the API reports of every package
 * under `<root>/packages`.
 *
 * @param {string} root
 * @param {{ localBuild: boolean }} options
 * @returns {ReportResult}
 */
export function checkReports(root, { localBuild }) {
  const packagesDir = path.join(root, 'packages');
  /** @type {string[]} */
  const problems = [];
  let checked = 0;

  for (const name of readdirSync(packagesDir).sort()) {
    const packageDir = path.join(packagesDir, name);
    if (!existsSync(path.join(packageDir, 'package.json'))) continue;
    const configs = readdirSync(packageDir)
      .filter((f) => CONFIG_PATTERN.test(f))
      .sort();
    const apiDir = path.join(packageDir, 'api');
    const entries = entryPoints(packageDir);
    if (entries === undefined) {
      if (configs.length > 0 || existsSync(apiDir)) {
        problems.push(`${name}: API Extractor configs or reports, but no "exports" field`);
      }
      continue;
    }
    const expected = new Set(entries);
    /** @type {Set<string>} */
    const reports = new Set();

    for (const file of configs) {
      const config = ExtractorConfig.loadFileAndPrepare(path.join(packageDir, file));
      const entry = path.resolve(config.mainEntryPointFilePath);
      if (!expected.delete(entry)) {
        problems.push(
          `${name}/${file}: entry point ${path.relative(root, entry)} is not in "exports"`,
        );
      }
      for (const report of config.reportConfigs) reports.add(report.fileName);
      const result = Extractor.invoke(config, { localBuild, showVerboseMessages: false });
      checked += 1;
      if (!result.succeeded) {
        problems.push(
          `${name}/${file}: ${String(result.errorCount)} error(s), ${String(result.warningCount)} warning(s)` +
            (result.apiReportChanged
              ? '; API report changed (review it, then run `pnpm api:update`)'
              : ''),
        );
      }
    }

    for (const missing of expected) {
      problems.push(
        `${name}: exported entry point ${path.relative(root, missing)} has no API Extractor config`,
      );
    }
    if (existsSync(apiDir)) {
      for (const report of readdirSync(apiDir)) {
        if (!reports.has(report))
          problems.push(`${name}/api/${report}: report without a config (stale?)`);
      }
    }
  }
  return { problems, checked };
}

function main() {
  const localBuild = process.argv.includes('--local');
  const { problems, checked } = checkReports(ROOT, { localBuild });
  if (problems.length > 0) {
    process.stderr.write(`api-report: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(
    `api-report: ${String(checked)} entry point(s) ${localBuild ? 'updated' : 'match their reports'}\n`,
  );
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
