// Logic of the job addon digest tool (plan §6.2; scripts/addon/write-digests.mjs
// supplies the I/O). Two separate jobs, by lead ruling on A2:
//
// - The release record. `native/win32-job/release/<release>/manifest.json`
//   is the single source of the core's digest table
//   (`packages/core/src/process/containment/win32-job-digests.ts`):
//   `--from-manifest` is the only way the table is written, and build output
//   never writes it. The record's `SHA256SUMS` and `toolchain.json` are
//   derived from the manifest and checked against it.
// - Staging. A local or CI build is copied, byte for byte, into its platform
//   package with a `SHA256SUMS` for those bytes and the build's
//   `toolchain.json`. Staging never touches the table.
//
// Every file access goes through the injected `io`.

import { createHash } from 'node:crypto';
import path from 'node:path';

import { checkIdentity, orderedIdentity } from './addon-identity.mjs';

/** @typedef {import('./addon-identity.mjs').Identity} Identity */

/** The addon's file name, in the build tree and in the platform packages. */
export const ADDON_FILE = 'hudhud_win32_job.node';

/** The digest table module of the core, relative to the repository root. */
export const DIGESTS_MODULE = 'packages/core/src/process/containment/win32-job-digests.ts';

/**
 * The architectures the addon is built for: the PE machine type of the
 * image and the platform package that carries it. Only x64 is in the
 * digest table: arm64 is not first-class in v1 (K17) and the loader never
 * loads it.
 *
 * @type {Readonly<Record<string, { machine: number; packageDir: string }>>}
 */
export const ARCHES = Object.freeze({
  x64: Object.freeze({ machine: 0x8664, packageDir: 'packages/win32-job-x64' }),
  arm64: Object.freeze({ machine: 0xaa64, packageDir: 'packages/win32-job-arm64' }),
});

/**
 * The fields of a `toolchain.json`: everything that changes the bytes of a
 * build (lead ruling on A2), plus the generator, which is recorded but
 * shown not to (see {@link INFORMATIONAL_FIELDS}).
 * `native/win32-job/build.mjs` writes one for every build, with the
 * optional {@link IDENTITY_FIELD} after them.
 */
export const TOOLCHAIN_FIELDS = Object.freeze([
  'arch',
  'generator',
  'vcToolsVersion',
  'clVersion',
  'windowsSdkVersion',
  'cmakeVersion',
  'nodeApiHeadersVersion',
]);

/** An addon `version` the table accepts: semver, optionally with a pre-release. */
const VERSION =
  /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z.-]{1,32})?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
/** A release record's path: `native/win32-job/release/<release>/manifest.json`. */
const MANIFEST_PATH =
  /^native\/win32-job\/release\/([0-9A-Za-z][0-9A-Za-z.+-]{0,63})\/manifest\.json$/u;
/** A toolchain field value: printable, no quote or backslash (it is shown and compared only). */
const TOOLCHAIN_VALUE = /^[0-9A-Za-z][0-9A-Za-z .+_-]{0,63}$/u;

/** A usage error (exit code 2). */
export class UsageError extends Error {}

/**
 * Whether a value is an addon `version` the table accepts.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isAddonVersion(value) {
  return typeof value === 'string' && VERSION.test(value);
}

/**
 * @typedef {object} StageOptions
 * @property {'stage'} mode
 * @property {string} arch `x64` or `arm64`.
 * @property {string | undefined} addon The built file (default: the build tree of the arch).
 * @property {string | undefined} toolchain Its `toolchain.json` (default: next to the build tree).
 * @property {string | undefined} version The expected addon `version`.
 */

/**
 * @typedef {object} ManifestOptions
 * @property {'from-manifest'} mode
 * @property {string} manifest Repository-relative path of the release manifest.
 */

/** @typedef {StageOptions | ManifestOptions} Options */

const USAGE =
  'usage: write-digests.mjs --from-manifest native/win32-job/release/<release>/manifest.json\n' +
  '       write-digests.mjs --stage --arch x64|arm64 [--addon <file>] [--toolchain <file>] [--version <v>]';

/**
 * @param {readonly string[]} argv
 * @returns {Options}
 * @throws {UsageError}
 */
export function parseArgs(argv) {
  /** @type {Partial<Record<'--arch' | '--addon' | '--toolchain' | '--version' | '--from-manifest', string>>} */
  const values = {};
  let stage = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--stage') {
      if (stage) throw new UsageError('--stage given twice');
      stage = true;
      continue;
    }
    if (
      flag !== '--arch' &&
      flag !== '--addon' &&
      flag !== '--toolchain' &&
      flag !== '--version' &&
      flag !== '--from-manifest'
    ) {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value === '') throw new UsageError(`missing value for ${flag}`);
    if (values[flag] !== undefined) throw new UsageError(`${flag} given twice`);
    values[flag] = value;
    i += 1;
  }
  const manifest = values['--from-manifest'];
  if (manifest !== undefined) {
    if (stage || Object.keys(values).length > 1) {
      throw new UsageError(`--from-manifest takes no other argument\n${USAGE}`);
    }
    return { mode: 'from-manifest', manifest };
  }
  const arch = values['--arch'];
  if (!stage || arch === undefined || !Object.hasOwn(ARCHES, arch)) throw new UsageError(USAGE);
  return {
    mode: 'stage',
    arch,
    addon: values['--addon'],
    toolchain: values['--toolchain'],
    version: values['--version'],
  };
}

/**
 * The PE machine type of an image, or null when the bytes are not a PE image
 * (`MZ` header, `e_lfanew` inside the file, `PE\0\0` signature).
 *
 * @param {Uint8Array} bytes
 * @returns {number | null}
 */
export function peMachine(bytes) {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(0x3c, true);
  if (offset + 6 > bytes.length) return null;
  if (view.getUint32(offset, false) !== 0x50450000) return null;
  return view.getUint16(offset + 4, true);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} lower-case hex sha256
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The `SHA256SUMS` file of a platform package (`sha256sum` format).
 *
 * @param {string} sha256
 * @returns {string}
 */
export function renderSha256Sums(sha256) {
  return `${sha256}  ${ADDON_FILE}\n`;
}

/**
 * Reads a platform package's `SHA256SUMS`: exactly one line for the addon.
 *
 * @param {string} text
 * @returns {string | null} the sha256, or null when the file is anything else
 */
export function parseSha256Sums(text) {
  const match = /^([0-9a-f]{64}) {2}hudhud_win32_job\.node\n$/u.exec(text);
  return match?.[1] ?? null;
}

// ---- toolchain -------------------------------------------------------------

/**
 * @typedef {Readonly<Record<string, string>>} Toolchain
 */

/**
 * The optional field of a `toolchain.json` that records the build's input
 * identity (scripts/lib/addon-identity.mjs): diagnostic only, never compared
 * as a gate (ADR-0014 amendment 14).
 */
export const IDENTITY_FIELD = 'identity';

/**
 * Checks a parsed `toolchain.json`: exactly {@link TOOLCHAIN_FIELDS}, each a
 * short printable string, and optionally an {@link IDENTITY_FIELD}, which is
 * checked too but is not part of the returned toolchain (see
 * {@link toolchainIdentity}).
 *
 * @param {unknown} value
 * @returns {Toolchain | string} the toolchain fields, or what is wrong with the file
 */
export function checkToolchain(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'not an object';
  }
  const keys = Object.keys(value)
    .filter((key) => key !== IDENTITY_FIELD)
    .sort();
  const expected = [...TOOLCHAIN_FIELDS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    return `fields ${keys.join(', ')} are not ${expected.join(', ')}`;
  }
  for (const key of keys) {
    /** @type {unknown} */
    const field = Reflect.get(value, key);
    if (typeof field !== 'string' || !TOOLCHAIN_VALUE.test(field)) return `${key} is not a value`;
  }
  if (Object.hasOwn(value, IDENTITY_FIELD)) {
    const identity = checkIdentity(Reflect.get(value, IDENTITY_FIELD));
    if (typeof identity === 'string') return `${IDENTITY_FIELD}: ${identity}`;
  }
  return /** @type {Toolchain} */ (
    Object.fromEntries(TOOLCHAIN_FIELDS.map((key) => [key, String(Reflect.get(value, key))]))
  );
}

/**
 * The input identity of a `toolchain.json` that {@link checkToolchain}
 * accepted, if it records one.
 *
 * @param {unknown} value
 * @returns {Identity | undefined}
 */
export function toolchainIdentity(value) {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, IDENTITY_FIELD)) {
    return undefined;
  }
  const identity = checkIdentity(Reflect.get(value, IDENTITY_FIELD));
  return typeof identity === 'string' ? undefined : identity;
}

/**
 * A toolchain as an object in the committed order: {@link TOOLCHAIN_FIELDS},
 * then the identity when there is one.
 *
 * @param {Toolchain} toolchain
 * @param {Identity | undefined} identity
 * @returns {Record<string, unknown>}
 */
export function orderedToolchain(toolchain, identity) {
  return {
    ...Object.fromEntries(TOOLCHAIN_FIELDS.map((field) => [field, toolchain[field]])),
    ...(identity === undefined ? {} : { [IDENTITY_FIELD]: orderedIdentity(identity) }),
  };
}

/**
 * Toolchain fields that are recorded but do not change the bytes, so they
 * never decide a comparison and a difference in them is reported as
 * information only (lead ruling on A3). `generator`: the CMake Visual
 * Studio generator only selects the MSBuild front end; with the toolset
 * and SDK pinned, `Visual Studio 17 2022` (the local build of record) and
 * `Visual Studio 18 2026` (windows-2025 CI, Addon prebuild run 38947897592)
 * produced byte-identical x64 and ARM64 addons.
 */
export const INFORMATIONAL_FIELDS = Object.freeze(['generator']);

/**
 * The toolchain fields that can change the bytes and must match exactly in
 * every comparison: arch, MSVC toolset, `cl` version, Windows SDK, CMake
 * and node-api-headers.
 */
export const BYTE_FIELDS = Object.freeze(
  TOOLCHAIN_FIELDS.filter((field) => !INFORMATIONAL_FIELDS.includes(field)),
);

/**
 * The fields that can change the bytes in which two toolchains differ, in
 * {@link TOOLCHAIN_FIELDS} order. A difference here means the builds are
 * not comparable as builds of record.
 *
 * @param {Toolchain} a
 * @param {Toolchain} b
 * @returns {string[]}
 */
export function toolchainDifferences(a, b) {
  return BYTE_FIELDS.filter((field) => a[field] !== b[field]);
}

/**
 * The {@link INFORMATIONAL_FIELDS} in which two toolchains differ: reported,
 * never a reason to skip or fail.
 *
 * @param {Toolchain} a
 * @param {Toolchain} b
 * @returns {string[]}
 */
export function informationalDifferences(a, b) {
  return INFORMATIONAL_FIELDS.filter((field) => a[field] !== b[field]);
}

/**
 * A toolchain as written to disk (fields in {@link TOOLCHAIN_FIELDS} order,
 * then the identity when there is one).
 *
 * @param {Toolchain} toolchain
 * @param {Identity} [identity]
 * @returns {string}
 */
export function renderToolchain(toolchain, identity) {
  return `${JSON.stringify(orderedToolchain(toolchain, identity), null, 2)}\n`;
}

// ---- release record --------------------------------------------------------

/**
 * @typedef {object} ReleaseArch
 * @property {string} sha256
 * @property {number} size
 * @property {Toolchain} toolchain
 * @property {Identity} [identity] The build's input identity, when recorded (diagnostic only).
 */

/**
 * @typedef {object} Manifest
 * @property {string} release The release name (the record's directory).
 * @property {string} version The addon's ABI `version`.
 * @property {Readonly<Record<string, ReleaseArch>>} arches At least `x64`.
 */

/**
 * Reads a release manifest; anything malformed is refused with a reason.
 *
 * @param {string} text
 * @returns {Manifest | string}
 */
export function parseManifest(text) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
  const fields = Object.keys(value).sort().join(',');
  if (fields !== 'arches,release,version')
    return `fields ${fields} are not arches, release, version`;
  /** @type {unknown} */
  const release = Reflect.get(value, 'release');
  /** @type {unknown} */
  const version = Reflect.get(value, 'version');
  /** @type {unknown} */
  const arches = Reflect.get(value, 'arches');
  if (typeof release !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(release)) {
    return 'release is not a release name';
  }
  if (typeof version !== 'string' || !VERSION.test(version)) return 'version is not semver';
  if (typeof arches !== 'object' || arches === null || Array.isArray(arches)) {
    return 'arches is not an object';
  }
  /** @type {Record<string, ReleaseArch>} */
  const checked = {};
  for (const [arch, entry] of /** @type {[string, unknown][]} */ (Object.entries(arches))) {
    if (!Object.hasOwn(ARCHES, arch)) return `unknown arch ${arch}`;
    if (typeof entry !== 'object' || entry === null) return `${arch} is not an object`;
    if (Object.keys(entry).sort().join(',') !== 'sha256,size,toolchain') {
      return `${arch} fields are not sha256, size, toolchain`;
    }
    /** @type {unknown} */
    const sha256 = Reflect.get(entry, 'sha256');
    /** @type {unknown} */
    const size = Reflect.get(entry, 'size');
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return `${arch}.sha256 is not a sha256`;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
      return `${arch}.size is not a size`;
    }
    /** @type {unknown} */
    const toolchainValue = Reflect.get(entry, 'toolchain');
    const toolchain = checkToolchain(toolchainValue);
    if (typeof toolchain === 'string') return `${arch}.toolchain: ${toolchain}`;
    if (toolchain['arch'] !== arch) return `${arch}.toolchain.arch is ${String(toolchain['arch'])}`;
    const identity = toolchainIdentity(toolchainValue);
    checked[arch] = { sha256, size, toolchain, ...(identity === undefined ? {} : { identity }) };
  }
  if (checked['x64'] === undefined) return 'no x64 build';
  return { release, version, arches: checked };
}

/**
 * The record's `SHA256SUMS` (`sha256sum` format, `<arch>/<file>`, arches sorted).
 *
 * @param {Manifest} manifest
 * @returns {string}
 */
export function renderReleaseSums(manifest) {
  return Object.keys(manifest.arches)
    .sort()
    .map((arch) => `${String(manifest.arches[arch]?.sha256)}  ${arch}/${ADDON_FILE}\n`)
    .join('');
}

/**
 * The record's `toolchain.json`: the toolchain of each arch, arches sorted.
 *
 * @param {Manifest} manifest
 * @returns {string}
 */
export function renderReleaseToolchains(manifest) {
  /** @type {Record<string, unknown>} */
  const byArch = {};
  for (const arch of Object.keys(manifest.arches).sort()) {
    const entry = /** @type {ReleaseArch} */ (manifest.arches[arch]);
    byArch[arch] = orderedToolchain(entry.toolchain, entry.identity);
  }
  return `${JSON.stringify(byArch, null, 2)}\n`;
}

// ---- the digest table ------------------------------------------------------

/**
 * @typedef {object} DigestTable
 * @property {string} version
 * @property {string} x64
 * @property {string} manifest Repository-relative path of the release manifest it was written from.
 */

/**
 * The digest table module of the core, exactly as committed (prettier-clean).
 *
 * @param {DigestTable} table
 * @returns {string}
 */
export function renderDigestsModule(table) {
  if (!VERSION.test(table.version)) throw new Error('invalid addon version');
  if (!SHA256.test(table.x64)) throw new Error('invalid x64 sha256');
  if (!MANIFEST_PATH.test(table.manifest)) throw new Error('invalid release manifest path');
  return `/**
 * The shipped digest table of the Windows job addon (plan §6.2, §6.4 step 4).
 *
 * @remarks
 * Written only from the release record
 * \`${table.manifest}\`
 * by \`scripts/addon/write-digests.mjs --from-manifest\`; never by a build and
 * never by hand (a test keeps this file equal to the generator's output for
 * that manifest). The loader refuses an addon file whose sha256 differs from
 * the table, and a missing digest counts as a mismatch (\`digest-mismatch\`);
 * the host then reports \`'best-effort'\`. The check is defence in depth only;
 * the real guarantees are npm integrity and provenance (ADR-0009). x64 only:
 * arm64 is not first-class in v1 (K17).
 *
 * @packageDocumentation
 */

/**
 * sha256 digests (lower-case hex) of the shipped addon files per
 * architecture, plus the addon \`version\` they were built as (the loader's
 * ABI check).
 *
 * @beta
 */
export interface JobAddonDigests {
  /** The addon's \`version\` constant the digests belong to. */
  readonly version?: string;
  /** sha256 of \`@hudhudjs/win32-job-x64/hudhud_win32_job.node\`. */
  readonly x64?: string;
}

/**
 * The digest table shipped with this build of the core.
 *
 * @beta
 */
export const WIN32_JOB_DIGESTS: JobAddonDigests = Object.freeze({
  version: '${table.version}',
  x64: '${table.x64}',
});
`;
}

/**
 * Reads the committed digest table module. Only the generator's own output
 * is accepted: anything else (a hand edit, an empty table) is null.
 *
 * @param {string} text
 * @returns {DigestTable | null}
 */
export function parseDigestsModule(text) {
  const version = /^ {2}version: '([^'\n]*)',$/mu.exec(text)?.[1];
  const x64 = /^ {2}x64: '([^'\n]*)',$/mu.exec(text)?.[1];
  const manifest = /^ \* `(native\/win32-job\/release\/[^`\n]*)`$/mu.exec(text)?.[1];
  if (version === undefined || x64 === undefined || manifest === undefined) return null;
  const table = { version, x64, manifest };
  try {
    return renderDigestsModule(table) === text ? table : null;
  } catch {
    return null;
  }
}

/**
 * The release name of a manifest path, or null when it is not one.
 *
 * @param {string} manifest
 * @returns {string | null}
 */
export function releaseOf(manifest) {
  return MANIFEST_PATH.exec(manifest)?.[1] ?? null;
}

// ---- the tool --------------------------------------------------------------

/**
 * @typedef {object} Io
 * @property {string} root The repository root.
 * @property {string} platform `process.platform`
 * @property {string} hostArch `process.arch`
 * @property {(file: string) => Uint8Array} readFile Throws when the file cannot be read.
 * @property {(file: string, data: Uint8Array | string) => void} writeFile
 * @property {(file: string) => unknown} loadVersion Loads the addon (`process.dlopen`)
 *   and returns its `version` export; only called on Windows for the host's own arch.
 * @property {(line: string) => void} log Progress, to stdout.
 * @property {(line: string) => void} error Why the input was refused, to stderr.
 */

/**
 * Runs the tool. Nothing is written unless every check passed.
 *
 * @param {Options} options
 * @param {Io} io
 * @returns {number} 0 written, 1 the input was refused
 */
export function writeDigests(options, io) {
  /** @param {string} message */
  const refuse = (message) => {
    io.error(`write-digests: ${message}`);
    return 1;
  };
  /** @param {string} file */
  const read = (file) => {
    try {
      return { bytes: io.readFile(file) };
    } catch (error) {
      const code = /** @type {{ code?: unknown }} */ (error).code;
      return { problem: String(code ?? error) };
    }
  };
  return options.mode === 'from-manifest'
    ? fromManifest(options, io, refuse, read)
    : stage(options, io, refuse, read);
}

/**
 * @typedef {(file: string) => { bytes: Uint8Array, problem?: undefined } | { problem: string, bytes?: undefined }} Reader
 */

/**
 * @param {ManifestOptions} options
 * @param {Io} io
 * @param {(message: string) => number} refuse
 * @param {Reader} read
 * @returns {number}
 */
function fromManifest(options, io, refuse, read) {
  const manifestPath = options.manifest.replaceAll('\\', '/');
  const release = releaseOf(manifestPath);
  if (release === null) {
    return refuse(
      `${options.manifest} is not native/win32-job/release/<release>/manifest.json in the repository`,
    );
  }
  const file = read(path.join(io.root, manifestPath));
  if (file.bytes === undefined) return refuse(`cannot read ${manifestPath} (${file.problem})`);
  const manifest = parseManifest(new TextDecoder().decode(file.bytes));
  if (typeof manifest === 'string') return refuse(`${manifestPath}: ${manifest}`);
  if (manifest.release !== release) {
    return refuse(`${manifestPath}: release ${manifest.release} is not its directory ${release}`);
  }
  const x64 = /** @type {ReleaseArch} */ (manifest.arches['x64']);
  const text = renderDigestsModule({
    version: manifest.version,
    x64: x64.sha256,
    manifest: manifestPath,
  });
  const modulePath = path.join(io.root, DIGESTS_MODULE);
  const current = read(modulePath);
  if (current.bytes !== undefined && new TextDecoder().decode(current.bytes) === text) {
    io.log(`${DIGESTS_MODULE} already holds ${manifestPath}`);
    return 0;
  }
  io.writeFile(modulePath, text);
  io.log(
    `wrote ${DIGESTS_MODULE} from ${manifestPath} (x64 ${x64.sha256}, version ${manifest.version})`,
  );
  return 0;
}

/**
 * @param {StageOptions} options
 * @param {Io} io
 * @param {(message: string) => number} refuse
 * @param {Reader} read
 * @returns {number}
 */
function stage(options, io, refuse, read) {
  const target = ARCHES[options.arch];
  if (target === undefined) throw new UsageError(`unknown arch ${options.arch}`);
  const buildDir = path.join('native', 'win32-job', 'build', options.arch);
  const addon = path.resolve(io.root, options.addon ?? path.join(buildDir, 'Release', ADDON_FILE));
  const toolchainPath = path.resolve(
    io.root,
    options.toolchain ?? (options.addon === undefined ? path.join(buildDir, 'toolchain.json') : ''),
  );
  if (options.addon !== undefined && options.toolchain === undefined) {
    return refuse('--addon needs the toolchain.json of that build (--toolchain <file>)');
  }

  const built = read(addon);
  if (built.bytes === undefined) {
    return refuse(
      `cannot read ${addon} (${built.problem}); build it first: node native/win32-job/build.mjs --arch ${options.arch}`,
    );
  }
  const bytes = built.bytes;
  const machine = peMachine(bytes);
  if (machine === null) return refuse(`${addon} is not a PE image`);
  if (machine !== target.machine) {
    return refuse(
      `${addon} is built for machine 0x${machine.toString(16)}, not ${options.arch} (0x${target.machine.toString(16)})`,
    );
  }

  const toolchainFile = read(toolchainPath);
  if (toolchainFile.bytes === undefined) {
    return refuse(`cannot read ${toolchainPath} (${toolchainFile.problem})`);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(toolchainFile.bytes));
  } catch {
    parsed = null;
  }
  const toolchain = checkToolchain(parsed);
  if (typeof toolchain === 'string') return refuse(`${toolchainPath}: ${toolchain}`);
  const identity = toolchainIdentity(parsed);
  if (toolchain['arch'] !== options.arch) {
    return refuse(`${toolchainPath} describes a ${String(toolchain['arch'])} build`);
  }

  /** @type {unknown} */
  let version = options.version;
  if (io.platform === 'win32' && io.hostArch === options.arch) {
    /** @type {unknown} */
    let loaded;
    try {
      loaded = io.loadVersion(addon);
    } catch (error) {
      return refuse(`cannot load ${addon}: ${String(error)}`);
    }
    if (options.version !== undefined && loaded !== options.version) {
      return refuse(
        `the addon reports version ${JSON.stringify(loaded)}, --version says ${JSON.stringify(options.version)}`,
      );
    }
    version = loaded;
  } else if (version === undefined) {
    return refuse(
      `the ${options.arch} addon cannot be loaded on ${io.platform}-${io.hostArch}: give its version with --version`,
    );
  }
  if (!isAddonVersion(version)) {
    return refuse(`the addon version ${JSON.stringify(version)} is not a semver version`);
  }

  const sha256 = sha256Hex(bytes);
  const packageDir = path.join(io.root, target.packageDir);
  io.writeFile(path.join(packageDir, ADDON_FILE), bytes);
  io.writeFile(path.join(packageDir, 'SHA256SUMS'), renderSha256Sums(sha256));
  io.writeFile(path.join(packageDir, 'toolchain.json'), renderToolchain(toolchain, identity));
  io.log(
    `staged ${options.arch} ${ADDON_FILE} (sha256 ${sha256}, version ${version}) in ${target.packageDir}`,
  );
  io.log(renderToolchain(toolchain).trimEnd());
  return 0;
}
