#!/usr/bin/env node
// Builds the Windows job-object addon (plan §6.1; run:
// node native/win32-job/build.mjs --arch x64|arm64 [--build-dir <name>]).
//
// Configures with CMake's Visual Studio generator out of the source tree in
// native/win32-job/build/<name> (gitignored; default <name> is the arch),
// deleted and recreated first so every build starts clean, builds Release
// with MSBuild warnings as errors, and prints the sha256 of the .node file.
// The build is reproducible (/Brepro): two builds give the same sha256.
//
// Tools are never taken from the working directory: CMake is the first
// cmake.exe found in an absolute PATH entry, or the HUDHUD_CMAKE absolute
// path; Visual Studio comes from vswhere at its fixed install location. The
// Node-API headers and node_api.def come from the pinned node-api-headers
// package (no download).
//
// Exit codes: 0 built, 1 build failed, 2 usage or setup error.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const HERE = import.meta.dirname;
const BUILD_ROOT = path.join(HERE, 'build');
const ADDON = 'hudhud_win32_job.node';
const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024 * 1024;

/** @type {Readonly<Record<string, { platform: string; component: string; spectre: string }>>} */
const ARCHES = Object.freeze({
  x64: {
    platform: 'x64',
    component: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    spectre: 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre',
  },
  arm64: {
    platform: 'ARM64',
    component: 'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
    spectre: 'Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre',
  },
});

/** A usage or setup error (exit code 2). */
class SetupError extends Error {}

/**
 * @param {readonly string[]} argv
 * @returns {{ arch: string; buildDir: string }}
 */
function parseArgs(argv) {
  /** @type {string | undefined} */
  let arch;
  /** @type {string | undefined} */
  let name;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new SetupError(`missing value for ${String(flag)}`);
    if (flag === '--arch') arch = value;
    else if (flag === '--build-dir') name = value;
    else throw new SetupError(`unknown argument ${String(flag)}`);
  }
  if (arch === undefined || !Object.hasOwn(ARCHES, arch)) {
    throw new SetupError('usage: build.mjs --arch x64|arm64 [--build-dir <name>]');
  }
  name ??= arch;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    throw new SetupError('--build-dir takes a name of lower-case letters, digits and dashes');
  }
  return { arch, buildDir: path.join(BUILD_ROOT, name) };
}

/**
 * Runs a tool by absolute path, without a shell; the output is printed.
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {{ capture?: boolean }} [options]
 * @returns {{ status: number | null; stdout: string }}
 */
function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) {
    throw new SetupError(`${path.basename(file)} could not run: ${result.error.message}`);
  }
  if (options.capture !== true) process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return { status: result.status, stdout: result.stdout };
}

/** @returns {string} the absolute path of cmake.exe */
function findCmake() {
  const explicit = process.env['HUDHUD_CMAKE'];
  if (explicit !== undefined && explicit !== '') {
    if (!path.win32.isAbsolute(explicit) || !existsSync(explicit)) {
      throw new SetupError('HUDHUD_CMAKE must be the absolute path of cmake.exe');
    }
    return explicit;
  }
  for (const entry of (process.env['PATH'] ?? '').split(';')) {
    if (!path.win32.isAbsolute(entry)) continue;
    const candidate = path.win32.join(entry, 'cmake.exe');
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new SetupError('cmake.exe (3.28 or newer) not found in an absolute PATH entry');
}

/**
 * CMake's "project author warnings as errors" flag: `-Werror=author` from
 * CMake 4.4 on (where `-Werror=dev` is deprecated and itself warns),
 * `-Werror=dev` before. Refuses CMake older than 3.28.
 *
 * @param {string} cmake
 * @returns {string}
 */
function authorWarningsAsErrors(cmake) {
  const { status, stdout } = run(cmake, ['--version'], { capture: true });
  const match = /^cmake version (\d+)\.(\d+)\./m.exec(stdout);
  if (status !== 0 || match === null) throw new SetupError('cmake --version gave no version');
  const version = [Number(match[1]), Number(match[2])];
  const atLeast = (/** @type {number} */ major, /** @type {number} */ minor) =>
    (version[0] ?? 0) > major || ((version[0] ?? 0) === major && (version[1] ?? 0) >= minor);
  if (!atLeast(3, 28)) throw new SetupError(`CMake 3.28 or newer is required (${match[0]})`);
  return atLeast(4, 4) ? '-Werror=author' : '-Werror=dev';
}

/**
 * The Visual Studio instance with the MSVC tools for the architecture.
 *
 * @param {{ component: string; spectre: string }} target
 * @returns {string} the installation path
 */
function findVisualStudio(target) {
  const programFiles = process.env['ProgramFiles(x86)'];
  if (programFiles === undefined || !path.win32.isAbsolute(programFiles)) {
    throw new SetupError('%ProgramFiles(x86)% is not set');
  }
  const vswhere = path.win32.join(
    programFiles,
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!existsSync(vswhere)) throw new SetupError('vswhere.exe not found (install Visual Studio)');
  const args = ['-latest', '-products', '*', '-requires', target.component];
  const found = run(vswhere, [...args, '-property', 'installationPath'], { capture: true });
  const install = found.stdout.trim();
  if (found.status !== 0 || install === '') {
    throw new SetupError(`no Visual Studio instance has the component ${target.component}`);
  }
  const spectre = run(vswhere, [...args, target.spectre, '-property', 'installationPath'], {
    capture: true,
  });
  if (spectre.status !== 0 || spectre.stdout.trim() === '') {
    throw new SetupError(
      `the Spectre-mitigated libraries are missing (/Qspectre): install the component ${target.spectre}`,
    );
  }
  return install;
}

/** @returns {string} the root of the pinned node-api-headers package */
function nodeApiHeaders() {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve('node-api-headers/package.json'));
}

function main() {
  if (process.platform !== 'win32') throw new SetupError('the addon builds on Windows only');
  const { arch, buildDir } = parseArgs(process.argv.slice(2));
  const target = ARCHES[arch];
  if (target === undefined) throw new SetupError(`unknown arch ${arch}`);
  const cmake = findCmake();
  const install = findVisualStudio(target);

  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const configure = run(cmake, [
    '-S',
    HERE,
    '-B',
    buildDir,
    '-G',
    'Visual Studio 17 2022',
    '-A',
    target.platform,
    `-DCMAKE_GENERATOR_INSTANCE=${install}`,
    `-DNODE_API_HEADERS_DIR=${nodeApiHeaders()}`,
    authorWarningsAsErrors(cmake),
    '-Werror=deprecated',
  ]);
  if (configure.status !== 0) return 1;

  const build = run(cmake, [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--',
    '/nologo',
    '/warnaserror',
    '/verbosity:minimal',
  ]);
  if (build.status !== 0) return 1;

  const addon = path.join(buildDir, 'Release', ADDON);
  const sha256 = createHash('sha256').update(readFileSync(addon)).digest('hex');
  process.stdout.write(`\n${arch} ${ADDON}\n  path   ${addon}\n  sha256 ${sha256}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (!(error instanceof SetupError)) throw error;
  process.stderr.write(`build.mjs: ${error.message}\n`);
  process.exitCode = 2;
}
