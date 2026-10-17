#!/usr/bin/env node
// Windows probe (review R2-4 / R2-U1, FX-B; checklist 1.11): how long does a
// short Windows PowerShell 5.1 run take to resolve an auto-loaded cmdlet
// (`Get-CimInstance`) in an environment shaped like the integration sandbox
// (fresh `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`; no `PSModulePath`), and
// with the integration harness's remedy (`PSModulePath` set to `$PSHOME\Modules`
// only)? Run on demand by `.github/workflows/timing.yml` (job `probe`).
//
// Each variant runs RUNS times in its own fresh profile directories:
// - `sandbox`: the sandbox shape as is (PowerShell builds its default module
//   path: Documents, Program Files, $PSHOME);
// - `pshome-only`: the same plus `PSModulePath=<SystemRoot>\System32\WindowsPowerShell\v1.0\Modules`;
// - `host`: the runner's own environment (its warm or cold cache), for reference.
// It also lists the module directories of `<ProgramFiles>\WindowsPowerShell\Modules`.
//
//   node scripts/probe/powershell-module-cache.mjs <scratch-dir>
//
// Prints one JSON line per run and a summary table; appends the table to
// $GITHUB_STEP_SUMMARY when set. Exit codes: 0 measured, 1 a run failed, 2
// usage or not Windows. It starts only powershell.exe children, each bounded
// by a timeout.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const RUNS = 3;
const SYSTEM_ROOT = process.env['SystemRoot'] ?? 'C:\\Windows';
const SYSTEM32 = path.win32.join(SYSTEM_ROOT, 'System32');
const PSHOME = path.win32.join(SYSTEM32, 'WindowsPowerShell', 'v1.0');
const POWERSHELL = path.win32.join(PSHOME, 'powershell.exe');
const COMMAND = 'Get-CimInstance Win32_Process -Filter "ProcessId=$PID" | Out-Null; \'ok\'';

/** The sandbox-shaped environment (tooling/test-support/src/launcher/env.ts) over fresh dirs. */
function sandboxEnv(/** @type {string} */ scratch) {
  const home = mkdtempSync(path.win32.join(scratch, 'home-'));
  const appData = path.win32.join(home, 'AppData', 'Roaming');
  const localAppData = path.win32.join(home, 'AppData', 'Local');
  const tmp = path.win32.join(home, 'tmp');
  for (const dir of [appData, localAppData, tmp]) mkdirSync(dir, { recursive: true });
  const homeDrive = path.win32.parse(home).root.replace(/\\$/, '');
  return {
    PATH: [SYSTEM32, SYSTEM_ROOT, PSHOME].join(';'),
    SYSTEMROOT: SYSTEM_ROOT,
    WINDIR: SYSTEM_ROOT,
    COMSPEC: path.win32.join(SYSTEM32, 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemDrive: SYSTEM_ROOT.slice(0, 2),
    HOMEDRIVE: homeDrive,
    HOMEPATH: home.slice(homeDrive.length),
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TMP: tmp,
    TEMP: tmp,
  };
}

/**
 * One timed run.
 *
 * @param {string} variant
 * @param {Readonly<Record<string, string | undefined>>} env
 */
function run(variant, env) {
  const started = performance.now();
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', COMMAND], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
  });
  const ms = Math.round(performance.now() - started);
  const ok = result.status === 0 && result.stdout.trim() === 'ok';
  return { variant, ms, ok, status: result.status, signal: result.signal };
}

function main() {
  if (process.platform !== 'win32') {
    process.stderr.write('powershell-module-cache: Windows only\n');
    return 2;
  }
  const [scratch, ...rest] = process.argv.slice(2);
  if (scratch === undefined || rest.length > 0 || !path.win32.isAbsolute(scratch)) {
    process.stderr.write('usage: powershell-module-cache <absolute scratch dir>\n');
    return 2;
  }
  mkdirSync(scratch, { recursive: true });
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  /** @type {string[]} */
  let modules;
  try {
    modules = readdirSync(path.win32.join(programFiles, 'WindowsPowerShell', 'Modules'));
  } catch {
    modules = [];
  }
  process.stdout.write(`${JSON.stringify({ programFilesModules: modules })}\n`);
  const variants = {
    sandbox: () => sandboxEnv(scratch),
    'pshome-only': () => ({
      ...sandboxEnv(scratch),
      PSModulePath: path.win32.join(PSHOME, 'Modules'),
    }),
    host: () => process.env,
  };
  /** @type {ReturnType<typeof run>[]} */
  const results = [];
  for (const [variant, env] of Object.entries(variants)) {
    for (let i = 0; i < RUNS; i++) {
      const result = run(variant, env());
      process.stdout.write(`${JSON.stringify(result)}\n`);
      results.push(result);
    }
  }
  const rows = Object.keys(variants).map((variant) => {
    const ms = results.filter((result) => result.variant === variant).map((result) => result.ms);
    return `| ${variant} | ${ms.join(', ')} |`;
  });
  const table = [
    '| variant | ms per run (a fresh profile each, sandbox variants) |',
    '| --- | --- |',
    ...rows,
  ].join('\n');
  process.stdout.write(`${table}\n`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') {
    appendFileSync(
      summary,
      `## Windows PowerShell cmdlet lookup, cold profile (R2-4)\n\n${table}\n\nModules in Program Files: ${modules.join(', ')}\n`,
      'utf8',
    );
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

process.exitCode = main();
