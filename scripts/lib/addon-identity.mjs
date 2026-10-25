// The input identity of a job addon build (diagnostic only; ADR-0014
// amendment 14). native/win32-job/build.mjs records, next to the toolchain
// fields that can change the bytes, the files the build actually read: the
// sha256 of every file the compiler, the linker and lib.exe read under the
// MSVC toolset, the Windows SDK and node-api-headers (from MSBuild's
// FileTracker `*.read.*.tlog`), plus cl.exe, c1.dll, c2.dll, link.exe and
// lib.exe themselves, the Visual Studio instance version and the Windows SDK
// servicing build.
//
// The gate is always the output bytes. The identity only explains a
// mismatch: when a rebuild does not reproduce a record, the tools name the
// inputs that differ (run 40161785779: an SDK servicing update changed
// kernel32.lib under the unchanged 10.0.26100.0 directory). Pure logic; the
// caller reads the tlogs and hashes the files.

/**
 * @typedef {object} Identity
 * @property {string} visualStudio The Visual Studio instance's installationVersion.
 * @property {string} windowsSdkBuild The pinned SDK's servicing build (`10.1.26100.7705`), or `unpinned`.
 * @property {Readonly<Record<string, string>>} files sha256 by input key (see {@link identityKey}).
 */

/**
 * @typedef {object} IdentityRoot
 * @property {string} name The key prefix (`msvc`, `sdk`, `node-api-headers`).
 * @property {string} dir Absolute directory (any case, with or without a trailing separator).
 */

/** The key prefixes of an identity, in the order they are tried. */
export const IDENTITY_PREFIXES = Object.freeze(['msvc', 'sdk', 'node-api-headers', 'other']);

/** At most this many inputs: a guard against a runaway tlog, not a budget. */
export const MAX_IDENTITY_FILES = 4000;

/** The byte order mark a tlog decoded from UTF-16LE may start with. */
const BOM = String.fromCharCode(0xfeff);
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION4 = /^\d{1,5}\.\d{1,5}\.\d{1,7}\.\d{1,7}$/u;
/**
 * An input key: a prefix, then a lower-case relative path with `/`; no
 * segment is empty or starts with a dot (so none is `.` or `..`).
 */
const KEY = /^(?:msvc|sdk|node-api-headers|other)(?:\/[a-z0-9_+()-][a-z0-9_.+() -]{0,127}){1,16}$/u;

/**
 * The files a FileTracker read log names: every line that is not a source
 * marker (`^<source>`), trimmed, without a byte order mark.
 *
 * @param {string} text The tlog decoded from UTF-16LE.
 * @returns {string[]}
 */
export function parseTlogReads(text) {
  return (text.startsWith(BOM) ? text.slice(1) : text)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('^'));
}

/**
 * A Windows directory as a lower-case prefix ending in `\`.
 *
 * @param {string} dir
 * @returns {string}
 */
function prefixOf(dir) {
  const normal = dir.replaceAll('/', '\\').toLowerCase();
  return normal.endsWith('\\') ? normal : `${normal}\\`;
}

/**
 * The identity key of a file the build read: `<root>/<path below it>` in
 * lower case with `/`, or null for a file below an excluded directory (the
 * build tree, the addon's sources: products and inputs of this repository,
 * not of the toolchain). Anything else is `other/<file name>`, so an
 * unexpected input shows without leaking its directory.
 *
 * @param {string} file Absolute Windows path, any case (tlogs are upper case).
 * @param {readonly IdentityRoot[]} roots
 * @param {readonly string[]} excluded Absolute directories.
 * @returns {string | null}
 */
export function identityKey(file, roots, excluded) {
  const lower = file.replaceAll('/', '\\').toLowerCase();
  if (excluded.some((dir) => lower.startsWith(prefixOf(dir)))) return null;
  for (const root of roots) {
    const prefix = prefixOf(root.dir);
    if (lower.startsWith(prefix))
      return `${root.name}/${lower.slice(prefix.length).replaceAll('\\', '/')}`;
  }
  return `other/${String(lower.split('\\').pop())}`;
}

/**
 * The inputs to hash: identity key to the file to read, keys sorted; the
 * first file named for a key wins (a key names one file, whatever its case).
 *
 * @param {readonly string[]} files
 * @param {readonly IdentityRoot[]} roots
 * @param {readonly string[]} excluded
 * @returns {Map<string, string>}
 */
export function identityInputs(files, roots, excluded) {
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const file of files) {
    const key = identityKey(file, roots, excluded);
    if (key !== null && !found.has(key)) found.set(key, file);
  }
  // Default sort: UTF-16 code unit order, the same on every machine.
  return new Map([...found.keys()].sort().map((key) => [key, String(found.get(key))]));
}

/**
 * Checks a parsed identity: exactly `visualStudio`, `windowsSdkBuild` and
 * `files`, each well formed.
 *
 * @param {unknown} value
 * @returns {Identity | string} the identity, or what is wrong with it
 */
export function checkIdentity(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'files,visualStudio,windowsSdkBuild') {
    return `fields ${keys} are not files, visualStudio, windowsSdkBuild`;
  }
  /** @type {unknown} */
  const visualStudio = Reflect.get(value, 'visualStudio');
  /** @type {unknown} */
  const windowsSdkBuild = Reflect.get(value, 'windowsSdkBuild');
  /** @type {unknown} */
  const files = Reflect.get(value, 'files');
  if (typeof visualStudio !== 'string' || !VERSION4.test(visualStudio)) {
    return 'visualStudio is not a version';
  }
  if (
    typeof windowsSdkBuild !== 'string' ||
    (windowsSdkBuild !== 'unpinned' && !VERSION4.test(windowsSdkBuild))
  ) {
    return 'windowsSdkBuild is not a version or unpinned';
  }
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return 'files is not an object';
  }
  const entries = Object.entries(files);
  if (entries.length > MAX_IDENTITY_FILES)
    return `files names more than ${String(MAX_IDENTITY_FILES)} inputs`;
  for (const [key, sha256] of /** @type {[string, unknown][]} */ (entries)) {
    if (!KEY.test(key)) return `files: ${JSON.stringify(key.slice(0, 80))} is not an input key`;
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return `files: ${key} is not a sha256`;
  }
  return /** @type {Identity} */ ({
    visualStudio,
    windowsSdkBuild,
    files: /** @type {Record<string, string>} */ (files),
  });
}

/**
 * An identity as written to disk: fields in order, files sorted by key.
 *
 * @param {Identity} identity
 * @returns {{ visualStudio: string, windowsSdkBuild: string, files: Record<string, string> }}
 */
export function orderedIdentity(identity) {
  return {
    visualStudio: identity.visualStudio,
    windowsSdkBuild: identity.windowsSdkBuild,
    files: Object.fromEntries(
      Object.keys(identity.files)
        .sort()
        .map((key) => [key, String(identity.files[key])]),
    ),
  };
}

/**
 * How a build's inputs differ from a reference's (the record, or a CI build),
 * one line each: the Visual Studio version, the SDK servicing build, then
 * every file whose sha256 differs, that only the reference read, or that
 * only the build read. Empty when they are the same.
 *
 * @param {Identity | undefined} reference
 * @param {Identity | undefined} build
 * @param {string} label The reference's label (`record`, `CI`).
 * @returns {string[]}
 */
export function identityDifferences(reference, build, label) {
  if (reference === undefined) return [`the ${label} names no input identity`];
  if (build === undefined) return [`the rebuild names no input identity (${label} has one)`];
  /** @type {string[]} */
  const lines = [];
  if (build.visualStudio !== reference.visualStudio) {
    lines.push(`Visual Studio ${build.visualStudio} (${label} ${reference.visualStudio})`);
  }
  if (build.windowsSdkBuild !== reference.windowsSdkBuild) {
    lines.push(
      `Windows SDK build ${build.windowsSdkBuild} (${label} ${reference.windowsSdkBuild})`,
    );
  }
  const keys = [...new Set([...Object.keys(reference.files), ...Object.keys(build.files)])].sort();
  for (const key of keys) {
    const ours = build.files[key];
    const theirs = reference.files[key];
    if (ours === theirs) continue;
    if (ours === undefined) lines.push(`${key}: read by the ${label} only`);
    else if (theirs === undefined) lines.push(`${key}: read by the rebuild only`);
    else lines.push(`${key}: sha256 ${ours} (${label} ${theirs})`);
  }
  return lines;
}
