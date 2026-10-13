#!/usr/bin/env node
// The macOS gate harness (plan §5.4 M1, ADR-0014 "macOS gate list"). Thin host
// wrapper: it binds Node.js built-ins to the GateHost interface and contains
// no decisions; the procedures and their unit tests live in src/ and test/
// (src/main.ts documents the options and the output files).
//
// Run only by .github/workflows/macos-gate.yml on a macOS runner, as an
// esbuild bundle (src/ is TypeScript):
//   pnpm exec esbuild tooling/macos-gate/bin/macos-gate.mjs --bundle \
//     --platform=node --format=esm --outfile=<tmp>/macos-gate.mjs
//   node <tmp>/macos-gate.mjs --out <dir> --expect-arch arm64
//
// It downloads the pinned darwin CLI binaries from registry.npmjs.org (never
// redistributed, ADR-0015), runs them only inside the sandbox of
// src/sandbox.ts against the in-process mock, and kills every process it
// started by verified identity before it exits.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { startMockServer } from '../../test-support/src/mock/server.js';
import { prepareBinaries } from '../src/items/provenance.js';
import { parseGateArgs, runGate, USAGE } from '../src/main.js';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function errnoCode(error) {
  /** @type {unknown} */
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** @type {import('../src/host.js').GateHost['run']} */
function run(file, args, options) {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], {
      env: options.env,
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const out = [];
    let outBytes = 0;
    let err = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      outBytes += chunk.byteLength;
      if (outBytes <= MAX_CAPTURE_BYTES) out.push(chunk);
    });
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      if (err.length < MAX_STDERR_CHARS) err += chunk.toString('utf8');
    });
    /**
     * @param {number | null} code
     * @param {string | null} signal
     * @param {string | undefined} error
     */
    const settle = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr: err.slice(0, MAX_STDERR_CHARS),
        error: error ?? (timedOut ? 'ETIMEDOUT' : undefined),
      });
    };
    child.on('error', (error) => {
      settle(null, null, errnoCode(error) ?? 'spawn-error');
    });
    child.on('close', (code, signal) => {
      settle(code, signal, undefined);
    });
  });
}

/** @type {import('../src/host.js').GateHost['spawn']} */
function spawnChild(file, args, options) {
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {
    // EPIPE after the CLI exited; the exit is reported through `exited`.
  });
  /** @type {Promise<import('../src/host.js').ChildExit>} */
  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      resolve({ code: null, signal: null, error: errnoCode(error) ?? 'spawn-error' });
    });
    // `exit`, not `close`: a surviving grandchild may hold stdout open.
    child.once('exit', (code, signal) => {
      resolve({ code, signal, error: undefined });
    });
  });
  return {
    pid: child.pid,
    write: (text) => {
      if (child.stdin.writable) child.stdin.write(text);
    },
    endInput: () => {
      child.stdin.end();
    },
    onStdout: (listener) => {
      child.stdout.on('data', listener);
    },
    onStderr: (listener) => {
      child.stderr.on('data', listener);
    },
    exited,
  };
}

/** @type {import('../src/host.js').GateHost['signal']} */
function signal(pid, name) {
  try {
    process.kill(pid, name);
    return 'sent';
  } catch (error) {
    return errnoCode(error) === 'ESRCH' ? 'gone' : 'denied';
  }
}

/** @type {import('../src/host.js').GateFs} */
const fs = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  writeFile: (file, text) => writeFile(file, text, 'utf8'),
  appendFile: (file, text) => appendFile(file, text, 'utf8'),
  readFile: (file) => readFile(file, 'utf8'),
  copyFile: (from, to) => copyFile(from, to),
  realpath: (value) => realpath(value),
  kind: async (value) => {
    try {
      const entry = await lstat(value);
      if (entry.isFile()) return 'file';
      if (entry.isDirectory()) return 'directory';
      if (entry.isSocket()) return 'socket';
      if (entry.isSymbolicLink()) return 'symlink';
      return 'other';
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return null;
      throw error;
    }
  },
  readdir: async (dir) => {
    try {
      return await readdir(dir);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return [];
      throw error;
    }
  },
  rm: (value) => rm(value, { recursive: true, force: true }),
};

/** @type {import('../src/host.js').GateHost} */
const host = {
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  user: os.userInfo().username,
  tmpdir: os.tmpdir(),
  env: process.env,
  nodeVersion: process.version,
  now: () => Date.now(),
  sleep: (ms) => delay(ms),
  uuid: () => randomUUID(),
  run,
  spawn: spawnChild,
  signal,
  fs,
  cwdFs: {
    realpath: (value) => realpath(value),
    stat: (value) => stat(value, { bigint: true }),
  },
  startMock: () => startMockServer(),
  registry: {
    fetch: (url, init) => fetch(url, init),
    documentTimeoutMs: 30_000,
    tarballTimeoutMs: 15 * 60_000,
  },
  log: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

const options = parseGateArgs(process.argv.slice(2), process.env, process.cwd());
if (typeof options === 'string') {
  process.stderr.write(`macos-gate: ${options}\n${USAGE}`);
  process.exit(2);
}
// Explicit exit: a stdio pipe still held by a process the sweep could not
// kill must not keep the harness alive (its survivor is in the report).
process.exit(await runGate(host, options, prepareBinaries));
