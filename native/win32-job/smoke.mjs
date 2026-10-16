#!/usr/bin/env node
// Native smoke test of the Windows job-object addon (plan §6.1, §6.5; run:
// node native/win32-job/smoke.mjs [--addon <path to hudhud_win32_job.node>]).
// Default addon: native/win32-job/build/x64/Release/hudhud_win32_job.node.
//
// Every tree is a `node -e` child that, once told to, starts a detached
// grandchild. Detached, the grandchild is in no job of the child's libuv and
// silently breaks away from the host's libuv job (07 §2), so it outlives its
// parent unless the addon's job holds it: the control case shows that, the
// job cases show the job ending it (05 §10, ADR-0009).
//
// Cases: exports and argument validation; the host's own pid refused
// (ERR_SELF_ASSIGN); control (no job, the grandchild
// survives its parent); create/assign/list/terminate (nesting under
// libuv's job, the grandchild inherits the job, terminate ends both);
// idempotency and ERR_JOB_CLOSED; kill on close while an unrelated child
// spawned after createJob lives (the handle is not inherited); the
// finalizer closes the job; host crash; a host whose executable is not
// named node.exe (the delay-load hook).
//
// Only processes this script spawned are ended: through their own handle,
// through a job they were assigned to, or after their pid and creation time
// were verified.
//
// Exit codes: 0 all cases passed, 1 a case failed, 2 setup error.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = import.meta.dirname;
const DEFAULT_ADDON = path.join(HERE, 'build', 'x64', 'Release', 'hudhud_win32_job.node');
const CASE_TIMEOUT_MS = 20_000;
const POLL_MS = 50;
/** OpenProcess refuses this pid with ERROR_INVALID_PARAMETER: never a real pid (not a multiple of 4). */
const NO_SUCH_PID = 0xff_ff_ff_fd;

/** Child of every tree: on a line on stdin it starts a detached grandchild and prints its pid. */
const TREE_CHILD = [
  "const { spawn } = require('node:child_process');",
  "process.stdin.once('data', () => {",
  "  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'],",
  "    { detached: true, stdio: 'ignore', windowsHide: true });",
  '  process.stdout.write(`${g.pid}\\n`);',
  '});',
  'setInterval(() => {}, 1e6);',
].join('\n');

/**
 * A helper host: loads the addon (argv[1]), creates a job, spawns a tree,
 * assigns the child, prints `{ child, grandchild }`. Mode (argv[2]) `hold`
 * keeps the job; `drop` drops the job external and runs the GC until the
 * child exited, then prints `child-exited`.
 */
const HELPER_HOST = [
  "const { spawn } = require('node:child_process');",
  'const [addonPath, mode, childScript] = process.argv.slice(1);',
  'const m = { exports: {} };',
  'process.dlopen(m, addonPath);',
  'let job = m.exports.createJob();',
  "const child = spawn(process.execPath, ['-e', childScript],",
  "  { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });",
  'm.exports.assignProcess(job, child.pid);',
  "child.on('exit', () => { process.stdout.write('child-exited\\n'); process.exit(0); });",
  "child.stdout.once('data', (d) => {",
  '  const grandchild = Number(String(d).trim());',
  '  process.stdout.write(JSON.stringify({ child: child.pid, grandchild }) + "\\n");',
  "  if (mode === 'drop') {",
  '    job = null;',
  '    const collect = () => { globalThis.gc(); setImmediate(collect); };',
  '    collect();',
  '  }',
  '});',
  "child.stdin.write('go\\n');",
  'setInterval(() => {}, 1e6);',
].join('\n');

/**
 * A host that tries to assign itself: prints the error code (or `assigned`),
 * the job's pid count, then terminates and closes the job and prints
 * `alive`. A host that had been assigned would never print `alive`.
 */
const SELF_ASSIGN_HOST = [
  'const m = { exports: {} };',
  'process.dlopen(m, process.argv[1]);',
  'const job = m.exports.createJob();',
  'try {',
  '  m.exports.assignProcess(job, process.pid);',
  "  process.stdout.write('assigned\\n');",
  '} catch (error) {',
  '  process.stdout.write(`${error.code}\\n`);',
  '}',
  'process.stdout.write(`pids=${m.exports.listPids(job).length}\\n`);',
  'm.exports.terminateJob(job, 0);',
  'm.exports.closeJob(job);',
  "process.stdout.write('alive\\n');",
].join('\n');

/** A host that loads the addon and uses it once; prints `ok`. */
const RENAMED_HOST = [
  'const m = { exports: {} };',
  'process.dlopen(m, process.argv[1]);',
  'const job = m.exports.createJob();',
  'const t = m.exports.processTimes(process.pid);',
  "if (typeof t.creationTime !== 'string') throw new Error('no creation time');",
  'm.exports.closeJob(job);',
  "process.stdout.write('ok\\n');",
].join('\n');

/** A setup problem (exit code 2). */
class SetupError extends Error {}

/** @typedef {(...args: unknown[]) => unknown} NativeFunction */

/**
 * @typedef {object} Addon
 * @property {string} version
 * @property {NativeFunction} createJob
 * @property {NativeFunction} assignProcess
 * @property {NativeFunction} terminateJob
 * @property {NativeFunction} closeJob
 * @property {NativeFunction} listPids
 * @property {NativeFunction} processTimes
 */

/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
}

/**
 * @param {unknown} value
 * @returns {value is NativeFunction}
 */
function isFunction(value) {
  return typeof value === 'function';
}

/**
 * @param {string} file
 * @returns {Addon}
 */
function loadAddon(file) {
  if (!existsSync(file)) throw new SetupError(`addon not found: ${file} (run build.mjs first)`);
  const module = { exports: /** @type {unknown} */ ({}) };
  process.dlopen(module, file);
  const exports = module.exports;
  check(typeof exports === 'object' && exports !== null, 'exports is an object');
  const names = /** @type {const} */ ([
    'createJob',
    'assignProcess',
    'terminateJob',
    'closeJob',
    'listPids',
    'processTimes',
  ]);
  /** @type {Partial<Record<(typeof names)[number], NativeFunction>>} */
  const functions = {};
  for (const name of names) {
    const value = /** @type {unknown} */ (Reflect.get(exports, name));
    check(isFunction(value), `${name} is a function`);
    functions[name] = value;
  }
  const version = /** @type {unknown} */ (Reflect.get(exports, 'version'));
  check(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version), 'version is a string');
  const keys = Object.keys(exports).sort();
  check(
    JSON.stringify(keys) === JSON.stringify([...names, 'version'].sort()),
    `exports are exactly the API (${keys.join(', ')})`,
  );
  return /** @type {Addon} */ ({ ...functions, version });
}

/**
 * @param {() => unknown} fn
 * @param {string} code
 * @param {string} [api] the Win32 API the message must name
 */
function expectThrow(fn, code, api) {
  try {
    fn();
  } catch (error) {
    const actual =
      error instanceof Error ? /** @type {unknown} */ (Reflect.get(error, 'code')) : undefined;
    check(actual === code, `error code ${String(actual)} is ${code}`);
    if (api !== undefined) {
      check(error instanceof Error && error.message.includes(api), `message names ${api}`);
    }
    return;
  }
  throw new Error(`check failed: expected ${code}, nothing was thrown`);
}

/**
 * @param {unknown} result
 * @returns {string}
 */
function creationTime(result) {
  check(typeof result === 'object' && result !== null, 'result is an object');
  const value = /** @type {unknown} */ (Reflect.get(result, 'creationTime'));
  check(typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value), 'creationTime is decimal');
  return value;
}

/**
 * @param {Addon} addon
 * @param {unknown} job
 * @returns {number[]}
 */
function listPids(addon, job) {
  const pids = addon.listPids(job);
  check(Array.isArray(pids), 'listPids returns an array');
  const list = /** @type {unknown[]} */ (pids);
  check(
    list.every((pid) => typeof pid === 'number' && Number.isInteger(pid) && pid > 0),
    'listPids returns positive integers',
  );
  return /** @type {number[]} */ (list).sort((a, b) => a - b);
}

/**
 * The process's creation time, or `null` once no process has the pid.
 *
 * @param {Addon} addon
 * @param {number} pid
 * @returns {string | null}
 */
function liveCreationTime(addon, pid) {
  try {
    return creationTime(addon.processTimes(pid));
  } catch (error) {
    const code =
      error instanceof Error ? /** @type {unknown} */ (Reflect.get(error, 'code')) : undefined;
    if (code === 'WIN32_87') return null;
    throw error;
  }
}

/**
 * True while the process with this pid and creation time runs.
 *
 * @param {Addon} addon
 * @param {{ pid: number; creationTime: string }} identity
 */
function isAlive(addon, identity) {
  return liveCreationTime(addon, identity.pid) === identity.creationTime;
}

/**
 * Waits until `condition` holds, polling; throws after the case timeout.
 *
 * @param {() => boolean} condition
 * @param {string} what
 */
async function waitFor(condition, what) {
  const deadline = Date.now() + CASE_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(POLL_MS);
  }
}

/**
 * The next line of a stream, within the case timeout.
 *
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      buffer += String(chunk);
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        finish();
        resolve(buffer.slice(0, end).trim());
      }
    };
    const onEnd = () => {
      finish();
      reject(new Error('stream ended before a line'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('timed out waiting for a line'));
    }, CASE_TIMEOUT_MS);
    const finish = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}

/** Every process this script spawned and holds a handle to. */
/** @type {Set<import('node:child_process').ChildProcess>} */
const spawned = new Set();

/** Identities (pid + creation time) of grandchildren this script caused. */
/** @type {{ pid: number; creationTime: string }[]} */
const grandchildren = [];

/**
 * @param {readonly string[]} args
 * @param {import('node:child_process').StdioOptions} stdio
 */
function spawnNode(args, stdio) {
  const child = spawn(process.execPath, args, { stdio, windowsHide: true, shell: false });
  spawned.add(child);
  child.once('exit', () => spawned.delete(child));
  return child;
}

/**
 * Resolves when the child exited; rejects after the case timeout.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`timed out waiting for pid ${String(child.pid)} to exit`));
    }, CASE_TIMEOUT_MS);
    child.once('exit', onExit);
  });
}

/**
 * Resolves when the child exited and its stdio closed (all output read);
 * rejects after the case timeout.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
function closed(child) {
  return new Promise((resolve, reject) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off('close', onClose);
      reject(new Error(`timed out waiting for pid ${String(child.pid)} to close`));
    }, CASE_TIMEOUT_MS);
    child.once('close', onClose);
  });
}

/**
 * Starts a tree; `beforeGo` runs between the spawn and the grandchild's
 * start (the assignment).
 *
 * @param {Addon} addon
 * @param {(pid: number) => void} beforeGo
 */
async function startTree(addon, beforeGo) {
  const child = spawnNode(['-e', TREE_CHILD], ['pipe', 'pipe', 'inherit']);
  const pid = child.pid;
  check(pid !== undefined, 'the child started');
  beforeGo(pid);
  const { stdin, stdout } = child;
  check(stdin !== null && stdout !== null, 'the child has pipes');
  stdin.write('go\n');
  const grandchildPid = Number(await readLine(stdout));
  check(Number.isInteger(grandchildPid) && grandchildPid > 0, 'the grandchild pid');
  const grandchild = {
    pid: grandchildPid,
    creationTime: creationTime(addon.processTimes(grandchildPid)),
  };
  grandchildren.push(grandchild);
  return { child, pid, grandchild };
}

/** @param {Addon} addon */
function caseValidation(addon) {
  expectThrow(() => addon.createJob(1), 'ERR_INVALID_ARG_COUNT');
  const job = addon.createJob();
  try {
    check(typeof job === 'object' && job !== null, 'createJob returns an external');
    expectThrow(() => addon.assignProcess(job), 'ERR_INVALID_ARG_COUNT');
    expectThrow(() => addon.assignProcess(job, 4, 4), 'ERR_INVALID_ARG_COUNT');
    expectThrow(() => addon.assignProcess({}, 4), 'ERR_INVALID_ARG_TYPE');
    expectThrow(() => addon.assignProcess(null, 4), 'ERR_INVALID_ARG_TYPE');
    expectThrow(() => addon.assignProcess(job, '4'), 'ERR_INVALID_ARG_TYPE');
    expectThrow(() => addon.assignProcess(job, 4n), 'ERR_INVALID_ARG_TYPE');
    for (const pid of [0, -1, 1.5, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectThrow(() => addon.assignProcess(job, pid), 'ERR_INVALID_ARG_VALUE');
    }
    expectThrow(() => addon.terminateJob(job), 'ERR_INVALID_ARG_COUNT');
    expectThrow(() => addon.terminateJob(job, -1), 'ERR_INVALID_ARG_VALUE');
    expectThrow(() => addon.terminateJob(job, 2 ** 32), 'ERR_INVALID_ARG_VALUE');
    expectThrow(() => addon.closeJob({}), 'ERR_INVALID_ARG_TYPE');
    expectThrow(() => addon.closeJob(job, job), 'ERR_INVALID_ARG_COUNT');
    expectThrow(() => addon.listPids(1), 'ERR_INVALID_ARG_TYPE');
    expectThrow(() => addon.processTimes('1'), 'ERR_INVALID_ARG_TYPE');
    expectThrow(() => addon.processTimes(0), 'ERR_INVALID_ARG_VALUE');
    expectThrow(() => addon.processTimes(NO_SUCH_PID), 'WIN32_87', 'OpenProcess');
    expectThrow(() => addon.assignProcess(job, NO_SUCH_PID), 'WIN32_87', 'OpenProcess');
    // The System process: refused access (no handle with these rights).
    expectThrow(() => addon.assignProcess(job, 4), 'WIN32_5', 'OpenProcess');
    check(listPids(addon, job).length === 0, 'a new job is empty');
    const own = creationTime(addon.processTimes(process.pid));
    check(own === creationTime(addon.processTimes(process.pid)), 'processTimes is stable');
  } finally {
    addon.closeJob(job);
  }
}

/**
 * The host's own pid is refused. Probed in a helper host, never in this
 * one: a host that had been assigned dies silently (exit code 0) when the
 * job is closed, so only the helper's complete output proves the refusal.
 *
 * @param {string} file
 */
async function caseSelfAssign(file) {
  const host = spawnNode(['-e', SELF_ASSIGN_HOST, file], ['ignore', 'pipe', 'inherit']);
  const { stdout } = host;
  check(stdout !== null, 'the helper host has a stdout pipe');
  let output = '';
  stdout.on('data', (/** @type {Buffer} */ chunk) => {
    output += String(chunk);
  });
  await closed(host);
  const lines = output.split('\n').filter((line) => line !== '');
  check(
    JSON.stringify(lines) === JSON.stringify(['ERR_SELF_ASSIGN', 'pids=0', 'alive']),
    `the helper refused its own pid and outlived its job (${lines.join(' | ')})`,
  );
  check(host.exitCode === 0, 'the helper exited 0');
}

/** @param {Addon} addon */
async function caseControl(addon) {
  const tree = await startTree(addon, () => undefined);
  tree.child.kill();
  await exited(tree.child);
  await delay(500);
  check(
    isAlive(addon, tree.grandchild),
    'without a job the detached grandchild survives its parent',
  );
  // Clean up: into a job of its own, by verified identity, then close it.
  const cleanup = addon.createJob();
  try {
    const assigned = creationTime(addon.assignProcess(cleanup, tree.grandchild.pid));
    check(assigned === tree.grandchild.creationTime, 'cleanup assigned the verified grandchild');
  } finally {
    addon.closeJob(cleanup);
  }
  await waitFor(() => !isAlive(addon, tree.grandchild), 'the control grandchild to end');
}

/** @param {Addon} addon */
async function caseTerminate(addon) {
  const job = addon.createJob();
  /** @type {string | undefined} */
  let assigned;
  // The child is spawned without `detached`, so libuv already put it into
  // its own job; the assignment nests the addon's job (05 §10).
  const tree = await startTree(addon, (pid) => {
    assigned = creationTime(addon.assignProcess(job, pid));
  });
  try {
    check(assigned === creationTime(addon.processTimes(tree.pid)), 'assign and processTimes agree');
    const pids = listPids(addon, job);
    const expected = [tree.pid, tree.grandchild.pid].sort((a, b) => a - b);
    check(
      JSON.stringify(pids) === JSON.stringify(expected),
      `job holds child and grandchild (${pids.join(', ')})`,
    );
    addon.terminateJob(job, 0);
    await exited(tree.child);
    check(tree.child.exitCode === 0, 'the child ended with the job exit code');
    await waitFor(() => !isAlive(addon, tree.grandchild), 'the grandchild to end');
    await waitFor(() => listPids(addon, job).length === 0, 'the job to empty');
    addon.terminateJob(job, 0);
    addon.terminateJob(job, 7);
  } finally {
    addon.closeJob(job);
  }
  addon.closeJob(job);
  expectThrow(() => addon.terminateJob(job, 0), 'ERR_JOB_CLOSED');
  expectThrow(() => addon.listPids(job), 'ERR_JOB_CLOSED');
  expectThrow(() => addon.assignProcess(job, NO_SUCH_PID), 'ERR_JOB_CLOSED');
  expectThrow(() => addon.closeJob({}), 'ERR_INVALID_ARG_TYPE');
}

/** @param {Addon} addon */
async function caseKillOnClose(addon) {
  const job = addon.createJob();
  // Spawned after createJob: an inheritable job handle would be inherited
  // by this process (libuv creates children with handle inheritance on)
  // and keep the job alive after the host closed its handle.
  const bystander = spawnNode(['-e', 'setInterval(() => {}, 1e6)'], 'ignore');
  const bystanderPid = bystander.pid;
  check(bystanderPid !== undefined, 'the bystander started');
  try {
    const tree = await startTree(addon, (pid) => {
      creationTime(addon.assignProcess(job, pid));
    });
    check(listPids(addon, job).length === 2, 'job holds the tree');
    addon.closeJob(job);
    await exited(tree.child);
    await waitFor(() => !isAlive(addon, tree.grandchild), 'the grandchild to end on close');
    check(bystander.exitCode === null, 'the bystander (not in the job) still runs');
  } finally {
    addon.closeJob(job);
    bystander.kill();
    await exited(bystander);
  }
}

/**
 * @param {Addon} addon
 * @param {string} file
 * @param {'drop' | 'crash'} mode
 */
async function caseHelperHost(addon, file, mode) {
  const args = mode === 'drop' ? ['--expose-gc'] : [];
  const host = spawnNode(
    [...args, '-e', HELPER_HOST, file, mode === 'drop' ? 'drop' : 'hold', TREE_CHILD],
    ['ignore', 'pipe', 'inherit'],
  );
  const { stdout } = host;
  check(stdout !== null, 'the helper host has a stdout pipe');
  const report = /** @type {unknown} */ (JSON.parse(await readLine(stdout)));
  check(typeof report === 'object' && report !== null, 'the helper reported');
  const childPid = /** @type {unknown} */ (Reflect.get(report, 'child'));
  const grandchildPid = /** @type {unknown} */ (Reflect.get(report, 'grandchild'));
  check(typeof childPid === 'number' && typeof grandchildPid === 'number', 'helper pids');
  const child = { pid: childPid, creationTime: creationTime(addon.processTimes(childPid)) };
  const grandchild = {
    pid: grandchildPid,
    creationTime: creationTime(addon.processTimes(grandchildPid)),
  };
  grandchildren.push(child, grandchild);
  if (mode === 'drop') {
    check((await readLine(stdout)) === 'child-exited', 'the finalizer closed the job');
  } else {
    host.kill();
  }
  await exited(host);
  await waitFor(() => !isAlive(addon, child), 'the helper child to end');
  await waitFor(() => !isAlive(addon, grandchild), 'the helper grandchild to end');
}

/** @param {string} file */
async function caseRenamedHost(file) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hudhud-a1-host-'));
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  try {
    const host = path.join(dir, 'hudhud-host.exe');
    copyFileSync(process.execPath, host);
    const started = spawn(host, ['-e', RENAMED_HOST, file], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
      shell: false,
    });
    child = started;
    spawned.add(started);
    started.once('exit', () => spawned.delete(started));
    let line;
    try {
      line = await readLine(started.stdout);
    } catch (error) {
      await exited(started);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `the renamed host gave no line (${reason}; exit code ${String(started.exitCode)})`,
        { cause: error },
      );
    }
    check(line === 'ok', 'the addon works in a host not named node.exe');
    await exited(started);
    check(started.exitCode === 0, 'the renamed host exited 0');
  } finally {
    // The executable cannot be removed while it runs.
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited(child);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Ends what a failed case left: spawned processes through their handle,
 * grandchildren after their identity was verified.
 *
 * @param {Addon} addon
 */
async function cleanup(addon) {
  for (const child of spawned) child.kill();
  const survivors = grandchildren.filter((identity) => isAlive(addon, identity));
  if (survivors.length === 0) return;
  const job = addon.createJob();
  try {
    for (const identity of survivors) {
      if (!isAlive(addon, identity)) continue;
      const assigned = creationTime(addon.assignProcess(job, identity.pid));
      check(assigned === identity.creationTime, `cleanup assigned ${String(identity.pid)}`);
    }
  } finally {
    addon.closeJob(job);
  }
  await waitFor(() => survivors.every((identity) => !isAlive(addon, identity)), 'cleanup');
}

async function main() {
  if (process.platform !== 'win32') throw new SetupError('the addon runs on Windows only');
  const argv = process.argv.slice(2);
  let file = DEFAULT_ADDON;
  if (argv.length === 2 && argv[0] === '--addon' && argv[1] !== undefined)
    file = path.resolve(argv[1]);
  else if (argv.length !== 0) throw new SetupError('usage: smoke.mjs [--addon <path>]');

  const addon = loadAddon(file);
  process.stdout.write(`addon ${file}\nversion ${addon.version}\n`);
  /** @type {[string, () => unknown][]} */
  const cases = [
    [
      'validation and errors',
      () => {
        caseValidation(addon);
      },
    ],
    ['the host refuses to assign itself (ERR_SELF_ASSIGN)', () => caseSelfAssign(file)],
    ['control: no job, the grandchild survives', () => caseControl(addon)],
    ['create/assign/list/terminate, idempotency, ERR_JOB_CLOSED', () => caseTerminate(addon)],
    ['kill on close, handle not inherited', () => caseKillOnClose(addon)],
    ['finalizer closes the job', () => caseHelperHost(addon, file, 'drop')],
    ['host crash ends the tree', () => caseHelperHost(addon, file, 'crash')],
    ['host not named node.exe (delay-load hook)', () => caseRenamedHost(file)],
  ];
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(
        `FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await cleanup(addon);
  }
  process.stdout.write(
    failed === 0 ? 'smoke: all cases passed\n' : `smoke: ${String(failed)} failed\n`,
  );
  return failed === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof SetupError)) throw error;
  process.stderr.write(`smoke.mjs: ${error.message}\n`);
  process.exitCode = 2;
}
