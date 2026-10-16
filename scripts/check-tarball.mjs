#!/usr/bin/env node
// Tarball check (plan §4.1 "Tarball install", §4.8; run: node scripts/check-tarball.mjs).
//
// For every publishable package under packages/ (a `publishConfig` or not
// private): `pnpm pack` it, check the tarball (files list, manifest, source
// maps, privacy scan, entry points; scripts/lib/tarball.mjs), install all
// tarballs into a fresh project outside the repository with `npm install
// --omit=dev --ignore-scripts`, import every JS entry point with Node's own
// ESM resolver, parse every JSON entry point, and type-check an import of
// every entry point with tsc against the installed packages (NodeNext,
// strict, declarations checked). Needs a built tree (`pnpm build`) and pnpm
// on PATH. A native platform package whose `os` excludes this host (the
// Windows job addon on Linux and macOS) cannot be built here: it is reported
// as `skipped (native, built on win32 only)` and not checked; on its own
// platform it must be built and pass like any other package.
//
// Safety: nothing is published and no registry is written or authenticated
// to: the install runs with empty npm configuration files, a clean
// environment (no tokens) and tarball sources only. The project lives in a
// new directory under HUDHUD_TEST_ROOT (else the system temporary
// directory), refused when an ancestor would change package resolution, and
// is removed at the end.
//
// Release mode (plan §6.3 phase 2):
//
//   node scripts/check-tarball.mjs --release-record native/win32-job/release/<release>/manifest.json
//
// packs only the core and the platform packages the record names (the
// addon staged into them first, `write-digests.mjs --stage`; the arm64
// package too, although it is private, K17) and hashes the bytes a release
// would publish again: the `.node` and `SHA256SUMS` inside each platform
// tarball and the digest table inside the core's tarball (source and
// compiled `dist` module) must equal the record, and the core's optional
// dependency must name the packed x64 version (scripts/lib/tarball.mjs
// `checkReleaseRecord`). Every mismatch names both values. The full package
// checks above are not repeated in this mode.
//
// Exit codes: 0 all checks passed, 1 problems found, 2 tool or setup error.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { ARCHES, parseManifest, releaseOf } from './lib/addon-digests.mjs';
import {
  checkImports,
  checkReleaseRecord,
  checkSourceManifest,
  checkTarball,
  cleanEnv,
  IMPORT_CHILD,
  isPublishable,
  nativeSkipReason,
  parseImportResults,
  readTarGz,
  renderTypeProject,
  rootProblem,
  supportsPlatform,
} from './lib/tarball.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024 * 1024;

/** A failure of the check's own tooling (exit code 2). */
class ToolError extends Error {}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasResolutionMarker(dir) {
  return existsSync(path.join(dir, 'package.json')) || existsSync(path.join(dir, 'node_modules'));
}

/**
 * @param {string} inner
 * @param {string} outer
 * @returns {boolean}
 */
function isInside(inner, outer) {
  const relative = path.relative(outer, inner);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Runs a program and returns its output; a failure is a {@link ToolError}
 * that carries the program's own message.
 *
 * @param {string} file
 * @param {readonly string[]} args
 * @param {{ cwd: string, env?: Record<string, string> }} options
 * @returns {string}
 */
function run(file, args, options) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env ?? { ...process.env },
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout || String(result.error))
      .trim()
      .split('\n')
      .slice(-12);
    throw new ToolError(
      `${path.basename(file)} ${args.slice(0, 2).join(' ')} failed:\n${detail.join('\n')}`,
    );
  }
  return result.stdout;
}

/**
 * Runs pnpm: through the script that started this process when pnpm did,
 * else through the shell on Windows (`pnpm.cmd` cannot be spawned directly),
 * with arguments checked for characters the shell would interpret.
 *
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function pnpm(args, cwd) {
  const execpath = process.env['npm_execpath'];
  if (execpath !== undefined && /pnpm\.c?js$/u.test(execpath)) {
    return run(process.execPath, [execpath, ...args], { cwd });
  }
  if (process.platform !== 'win32') return run('pnpm', args, { cwd });
  if (args.some((arg) => /["%^&|<>\r\n]/u.test(arg))) throw new ToolError('unsafe pnpm argument');
  const line = `pnpm ${args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;
  const result = spawnSync(line, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new ToolError(
      `pnpm ${args[0] ?? ''} failed:\n${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

/**
 * The npm CLI that ships with the running Node.js.
 *
 * @returns {string}
 */
function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new ToolError(`npm is not installed next to ${process.execPath}`);
  return found;
}

/**
 * @typedef {import('./lib/tarball.mjs').PackageJson} PackageJson
 */

/**
 * @returns {{ dir: string, manifest: PackageJson }[]}
 */
function publishablePackages() {
  const base = path.join(REPO, 'packages');
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(base, entry.name))
    .filter((dir) => existsSync(path.join(dir, 'package.json')))
    .map((dir) => {
      /** @type {unknown} */
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      return { dir, manifest: /** @type {PackageJson} */ (manifest) };
    })
    .filter(({ manifest }) => isPublishable(manifest));
}

/**
 * @param {string} base
 * @returns {string} A new directory under `base`, by real path.
 */
function makeRoot(base) {
  mkdirSync(base, { recursive: true });
  const root = realpathSync(mkdtempSync(path.join(base, 'hudhud-tarball-')));
  const problem = rootProblem(root, REPO, hasResolutionMarker, isInside, (dir) =>
    path.dirname(dir),
  );
  if (problem !== null) {
    rmSync(root, { recursive: true, force: true });
    throw new ToolError(problem);
  }
  return root;
}

/**
 * @param {readonly string[]} lines
 * @param {string} heading
 * @returns {void}
 */
function report(lines, heading) {
  process.stdout.write(`${heading}\n${lines.map((line) => `  ${line}`).join('\n')}\n`);
}

/**
 * Packs one package with `pnpm pack` into `tarballs`.
 *
 * @param {string} dir The package directory.
 * @param {string} name Its name, for messages.
 * @param {string} tarballs
 * @returns {string} The tarball's path.
 */
function pack(dir, name, tarballs) {
  const before = new Set(readdirSync(tarballs));
  pnpm(['pack', '--pack-destination', tarballs], dir);
  const created = readdirSync(tarballs).filter(
    (file) => !before.has(file) && file.endsWith('.tgz'),
  );
  if (created.length !== 1 || created[0] === undefined) {
    throw new ToolError(
      `pnpm pack of ${name} produced ${String(created.length)} tarballs, expected 1`,
    );
  }
  return path.join(tarballs, created[0]);
}

const USAGE =
  'usage: node scripts/check-tarball.mjs [--release-record native/win32-job/release/<release>/manifest.json]\n';

/** @returns {number} */
function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--release-record' && args[1] !== undefined) {
    return releaseRecord(args[1]);
  }
  if (args.length > 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const packages = publishablePackages();
  if (packages.length === 0) throw new ToolError('no publishable package found under packages/');

  const root = makeRoot(process.env['HUDHUD_TEST_ROOT'] ?? os.tmpdir());
  /** @type {string[]} */
  const problems = [];
  try {
    const forbidden = [REPO, os.homedir(), root].filter((entry) => entry.length >= 4);
    const tarballs = path.join(root, 'tarballs');
    mkdirSync(tarballs);

    /** @type {{ manifest: PackageJson, file: string, entryPoints: import('./lib/tarball.mjs').EntryPoint[], installable: boolean }[]} */
    const packed = [];
    for (const { dir, manifest } of packages) {
      const name = String(manifest.name);
      const scripted = checkSourceManifest(manifest);
      if (scripted.length > 0) {
        problems.push(...scripted.map((problem) => `${name}: ${problem}`));
        continue;
      }
      const file = pack(dir, name, tarballs);
      const skipped = nativeSkipReason(manifest, process.platform);
      if (skipped !== null) {
        // Not built on this host, so nothing in it can be checked here; the
        // tarball only satisfies optional dependencies on it, offline.
        packed.push({ manifest, file, entryPoints: [], installable: false });
        process.stdout.write(`skipped ${name} (${skipped})\n`);
        continue;
      }
      const result = checkTarball(manifest, readFileSync(file), forbidden);
      problems.push(...result.problems.map((problem) => `${name}: ${problem}`));
      const installable = supportsPlatform(manifest, process.platform, process.arch);
      packed.push({ manifest, file, entryPoints: result.entryPoints, installable });
      process.stdout.write(
        `packed ${name}: ${String(result.paths.length)} files, ${String(result.entryPoints.length)} entry points${installable ? '' : ' (not installable on this platform: static checks only)'}\n`,
      );
    }

    const toInstall = packed.filter((entry) => entry.installable);
    const otherPlatform = packed.filter((entry) => !entry.installable);
    if (toInstall.length > 0) installAndImport(root, toInstall, otherPlatform, problems);

    if (problems.length > 0) {
      report(problems, `tarball check FAILED (${String(problems.length)} problem(s)):`);
      return 1;
    }
    process.stdout.write('tarball check passed\n');
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

/**
 * Installs the tarballs into a project in `root`, imports every entry point
 * and type-checks the imports.
 *
 * @param {string} root
 * @param {{ manifest: PackageJson, file: string, entryPoints: import('./lib/tarball.mjs').EntryPoint[] }[]} installed
 * @param {{ manifest: PackageJson, file: string }[]} otherPlatform Tarballs
 *   of packages for other platforms (the Windows addon packages elsewhere).
 *   They are listed as optional dependencies of the project, so a package's
 *   optional dependency on one of them is satisfied by its tarball and npm
 *   skips it for the platform instead of asking the registry for it.
 * @param {string[]} problems Appended to.
 * @returns {void}
 */
function installAndImport(root, installed, otherPlatform, problems) {
  const project = path.join(root, 'project');
  mkdirSync(project);
  writeFileSync(path.join(root, 'user.npmrc'), '');
  writeFileSync(path.join(root, 'global.npmrc'), '');
  /** @param {{ manifest: PackageJson, file: string }[]} tarballs */
  const sources = (tarballs) =>
    Object.fromEntries(
      tarballs.map(({ manifest, file }) => [
        String(manifest.name),
        `file:${file.replaceAll('\\', '/')}`,
      ]),
    );
  const consumer = {
    name: 'hudhud-tarball-check',
    private: true,
    type: 'module',
    dependencies: sources(installed),
    optionalDependencies: sources(otherPlatform),
  };
  writeFileSync(path.join(project, 'package.json'), `${JSON.stringify(consumer, null, 2)}\n`);
  const env = cleanEnv({ ...process.env }, root.replaceAll('\\', '/'), process.platform);
  run(
    process.execPath,
    [
      npmCli(),
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    { cwd: project, env },
  );

  const modules = path.join(project, 'node_modules');
  const js = installed.flatMap(({ entryPoints }) =>
    entryPoints.filter((entry) => entry.kind === 'js'),
  );
  for (const { manifest, entryPoints } of installed) {
    for (const entry of entryPoints.filter((candidate) => candidate.kind === 'json')) {
      try {
        JSON.parse(
          readFileSync(path.join(modules, String(manifest.name), entry.runtime ?? ''), 'utf8'),
        );
      } catch {
        problems.push(`${entry.specifier}: the installed JSON file is missing or invalid`);
      }
    }
    // A native addon is loaded by its consumer with `process.dlopen`, never
    // imported; the installed package must carry the file the subpath names.
    for (const entry of entryPoints.filter((candidate) => candidate.kind === 'native')) {
      if (!existsSync(path.join(modules, String(manifest.name), entry.runtime ?? ''))) {
        problems.push(`${entry.specifier}: the installed addon file is missing`);
      }
    }
  }

  const output = run(process.execPath, ['--input-type=module', '--eval', IMPORT_CHILD], {
    cwd: project,
    env: { ...env, HUDHUD_TARBALL_SPECIFIERS: JSON.stringify(js.map((entry) => entry.specifier)) },
  });
  const modulesUrl = `${pathToFileURL(modules).href}/`;
  problems.push(...checkImports(js, parseImportResults(output), modulesUrl));
  process.stdout.write(`imported ${String(js.length)} entry points from the installed tarballs\n`);

  const typed = js.filter((entry) => entry.types !== undefined).map((entry) => entry.specifier);
  const typeRoot = path.join(REPO, 'node_modules', '@types').replaceAll('\\', '/');
  const { tsconfig, source } = renderTypeProject(typed, typeRoot);
  writeFileSync(path.join(project, 'tsconfig.json'), tsconfig);
  writeFileSync(path.join(project, 'check.ts'), source);
  const tsc = path.join(REPO, 'node_modules', 'typescript', 'lib', 'tsc.js');
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
  });
  if (result.status !== 0) {
    const lines = result.stdout.trim().split('\n').slice(0, 20);
    problems.push(`types of the installed packages do not resolve or check:\n${lines.join('\n')}`);
  } else {
    process.stdout.write(
      `type-checked ${String(typed.length)} entry points against the installed packages\n`,
    );
  }
}

/**
 * Release mode: packs the core and the record's platform packages and
 * checks the packed bytes against the release record.
 *
 * @param {string} given The record's repository path.
 * @returns {number}
 */
function releaseRecord(given) {
  const manifestPath = given.replaceAll('\\', '/');
  if (releaseOf(manifestPath) === null) {
    process.stderr.write(`${given} is not a release record path\n${USAGE}`);
    return 2;
  }
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path.join(REPO, manifestPath), 'utf8');
  } catch (error) {
    throw new ToolError(
      `cannot read ${manifestPath} (${String(/** @type {{ code?: unknown }} */ (error).code ?? error)})`,
    );
  }
  const manifest = parseManifest(text);
  if (typeof manifest === 'string') throw new ToolError(`${manifestPath}: ${manifest}`);

  const root = makeRoot(process.env['HUDHUD_TEST_ROOT'] ?? os.tmpdir());
  try {
    const tarballs = path.join(root, 'tarballs');
    mkdirSync(tarballs);
    /** @param {string} dir */
    const packed = (dir) => {
      const source = path.join(REPO, dir);
      /** @type {unknown} */
      const parsed = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
      const name = String(/** @type {PackageJson} */ (parsed).name);
      const scripted = checkSourceManifest(/** @type {PackageJson} */ (parsed));
      if (scripted.length > 0) throw new ToolError(`${name}: ${scripted.join('; ')}`);
      const file = pack(source, name, tarballs);
      try {
        return readTarGz(readFileSync(file));
      } catch (error) {
        throw new ToolError(
          `cannot read the tarball of ${name}: ${/** @type {Error} */ (error).message}`,
        );
      }
    };
    const core = packed('packages/core');
    /** @type {Record<string, import('./lib/tarball.mjs').TarEntry[]>} */
    const platforms = {};
    for (const arch of Object.keys(manifest.arches).sort()) {
      const target = ARCHES[arch];
      if (target !== undefined) platforms[arch] = packed(target.packageDir);
    }
    const problems = checkReleaseRecord(manifest, manifestPath, { core, platforms });
    if (problems.length > 0) {
      report(problems, `release record check FAILED against ${manifestPath}:`);
      return 1;
    }
    const lines = Object.keys(manifest.arches)
      .sort()
      .map((arch) => `${arch} sha256 ${String(manifest.arches[arch]?.sha256)}`);
    report(
      lines,
      `release record check passed: the packed tarballs carry ${manifestPath} (version ${manifest.version})`,
    );
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `tarball check: ${error instanceof ToolError ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
