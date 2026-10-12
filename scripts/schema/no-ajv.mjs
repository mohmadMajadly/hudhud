#!/usr/bin/env node
// check:no-ajv — fails when any built file under packages/*/dist imports
// Ajv, or when there is no built output to scan (ADR-0005 §4).
//
//   node scripts/schema/no-ajv.mjs [--root <dir>]
//
// Run after the build. Exit codes: 0 clean, 1 an Ajv import or nothing to
// scan, 2 usage error.

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { scanBuiltOutput } from '../lib/schema/no-ajv.mjs';

const args = process.argv.slice(2);
let root = fileURLToPath(new URL('../..', import.meta.url));
if (args.length === 2 && args[0] === '--root' && args[1] !== undefined) root = args[1];
else if (args.length > 0) {
  process.stderr.write('usage: node scripts/schema/no-ajv.mjs [--root <dir>]\n');
  process.exit(2);
}

const { scanned, imports } = scanBuiltOutput(root);
if (scanned === 0) {
  process.stderr.write(
    'check:no-ajv: FAILED (no built output under packages/*/dist; build first)\n',
  );
  process.exitCode = 1;
} else if (imports.length > 0) {
  process.stderr.write(
    `check:no-ajv: FAILED\n${imports.map((i) => `  - ${i.file}: imports ${i.specifier}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`check:no-ajv: ${String(scanned)} built files, no Ajv import\n`);
}
