#!/usr/bin/env node
// Tarball check (plan §4.1 "Tarball install", §4.8; run: node scripts/check-tarball.mjs).
//
// For every publishable package under packages/ (a `publishConfig` or not
// private): `pnpm pack` it, check the tarball (files list with a README, a
// LICENSE byte-equal to the repository's and a NOTICE that begins with the
// repository's and lists the third-party code the package bundles,
// manifest, source maps and their packed sources, privacy scan, entry points;
// scripts/lib/tarball.mjs), install all tarballs into a fresh project
// outside the repository with `npm install --omit=dev --ignore-scripts`,
// import every JS entry point with Node's own ESM resolver, parse every JSON
// entry point, and type-check an import of every entry point with tsc
// against the installed packages (NodeNext, strict, declarations checked).
// Needs a built tree (`pnpm build`) and pnpm on PATH. A native platform
// package whose `os` excludes this host (the Windows job addon on Linux and
// macOS) cannot be built here: it is reported as `skipped (native, built on
// win32 only)`, and only its README, LICENSE and NOTICE are checked; on its
// own platform it must be built and pass like any other package.
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
// Release tag mode (the tag run of addon-prebuild.yml; ADR-0014 amendment 10):
//
//   node scripts/check-tarball.mjs --release-tag v<version>
//
// does the same against the record the core's digest table names, packs
// every package under packages/ and also requires (`checkReleaseTag`): the
// tag is v<semver> and every package of the changesets `fixed` group is
// packed at that version; `@hudhudjs/win32-job-x64` is packed at the
// record's `release`; every package with `publishConfig` is not private and
// every other package is; no changeset is left unconsumed; and every
// published package names the publishing repository (`GITHUB_REPOSITORY`,
// else the https `origin` remote) in `repository`, `homepage` and `bugs`
// (`checkRepositoryFields`).
//
// Release runs (.github/workflows/release.yml, ADR-0014 amendment 12) publish
// exactly the bytes they checked:
//
//   node scripts/check-tarball.mjs --release-tag v<version> --keep-tarballs <dir>
//
// copies, once every check passed, the tarball of every package the release
// publishes (`publishConfig` and not private) into the new directory <dir>;
// and
//
//   node scripts/check-tarball.mjs --tarballs <dir>
//
// runs the full check above over those tarballs instead of packing again:
// every publishable package needs exactly one tarball in <dir>, packed at its
// source version, and no other file may be there (`matchTarballs`).
//
// Exit codes: 0 all checks passed, 1 problems found, 2 tool or setup error.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
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

import {
  ARCHES,
  DIGESTS_MODULE,
  parseDigestsModule,
  parseManifest,
  releaseOf,
} from './lib/addon-digests.mjs';
import {
  checkImports,
  checkLegalFiles,
  checkReleaseRecord,
  checkReleaseTag,
  checkRepositoryFields,
  checkRequiredFiles,
  checkSourceManifest,
  checkTarball,
  cleanEnv,
  IMPORT_CHILD,
  isPublishable,
  isPublished,
  manifestOf,
  matchTarballs,
  nativeSkipReason,
  parseImportResults,
  readTarGz,
  renderTypeProject,
  repositorySlug,
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
  'usage: node scripts/check-tarball.mjs [--tarballs <dir> | --release-record native/win32-job/release/<release>/manifest.json | --release-tag v<version> [--keep-tarballs <dir>]]\n';

/**
 * The files of a directory of tarballs, with the name and version of each
 * packed manifest; anything but a `.tgz` file there is refused.
 *
 * @param {string} dir
 * @returns {import('./lib/tarball.mjs').GivenTarball[]}
 */
function givenTarballs(dir) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    throw new ToolError(
      `cannot read ${dir} (${String(/** @type {{ code?: unknown }} */ (error).code ?? error)})`,
    );
  }
  const other = names.filter((name) => !name.endsWith('.tgz'));
  if (other.length > 0) {
    throw new ToolError(`${dir} holds files that are not tarballs: ${other.join(', ')}`);
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    /** @type {PackageJson | undefined} */
    let manifest;
    try {
      manifest = manifestOf(readTarGz(readFileSync(file)));
    } catch (error) {
      throw new ToolError(
        `cannot read the tarball ${file}: ${/** @type {Error} */ (error).message}`,
      );
    }
    return {
      file,
      name: typeof manifest?.name === 'string' ? manifest.name : undefined,
      version: typeof manifest?.version === 'string' ? manifest.version : undefined,
    };
  });
}

/** @returns {number} */
function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--release-record' && args[1] !== undefined) {
    return releaseCheck(args[1], null, null);
  }
  if (args.length === 2 && args[0] === '--release-tag' && args[1] !== undefined) {
    return releaseCheck(tableRecordPath(), args[1], null);
  }
  if (
    args.length === 4 &&
    args[0] === '--release-tag' &&
    args[1] !== undefined &&
    args[2] === '--keep-tarballs' &&
    args[3] !== undefined
  ) {
    return releaseCheck(tableRecordPath(), args[1], path.resolve(args[3]));
  }
  if (args.length === 2 && args[0] === '--tarballs' && args[1] !== undefined) {
    return fullCheck(path.resolve(args[1]));
  }
  if (args.length > 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  return fullCheck(null);
}

/**
 * The full check of every publishable package.
 *
 * @param {string | null} given A directory of tarballs packed earlier, checked
 *   instead of packing (`--tarballs`).
 * @returns {number}
 */
function fullCheck(given) {
  const packages = publishablePackages();
  if (packages.length === 0) throw new ToolError('no publishable package found under packages/');
  /** @type {Map<string, string> | null} */
  let givenFiles = null;
  if (given !== null) {
    const matched = matchTarballs(
      packages.map(({ manifest }) => ({ name: String(manifest.name), version: manifest.version })),
      givenTarballs(given),
    );
    if (matched.problems.length > 0) {
      report(
        matched.problems,
        `tarball check FAILED: the tarballs in ${given} are not those of the publishable packages:`,
      );
      return 1;
    }
    givenFiles = matched.files;
  }

  const root = makeRoot(process.env['HUDHUD_TEST_ROOT'] ?? os.tmpdir());
  /** @type {string[]} */
  const problems = [];
  try {
    const forbidden = [REPO, os.homedir(), root].filter((entry) => entry.length >= 4);
    // Every package ships the repository's LICENSE and NOTICE (Apache-2.0
    // §4(a), §4(d)); a package's LICENSE must equal the root file byte for
    // byte, its NOTICE must begin with the root file and list after it every
    // third-party package its code bundles (R6-2).
    /** @type {import('./lib/tarball.mjs').LegalFile[]} */
    const legal = [
      { label: 'LICENSE', data: readFileSync(path.join(REPO, 'LICENSE')) },
      { label: 'NOTICE', data: readFileSync(path.join(REPO, 'NOTICE')) },
    ];
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
      const file = givenFiles?.get(name) ?? pack(dir, name, tarballs);
      const skipped = nativeSkipReason(manifest, process.platform);
      if (skipped !== null) {
        // Not built on this host, so its contents cannot be checked here,
        // only that it carries the README, LICENSE and NOTICE (which need no
        // build); the tarball only satisfies optional dependencies on it,
        // offline.
        const entries = readTarGz(readFileSync(file));
        const paths = entries.map((entry) => entry.path);
        problems.push(
          ...[...checkRequiredFiles(paths), ...checkLegalFiles(entries, legal)].map(
            (problem) => `${name}: ${problem}`,
          ),
        );
        packed.push({ manifest, file, entryPoints: [], installable: false });
        process.stdout.write(`skipped ${name} (${skipped}; README, LICENSE and NOTICE checked)\n`);
        continue;
      }
      const result = checkTarball(manifest, readFileSync(file), forbidden, legal);
      problems.push(...result.problems.map((problem) => `${name}: ${problem}`));
      const installable = supportsPlatform(manifest, process.platform, process.arch);
      packed.push({ manifest, file, entryPoints: result.entryPoints, installable });
      process.stdout.write(
        `${givenFiles === null ? 'packed' : 'checked the given tarball of'} ${name}: ${String(result.paths.length)} files, ${String(result.entryPoints.length)} entry points${installable ? '' : ' (not installable on this platform: static checks only)'}\n`,
      );
    }

    const toInstall = packed.filter((entry) => entry.installable);
    const otherPlatform = packed.filter((entry) => !entry.installable);
    if (toInstall.length > 0) installAndImport(root, toInstall, otherPlatform, problems);

    if (problems.length > 0) {
      report(problems, `tarball check FAILED (${String(problems.length)} problem(s)):`);
      return 1;
    }
    process.stdout.write(
      given === null
        ? 'tarball check passed\n'
        : `tarball check passed over the tarballs in ${given}\n`,
    );
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
  // JS and JSON entry points are imported by their specifiers with Node's own
  // resolver, each pinned to the file the exports map names (R5-6).
  const imported = installed.flatMap(({ manifest, entryPoints }) =>
    entryPoints
      .filter((entry) => entry.kind === 'js' || entry.kind === 'json')
      .map((entry) => ({ ...entry, packageName: String(manifest.name) })),
  );
  const js = imported.filter((entry) => entry.kind === 'js');
  for (const { manifest, entryPoints } of installed) {
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
    env: {
      ...env,
      HUDHUD_TARBALL_SPECIFIERS: JSON.stringify(imported.map((entry) => entry.specifier)),
    },
  });
  const modulesUrl = `${pathToFileURL(modules).href}/`;
  problems.push(...checkImports(imported, parseImportResults(output), modulesUrl));
  process.stdout.write(
    `imported ${String(imported.length)} entry points (${String(js.length)} JS) from the installed tarballs\n`,
  );

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
 * The repository path of the release record the core's digest table names.
 *
 * @returns {string}
 */
function tableRecordPath() {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path.join(REPO, DIGESTS_MODULE), 'utf8');
  } catch (error) {
    throw new ToolError(
      `cannot read ${DIGESTS_MODULE} (${String(/** @type {{ code?: unknown }} */ (error).code ?? error)})`,
    );
  }
  const table = parseDigestsModule(text);
  if (table === null) throw new ToolError(`${DIGESTS_MODULE} is not a generated digest table`);
  return table.manifest;
}

/**
 * The `fixed` group of `.changeset/config.json`: the packages a release tag
 * names the version of (ADR-0004).
 *
 * @returns {string[]}
 */
function fixedGroup() {
  /** @type {unknown} */
  const config = JSON.parse(readFileSync(path.join(REPO, '.changeset', 'config.json'), 'utf8'));
  /** @type {unknown} */
  const fixed = typeof config === 'object' && config !== null ? Reflect.get(config, 'fixed') : [];
  if (!Array.isArray(fixed) || fixed.length > 1) {
    throw new ToolError('.changeset/config.json must have at most one fixed group');
  }
  /** @type {unknown} */
  const group = fixed[0] ?? [];
  if (!Array.isArray(group) || !group.every((name) => typeof name === 'string')) {
    throw new ToolError('.changeset/config.json: the fixed group is not a list of package names');
  }
  return /** @type {string[]} */ (group);
}

/**
 * The GitHub repository the release is published from: `GITHUB_REPOSITORY`
 * on Actions, else this checkout's `origin` remote.
 *
 * @returns {string | null}
 */
function publishingRepository() {
  const env = process.env['GITHUB_REPOSITORY'];
  if (env !== undefined && env !== '') return repositorySlug(env, undefined);
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    windowsHide: true,
  });
  return remote.status === 0 ? repositorySlug(undefined, remote.stdout) : null;
}

/**
 * Release modes: pack the core and the record's platform packages and check
 * the packed bytes against the release record (`--release-record`); for a
 * release tag (`--release-tag`), the record is the one the core's digest
 * table names, every package is packed, and the tag's versions, the private
 * flags, the changesets and the source links are checked too
 * (`checkReleaseTag`, `checkRepositoryFields`; ADR-0014 amendment 10).
 *
 * @param {string} given The record's repository path.
 * @param {string | null} tag The release tag, or null for the record alone.
 * @param {string | null} keep With a tag: the new directory that receives,
 *   once every check passed, the tarballs of the packages the release
 *   publishes (`--keep-tarballs`).
 * @returns {number}
 */
function releaseCheck(given, tag, keep) {
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
    /** @type {Map<string, string>} The tarball of each packed package directory. */
    const files = new Map();
    /** @param {string} dir */
    const packed = (dir) => {
      const source = path.join(REPO, dir);
      /** @type {unknown} */
      const parsed = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
      const name = String(/** @type {PackageJson} */ (parsed).name);
      const scripted = checkSourceManifest(/** @type {PackageJson} */ (parsed));
      if (scripted.length > 0) throw new ToolError(`${name}: ${scripted.join('; ')}`);
      const file = pack(source, name, tarballs);
      files.set(dir, file);
      try {
        return readTarGz(readFileSync(file));
      } catch (error) {
        throw new ToolError(
          `cannot read the tarball of ${name}: ${/** @type {Error} */ (error).message}`,
        );
      }
    };
    /** @type {Map<string, import('./lib/tarball.mjs').TarEntry[]>} */
    const packs = new Map();
    /** @param {string} dir */
    const packOnce = (dir) => {
      const known = packs.get(dir);
      if (known !== undefined) return known;
      const entries = packed(dir);
      packs.set(dir, entries);
      return entries;
    };
    const core = packOnce('packages/core');
    /** @type {Record<string, import('./lib/tarball.mjs').TarEntry[]>} */
    const platforms = {};
    for (const arch of Object.keys(manifest.arches).sort()) {
      const target = ARCHES[arch];
      if (target !== undefined) platforms[arch] = packOnce(target.packageDir);
    }
    const problems = checkReleaseRecord(manifest, manifestPath, { core, platforms });
    if (tag !== null) {
      const dirs = readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `packages/${entry.name}`)
        .filter((dir) => existsSync(path.join(REPO, dir, 'package.json')))
        .sort();
      const all = dirs.map((directory) => ({ directory, entries: packOnce(directory) }));
      problems.push(
        ...checkReleaseTag({
          tag,
          recordRelease: manifest.release,
          fixed: fixedGroup(),
          changesetFiles: readdirSync(path.join(REPO, '.changeset')),
          packs: all,
        }),
      );
      const slug = publishingRepository();
      for (const { directory, entries } of all) {
        const data = entries.find((entry) => entry.path === 'package.json')?.data;
        // checkReleaseTag above reports a missing or unreadable package.json.
        /** @type {PackageJson} */
        let packedManifest = {};
        try {
          if (data !== undefined) {
            /** @type {unknown} */
            const parsed = JSON.parse(data.toString('utf8'));
            packedManifest = /** @type {PackageJson} */ (parsed);
          }
        } catch {
          continue;
        }
        if (packedManifest.publishConfig === undefined) continue;
        if (slug === null) {
          problems.push(
            'the publishing repository is unknown (GITHUB_REPOSITORY unset and no https origin remote)',
          );
          break;
        }
        problems.push(
          ...checkRepositoryFields(packedManifest, directory, slug).map(
            (problem) => `${String(packedManifest.name)}: ${problem}`,
          ),
        );
      }
    }
    const what = tag === null ? 'release record check' : `release check of ${tag}`;
    if (problems.length > 0) {
      report(problems, `${what} FAILED against ${manifestPath}:`);
      return 1;
    }
    const lines = Object.keys(manifest.arches)
      .sort()
      .map((arch) => `${arch} sha256 ${String(manifest.arches[arch]?.sha256)}`);
    if (keep !== null) lines.push(...keepTarballs(keep, packs, files));
    report(
      lines,
      `${what} passed: the packed tarballs carry ${manifestPath} (version ${manifest.version})`,
    );
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

/**
 * Copies the checked tarballs of the packages a release publishes into a new
 * directory.
 *
 * @param {string} keep The directory; it must not exist yet.
 * @param {Map<string, import('./lib/tarball.mjs').TarEntry[]>} packs The
 *   packed entries by package directory.
 * @param {Map<string, string>} files The tarball by package directory.
 * @returns {string[]} one line per kept tarball
 */
function keepTarballs(keep, packs, files) {
  mkdirSync(path.dirname(keep), { recursive: true });
  try {
    mkdirSync(keep);
  } catch (error) {
    throw new ToolError(
      `cannot create ${keep} for the tarballs (${String(/** @type {{ code?: unknown }} */ (error).code ?? error)}); it must not exist`,
    );
  }
  /** @type {string[]} */
  const kept = [];
  for (const dir of [...packs.keys()].sort()) {
    const packedManifest = manifestOf(packs.get(dir) ?? []);
    const file = files.get(dir);
    if (packedManifest === undefined || file === undefined || !isPublished(packedManifest)) {
      continue;
    }
    copyFileSync(file, path.join(keep, path.basename(file)));
    kept.push(
      `kept ${path.basename(file)} (${String(packedManifest.name)}@${String(packedManifest.version)})`,
    );
  }
  if (kept.length === 0) throw new ToolError('no published package was packed: nothing to keep');
  return kept;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `tarball check: ${error instanceof ToolError ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
