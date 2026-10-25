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
// - With --toolset-of-record the inputs of the release record the core's
//   digest table was written from are used (ADR-0014 amendment 14):
//   - the Visual Studio instance at HUDHUD_VS_INSTALL (the release workflow
//     names the runner image's Visual Studio Enterprise instance, the
//     licensing basis of the static runtime, ADR-0015 item 12), else the
//     only instance that holds the record's MSVC toolset; never the latest
//     or default instance;
//   - its MSVC toolset of the record (`-T v143,version=<VCToolsVersion>`);
//   - the Windows SDK of the pin, unpacked by
//     `scripts/addon/toolchain.mjs provision-sdk` into the directory
//     HUDHUD_WINDOWS_SDK names; MSBuild (WindowsSdkDir_10,
//     UniversalCRTSdkDir_10, UCRTContentRoot) and CMake
//     (CMAKE_WINDOWS_KITS_10_DIR) are pointed at it, so the machine's SDK,
//     whatever its servicing build, is never read;
//   - `-DCMAKE_SYSTEM_VERSION=<SDK>` of the record.
//   A missing piece fails the build and names how to provide it. Nothing is
//   ever installed here; the release workflow
//   (.github/workflows/addon-prebuild.yml) provisions the SDK first.
// - toolchain.json records what changes the bytes: arch, generator,
//   VCToolsVersion, cl version, Windows SDK, CMake and node-api-headers
//   versions; and, diagnostic only, the input identity: the Visual Studio
//   build, the SDK servicing build and the sha256 of every file the compiler,
//   linker and lib.exe read under the toolset, the SDK and node-api-headers
//   (from MSBuild's FileTracker logs), plus the tools themselves
//   (scripts/lib/addon-identity.mjs).
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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
import {
  checkIdentity,
  identityInputs,
  parseTlogReads,
} from '../../scripts/lib/addon-identity.mjs';
import { toolsetOfRecord } from '../../scripts/lib/addon-manifest.mjs';
import {
  checkSdkMarker,
  kitsRoot,
  parsePin,
  PIN_FILE,
  SDK_MARKER,
  selectInstance,
} from '../../scripts/lib/addon-pin.mjs';

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
 */

/** @type {Readonly<Record<string, Target>>} */
const ARCHES = Object.freeze({
  x64: {
    platform: 'x64',
    clDir: 'x64',
    component: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    spectre: 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre',
  },
  arm64: {
    platform: 'ARM64',
    clDir: 'arm64',
    component: 'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
    spectre: 'Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre',
  },
});

/** CMake's Visual Studio generator per Visual Studio major version. */
const GENERATORS = Object.freeze({ 17: 'Visual Studio 17 2022', 18: 'Visual Studio 18 2026' });

/** A usage or setup error (exit code 2). */
class SetupError extends Error {}

/**
 * Environment variables of a Visual Studio developer prompt that would point
 * a build at other SDK or toolset directories; removed for a build of record.
 */
const DEV_PROMPT_VARIABLES = Object.freeze([
  'INCLUDE',
  'LIB',
  'LIBPATH',
  'WindowsSdkDir',
  'WindowsSdkBinPath',
  'WindowsSdkVerBinPath',
  'WindowsSDKLibVersion',
  'WindowsSDKVersion',
  'WindowsLibPath',
  'UniversalCRTSdkDir',
  'UCRTVersion',
  'VCToolsInstallDir',
  'VCToolsVersion',
  'VCINSTALLDIR',
  'VSINSTALLDIR',
]);

/** The MSVC tools whose bytes the identity records, besides what the tlogs name. */
const TOOL_FILES = Object.freeze(['cl.exe', 'c1.dll', 'c2.dll', 'link.exe', 'lib.exe']);

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
 * @param {{ capture?: boolean, env?: NodeJS.ProcessEnv | undefined }} [options]
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
    ...(options.env === undefined ? {} : { env: options.env }),
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
 * Whether a Visual Studio instance holds an MSVC toolset for the target:
 * its compiler and its Spectre-mitigated libraries.
 *
 * @param {string} install
 * @param {string} vcTools
 * @param {Target} target
 * @returns {boolean}
 */
function holdsToolset(install, vcTools, target) {
  const msvc = path.join(install, 'VC', 'Tools', 'MSVC', vcTools);
  return (
    existsSync(path.join(msvc, 'bin', hostDir(), target.clDir, 'cl.exe')) &&
    existsSync(path.join(msvc, 'lib', 'spectre', target.clDir))
  );
}

/**
 * The Visual Studio instance, its version and its CMake generator. Without
 * the pin: the latest instance with the default MSVC tools and
 * Spectre-mitigated libraries of the architecture. For a build of record
 * (`--toolset-of-record`, `vcRecord` given): the instance at
 * HUDHUD_VS_INSTALL, else the only one that holds the record's toolset
 * (scripts/lib/addon-pin.mjs selectInstance); never the latest or default.
 *
 * @param {Target} target
 * @param {string | undefined} vcRecord The record's VCToolsVersion.
 * @returns {{ install: string; version: string; generator: string }}
 */
function findVisualStudio(target, vcRecord) {
  const vswhere = path.win32.join(
    programFilesX86(),
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!existsSync(vswhere)) throw new SetupError('vswhere.exe not found (install Visual Studio)');
  /** @type {string} */
  let install;
  /** @type {string} */
  let version;
  if (vcRecord !== undefined) {
    const listed = run(vswhere, ['-all', '-products', '*', '-format', 'json', '-utf8'], {
      capture: true,
    });
    const wanted = process.env['HUDHUD_VS_INSTALL'];
    const chosen = selectInstance(listed.status === 0 ? listed.stdout : '', {
      wanted: wanted === undefined || wanted === '' ? undefined : wanted,
      toolset: `MSVC ${vcRecord} for ${target.clDir} with its Spectre-mitigated libraries`,
      hasToolset: (dir) => holdsToolset(dir, vcRecord, target),
    });
    if (typeof chosen === 'string') throw new SetupError(chosen);
    install = chosen.path;
    version = chosen.version;
    process.stdout.write(
      `Visual Studio instance of record: ${chosen.product} ${version} at ${install}\n`,
    );
  } else {
    const args = ['-latest', '-products', '*', '-requires', target.component, target.spectre];
    const found = run(vswhere, [...args, '-property', 'installationPath'], { capture: true });
    const versionOf = run(vswhere, [...args, '-property', 'installationVersion'], {
      capture: true,
    });
    if (found.status !== 0 || found.stdout.trim() === '') {
      throw new SetupError(
        `no Visual Studio instance has both ${target.component} and ${target.spectre} (the Spectre-mitigated libraries /Qspectre links against)`,
      );
    }
    install = found.stdout.trim();
    version = versionOf.stdout.trim();
  }
  const major = /^(\d+)\./.exec(version)?.[1];
  /** @type {unknown} */
  const generator = major === undefined ? undefined : Reflect.get(GENERATORS, major);
  if (typeof generator !== 'string') {
    throw new SetupError(
      `Visual Studio ${version} is not supported: use Visual Studio 2022 (17.x) or 2026 (18.x)`,
    );
  }
  return { install, version, generator };
}

/** @returns {import('../../scripts/lib/addon-pin.mjs').Pin} the committed pin */
function readPin() {
  const pin = parsePin(readFileSync(path.join(REPO, PIN_FILE), 'utf8'));
  if (typeof pin === 'string') throw new SetupError(`${PIN_FILE}: ${pin}`);
  return pin;
}

/**
 * The pinned Windows SDK that HUDHUD_WINDOWS_SDK names: its Windows Kits
 * root and servicing build, after checking its marker against the pin.
 *
 * @param {import('../../scripts/lib/addon-pin.mjs').Pin} pin
 * @returns {{ kits: string; build: string }}
 */
function pinnedSdk(pin) {
  const dir = process.env['HUDHUD_WINDOWS_SDK'];
  const how = `provision it: node scripts/addon/toolchain.mjs provision-sdk --downloads <dir> --out <dir>, then set HUDHUD_WINDOWS_SDK to the --out directory`;
  if (dir === undefined || dir === '' || !path.win32.isAbsolute(dir)) {
    throw new SetupError(`a build of record needs the pinned Windows SDK (${PIN_FILE}); ${how}`);
  }
  const marker = path.win32.join(dir, SDK_MARKER);
  if (!existsSync(marker)) {
    throw new SetupError(`${dir} is not a provisioned Windows SDK (no ${SDK_MARKER}); ${how}`);
  }
  const checked = checkSdkMarker(readFileSync(marker, 'utf8'), pin);
  if (typeof checked === 'string') throw new SetupError(`${dir}: ${checked}; ${how}`);
  return { kits: kitsRoot(dir), build: checked.build };
}

/**
 * The environment of the configure and build processes of a build of
 * record: the developer-prompt variables removed, MSBuild's SDK roots and
 * CMake's Windows Kits directory pointed at the pinned SDK.
 *
 * @param {string} kits
 * @returns {NodeJS.ProcessEnv}
 */
function pinnedEnvironment(kits) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  const removed = new Set(DEV_PROMPT_VARIABLES.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(process.env)) {
    if (!removed.has(name.toLowerCase())) env[name] = value;
  }
  env['WindowsSdkDir_10'] = kits;
  env['UniversalCRTSdkDir_10'] = kits;
  env['UCRTContentRoot'] = kits;
  env['CMAKE_WINDOWS_KITS_10_DIR'] = kits;
  return env;
}

/**
 * The input identity of a finished build: the files its compiler, linker
 * and lib.exe read (FileTracker read logs of the addon target) under the
 * toolset, the SDK and node-api-headers, plus the MSVC tools, each with its
 * sha256.
 *
 * @param {{ buildDir: string; msvc: string; bin: string; kits: string; headers: string;
 *   visualStudio: string; windowsSdkBuild: string }} where
 * @returns {import('../../scripts/lib/addon-identity.mjs').Identity}
 */
function buildIdentity(where) {
  const tlogs = path.join(
    where.buildDir,
    'hudhud_win32_job.dir',
    'Release',
    'hudhud_win32_job.tlog',
  );
  if (!existsSync(tlogs)) throw new SetupError(`no FileTracker logs at ${tlogs}`);
  /** @type {string[]} */
  const files = TOOL_FILES.map((name) => path.join(where.bin, name));
  for (const name of readdirSync(tlogs).sort()) {
    // The compiler's and the linker's read logs (UTF-16LE with a byte order
    // mark); the custom-build logs name CMake's own regeneration inputs.
    if (!/^(?:cl|link)\.read\.\d+\.tlog$/iu.test(name)) continue;
    const bytes = readFileSync(path.join(tlogs, name));
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
    files.push(...parseTlogReads(new TextDecoder(encoding).decode(bytes)));
  }
  const inputs = identityInputs(
    files,
    [
      { name: 'msvc', dir: where.msvc },
      { name: 'sdk', dir: where.kits },
      { name: 'node-api-headers', dir: where.headers },
    ],
    // The repository's own files, and Windows' (the OS's locale and time
    // zone data the tools open; they vary with the runner's OS build).
    [where.buildDir, HERE, windowsDir()],
  );
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const [key, file] of inputs) {
    if (!existsSync(file)) throw new SetupError(`the build read ${file}, which is gone`);
    hashes[key] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  const identity = checkIdentity({
    visualStudio: where.visualStudio,
    windowsSdkBuild: where.windowsSdkBuild,
    files: hashes,
  });
  if (typeof identity === 'string') throw new SetupError(`input identity: ${identity}`);
  return identity;
}

/** @returns {string} the absolute Windows directory (%SystemRoot%) */
function windowsDir() {
  const dir = process.env['SystemRoot'];
  if (dir === undefined || !path.win32.isAbsolute(dir))
    throw new SetupError('%SystemRoot% is not set');
  return dir;
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
  const record = ofRecord ? recordToolchain(arch) : undefined;
  const pin = ofRecord ? readPin() : undefined;
  const {
    install,
    version: vsVersion,
    generator,
  } = findVisualStudio(
    target,
    record === undefined ? undefined : String(record.toolchain['vcToolsVersion']),
  );
  const sdkPin = pin === undefined ? undefined : pinnedSdk(pin);
  const env = sdkPin === undefined ? undefined : pinnedEnvironment(sdkPin.kits);
  const headers = nodeApiHeaders();
  /** @type {unknown} */
  const headersManifest = JSON.parse(readFileSync(path.join(headers, 'package.json'), 'utf8'));
  const headersVersion = String(Reflect.get(Object(headersManifest), 'version'));

  /** @type {string[]} */
  const cmakePin = [];
  let vcTools = readFileSync(
    path.join(install, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'),
    'utf8',
  ).trim();
  if (record !== undefined) {
    const vcRecord = String(record.toolchain['vcToolsVersion']);
    const sdkRecord = String(record.toolchain['windowsSdkVersion']);
    const toolset = toolsetOfRecord(record.toolchain);
    if (typeof toolset === 'string') throw new SetupError(`${record.manifest}: ${toolset}`);
    const sdkPinned = /** @type {{ kits: string; build: string }} */ (sdkPin);
    const pinnedVersion = /** @type {import('../../scripts/lib/addon-pin.mjs').Pin} */ (pin)
      .windowsSdk.version;
    if (pinnedVersion !== sdkRecord) {
      throw new SetupError(
        `${PIN_FILE} pins Windows SDK ${pinnedVersion}, the record (${record.manifest}) was built with ${sdkRecord}`,
      );
    }
    if (!existsSync(path.win32.join(sdkPinned.kits, 'Lib', sdkRecord, 'ucrt', target.clDir))) {
      throw new SetupError(
        `the pinned SDK at ${sdkPinned.kits} has no ${sdkRecord} ${arch} libraries`,
      );
    }
    vcTools = vcRecord;
    cmakePin.push(
      '-T',
      `${toolset.platformToolset},version=${vcRecord}`,
      `-DCMAKE_SYSTEM_VERSION=${sdkRecord}`,
    );
    process.stdout.write(
      `toolset of record: Visual Studio ${vsVersion} at ${install}, MSVC ${vcRecord}, Windows SDK ${sdkRecord} build ${sdkPinned.build} at ${sdkPinned.kits} (${record.manifest}, ${PIN_FILE})\n`,
    );
  }
  const cl = clVersion(install, vcTools, target);

  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const configure = run(
    cmake,
    [
      '-S',
      HERE,
      '-B',
      buildDir,
      '-G',
      generator,
      '-A',
      target.platform,
      ...cmakePin,
      `-DCMAKE_GENERATOR_INSTANCE=${install}`,
      `-DNODE_API_HEADERS_DIR=${headers}`,
      cmakeInfo.authorFlag,
      '-Werror=deprecated',
    ],
    { env },
  );
  if (configure.status !== 0) return 1;

  const build = run(
    cmake,
    [
      '--build',
      buildDir,
      '--config',
      'Release',
      '--',
      '/nologo',
      '/warnaserror',
      '/verbosity:minimal',
    ],
    { env },
  );
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
  const msvcDir = path.join(install, 'VC', 'Tools', 'MSVC', vcTools);
  const identity = buildIdentity({
    buildDir,
    msvc: msvcDir,
    bin: path.join(msvcDir, 'bin', hostDir(), target.clDir),
    kits: sdkPin?.kits ?? path.win32.join(programFilesX86(), 'Windows Kits', '10'),
    headers,
    visualStudio: vsVersion,
    windowsSdkBuild: sdkPin?.build ?? 'unpinned',
  });
  writeFileSync(path.join(buildDir, 'toolchain.json'), renderToolchain(toolchain, identity));
  const text = renderToolchain(toolchain);

  const addon = path.join(buildDir, 'Release', ADDON);
  const sha256 = createHash('sha256').update(readFileSync(addon)).digest('hex');
  process.stdout.write(
    `\n${arch} ${ADDON}\n  path   ${addon}\n  sha256 ${sha256}\n  toolchain ${path.join(buildDir, 'toolchain.json')}\n${text}` +
      `  inputs: Visual Studio ${identity.visualStudio}, Windows SDK build ${identity.windowsSdkBuild}, ${String(Object.keys(identity.files).length)} files hashed (identity in toolchain.json)\n`,
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
