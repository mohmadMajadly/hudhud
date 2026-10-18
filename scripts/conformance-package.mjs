#!/usr/bin/env node
// Builds the data package @hudhudjs/conformance (run by `pnpm build` before
// tsc): replaces packages/conformance/dist/ with a byte copy of every expected
// stream of packages/claude-code/conformance and the typed index rendered for
// the package's version (scripts/lib/conformance-package.mjs). Nothing of it
// is committed.
//
// Exit codes: 0 built, 1 the fixtures were refused.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadExpected, PACKAGE_DIR } from './lib/conformance-package.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const target = path.join(ROOT, PACKAGE_DIR);

/** @type {unknown} */
const manifest = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
/** @type {unknown} */
const version =
  typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined;
if (typeof version !== 'string') {
  process.stderr.write(`conformance-package: ${PACKAGE_DIR}/package.json has no version\n`);
  process.exit(1);
}
const { files, streams, problems } = loadExpected(ROOT, version);
if (problems.length > 0) {
  process.stderr.write(`conformance-package: ${problems.join('\n')}\n`);
  process.exit(1);
}
rmSync(path.join(target, 'dist'), { recursive: true, force: true });
for (const [file, data] of files) {
  mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
  writeFileSync(path.join(target, file), data);
}
process.stdout.write(
  `conformance-package: ${String(streams.length)} streams and the index of ${version} in ${PACKAGE_DIR}/dist\n`,
);
