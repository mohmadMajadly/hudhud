#!/usr/bin/env node
// Builds the Windows job-object addon (plan §6.1; run:
// node native/win32-job/build.mjs --arch x64|arm64 [--build-dir <name>]
//   [--toolset-of-record]).
//
// Configures with CMake's Visual Studio generator out of the source tree in
// native/win32-job/build/<name> (gitignored; default <name> is the arch),
// deleted and recreated first so every build starts clean, builds Release
// with MSBuild warnings as errors, writes the build's toolchain.json next to
// it and prints it with the sha256 of the .node file. The build is
// reproducible (/Brepro): the same toolchain gives the same sha256.
//
// Toolchain (lead rulings on A2):
// - Visual Studio 2022 (17.x, generator "Visual Studio 17 2022") or 2026
//   (18.x, "Visual Studio 18 2026") with the MSVC tools of the architecture
//   and their Spectre-mitigated libraries; anything else is refused.
// - Without --toolset-of-record the instance's default toolset and the
//   newest Windows SDK are used (staging, `pnpm addon:stage`).
// - With --toolset-of-record the MSVC toolset and Windows SDK of the release
//   record the core's digest table was written from are pinned
//   (`-T v143,version=<VCToolsVersion>`, `-DCMAKE_SYSTEM_VERSION=<SDK>`); a
//   missing toolset, Spectre library or SDK fails the build and names the
//   Visual Studio component ids to install. Nothing is ever installed here.
// - toolchain.json records what changes the bytes: arch, generator,
//   VCToolsVersion, cl version, Windows SDK, CMake and node-api-headers
//   versions.
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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

import {
  checkToolchain,
  DIGESTS_MODULE,
  parseDigestsModule,
  parseManifest,
  renderToolchain,
} from '../../scripts/lib/addon-digests.mjs';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '..', '..');
const BUILD_ROOT = path.join(HERE, 'build');
const ADDON = 'hudhud_win32_job.node';
const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * @typedef {object} Target
 * @property {string} platform CMake's `-A` value.
 * @property {string} clDir Target directory of `cl.exe` under `bin/Host<host>/`.
 * @property {string} component The instance's MSVC tools.
 * @property {string} spectre Their Spectre-mitigated libraries.
 * @property {string} versioned Suffix of the side-by-side toolset component ids.
 */

/** @type {Readonly<Record<string, Target>>} */
const ARCHES = Object.freeze({
  x64: {
    platform: 'x64',
    clDir: 'x64',
    component: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    spectre: 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre',
    versioned: 'x86.x64',
  },
  arm64: {
    platform: 'ARM64',
    clDir: 'arm64',
    component: 'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
    spectre: 'Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre',
    versioned: 'ARM64',
  },
});

/** CMake's Visual Studio generator per Visual Studio major version. */
const GENERATORS = Object.freeze({ 17: 'Visual Studio 17 2022', 18: 'Visual Studio 18 2026' });

/** A usage or setup error (exit code 2). */
class SetupError extends Error {}

/**
 * @param {readonly string[]} argv
 * @returns {{ arch: string; buildDir: string; ofRecord: boolean }}
 */
function parseArgs(argv) {
  /** @type {string | undefined} */
  let arch;
  /** @type {string | undefined} */
  let name;
  let ofRecord = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--toolset-of-record') {
      ofRecord = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new SetupError(`missing value for ${String(flag)}`);
    if (flag === '--arch') arch = value;
    else if (flag === '--build-dir') name = value;
    else throw new SetupError(`unknown argument ${String(flag)}`);
    i += 1;
  }
  if (arch === undefined || !Object.hasOwn(ARCHES, arch)) {
    throw new SetupError(
      'usage: build.mjs --arch x64|arm64 [--build-dir <name>] [--toolset-of-record]',
    );
  }
  name ??= arch;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    throw new SetupError('--build-dir takes a name of lower-case letters, digits and dashes');
  }
  return { arch, buildDir: path.join(BUILD_ROOT, name), ofRecord };
}

/**
 * Runs a tool by absolute path, without a shell; the output is printed.
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {{ capture?: boolean }} [options]
 * @returns {{ status: number | null; stdout: string; stderr: string }}
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
  if (options.capture !== true) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
 * The CMake version (`x.y.z`) and its "project author warnings as errors"
 * flag: `-Werror=author` from CMake 4.4 on (where `-Werror=dev` is
 * deprecated and itself warns), `-Werror=dev` before. Refuses CMake older
 * than 3.28.
 *
 * @param {string} cmake
 * @returns {{ version: string; authorFlag: string }}
 */
function cmakeVersion(cmake) {
  const { status, stdout } = run(cmake, ['--version'], { capture: true });
  const match = /^cmake version (\d+)\.(\d+)\.(\d+)/m.exec(stdout);
  if (status !== 0 || match === null) throw new SetupError('cmake --version gave no version');
  const version = [Number(match[1]), Number(match[2])];
  const atLeast = (/** @type {number} */ major, /** @type {number} */ minor) =>
    (version[0] ?? 0) > major || ((version[0] ?? 0) === major && (version[1] ?? 0) >= minor);
  if (!atLeast(3, 28)) throw new SetupError(`CMake 3.28 or newer is required (${match[0]})`);
  return {
    version: `${String(match[1])}.${String(match[2])}.${String(match[3])}`,
    authorFlag: atLeast(4, 4) ? '-Werror=author' : '-Werror=dev',
  };
}

/** @returns {string} the absolute `Program Files (x86)` directory */
function programFilesX86() {
  const dir = process.env['ProgramFiles(x86)'];
  if (dir === undefined || !path.win32.isAbsolute(dir)) {
    throw new SetupError('%ProgramFiles(x86)% is not set');
  }
  return dir;
}

/**
 * The Visual Studio instance with the MSVC tools and the Spectre-mitigated
 * libraries of the architecture, and its CMake generator.
 *
 * @param {Target} target
 * @returns {{ install: string; generator: string }}
 */
function findVisualStudio(target) {
  const vswhere = path.win32.join(
    programFilesX86(),
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!existsSync(vswhere)) throw new SetupError('vswhere.exe not found (install Visual Studio)');
  const args = ['-latest', '-products', '*', '-requires', target.component, target.spectre];
  const install = run(vswhere, [...args, '-property', 'installationPath'], { capture: true });
  const version = run(vswhere, [...args, '-property', 'installationVersion'], { capture: true });
  if (install.status !== 0 || install.stdout.trim() === '') {
    throw new SetupError(
      `no Visual Studio instance has both ${target.component} and ${target.spectre} (the Spectre-mitigated libraries /Qspectre links against)`,
    );
  }
  const major = /^(\d+)\./.exec(version.stdout.trim())?.[1];
  /** @type {unknown} */
  const generator = major === undefined ? undefined : Reflect.get(GENERATORS, major);
  if (typeof generator !== 'string') {
    throw new SetupError(
      `Visual Studio ${version.stdout.trim()} is not supported: use Visual Studio 2022 (17.x) or 2026 (18.x)`,
    );
  }
  return { install: install.stdout.trim(), generator };
}

/** @returns {string} the root of the pinned node-api-headers package */
function nodeApiHeaders() {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve('node-api-headers/package.json'));
}

/**
 * The toolchain of the release record the committed digest table was
 * written from, for one architecture.
 *
 * @param {string} arch
 * @returns {{ toolchain: Readonly<Record<string, string>>; manifest: string }}
 */
function recordToolchain(arch) {
  const table = parseDigestsModule(readFileSync(path.join(REPO, DIGESTS_MODULE), 'utf8'));
  if (table === null) throw new SetupError(`${DIGESTS_MODULE} is not a generated digest table`);
  const manifest = parseManifest(readFileSync(path.join(REPO, table.manifest), 'utf8'));
  if (typeof manifest === 'string') throw new SetupError(`${table.manifest}: ${manifest}`);
  const entry = manifest.arches[arch];
  if (entry === undefined) throw new SetupError(`${table.manifest} records no ${arch} build`);
  return { toolchain: entry.toolchain, manifest: table.manifest };
}

/**
 * The platform toolset of an MSVC toolset version and the component ids of
 * that version as a side-by-side toolset (14.3x and 14.4x are v143, the
 * toolsets of Visual Studio 17.0 to 17.14).
 *
 * @param {string} vcTools
 * @param {Target} target
 * @returns {{ platformToolset: string; tools: string; spectre: string }}
 */
function toolsetOfRecord(vcTools, target) {
  const match = /^14\.([34]\d)\.\d+$/.exec(vcTools);
  if (match === null) throw new SetupError(`no platform toolset is known for MSVC ${vcTools}`);
  const minor = Number(match[1]);
  const id = `Microsoft.VisualStudio.Component.VC.14.${String(minor)}.17.${String(minor - 30)}.${target.versioned}`;
  return { platformToolset: 'v143', tools: id, spectre: `${id}.Spectre` };
}

/**
 * The host directory of the MSVC binaries (`Hostx64` or `HostARM64`).
 *
 * @returns {string}
 */
function hostDir() {
  return process.arch === 'arm64' ? 'HostARM64' : 'Hostx64';
}

/**
 * The `cl.exe` banner version of an MSVC toolset.
 *
 * @param {string} install
 * @param {string} vcTools
 * @param {Target} target
 * @returns {string}
 */
function clVersion(install, vcTools, target) {
  const cl = path.join(
    install,
    'VC',
    'Tools',
    'MSVC',
    vcTools,
    'bin',
    hostDir(),
    target.clDir,
    'cl.exe',
  );
  if (!existsSync(cl)) throw new SetupError(`cl.exe of MSVC ${vcTools} not found at ${cl}`);
  const { stdout, stderr } = run(cl, [], { capture: true });
  const version = /Version (\d+\.\d+\.\d+)/.exec(`${stderr}${stdout}`)?.[1];
  if (version === undefined) throw new SetupError(`cl.exe of MSVC ${vcTools} printed no version`);
  return version;
}

function main() {
  if (process.platform !== 'win32') throw new SetupError('the addon builds on Windows only');
  const { arch, buildDir, ofRecord } = parseArgs(process.argv.slice(2));
  const target = ARCHES[arch];
  if (target === undefined) throw new SetupError(`unknown arch ${arch}`);
  const cmake = findCmake();
  const cmakeInfo = cmakeVersion(cmake);
  const { install, generator } = findVisualStudio(target);
  const headers = nodeApiHeaders();
  /** @type {unknown} */
  const headersManifest = JSON.parse(readFileSync(path.join(headers, 'package.json'), 'utf8'));
  const headersVersion = String(Reflect.get(Object(headersManifest), 'version'));

  /** @type {string[]} */
  const pin = [];
  let vcTools = readFileSync(
    path.join(install, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'),
    'utf8',
  ).trim();
  if (ofRecord) {
    const record = recordToolchain(arch);
    const vcRecord = String(record.toolchain['vcToolsVersion']);
    const sdkRecord = String(record.toolchain['windowsSdkVersion']);
    const toolset = toolsetOfRecord(vcRecord, target);
    const msvc = path.join(install, 'VC', 'Tools', 'MSVC', vcRecord);
    const sdkBuild = /^10\.0\.(\d+)\.\d+$/.exec(sdkRecord)?.[1] ?? sdkRecord;
    const kits = path.win32.join(programFilesX86(), 'Windows Kits', '10');
    /** @type {string[]} */
    const missing = [];
    if (!existsSync(path.join(msvc, 'bin', hostDir(), target.clDir, 'cl.exe'))) {
      missing.push(`${toolset.tools} (MSVC ${vcRecord})`);
    }
    if (!existsSync(path.join(msvc, 'lib', 'spectre', target.clDir))) {
      missing.push(`${toolset.spectre} (its Spectre-mitigated libraries)`);
    }
    if (!existsSync(path.win32.join(kits, 'Lib', sdkRecord, 'ucrt', target.clDir))) {
      missing.push(
        `Microsoft.VisualStudio.Component.Windows11SDK.${sdkBuild} (Windows SDK ${sdkRecord})`,
      );
    }
    if (missing.length > 0) {
      throw new SetupError(
        `the toolset of record (${record.manifest}) is not installed in ${install}; install these Visual Studio components:\n  ${missing.join('\n  ')}`,
      );
    }
    vcTools = vcRecord;
    pin.push(
      '-T',
      `${toolset.platformToolset},version=${vcRecord}`,
      `-DCMAKE_SYSTEM_VERSION=${sdkRecord}`,
    );
    process.stdout.write(
      `toolset of record: MSVC ${vcRecord}, Windows SDK ${sdkRecord} (${record.manifest})\n`,
    );
  }
  const cl = clVersion(install, vcTools, target);

  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const configure = run(cmake, [
    '-S',
    HERE,
    '-B',
    buildDir,
    '-G',
    generator,
    '-A',
    target.platform,
    ...pin,
    `-DCMAKE_GENERATOR_INSTANCE=${install}`,
    `-DNODE_API_HEADERS_DIR=${headers}`,
    cmakeInfo.authorFlag,
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

  const project = readFileSync(path.join(buildDir, 'hudhud_win32_job.vcxproj'), 'utf8');
  const sdk = /<WindowsTargetPlatformVersion>([^<]+)</.exec(project)?.[1];
  if (sdk === undefined) throw new SetupError('the generated project names no Windows SDK');
  const toolchain = checkToolchain({
    arch,
    generator,
    vcToolsVersion: vcTools,
    clVersion: cl,
    windowsSdkVersion: sdk,
    cmakeVersion: cmakeInfo.version,
    nodeApiHeadersVersion: headersVersion,
  });
  if (typeof toolchain === 'string') throw new SetupError(`toolchain.json: ${toolchain}`);
  const text = renderToolchain(toolchain);
  writeFileSync(path.join(buildDir, 'toolchain.json'), text);

  const addon = path.join(buildDir, 'Release', ADDON);
  const sha256 = createHash('sha256').update(readFileSync(addon)).digest('hex');
  process.stdout.write(
    `\n${arch} ${ADDON}\n  path   ${addon}\n  sha256 ${sha256}\n  toolchain ${path.join(buildDir, 'toolchain.json')}\n${text}`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (!(error instanceof SetupError)) throw error;
  process.stderr.write(`build.mjs: ${error.message}\n`);
  process.exitCode = 2;
}
