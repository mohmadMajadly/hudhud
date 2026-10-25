#!/usr/bin/env node
// The pinned Windows SDK of the job addon's release build (ADR-0014
// amendment 14):
//
//   node scripts/addon/toolchain.mjs provision-sdk --downloads <dir> --out <dir>
//
// What it does and refuses: scripts/lib/addon-pin.mjs (logic,
// covered by scripts/test/addon-pin.test.ts). Downloads come only from the
// URLs in native/win32-job/toolchain-pin.json and are checked against its
// sha256 before anything runs. Windows only.
//
// Exit codes: 0 done, 1 refused, 2 usage error.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { parsePinArgs, PinUsageError, runPin } from '../lib/addon-pin.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** @param {string} name */
function envDir(name) {
  const value = process.env[name];
  if (value === undefined || !path.win32.isAbsolute(value))
    throw new PinUsageError(`%${name}% is not set`);
  return value;
}

try {
  if (process.platform !== 'win32') throw new PinUsageError('the addon toolchain is Windows only');
  const options = parsePinArgs(process.argv.slice(2));
  process.exitCode = await runPin(options, {
    root: ROOT,
    systemRoot: envDir('SystemRoot'),
    exists: (file) => existsSync(file),
    readFile: (file) => readFileSync(file),
    writeFile: (file, data) => {
      writeFileSync(file, data);
    },
    makeDir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    removeFile: (file) => {
      rmSync(file, { force: true });
    },
    hashFile: async (file) => {
      const hash = createHash('sha256');
      let size = 0;
      const stream = /** @type {AsyncIterable<Buffer>} */ (createReadStream(file));
      for await (const chunk of stream) {
        hash.update(chunk);
        size += chunk.length;
      }
      return { size, sha256: hash.digest('hex') };
    },
    download: async (url, file) => {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (!response.ok || response.body === null)
        throw new Error(`HTTP ${String(response.status)}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
    },
    run: (file, args, timeoutMs) => {
      const result = spawnSync(file, args, {
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      return {
        status: result.status,
        ...(result.error === undefined ? {} : { error: result.error.message }),
      };
    },
    log: (line) => {
      process.stdout.write(`${line}\n`);
    },
    error: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
} catch (error) {
  if (!(error instanceof PinUsageError)) throw error;
  process.stderr.write(`toolchain: ${error.message}\n`);
  process.exitCode = 2;
}
