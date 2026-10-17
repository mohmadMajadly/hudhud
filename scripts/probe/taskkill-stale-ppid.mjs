#!/usr/bin/env node
// Windows probe (review R2-2 / R2-U2, FX-B): does `taskkill /T` follow a
// stale parent pid? Run on demand by `.github/workflows/timing.yml` (job
// `probe`) on the windows-2025 image; it is the reviewer's experiment
// (`tk-stale.mjs`, `tk-control.mjs`) made repeatable.
//
// Every process this probe touches is its own:
// - stale trial: A (node) starts C (a detached, long-lived node carrying a
//   random marker) and exits, so C's parent pid names A's dead pid. The probe
//   then starts holders (`cmd.exe /d /k`), each ended at once through its own
//   handle, until one receives A's pid (at most MAX_TRIES). The holder starts
//   after C, so C's `ppid` is stale for it: exactly the ladder's
//   `identity-foreign-child` topology. `taskkill /T /F /PID <holder>` runs;
//   the verdict is whether C survived it.
// - control trial: P (node, alive) starts D the same way; `taskkill /T /F
//   /PID <P>` must end D (it proves `/T` reaches a real detached child).
//
// C and D are ended at the end only when a fresh CIM read still shows them
// with their recorded creation time and marker (pid plus start time).
//
//   node scripts/probe/taskkill-stale-ppid.mjs [trials]
//
// Prints one JSON line per trial and a verdict; appends a summary to
// $GITHUB_STEP_SUMMARY when set. Exit codes: 0 conclusive (either verdict:
// it is a measurement), 1 a trial failed for a reason it names, 2 usage or
// not Windows, 3 inconclusive (no holder received the stale pid).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_TRIES = 20_000;
const SYSTEM_ROOT = process.env['SystemRoot'] ?? 'C:\\Windows';
const TASKKILL = path.win32.join(SYSTEM_ROOT, 'System32', 'taskkill.exe');
const POWERSHELL = path.win32.join(
  SYSTEM_ROOT,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const CMD = path.win32.join(SYSTEM_ROOT, 'System32', 'cmd.exe');

/**
 * @typedef {{ pid: number, ppid: number, created: string, commandLine: string }} Row
 * @typedef {{
 *   trial: number,
 *   kind: 'stale' | 'control',
 *   error?: string,
 *   staleTopology?: boolean,
 *   cSurvived?: boolean,
 *   dSurvived?: boolean,
 *   [detail: string]: unknown,
 * }} Trial
 */

/**
 * The CIM rows of the `node.exe` processes whose command line holds `marker`
 * (never the query's own PowerShell, whose command line holds it too), plus
 * the rows of `pids`.
 *
 * @param {string} marker
 * @param {readonly number[]} pids
 * @returns {Row[]}
 */
function cimRows(marker, pids) {
  const list = pids.map(String).join(',');
  const script = [
    `$pids = @(${list})`,
    `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*${marker}*') -or $pids -contains [int]$_.ProcessId } | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToFileTimeUtc())|$($_.CommandLine)" }`,
  ].join('; ');
  const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  return out
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [pid = '', ppid = '', created = '', ...rest] = line.split('|');
      return { pid: Number(pid), ppid: Number(ppid), created, commandLine: rest.join('|') };
    });
}

/**
 * Ends `row` when a fresh read still shows the same process (pid, creation
 * time, marker). Returns what it did.
 *
 * @param {Row} row
 * @param {string} marker
 */
function endIfSame(row, marker) {
  const now = cimRows(marker, [row.pid]).find((entry) => entry.pid === row.pid);
  if (now === undefined) return 'gone';
  if (now.created !== row.created || !now.commandLine.includes(marker)) return 'reused';
  process.kill(row.pid);
  return 'ended';
}

/** A node script that starts a detached, long-lived node carrying `marker`. */
function starter(/** @type {string} */ marker, /** @type {boolean} */ stay) {
  const child = `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},300000)','${marker}'],{detached:true,stdio:'ignore',windowsHide:true}).unref();`;
  return stay ? `${child} setTimeout(()=>{},300000);` : child;
}

/**
 * One stale-ppid trial.
 *
 * @returns {Promise<Trial>}
 */
async function staleTrial(/** @type {number} */ trial) {
  const marker = `hudhudprobe${randomBytes(8).toString('hex')}`;
  const a = spawnSync(process.execPath, ['-e', starter(marker, false)], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 30_000,
  });
  if (a.status !== 0) {
    return { trial, kind: 'stale', error: `starter failed (status ${String(a.status)})` };
  }
  const aPid = a.pid;
  const c = cimRows(marker, []).find((row) => row.commandLine.includes(marker));
  if (c === undefined) return { trial, kind: 'stale', error: 'C not found' };
  if (c.ppid !== aPid) {
    return {
      trial,
      kind: 'stale',
      error: `C's ppid ${String(c.ppid)} is not A ${String(aPid)}`,
      cleanup: endIfSame(c, marker),
    };
  }
  /** @type {import('node:child_process').ChildProcess | null} */
  let holder = null;
  let tries = 0;
  for (; tries < MAX_TRIES; tries++) {
    const h = spawn(CMD, ['/d', '/k'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    if (h.pid === aPid) {
      holder = h;
      break;
    }
    const exited = new Promise((resolve) => h.once('exit', resolve));
    h.kill();
    await exited;
  }
  if (holder === null) {
    return { trial, kind: 'stale', aPid, tries, holder: null, cleanup: endIfSame(c, marker) };
  }
  const before = cimRows(marker, [aPid]);
  const holderRow = before.find((row) => row.pid === aPid);
  const cBefore = before.find((row) => row.pid === c.pid);
  let taskkillExit = 0;
  try {
    execFileSync(TASKKILL, ['/T', '/F', '/PID', String(aPid)], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 60_000,
    });
  } catch (error) {
    taskkillExit = /** @type {{ status?: number }} */ (error).status ?? -1;
  }
  await delay(1000);
  const after = cimRows(marker, []).find((row) => row.pid === c.pid);
  const cSurvived = after?.created === c.created;
  const holderGone = holder.exitCode !== null || holder.signalCode !== null;
  if (!holderGone) holder.kill();
  return {
    trial,
    kind: 'stale',
    aPid,
    tries,
    holderCreated: holderRow?.created ?? null,
    cCreated: c.created,
    cPpidBefore: cBefore?.ppid ?? null,
    // The topology holds only when the holder started after C.
    staleTopology:
      holderRow !== undefined &&
      cBefore?.ppid === aPid &&
      BigInt(holderRow.created) > BigInt(c.created),
    taskkillExit,
    holderEnded: holderGone,
    cSurvived,
    cleanup: cSurvived ? endIfSame(c, marker) : 'gone',
  };
}

/**
 * One control trial: `/T` on a live parent ends its detached child.
 *
 * @returns {Promise<Trial>}
 */
async function controlTrial(/** @type {number} */ trial) {
  const marker = `hudhudprobe${randomBytes(8).toString('hex')}`;
  const p = spawn(process.execPath, ['-e', starter(marker, true)], {
    windowsHide: true,
    stdio: 'ignore',
  });
  /** @type {Row | undefined} */
  let d;
  for (let i = 0; i < 30 && d === undefined; i++) {
    await delay(500);
    d = cimRows(marker, []).find((row) => row.ppid === p.pid && row.commandLine.includes(marker));
  }
  if (d === undefined) {
    p.kill();
    return { trial, kind: 'control', error: 'D not found' };
  }
  let taskkillExit = 0;
  try {
    execFileSync(TASKKILL, ['/T', '/F', '/PID', String(p.pid)], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 60_000,
    });
  } catch (error) {
    taskkillExit = /** @type {{ status?: number }} */ (error).status ?? -1;
  }
  await delay(1000);
  const after = cimRows(marker, []).find((row) => row.pid === d.pid);
  const dSurvived = after?.created === d.created;
  if (p.exitCode === null && p.signalCode === null) p.kill();
  return {
    trial,
    kind: 'control',
    taskkillExit,
    dSurvived,
    cleanup: dSurvived ? endIfSame(d, marker) : 'gone',
  };
}

async function main() {
  if (process.platform !== 'win32') {
    process.stderr.write('taskkill-stale-ppid: Windows only\n');
    return 2;
  }
  const trials = Number(process.argv[2] ?? '3');
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) {
    process.stderr.write('usage: taskkill-stale-ppid [trials 1..10]\n');
    return 2;
  }
  /** @type {Trial[]} */
  const results = [];
  for (let trial = 1; trial <= trials; trial++) {
    const stale = await staleTrial(trial);
    process.stdout.write(`${JSON.stringify(stale)}\n`);
    results.push(stale);
    const control = await controlTrial(trial);
    process.stdout.write(`${JSON.stringify(control)}\n`);
    results.push(control);
  }
  const errors = results.filter((result) => result.error !== undefined);
  const conclusive = results.filter((result) => result.staleTopology === true);
  const controls = results.filter((result) => result.kind === 'control');
  const follows = conclusive.filter((result) => result.cSurvived === false).length;
  const controlOk = controls.length > 0 && controls.every((result) => result.dSurvived === false);
  let verdict;
  let code;
  if (errors.length > 0) {
    verdict = `error: ${String(errors.length)} trial(s) failed (see the JSON lines)`;
    code = 1;
  } else if (!controlOk) {
    verdict = "error: the control failed (`/T` did not end a live parent's detached child)";
    code = 1;
  } else if (conclusive.length === 0) {
    verdict = `inconclusive: no holder received the stale pid in ${String(MAX_TRIES)} tries`;
    code = 3;
  } else if (follows === 0) {
    verdict = `taskkill /T does NOT follow a stale ppid (${String(conclusive.length)} conclusive trial(s), control ok)`;
    code = 0;
  } else {
    verdict = `taskkill /T FOLLOWS a stale ppid in ${String(follows)} of ${String(conclusive.length)} conclusive trial(s)`;
    code = 0;
  }
  process.stdout.write(`verdict: ${verdict}\n`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') {
    appendFileSync(
      summary,
      `## taskkill /T and a stale parent pid (R2-2)\n\n${verdict}\n\n\`\`\`\n${results.map((result) => JSON.stringify(result)).join('\n')}\n\`\`\`\n`,
      'utf8',
    );
  }
  return code;
}

process.exitCode = await main();
