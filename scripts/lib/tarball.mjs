// Pure logic of the tarball check (plan §4.1, §4.8; scripts/check-tarball.mjs
// supplies the I/O): reads the tarball `pnpm pack` made, checks its files and
// its manifest, lists the entry points to import and renders the type-check
// project. No file system, no process, no clock here.

import { gunzipSync } from 'node:zlib';

import {
  ADDON_FILE,
  DIGESTS_MODULE,
  parseDigestsModule,
  renderSha256Sums,
  sha256Hex,
} from './addon-digests.mjs';
import { scanText } from './privacy.mjs';

/**
 * @typedef {object} TarEntry
 * @property {string} path Path inside the package (the leading `package/` removed).
 * @property {Buffer} data
 * @property {number} mode
 */

/** Largest unpacked tarball the reader accepts (a published package is far below). */
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
/** Largest number of entries. */
export const MAX_ENTRIES = 20000;
/** Largest file that is scanned as text. */
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;

const BLOCK = 512;

/**
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} length
 * @returns {string}
 */
function field(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? length : nul).toString('utf8');
}

/**
 * @param {Buffer} header
 * @param {number} start
 * @param {number} length
 * @returns {number}
 */
function octal(header, start, length) {
  const text = field(header, start, length).trim();
  if (!/^[0-7]*$/u.test(text)) throw new Error('tar: bad number in a header');
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/**
 * @param {Buffer} header
 * @returns {boolean}
 */
function checksumMatches(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : /** @type {number} */ (header[i]);
  }
  return sum === octal(header, 148, 8);
}

/**
 * Parses the records of a pax extended header (`<len> <key>=<value>\n`).
 *
 * @param {Buffer} data
 * @returns {Map<string, string>}
 */
function paxRecords(data) {
  const records = /** @type {Map<string, string>} */ (new Map());
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10);
    if (
      space === -1 ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      offset + length > data.length
    ) {
      throw new Error('tar: malformed pax header');
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    offset += length;
  }
  return records;
}

/**
 * A path in a tarball is acceptable when it is relative, normalized and has
 * no `..`, empty or backslash segment (an unpacker must never write outside
 * its directory).
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isSafeEntryPath(path) {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0'))
    return false;
  if (/^[A-Za-z]:/u.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Reads a gzipped tar of an npm package: ustar headers with the `prefix`
 * field, pax (`x`, path only) and GNU long-name (`L`) records. Only regular
 * files and directories are accepted (a link or device in a package is a
 * defect); every file must lie under `package/`. Header checksums are
 * verified.
 *
 * @param {Buffer} gz
 * @returns {TarEntry[]} Regular files only, `package/` removed, in archive order.
 * @throws {Error} on anything malformed, unsafe or over the limits.
 */
export function readTarGz(gz) {
  const tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  /** @type {TarEntry[]} */
  const entries = [];
  /** @type {string | undefined} */
  let nextPath;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumMatches(header)) throw new Error('tar: header checksum mismatch');
    const size = octal(header, 124, 12);
    const flag = /** @type {number} */ (header[156]);
    const type = flag === 0 ? '0' : String.fromCharCode(flag);
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) throw new Error('tar: truncated entry');
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      nextPath = paxRecords(data).get('path');
    } else if (type === 'L') {
      nextPath = field(data, 0, data.length);
    } else if (type === 'g') {
      // global pax header: nothing we need
    } else if (type === '0' || type === '5') {
      const prefix = field(header, 345, 155);
      const name = field(header, 0, 100);
      const full = nextPath ?? (prefix === '' ? name : `${prefix}/${name}`);
      nextPath = undefined;
      const clean = type === '5' ? full.replace(/\/$/u, '') : full;
      if (!isSafeEntryPath(clean)) throw new Error('tar: unsafe path in an entry');
      if (clean !== 'package' && !clean.startsWith('package/')) {
        throw new Error('tar: an entry lies outside package/');
      }
      if (type === '0') {
        if (clean === 'package') throw new Error('tar: package is a file');
        entries.push({
          path: clean.slice('package/'.length),
          data: Buffer.from(data),
          mode: octal(header, 100, 8),
        });
        if (entries.length > MAX_ENTRIES) throw new Error('tar: too many entries');
      }
    } else {
      throw new Error(`tar: unsupported entry type ${JSON.stringify(type)}`);
    }
  }
  return entries;
}

// ---- manifest --------------------------------------------------------------

/**
 * @typedef {object} PackageJson
 * @property {string} [name]
 * @property {string} [version]
 * @property {boolean} [private]
 * @property {unknown} [exports]
 * @property {readonly string[]} [files]
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [optionalDependencies]
 * @property {Record<string, string>} [peerDependencies]
 * @property {Record<string, string>} [scripts]
 * @property {readonly string[]} [os]
 * @property {readonly string[]} [cpu]
 * @property {unknown} [bin]
 * @property {string} [main]
 * @property {string} [types]
 * @property {unknown} [publishConfig]
 */

/**
 * Whether a package is one the repository publishes: one that declares
 * `publishConfig` (the private flag is lifted at release time) or is not
 * private.
 *
 * @param {PackageJson} manifest
 * @returns {boolean}
 */
export function isPublishable(manifest) {
  return manifest.publishConfig !== undefined || manifest.private !== true;
}

/**
 * Whether a package installs on a platform (`os` and `cpu` of the manifest,
 * with npm's `!` negation).
 *
 * @param {PackageJson} manifest
 * @param {string} platform `process.platform`
 * @param {string} arch `process.arch`
 * @returns {boolean}
 */
export function supportsPlatform(manifest, platform, arch) {
  /** @param {readonly string[] | undefined} list @param {string} value */
  const allows = (list, value) => {
    if (list === undefined || list.length === 0) return true;
    if (list.includes(`!${value}`)) return false;
    const positives = list.filter((item) => !item.startsWith('!'));
    return positives.length === 0 || positives.includes(value);
  };
  return allows(manifest.os, platform) && allows(manifest.cpu, arch);
}

/**
 * Why a package is not checked on this host, or null when it must be: a
 * native platform package (an `exports` target is a `.node` file) whose `os`
 * list excludes the host cannot be built here (the Windows job addon is
 * built on win32 only). On a platform its `os` allows, it is checked like
 * any other package and a missing build is a problem.
 *
 * @param {PackageJson} manifest
 * @param {string} platform `process.platform`
 * @returns {string | null}
 */
export function nativeSkipReason(manifest, platform) {
  const map = manifest.exports;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return null;
  const native = Object.values(map).some((node) => pick(node, 'default')?.endsWith('.node'));
  const allowed = (manifest.os ?? []).filter((entry) => !entry.startsWith('!'));
  const osOnly = manifest.os === undefined ? {} : { os: manifest.os };
  if (!native || supportsPlatform(osOnly, platform, '')) return null;
  return `native, built on ${allowed.length > 0 ? allowed.join(', ') : 'another platform'} only`;
}

/** Lifecycle scripts a consumer's install runs. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/** Specifiers `pnpm pack` must have rewritten. */
const UNRESOLVED_SPEC = /^(?:(?:workspace|catalog|link|file|portal|github):|git\+)/u;

/**
 * Checks the manifest inside the tarball against the source manifest.
 *
 * @param {PackageJson} source
 * @param {PackageJson} packed
 * @returns {string[]} problems
 */
export function checkPackedManifest(source, packed) {
  /** @type {string[]} */
  const problems = [];
  if (packed.name !== source.name)
    problems.push(`package.json name ${String(packed.name)} differs from the source`);
  if (packed.version !== source.version) {
    problems.push(`package.json version ${String(packed.version)} differs from the source`);
  }
  for (const kind of /** @type {const} */ ([
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ])) {
    for (const [name, spec] of Object.entries(packed[kind] ?? {})) {
      if (UNRESOLVED_SPEC.test(spec))
        problems.push(`${kind}.${name} is still ${spec} (pack must resolve it)`);
    }
  }
  for (const script of INSTALL_SCRIPTS) {
    if (packed.scripts?.[script] !== undefined) {
      problems.push(`scripts.${script} would run on the consumer's install`);
    }
  }
  return problems;
}

/** A GitHub repository slug, `<owner>/<name>`. */
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;

/**
 * The GitHub repository the packages are published from, as `<owner>/<name>`:
 * `GITHUB_REPOSITORY` on GitHub Actions, else the `origin` remote's URL
 * (`https://github.com/<owner>/<name>[.git]`; an SSH remote is not read).
 * The slug is never committed: the repository's privacy denylist covers the
 * owner's name, so the check reads it from where the publish runs.
 *
 * @param {string | undefined} githubRepository `GITHUB_REPOSITORY`
 * @param {string | undefined} originUrl `git remote get-url origin`
 * @returns {string | null}
 */
export function repositorySlug(githubRepository, originUrl) {
  if (githubRepository !== undefined && githubRepository !== '') {
    return SLUG.test(githubRepository) ? githubRepository : null;
  }
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u.exec(
    originUrl?.trim() ?? '',
  );
  const slug = match?.[1];
  return slug !== undefined && SLUG.test(slug) ? slug : null;
}

/**
 * Checks the source links of a published package's manifest: `repository`
 * (git, the repository it is published from, the package's directory),
 * `homepage` and `bugs`. npm trusted publishing requires `repository.url`
 * to "exactly match your GitHub repository" (docs.npmjs.com, "Trusted
 * publishing for npm packages", read 2026-10-17), and provenance
 * verification compares it with the source repository of the build; the
 * package pages link the source and the issue tracker through these fields
 * (review findings R6-4, R7-3).
 *
 * @param {PackageJson} manifest
 * @param {string} directory The package's directory in the repository (`packages/core`).
 * @param {string} slug The repository, `<owner>/<name>` ({@link repositorySlug}).
 * @returns {string[]} problems
 */
export function checkRepositoryFields(manifest, directory, slug) {
  const url = `git+https://github.com/${slug}.git`;
  const web = `https://github.com/${slug}`;
  /** @type {string[]} */
  const problems = [];
  /**
   * @param {unknown} value
   * @param {string} key
   * @returns {unknown}
   */
  const field = (value, key) =>
    typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  /** @type {unknown} */
  const repository = Reflect.get(manifest, 'repository');
  if (
    field(repository, 'type') !== 'git' ||
    field(repository, 'url') !== url ||
    field(repository, 'directory') !== directory
  ) {
    problems.push(
      `package.json repository must be { type: "git", url: "${url}", directory: "${directory}" }, is ${JSON.stringify(repository)}`,
    );
  }
  const homepage = `${web}/tree/main/${directory}#readme`;
  /** @type {unknown} */
  const actualHomepage = Reflect.get(manifest, 'homepage');
  if (actualHomepage !== homepage) {
    problems.push(
      `package.json homepage must be ${homepage}, is ${JSON.stringify(actualHomepage)}`,
    );
  }
  /** @type {unknown} */
  const bugs = Reflect.get(manifest, 'bugs');
  if (field(bugs, 'url') !== `${web}/issues`) {
    problems.push(`package.json bugs.url must be ${web}/issues, is ${JSON.stringify(bugs)}`);
  }
  return problems;
}

// ---- files -----------------------------------------------------------------

/**
 * Files every package must carry. LICENSE and NOTICE are the repository's
 * own (Apache-2.0 §4(a) and §4(d)); {@link checkLegalFiles} compares their
 * bytes with the repository's.
 */
const REQUIRED_FILES = [
  { label: 'README', pattern: /^README(?:\.[A-Za-z]+)?$/u },
  { label: 'LICENSE', pattern: /^LICEN[CS]E(?:\.[A-Za-z]+)?$/u },
  { label: 'NOTICE', pattern: /^NOTICE(?:\.[A-Za-z]+)?$/u },
];

/**
 * Reports each of README, LICENSE and NOTICE that no path names.
 *
 * @param {readonly string[]} paths Paths inside the package.
 * @returns {string[]} problems
 */
export function checkRequiredFiles(paths) {
  return REQUIRED_FILES.filter(({ pattern }) => !paths.some((path) => pattern.test(path))).map(
    ({ label }) => `${label} is missing`,
  );
}

/**
 * @typedef {object} LegalFile
 * @property {'LICENSE' | 'NOTICE'} label
 * @property {Buffer} data The repository's own file.
 */

/**
 * Compares every LICENSE and NOTICE file of a tarball (any spelling the
 * required-files check accepts) with the repository's bytes, so a package's
 * copy cannot drift from the root file: a LICENSE must equal the root file,
 * a NOTICE must begin with it. After the root text, a package's NOTICE lists
 * the third-party code that package includes, with its license notice
 * (review finding R6-2; {@link checkBundledNotices}). A missing file is
 * reported by {@link checkRequiredFiles}, not here.
 *
 * @param {readonly TarEntry[]} entries
 * @param {readonly LegalFile[]} legal
 * @returns {string[]} problems
 */
export function checkLegalFiles(entries, legal) {
  /** @type {string[]} */
  const problems = [];
  for (const { label, data } of legal) {
    const required = REQUIRED_FILES.find((file) => file.label === label);
    if (required === undefined) throw new Error(`not a legal file: ${label}`);
    for (const entry of entries.filter(({ path }) => required.pattern.test(path))) {
      if (label === 'LICENSE' && !entry.data.equals(data)) {
        problems.push(`${entry.path} differs from the repository's ${label}`);
      }
      if (label === 'NOTICE' && !entry.data.subarray(0, data.length).equals(data)) {
        problems.push(`${entry.path} does not begin with the repository's ${label}`);
      }
    }
  }
  return problems;
}

/**
 * The marker esbuild writes above each module it bundles from a dependency
 * (`// node_modules/<package>/<file>`), as the generated validators carry
 * it; group 1 is the package name, scoped or not.
 */
const BUNDLED_MODULE = /^\/\/ node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gmu;

/**
 * The third-party packages whose code a text bundles, by esbuild's
 * `// node_modules/<package>/` markers, sorted and unique.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function bundledPackages(text) {
  return [...new Set([...text.matchAll(BUNDLED_MODULE)].map((match) => String(match[1])))].sort();
}

/**
 * Requires the package's NOTICE to list every third-party package whose
 * code its JavaScript or TypeScript files bundle, under a `--- <package> ---`
 * heading followed by that package's license text (review finding R6-2: the
 * MIT License asks for its notice in all copies or substantial portions).
 * `scripts/test/package-legal.test.ts` compares the license texts with the
 * installed packages' own.
 *
 * @param {readonly TarEntry[]} entries
 * @returns {string[]} problems
 */
export function checkBundledNotices(entries) {
  const notice = entries.find((entry) => entry.path === 'NOTICE')?.data.toString('utf8') ?? '';
  /** @type {Map<string, string>} */
  const firstFile = new Map();
  for (const entry of entries) {
    if (!/\.(?:[cm]?js|[cm]?ts)$/u.test(entry.path) || !looksLikeText(entry.data)) continue;
    for (const name of bundledPackages(entry.data.toString('utf8'))) {
      if (!firstFile.has(name)) firstFile.set(name, entry.path);
    }
  }
  return [...firstFile]
    .filter(([name]) => !notice.includes(`\n--- ${name} ---\n`))
    .map(
      ([name, path]) =>
        `${path} bundles code of ${name}, which NOTICE does not list (--- ${name} --- and its license)`,
    );
}

/** Root files npm always packs, whatever `files` says. */
const ALWAYS_TOP =
  /^(?:package\.json|README(?:\.[A-Za-z]+)?|LICEN[CS]E(?:\.[A-Za-z]+)?|CHANGELOG(?:\.[A-Za-z]+)?|NOTICE(?:\.[A-Za-z]+)?)$/u;

const FORBIDDEN_PATHS = [
  {
    label: 'a test, fixture or tooling directory',
    pattern:
      /(?:^|\/)(?:test|tests|__tests__|__mocks__|conformance|fixtures|coverage|\.cache|\.github|\.changeset|\.githooks|node_modules)(?:\/|$)/u,
  },
  { label: 'a test file', pattern: /\.(?:test|spec)\.[cm]?[jt]sx?(?:\.map)?$/u },
  { label: 'TypeScript build info', pattern: /\.tsbuildinfo$/u },
  { label: 'the schema baseline', pattern: /(?:^|\/)\.baseline(?:\/|$)/u },
  { label: 'an environment file', pattern: /(?:^|\/)\.env(?:\.|$)/u },
  {
    label: 'a key or certificate file',
    pattern: /\.(?:pem|key|p12|pfx|crt|cer)$|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/u,
  },
  { label: 'a log file', pattern: /\.log$/u },
  { label: 'an editor or OS file', pattern: /(?:^|\/)(?:\.DS_Store|Thumbs\.db)$|~$|\.sw[op]$/u },
  { label: 'a git or npm configuration file', pattern: /(?:^|\/)\.(?:git|npm)[A-Za-z]*$/u },
];

/**
 * Whether a `files` entry (a path, a directory or a simple glob) covers a path.
 *
 * @param {string} pattern `files` entry without a leading `!` or `./`
 * @param {string} path
 * @returns {boolean}
 */
export function coversPath(pattern, path) {
  const clean = pattern.replace(/\/+$/u, '');
  if (!clean.includes('*')) return path === clean || path.startsWith(`${clean}/`);
  const source = clean
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${source}(?:/|$)`, 'u').test(path);
}

/** @param {string} entry @returns {string} */
const stripDot = (entry) => entry.replace(/^\.\//u, '');

/**
 * Checks the list of files in the tarball.
 *
 * @param {PackageJson} manifest Source manifest (its `files` is the allowlist).
 * @param {readonly string[]} paths Paths inside the package.
 * @returns {string[]} problems
 */
export function checkFileList(manifest, paths) {
  /** @type {string[]} */
  const problems = [];
  if (!paths.includes('package.json')) problems.push('package.json is missing');
  problems.push(...checkRequiredFiles(paths));
  const listed = (manifest.files ?? []).map(stripDot);
  const positive = listed.filter((entry) => !entry.startsWith('!'));
  const negative = listed.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1));
  for (const entry of positive) {
    if (!paths.some((path) => coversPath(entry, path))) {
      problems.push(`files entry ${entry} matches nothing in the tarball (not built?)`);
    }
  }
  for (const path of paths) {
    const forbidden = FORBIDDEN_PATHS.find(({ pattern }) => pattern.test(path));
    if (forbidden !== undefined) problems.push(`${path}: ${forbidden.label}`);
    const allowed =
      ALWAYS_TOP.test(path) ||
      (positive.some((entry) => coversPath(entry, path)) &&
        !negative.some((entry) => coversPath(entry, path)));
    if (!allowed) problems.push(`${path}: not covered by the files allowlist`);
  }
  return problems;
}

// ---- source maps -----------------------------------------------------------

/**
 * Resolves `relative` against the directory of `from` in a package-relative,
 * forward-slash namespace.
 *
 * @param {string} from Package-relative path of a file.
 * @param {string} relative
 * @returns {string | null} The package-relative path, or null when it
 *   escapes the package.
 */
export function resolveInside(from, relative) {
  /** @type {string[]} */
  const stack = from.split('/').slice(0, -1);
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else stack.push(segment);
  }
  return stack.join('/');
}

/**
 * Checks the `sources` of a source map: relative, inside the package, no
 * machine path, and packed. The packages ship their maps and their `src`
 * (go-to-definition and stack traces point at the TypeScript sources), so a
 * map whose source is not in the tarball is broken for every user, for
 * example when `src` drops out of `files` (review finding R7-6).
 *
 * @param {string} mapPath Package-relative path of the `.map` file.
 * @param {string} text Its content.
 * @param {ReadonlySet<string>} packed Every package-relative path in the tarball.
 * @returns {string[]} problems
 */
export function checkSourceMap(mapPath, text, packed) {
  /** @type {unknown} */
  let map;
  try {
    map = JSON.parse(text);
  } catch {
    return [`${mapPath}: not valid JSON`];
  }
  if (typeof map !== 'object' || map === null) return [`${mapPath}: not a source map`];
  /** @type {unknown} */
  const sources = Reflect.get(map, 'sources');
  /** @type {unknown} */
  const root = Reflect.get(map, 'sourceRoot');
  if (!Array.isArray(sources)) return [`${mapPath}: no sources list`];
  /** @type {string[]} */
  const problems = [];
  if (typeof root === 'string' && root !== '') problems.push(`${mapPath}: has a sourceRoot`);
  for (const source of /** @type {unknown[]} */ (sources)) {
    if (typeof source !== 'string') {
      problems.push(`${mapPath}: a source is not a string`);
    } else if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|\\)/u.test(source) || source.includes('\\')) {
      problems.push(`${mapPath}: absolute or non-portable source ${JSON.stringify(source)}`);
    } else {
      const resolved = resolveInside(mapPath, source);
      if (resolved === null) {
        problems.push(`${mapPath}: source ${JSON.stringify(source)} lies outside the package`);
      } else if (!packed.has(resolved)) {
        problems.push(
          `${mapPath}: source ${JSON.stringify(source)} (${resolved}) is not in the tarball`,
        );
      }
    }
  }
  return problems;
}

// ---- content ---------------------------------------------------------------

/**
 * @param {Buffer} data
 * @returns {boolean} Whether the file looks like text (no NUL in its first 8000 bytes).
 */
export function looksLikeText(data) {
  return !data.subarray(0, 8000).includes(0);
}

/**
 * The spellings of a forbidden string that can appear in a text file: as
 * given, with forward slashes and JSON-escaped, lower-cased.
 *
 * @param {string} forbidden
 * @returns {string[]}
 */
function spellings(forbidden) {
  return [forbidden, forbidden.replaceAll('\\', '/'), JSON.stringify(forbidden).slice(1, -1)].map(
    (text) => text.toLowerCase(),
  );
}

/**
 * Scans the files of a tarball for what must not be published: the
 * repository's privacy rules (home-directory paths, credentials, personal
 * e-mail addresses) and the exact strings of this machine (the checkout, the
 * home directory, the temporary directories). Findings name the file, line
 * and rule; the text found is never repeated.
 *
 * @param {readonly TarEntry[]} entries
 * @param {readonly string[]} forbidden Paths and strings of this machine.
 * @returns {string[]} problems
 */
export function scanEntries(entries, forbidden) {
  /** @type {string[]} */
  const problems = [];
  const needles = forbidden.filter((entry) => entry !== '').flatMap((entry) => spellings(entry));
  for (const entry of entries) {
    if (!looksLikeText(entry.data)) continue;
    if (entry.data.length > MAX_SCAN_BYTES) {
      problems.push(`${entry.path}: too large to scan (${String(entry.data.length)} bytes)`);
      continue;
    }
    const text = entry.data.toString('utf8');
    for (const finding of scanText(entry.path, text, [])) {
      problems.push(`${entry.path}:${String(finding.line)}: privacy rule ${finding.rule}`);
    }
    const lower = text.toLowerCase();
    if (needles.some((needle) => lower.includes(needle))) {
      problems.push(`${entry.path}: contains a path or string of the build machine`);
    }
  }
  return problems;
}

// ---- exports ---------------------------------------------------------------

/**
 * @typedef {object} EntryPoint
 * @property {string} specifier What a consumer imports.
 * @property {'js' | 'json' | 'native'} kind `native`: a Node-API addon (`.node`),
 *   which is loaded with `process.dlopen`, never imported.
 * @property {string} [runtime] Package-relative file the runtime import resolves to.
 * @property {string} [types] Package-relative declaration file (the `types` condition).
 */

/**
 * @param {string} runtime
 * @returns {EntryPoint['kind']}
 */
function entryKind(runtime) {
  if (runtime.endsWith('.json')) return 'json';
  return runtime.endsWith('.node') ? 'native' : 'js';
}

/** Conditions that only group others: looked through when the wanted one is absent. */
const PASS_THROUGH_CONDITIONS = ['import', 'node', 'default'];

/**
 * @param {unknown} node
 * @param {string} condition `types` or `default`
 * @returns {string | undefined} The target a condition names, looking through nested conditions.
 */
function pick(node, condition) {
  if (typeof node === 'string') return condition === 'default' ? node : undefined;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
  if (condition in node) {
    /** @type {unknown} */
    const value = Reflect.get(node, condition);
    return typeof value === 'string' ? value : pick(value, condition);
  }
  for (const key of PASS_THROUGH_CONDITIONS) {
    if (key in node) {
      const found = pick(Reflect.get(node, key), condition);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Lists the entry points of the `exports` map. Patterns (`./schemas/*`) are
 * expanded against the files of the tarball. An entry whose target is
 * missing from the tarball is a problem.
 *
 * @param {PackageJson} manifest
 * @param {readonly string[]} paths Paths inside the package.
 * @returns {{ entries: EntryPoint[], problems: string[] }}
 */
export function listEntryPoints(manifest, paths) {
  /** @type {EntryPoint[]} */
  const entries = [];
  /** @type {string[]} */
  const problems = [];
  const name = String(manifest.name);
  const map = manifest.exports;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return { entries, problems: ['exports must be an object of subpaths'] };
  }
  for (const [subpath, node] of Object.entries(map)) {
    const runtime = pick(node, 'default');
    const types = pick(node, 'types');
    if (!subpath.startsWith('.')) {
      problems.push(`exports key ${subpath} is not a subpath`);
      continue;
    }
    const base = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
    if (runtime === undefined) {
      problems.push(`exports ${subpath} has no default target`);
      continue;
    }
    const target = stripDot(runtime);
    if (subpath.includes('*')) {
      const [subHead = '', subTail = ''] = subpath.slice(2).split('*');
      const [tHead = '', tTail = ''] = target.split('*');
      const matches = paths.filter(
        (path) =>
          path.startsWith(tHead) &&
          path.endsWith(tTail) &&
          path.length >= tHead.length + tTail.length,
      );
      if (matches.length === 0) problems.push(`exports ${subpath} matches no file`);
      for (const path of matches) {
        const star = path.slice(tHead.length, path.length - tTail.length);
        entries.push({
          specifier: `${name}/${subHead}${star}${subTail}`,
          kind: entryKind(runtime),
          runtime: path,
        });
      }
    } else {
      const kind = entryKind(runtime);
      if (!paths.includes(target))
        problems.push(`exports ${subpath}: ${target} is not in the tarball`);
      /** @type {EntryPoint} */
      const entry = { specifier: base, kind, runtime: target };
      if (types !== undefined) {
        const typesTarget = stripDot(types);
        if (!paths.includes(typesTarget)) {
          problems.push(`exports ${subpath}: types ${typesTarget} is not in the tarball`);
        }
        entry.types = typesTarget;
      }
      entries.push(entry);
    }
  }
  if (entries.length === 0 && problems.length === 0) problems.push('exports lists no entry point');
  return { entries, problems };
}

// ---- one tarball -----------------------------------------------------------

/** Scripts `pnpm pack` runs in the repository before it packs. */
const PACK_SCRIPTS = ['prepack', 'prepare', 'prepublish', 'prepublishOnly', 'postpack'];

/**
 * Refuses a package whose packing would run scripts: the check packs what
 * the manifest declares and must not execute package code to do so.
 *
 * @param {PackageJson} source
 * @returns {string[]} problems
 */
export function checkSourceManifest(source) {
  return PACK_SCRIPTS.filter((script) => source.scripts?.[script] !== undefined).map(
    (script) => `scripts.${script} would run while packing`,
  );
}

/**
 * @typedef {object} TarballReport
 * @property {string[]} problems
 * @property {string[]} paths Paths inside the package.
 * @property {EntryPoint[]} entryPoints
 */

/**
 * All static checks of one tarball: manifest, file list, source maps,
 * content and entry points.
 *
 * @param {PackageJson} source The package's own `package.json`.
 * @param {Buffer} gz The tarball.
 * @param {readonly string[]} forbidden Paths and strings of this machine.
 * @param {readonly LegalFile[]} [legal] The repository's LICENSE and NOTICE,
 *   which the tarball's copies must equal.
 * @returns {TarballReport}
 */
export function checkTarball(source, gz, forbidden, legal = []) {
  /** @type {TarEntry[]} */
  let entries;
  try {
    entries = readTarGz(gz);
  } catch (error) {
    return {
      problems: [`cannot read the tarball: ${/** @type {Error} */ (error).message}`],
      paths: [],
      entryPoints: [],
    };
  }
  const paths = entries.map((entry) => entry.path);
  /** @type {string[]} */
  const problems = [
    ...checkFileList(source, paths),
    ...checkLegalFiles(entries, legal),
    ...checkBundledNotices(entries),
  ];
  const manifestEntry = entries.find((entry) => entry.path === 'package.json');
  /** @type {PackageJson | undefined} */
  let packed;
  if (manifestEntry !== undefined) {
    try {
      /** @type {unknown} */
      const parsed = JSON.parse(manifestEntry.data.toString('utf8'));
      packed = /** @type {PackageJson} */ (parsed);
    } catch {
      problems.push('package.json is not valid JSON');
    }
  }
  if (packed !== undefined) problems.push(...checkPackedManifest(source, packed));
  const packedPaths = new Set(paths);
  for (const entry of entries) {
    if (entry.path.endsWith('.map')) {
      problems.push(...checkSourceMap(entry.path, entry.data.toString('utf8'), packedPaths));
    }
  }
  problems.push(...scanEntries(entries, forbidden));
  const listed = listEntryPoints(packed ?? source, paths);
  problems.push(...listed.problems);
  return { problems, paths, entryPoints: listed.entries };
}

// ---- consumer project ------------------------------------------------------

/**
 * Source of the child process that imports every JS entry point with Node's
 * own resolver, as a consumer's ESM code would, and reports the file each
 * resolved to (package-relative to `node_modules`) and its export names.
 * The specifiers arrive in `HUDHUD_TARBALL_SPECIFIERS` (JSON).
 */
export const IMPORT_CHILD = `
const specifiers = JSON.parse(process.env.HUDHUD_TARBALL_SPECIFIERS);
const results = {};
for (const specifier of specifiers) {
  try {
    const url = import.meta.resolve(specifier);
    const namespace = await import(specifier);
    results[specifier] = { ok: true, url, names: Object.keys(namespace).sort() };
  } catch (error) {
    results[specifier] = { ok: false, code: String(error?.code ?? error) };
  }
}
process.stdout.write(JSON.stringify(results));
`;

/**
 * @typedef {object} ImportResult
 * @property {boolean} ok
 * @property {string} [url]
 * @property {string[]} [names]
 * @property {string} [code]
 */

/**
 * Reads the output of {@link IMPORT_CHILD}.
 *
 * @param {string} stdout
 * @returns {Record<string, ImportResult>}
 * @throws {Error} when the output is not what the child writes.
 */
export function parseImportResults(stdout) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('the import child wrote no JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the import child wrote an unexpected result');
  }
  /** @type {Record<string, ImportResult>} */
  const results = {};
  for (const [specifier, value] of /** @type {[string, unknown][]} */ (Object.entries(parsed))) {
    if (typeof value !== 'object' || value === null) {
      throw new Error('the import child wrote an unexpected result');
    }
    results[specifier] = /** @type {ImportResult} */ (value);
  }
  return results;
}

/**
 * Judges the import results: each JS entry point must import, and the file
 * must lie under the project's `node_modules` (never the repository).
 *
 * @param {readonly EntryPoint[]} entries JS entry points that were imported.
 * @param {Record<string, ImportResult>} results
 * @param {string} modulesUrl `file:` URL of the project's `node_modules/`.
 * @returns {string[]} problems
 */
export function checkImports(entries, results, modulesUrl) {
  /** @type {string[]} */
  const problems = [];
  for (const entry of entries) {
    const result = results[entry.specifier];
    if (result === undefined) problems.push(`${entry.specifier}: not imported`);
    else if (!result.ok)
      problems.push(`${entry.specifier}: import failed (${String(result.code)})`);
    else if (typeof result.url !== 'string' || !result.url.startsWith(modulesUrl)) {
      problems.push(`${entry.specifier}: resolved outside the installed packages`);
    } else if ((result.names ?? []).length === 0) {
      problems.push(`${entry.specifier}: exports nothing`);
    }
  }
  return problems;
}

/**
 * The files of the consumer's TypeScript project: strict, NodeNext (so the
 * `exports` map and its `types` condition decide), declarations checked
 * (`skipLibCheck` off), importing every JS entry point. A specifier without
 * resolvable declarations is an implicit-any error.
 *
 * @param {readonly string[]} specifiers
 * @param {string} typeRoot Directory holding `node` types (`@types` of the repository).
 * @returns {{ tsconfig: string, source: string }}
 */
export function renderTypeProject(specifiers, typeRoot) {
  const tsconfig = JSON.stringify(
    {
      compilerOptions: {
        target: 'es2024',
        lib: ['es2024'],
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        verbatimModuleSyntax: true,
        types: ['node'],
        typeRoots: [typeRoot],
      },
      files: ['check.ts'],
    },
    null,
    2,
  );
  const lines = specifiers.map(
    (specifier, index) => `import * as m${String(index)} from ${JSON.stringify(specifier)};`,
  );
  const names = specifiers.map((_specifier, index) => `m${String(index)}`).join(', ');
  return {
    tsconfig: `${tsconfig}\n`,
    source: `${lines.join('\n')}\nexport const all = [${names}];\n`,
  };
}

/**
 * Environment of the install and type-check children: nothing of the
 * caller's (no tokens, no registry configuration), only what a tool needs to
 * run. npm configuration files point at empty files in the temporary root.
 *
 * @param {Record<string, string | undefined>} parent
 * @param {string} root Temporary root (holds the empty configs and the cache).
 * @param {string} platform
 * @returns {Record<string, string>}
 */
export function cleanEnv(parent, root, platform) {
  /** @type {Record<string, string>} */
  const env = {
    npm_config_userconfig: `${root}/user.npmrc`,
    npm_config_globalconfig: `${root}/global.npmrc`,
    npm_config_cache: `${root}/npm-cache`,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    HOME: root,
    TMPDIR: root,
  };
  const keep =
    platform === 'win32'
      ? ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'WINDIR']
      : ['PATH', 'LANG', 'LC_ALL'];
  for (const name of keep) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  if (platform === 'win32') {
    env['USERPROFILE'] = root;
    env['TEMP'] = root;
    env['TMP'] = root;
    env['APPDATA'] = `${root}/appdata`;
    env['LOCALAPPDATA'] = `${root}/localappdata`;
  }
  return env;
}

/**
 * Whether the temporary root is acceptable: not inside the repository and
 * with no ancestor that would change how the project resolves packages.
 *
 * @param {string} root Absolute path.
 * @param {string} repo Absolute path of the repository.
 * @param {(dir: string) => boolean} hasResolutionMarker Whether `dir` holds
 *   a `package.json` or a `node_modules`.
 * @param {(a: string, b: string) => boolean} inside Whether `a` is inside `b`.
 * @param {(dir: string) => string} parentOf
 * @returns {string | null} The reason it is not, or null.
 */
export function rootProblem(root, repo, hasResolutionMarker, inside, parentOf) {
  if (inside(root, repo)) return 'the temporary root lies inside the repository';
  for (let dir = parentOf(root); ; dir = parentOf(dir)) {
    if (hasResolutionMarker(dir)) {
      return `an ancestor of the temporary root (${dir}) has a package.json or node_modules; set HUDHUD_TEST_ROOT to a clean directory`;
    }
    if (parentOf(dir) === dir) return null;
  }
}

// ---- release record (plan §6.3 phase 2) -------------------------------------

/** The core's package directory, the prefix of {@link DIGESTS_MODULE}. */
const CORE_DIR = 'packages/core/';

/** The digest table's source inside the core's tarball. */
export const DIGESTS_SOURCE = DIGESTS_MODULE.slice(CORE_DIR.length);

/** The digest table's compiled module inside the core's tarball (what the loader imports). */
export const DIGESTS_BUILD = DIGESTS_SOURCE.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '.js');

/**
 * Reads the digest table from its compiled module: the `tsc` output of the
 * generated table, exactly one `WIN32_JOB_DIGESTS` object with `version`
 * and `x64`. Anything else is null.
 *
 * @param {string} text
 * @returns {{ version: string, x64: string } | null}
 */
export function parseCompiledDigests(text) {
  const matches = [
    ...text.matchAll(
      /^export const WIN32_JOB_DIGESTS = Object\.freeze\(\{\n {4}version: '([^'\n]*)',\n {4}x64: '([^'\n]*)',\n\}\);$/gmu,
    ),
  ];
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) return null;
  return { version: String(match[1]), x64: String(match[2]) };
}

/**
 * @param {readonly TarEntry[]} entries
 * @param {string} path
 * @returns {Buffer | undefined}
 */
function fileIn(entries, path) {
  return entries.find((entry) => entry.path === path)?.data;
}

/**
 * @param {readonly TarEntry[]} entries
 * @returns {PackageJson | undefined}
 */
function packedManifest(entries) {
  const data = fileIn(entries, 'package.json');
  if (data === undefined) return undefined;
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(data.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? /** @type {PackageJson} */ (parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The release check of the packed tarballs (plan §6.3 phase 2): the bytes a
 * release would publish must equal the release record.
 *
 * - Each platform package of the record carries the addon with the record's
 *   sha256 and size, and a `SHA256SUMS` naming that sha256.
 * - The core carries the digest table written from this record, in its
 *   source and in its compiled module (`dist`, what the loader imports).
 * - The core's optional dependency on the x64 package is that package's
 *   exact packed version, so it resolves to these bytes; arm64 is not a
 *   dependency (K17).
 *
 * @param {import('./addon-digests.mjs').Manifest} manifest The record.
 * @param {string} manifestPath Its repository path, as the table names it.
 * @param {{ core: readonly TarEntry[], platforms: Readonly<Record<string, readonly TarEntry[]>> }} packs
 * @returns {string[]} problems, each naming both values
 */
export function checkReleaseRecord(manifest, manifestPath, packs) {
  /** @type {string[]} */
  const problems = [];
  const core = packedManifest(packs.core);
  if (core === undefined) problems.push('@hudhudjs/core: the tarball has no readable package.json');
  const optional = core?.optionalDependencies ?? {};
  for (const arch of Object.keys(manifest.arches).sort()) {
    const record = /** @type {import('./addon-digests.mjs').ReleaseArch} */ (manifest.arches[arch]);
    const label = `the ${arch} platform package`;
    const entries = packs.platforms[arch];
    if (entries === undefined) {
      problems.push(`${label} was not packed`);
      continue;
    }
    const addon = fileIn(entries, ADDON_FILE);
    if (addon === undefined) {
      problems.push(`${label}: the tarball has no ${ADDON_FILE}`);
    } else {
      const sha256 = sha256Hex(addon);
      if (sha256 !== record.sha256 || addon.length !== record.size) {
        problems.push(
          `${label}: ${ADDON_FILE} in the tarball is sha256 ${sha256} size ${String(addon.length)}, ${manifestPath} records sha256 ${record.sha256} size ${String(record.size)}`,
        );
      }
    }
    if (fileIn(entries, 'SHA256SUMS')?.toString('utf8') !== renderSha256Sums(record.sha256)) {
      problems.push(`${label}: SHA256SUMS in the tarball does not name ${record.sha256} alone`);
    }
    const platform = packedManifest(entries);
    const name = platform?.name;
    const version = platform?.version;
    if (typeof name !== 'string' || typeof version !== 'string') {
      problems.push(`${label}: the tarball's package.json has no name and version`);
    } else if (arch === 'x64') {
      if (optional[name] !== version) {
        problems.push(
          `@hudhudjs/core: optionalDependencies.${name} is ${String(optional[name])}, the packed ${name} is ${version}`,
        );
      }
    } else if (Object.hasOwn(optional, name)) {
      problems.push(`@hudhudjs/core: lists ${name} as an optional dependency (K17: x64 only)`);
    }
  }

  const x64 = manifest.arches['x64']?.sha256;
  const want = `version ${manifest.version}, x64 ${String(x64)}`;
  const source = fileIn(packs.core, DIGESTS_SOURCE);
  const table = source === undefined ? null : parseDigestsModule(source.toString('utf8'));
  if (table === null) {
    problems.push(`@hudhudjs/core: ${DIGESTS_SOURCE} is missing or not a generated table`);
  } else if (
    table.version !== manifest.version ||
    table.x64 !== x64 ||
    table.manifest !== manifestPath
  ) {
    problems.push(
      `@hudhudjs/core: ${DIGESTS_SOURCE} holds version ${table.version}, x64 ${table.x64} from ${table.manifest}; ${manifestPath} records ${want}`,
    );
  }
  const built = fileIn(packs.core, DIGESTS_BUILD);
  const compiled = built === undefined ? null : parseCompiledDigests(built.toString('utf8'));
  if (compiled === null) {
    problems.push(
      `@hudhudjs/core: ${DIGESTS_BUILD} is missing or not the compiled table (build first)`,
    );
  } else if (compiled.version !== manifest.version || compiled.x64 !== x64) {
    problems.push(
      `@hudhudjs/core: ${DIGESTS_BUILD} holds version ${compiled.version}, x64 ${compiled.x64}; ${manifestPath} records ${want}`,
    );
  }
  return problems;
}
