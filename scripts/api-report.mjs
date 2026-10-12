#!/usr/bin/env node
// Runs API Extractor for every public entry point (ADR-0017).
//
//   node scripts/api-report.mjs           check: fails when a committed report
//                                         under packages/*/api/ is out of date
//   node scripts/api-report.mjs --local   update the committed reports
//
// Also fails when an `exports` subpath has no API Extractor config, or a
// committed report has no config, so no entry point escapes review.
// Requires a prior `pnpm build`.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = path.join(ROOT, 'packages');
const CONFIG_PATTERN = /^api-extractor(?:\.[\w-]+)?\.json$/u;

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
 * @returns {string[]} Absolute declaration paths of every public entry point.
 */
function entryPoints(packageDir) {
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  /** @type {unknown} */
  const exportsField =
    typeof manifest === 'object' && manifest !== null
      ? Reflect.get(manifest, 'exports')
      : undefined;
  if (typeof exportsField !== 'object' || exportsField === null) return [];
  /** @type {string[]} */
  const entries = [];
  for (const [subpath, target] of Object.entries(exportsField)) {
    if (subpath === './package.json') continue;
    const declaration = declarationOf(target);
    if (declaration === undefined) {
      throw new Error(`${path.basename(packageDir)}: export ${subpath} has no "types" condition`);
    }
    entries.push(path.resolve(packageDir, declaration));
  }
  return entries;
}

function main() {
  const localBuild = process.argv.includes('--local');
  /** @type {string[]} */
  const problems = [];
  let checked = 0;

  for (const name of readdirSync(PACKAGES).sort()) {
    const packageDir = path.join(PACKAGES, name);
    if (!existsSync(path.join(packageDir, 'package.json'))) continue;
    const expected = new Set(entryPoints(packageDir));
    /** @type {Set<string>} */
    const reports = new Set();

    for (const file of readdirSync(packageDir)
      .filter((f) => CONFIG_PATTERN.test(f))
      .sort()) {
      const config = ExtractorConfig.loadFileAndPrepare(path.join(packageDir, file));
      const entry = path.resolve(config.mainEntryPointFilePath);
      if (!expected.delete(entry)) {
        problems.push(
          `${name}/${file}: entry point ${path.relative(ROOT, entry)} is not in "exports"`,
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
        `${name}: exported entry point ${path.relative(ROOT, missing)} has no API Extractor config`,
      );
    }
    const apiDir = path.join(packageDir, 'api');
    if (existsSync(apiDir)) {
      for (const report of readdirSync(apiDir)) {
        if (!reports.has(report))
          problems.push(`${name}/api/${report}: report without a config (stale?)`);
      }
    }
  }

  if (problems.length > 0) {
    process.stderr.write(`api-report: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(
    `api-report: ${String(checked)} entry point(s) ${localBuild ? 'updated' : 'match their reports'}\n`,
  );
  return 0;
}

process.exitCode = main();
