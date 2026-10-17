#!/usr/bin/env node
// Windows probe (review R2-4 / R2-U1, FX-B; checklist 1.11): why does a
// short Windows PowerShell 5.1 run that calls an auto-loaded cmdlet
// (`Get-CimInstance`) take tens of seconds in an environment shaped like the
// integration sandbox (fresh `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`; no
// `PSModulePath`) on the windows-2025 image? Run on demand by
// `.github/workflows/timing.yml` (job `probe`).
//
// Every run reports, besides its wall time, three phases measured inside
// PowerShell: `ready` (process start to the first statement: the engine's
// own start-up), `lookup` (`Get-Command Get-CimInstance`: command discovery,
// the module analysis) and `call` (the CIM query itself). Variants, each run
// in its own fresh profile directories:
// - `sandbox`: the sandbox shape as is;
// - `pshome-only`: plus `PSModulePath=<PSHOME>\Modules`;
// - `import`: the sandbox shape, `Import-Module CimCmdlets` instead of the
//   lookup (no command discovery);
// - `host-localappdata`: the sandbox shape with the runner's own
//   `LOCALAPPDATA` (its analysis cache) and nothing else of its profile;
// - `warm-cache`: the sandbox shape plus `PSModuleAnalysisCachePath` naming a
//   cache file one long-lived PowerShell wrote first (in its own fresh profile);
// - `host`: the runner's own environment, for reference.
// It also lists the module directories of `<ProgramFiles>\WindowsPowerShell\Modules`.
//
//   node scripts/probe/powershell-module-cache.mjs <scratch-dir>
//
// Prints one JSON line per run and a summary table; appends the table to
// $GITHUB_STEP_SUMMARY when set. Exit codes: 0 measured, 1 a run failed, 2
// usage or not Windows. It starts only powershell.exe children, each bounded
// by a timeout.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const RUNS = 3;
const SYSTEM_ROOT = process.env['SystemRoot'] ?? 'C:\\Windows';
const SYSTEM32 = path.win32.join(SYSTEM_ROOT, 'System32');
const PSHOME = path.win32.join(SYSTEM32, 'WindowsPowerShell', 'v1.0');
const POWERSHELL = path.win32.join(PSHOME, 'powershell.exe');
/** How long the warming PowerShell lives (the reviewer saw a cache written after 20 s). */
const WARM_SECONDS = 30;

/** The PowerShell script of a run: phases in milliseconds, then `ok`. */
function script(/** @type {'lookup' | 'import'} */ mode, /** @type {number} */ linger = 0) {
  const discover =
    mode === 'lookup' ? '$null = Get-Command Get-CimInstance' : 'Import-Module CimCmdlets';
  return [
    '$ready = [int]([DateTime]::Now - [Diagnostics.Process]::GetCurrentProcess().StartTime).TotalMilliseconds',
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    discover,
    '$lookup = $sw.ElapsedMilliseconds',
    '$sw.Restart()',
    '$null = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"',
    '$call = $sw.ElapsedMilliseconds',
    linger > 0 ? `Start-Sleep -Seconds ${String(linger)}` : '',
    '"ok|$ready|$lookup|$call"',
  ]
    .filter((line) => line !== '')
    .join('; ');
}

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
 * @param {string} command
 */
function run(variant, env, command) {
  const started = performance.now();
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
  });
  const ms = Math.round(performance.now() - started);
  const [ok, ready, lookup, call] = result.stdout.trim().split('|');
  return {
    variant,
    ms,
    ready: Number(ready),
    lookup: Number(lookup),
    call: Number(call),
    ok: result.status === 0 && ok === 'ok',
    status: result.status,
  };
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

  // The warm cache: one PowerShell that lives WARM_SECONDS in its own fresh profile.
  const cacheFile = path.win32.join(mkdtempSync(path.win32.join(scratch, 'cache-')), 'analysis');
  const warm = run(
    'warming',
    { ...sandboxEnv(scratch), PSModuleAnalysisCachePath: cacheFile },
    script('lookup', WARM_SECONDS),
  );
  const cacheBytes = existsSync(cacheFile) ? statSync(cacheFile).size : 0;
  process.stdout.write(`${JSON.stringify({ ...warm, cacheBytes })}\n`);

  const hostLocal = process.env['LOCALAPPDATA'] ?? '';
  /** @type {Record<string, () => [Readonly<Record<string, string | undefined>>, string]>} */
  const variants = {
    sandbox: () => [sandboxEnv(scratch), script('lookup')],
    'pshome-only': () => [
      { ...sandboxEnv(scratch), PSModulePath: path.win32.join(PSHOME, 'Modules') },
      script('lookup'),
    ],
    import: () => [sandboxEnv(scratch), script('import')],
    'host-localappdata': () => [
      { ...sandboxEnv(scratch), LOCALAPPDATA: hostLocal },
      script('lookup'),
    ],
    'warm-cache': () => [
      { ...sandboxEnv(scratch), PSModuleAnalysisCachePath: cacheFile },
      script('lookup'),
    ],
    host: () => [process.env, script('lookup')],
  };
  /** @type {ReturnType<typeof run>[]} */
  const results = [warm];
  for (const [variant, make] of Object.entries(variants)) {
    for (let i = 0; i < RUNS; i++) {
      const [env, command] = make();
      const result = run(variant, env, command);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      results.push(result);
    }
  }
  const rows = ['warming', ...Object.keys(variants)].map((variant) => {
    const of = results.filter((result) => result.variant === variant);
    const cell = (/** @type {'ms' | 'ready' | 'lookup' | 'call'} */ key) =>
      of.map((result) => String(result[key])).join(', ');
    return `| ${variant} | ${cell('ms')} | ${cell('ready')} | ${cell('lookup')} | ${cell('call')} |`;
  });
  const table = [
    '| variant | wall ms | ready ms | lookup ms | call ms |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
  process.stdout.write(`${table}\nwarm cache bytes: ${String(cacheBytes)}\n`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') {
    appendFileSync(
      summary,
      `## Windows PowerShell cmdlet lookup, cold profile (R2-4)\n\n${table}\n\nWarm cache bytes: ${String(cacheBytes)}\n\nModules in Program Files: ${modules.join(', ')}\n`,
      'utf8',
    );
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

process.exitCode = main();
