// Logic of the job addon release tooling (plan §6.3; scripts/addon/manifest.mjs
// supplies the I/O, .github/workflows/addon-prebuild.yml runs it).
//
// The invariant (lead ruling on A2): the published bytes equal the release
// record, `native/win32-job/release/<release>/manifest.json`. Every rebuild
// of a release must reproduce it, and every comparison names both values.
//
// Commands:
// - `components --arch <a>`: the Visual Studio component ids of the toolset
//   of record (the record the core's digest table names), one per line. The
//   workflow installs the missing ones; build.mjs names them when absent.
// - `collect --arch <a> --out <dir>`: copies a build of
//   `native/win32-job/build.mjs` (the `.node` and its `toolchain.json`) into
//   an artifact directory with a `SHA256SUMS` for its bytes and, where the
//   host can load it, its ABI `version`.
// - `check-toolchain --toolchain <file>`: requires a build's toolchain to
//   equal the record's in every field that can change the bytes; the
//   generator is reported only (the condition under which the record
//   check of scripts/test/addon-record.test.ts runs instead of skipping).
// - `verify --dir <artifact> --record <manifest>`: requires a rebuild to
//   reproduce the committed record (sha256 and size, with the toolchain of
//   record), and the core's table to be written from that record (release
//   phase 2).
// - `write --release <name> --dir <artifacts> --out <dir>`: writes
//   `manifest.json`, `SHA256SUMS` and `toolchain.json` of a release record,
//   in exactly the committed format, from the x64 and arm64 artifacts.
// - `compare --manifest <file>`: compares the local builds of record
//   (`native/win32-job/build/<arch>/`) with a CI manifest, per architecture.
//
// Every file access goes through the injected `io`.

import path from 'node:path';

import {
  ADDON_FILE,
  ARCHES,
  checkToolchain,
  DIGESTS_MODULE,
  isAddonVersion,
  parseDigestsModule,
  parseManifest,
  parseSha256Sums,
  peMachine,
  releaseOf,
  renderReleaseSums,
  renderReleaseToolchains,
  renderSha256Sums,
  renderToolchain,
  sha256Hex,
  informationalDifferences,
  orderedToolchain,
  toolchainDifferences,
  toolchainIdentity,
  UsageError,
} from './addon-digests.mjs';
import { identityDifferences } from './addon-identity.mjs';

/** @typedef {import('./addon-digests.mjs').Manifest} Manifest */
/** @typedef {import('./addon-digests.mjs').ReleaseArch} ReleaseArch */
/** @typedef {import('./addon-digests.mjs').Toolchain} Toolchain */
/** @typedef {import('./addon-identity.mjs').Identity} Identity */

/** The addon's ABI version file in an artifact directory (`<version>\n`). */
export const VERSION_FILE = 'version';

/** Suffix of the side-by-side MSVC toolset component ids per architecture. */
const COMPONENT_SUFFIX = Object.freeze({ x64: 'x86.x64', arm64: 'ARM64' });

/** The architectures of a release record, in the record's (sorted) order. */
export const RELEASE_ARCHES = Object.freeze(Object.keys(ARCHES).sort());

// ---- toolset of record -----------------------------------------------------

/**
 * @typedef {object} ToolsetOfRecord
 * @property {string} platformToolset MSBuild's platform toolset (`-T <name>,version=...`).
 * @property {string} tools Component id of the MSVC toolset for the architecture.
 * @property {string} spectre Component id of its Spectre-mitigated libraries.
 * @property {string} sdk Component id of the Windows SDK.
 * @property {string} sdkBuild The SDK's build number (`26100`).
 */

/**
 * The Visual Studio components of a recorded toolchain: the side-by-side
 * MSVC toolset of its version for its architecture (14.3x and 14.4x are
 * v143, the toolsets of Visual Studio 17.0 to 17.14), its Spectre libraries
 * and the Windows SDK.
 *
 * @param {Toolchain} toolchain
 * @returns {ToolsetOfRecord | string} the components, or why there are none
 */
export function toolsetOfRecord(toolchain) {
  const arch = String(toolchain['arch']);
  const vcTools = String(toolchain['vcToolsVersion']);
  const sdkVersion = String(toolchain['windowsSdkVersion']);
  /** @type {unknown} */
  const suffix = Reflect.get(COMPONENT_SUFFIX, arch);
  if (typeof suffix !== 'string') return `unknown arch ${arch}`;
  const match = /^14\.([34]\d)\.\d+$/u.exec(vcTools);
  if (match === null) return `no platform toolset is known for MSVC ${vcTools}`;
  const sdk = /^10\.0\.(\d+)\.\d+$/u.exec(sdkVersion);
  if (sdk === null) return `Windows SDK ${sdkVersion} is not a 10.0.<build>.<revision> version`;
  const minor = Number(match[1]);
  const sdkBuild = String(sdk[1]);
  const id = `Microsoft.VisualStudio.Component.VC.14.${String(minor)}.17.${String(minor - 30)}.${suffix}`;
  const windows = Number(sdkBuild) >= 22000 ? '11' : '10';
  return {
    platformToolset: 'v143',
    tools: id,
    spectre: `${id}.Spectre`,
    sdk: `Microsoft.VisualStudio.Component.Windows${windows}SDK.${sdkBuild}`,
    sdkBuild,
  };
}

// ---- the release manifest --------------------------------------------------

/**
 * A release manifest as committed: arches sorted, toolchain fields in
 * TOOLCHAIN_FIELDS order (then the input identity, when recorded),
 * two-space JSON and a final newline.
 *
 * @param {Manifest} manifest
 * @returns {string}
 */
export function renderManifest(manifest) {
  /** @type {Record<string, unknown>} */
  const arches = {};
  for (const arch of Object.keys(manifest.arches).sort()) {
    const entry = /** @type {ReleaseArch} */ (manifest.arches[arch]);
    arches[arch] = {
      sha256: entry.sha256,
      size: entry.size,
      toolchain: orderedToolchain(entry.toolchain, entry.identity),
    };
  }
  return `${JSON.stringify({ release: manifest.release, version: manifest.version, arches }, null, 2)}\n`;
}

// ---- arguments -------------------------------------------------------------

/**
 * @typedef {{ command: 'components', arch: string }
 *   | { command: 'collect', arch: string, out: string }
 *   | { command: 'check-toolchain', toolchain: string }
 *   | { command: 'verify', dir: string, record: string | undefined }
 *   | { command: 'write', release: string, dir: string, out: string }
 *   | { command: 'compare', manifest: string }} Options
 */

/**
 * The flags of each command; a trailing `?` marks an optional one.
 *
 * @type {ReadonlyMap<string, readonly string[]>}
 */
const COMMANDS = new Map([
  ['components', ['--arch']],
  ['collect', ['--arch', '--out']],
  ['check-toolchain', ['--toolchain']],
  ['verify', ['--dir', '--record?']],
  ['write', ['--release', '--dir', '--out']],
  ['compare', ['--manifest']],
]);

export const USAGE = [
  'usage: manifest.mjs components --arch x64|arm64',
  '       manifest.mjs collect --arch x64|arm64 --out <dir>',
  '       manifest.mjs check-toolchain --toolchain <toolchain.json>',
  '       manifest.mjs verify --dir <artifact dir> [--record native/win32-job/release/<release>/manifest.json]',
  '       manifest.mjs write --release <release> --dir <artifacts dir> --out <dir>',
  '       manifest.mjs compare --manifest <CI manifest.json>',
].join('\n');

/**
 * @param {readonly string[]} argv
 * @returns {Options}
 * @throws {UsageError}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const declared = command === undefined ? undefined : COMMANDS.get(command);
  if (command === undefined || declared === undefined) throw new UsageError(USAGE);
  const flags = declared.map((flag) => flag.replace(/\?$/u, ''));
  const required = declared.filter((flag) => !flag.endsWith('?'));
  /** @type {Record<string, string>} */
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = String(rest[i]);
    if (!flags.includes(flag)) {
      throw new UsageError(`${command} takes no ${JSON.stringify(flag)}\n${USAGE}`);
    }
    const value = rest[i + 1];
    if (value === undefined || value === '') throw new UsageError(`missing value for ${flag}`);
    if (Object.hasOwn(values, flag)) throw new UsageError(`${flag} given twice`);
    values[flag] = value;
  }
  for (const flag of required) {
    if (!Object.hasOwn(values, flag)) throw new UsageError(`${command} needs ${flag}\n${USAGE}`);
  }
  const arch = values['--arch'];
  if (arch !== undefined && !Object.hasOwn(ARCHES, arch)) {
    throw new UsageError(`unknown arch ${JSON.stringify(arch)}\n${USAGE}`);
  }
  /** @param {string} flag */
  const value = (flag) => String(values[flag]);
  switch (command) {
    case 'components':
      return { command, arch: value('--arch') };
    case 'collect':
      return { command, arch: value('--arch'), out: value('--out') };
    case 'check-toolchain':
      return { command, toolchain: value('--toolchain') };
    case 'verify':
      return { command, dir: value('--dir'), record: values['--record'] };
    case 'write':
      return { command, release: value('--release'), dir: value('--dir'), out: value('--out') };
    default:
      return { command: 'compare', manifest: value('--manifest') };
  }
}

// ---- the tool --------------------------------------------------------------

/**
 * @typedef {object} Io
 * @property {string} root The repository root; relative paths resolve against it.
 * @property {string} platform `process.platform`
 * @property {string} hostArch `process.arch`
 * @property {(file: string) => Uint8Array} readFile Throws (with `code`) when the file cannot be read.
 * @property {(file: string, data: Uint8Array | string) => void} writeFile
 * @property {(dir: string) => void} makeDir Creates a directory and its parents.
 * @property {(file: string) => unknown} loadVersion Loads the addon (`process.dlopen`)
 *   and returns its `version` export; only called on Windows for the host's own arch.
 * @property {(line: string) => void} log Results, to stdout.
 * @property {(line: string) => void} error Why the input was refused, to stderr.
 */

/**
 * @typedef {{ bytes: Uint8Array, problem?: undefined, missing?: undefined }
 *   | { problem: string, missing: boolean, bytes?: undefined }} Read
 */

/**
 * A built addon with its toolchain, as read from an artifact directory or a
 * build tree.
 *
 * @typedef {object} Build
 * @property {string} arch
 * @property {Uint8Array} bytes
 * @property {string} sha256
 * @property {number} size
 * @property {Toolchain} toolchain
 * @property {Identity | undefined} identity Its input identity, when recorded.
 * @property {string | undefined} version Its ABI version, when recorded.
 */

/**
 * The tool's context: file access relative to the repository and the
 * shared refusal.
 */
class Context {
  /** @param {Io} io */
  constructor(io) {
    this.io = io;
  }

  /**
   * @param {string} file Absolute, or relative to the repository root.
   * @returns {string}
   */
  resolve(file) {
    return path.resolve(this.io.root, file);
  }

  /**
   * @param {string} file
   * @returns {Read}
   */
  read(file) {
    try {
      return { bytes: this.io.readFile(this.resolve(file)) };
    } catch (error) {
      const code = /** @type {{ code?: unknown }} */ (error).code;
      return { problem: String(code ?? error), missing: code === 'ENOENT' };
    }
  }

  /**
   * @param {string} message
   * @returns {number}
   */
  refuse(message) {
    this.io.error(`manifest: ${message}`);
    return 1;
  }

  /**
   * A release manifest by repository path.
   *
   * @param {string} file
   * @returns {Manifest | string}
   */
  manifest(file) {
    const text = this.read(file);
    if (text.bytes === undefined) return `cannot read ${file} (${text.problem})`;
    const manifest = parseManifest(new TextDecoder().decode(text.bytes));
    return typeof manifest === 'string' ? `${file}: ${manifest}` : manifest;
  }

  /**
   * The release record the core's digest table names.
   *
   * @returns {{ path: string, manifest: Manifest } | string}
   */
  record() {
    const text = this.read(DIGESTS_MODULE);
    if (text.bytes === undefined) return `cannot read ${DIGESTS_MODULE} (${text.problem})`;
    const table = parseDigestsModule(new TextDecoder().decode(text.bytes));
    if (table === null) return `${DIGESTS_MODULE} is not a generated digest table`;
    const manifest = this.manifest(table.manifest);
    return typeof manifest === 'string' ? manifest : { path: table.manifest, manifest };
  }

  /**
   * Reads and checks a build: a PE image of the toolchain's architecture,
   * and, in an artifact directory, a `SHA256SUMS` that names its bytes.
   *
   * @param {{ addon: string, toolchain: string, sums?: string, version?: string, arch?: string }} files
   * @returns {Build | string}
   */
  build(files) {
    const addon = this.read(files.addon);
    if (addon.bytes === undefined) return `cannot read ${files.addon} (${addon.problem})`;
    const toolchainFile = this.read(files.toolchain);
    if (toolchainFile.bytes === undefined) {
      return `cannot read ${files.toolchain} (${toolchainFile.problem})`;
    }
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(toolchainFile.bytes));
    } catch {
      parsed = null;
    }
    const toolchain = checkToolchain(parsed);
    if (typeof toolchain === 'string') return `${files.toolchain}: ${toolchain}`;
    const arch = String(toolchain['arch']);
    if (files.arch !== undefined && arch !== files.arch) {
      return `${files.toolchain} describes a ${arch} build, not ${files.arch}`;
    }
    const target = ARCHES[arch];
    if (target === undefined) return `${files.toolchain}: unknown arch ${arch}`;
    const machine = peMachine(addon.bytes);
    if (machine !== target.machine) {
      return `${files.addon} is ${machine === null ? 'not a PE image' : `built for machine 0x${machine.toString(16)}`}, not ${arch} (0x${target.machine.toString(16)})`;
    }
    const sha256 = sha256Hex(addon.bytes);
    if (files.sums !== undefined) {
      const sums = this.read(files.sums);
      if (sums.bytes === undefined) return `cannot read ${files.sums} (${sums.problem})`;
      const named = parseSha256Sums(new TextDecoder().decode(sums.bytes));
      if (named === null) return `${files.sums} is not a SHA256SUMS of ${ADDON_FILE}`;
      if (named !== sha256) return `${files.sums} names ${named}, ${files.addon} is ${sha256}`;
    }
    /** @type {string | undefined} */
    let version;
    if (files.version !== undefined) {
      const text = this.read(files.version);
      if (text.bytes === undefined && !text.missing) {
        return `cannot read ${files.version} (${text.problem})`;
      }
      if (text.bytes !== undefined) {
        const match = /^([^\n]*)\n$/u.exec(new TextDecoder().decode(text.bytes))?.[1];
        if (!isAddonVersion(match)) return `${files.version} holds no addon version`;
        version = match;
      }
    }
    const identity = toolchainIdentity(parsed);
    return {
      arch,
      bytes: addon.bytes,
      sha256,
      size: addon.bytes.length,
      toolchain,
      identity,
      version,
    };
  }

  /**
   * The build in an artifact directory (`collect`'s output).
   *
   * @param {string} dir
   * @param {string} [arch] The architecture it must hold.
   * @returns {Build | string}
   */
  artifact(dir, arch) {
    return this.build({
      addon: path.join(dir, ADDON_FILE),
      toolchain: path.join(dir, 'toolchain.json'),
      sums: path.join(dir, 'SHA256SUMS'),
      version: path.join(dir, VERSION_FILE),
      ...(arch === undefined ? {} : { arch }),
    });
  }
}

/**
 * The toolchain fields in which a build differs from a reference, as
 * `<field> <own label><value> (<label> <value>)`: those that can change the
 * bytes, and the informational ones (`generator`, shown not to change them;
 * scripts/lib/addon-digests.mjs `INFORMATIONAL_FIELDS`), which are only
 * ever reported.
 *
 * @param {Toolchain} reference
 * @param {Toolchain} toolchain
 * @param {string} label The reference's label (`record`, `CI`).
 * @param {string} [own] The build's label with a trailing space (`local `), or nothing.
 * @returns {{ bytes: string[], info: string[] }}
 */
function describeDifferences(reference, toolchain, label, own = '') {
  /** @param {string} field */
  const line = (field) =>
    `${field} ${own}${String(toolchain[field])} (${label} ${String(reference[field])})`;
  return {
    bytes: toolchainDifferences(reference, toolchain).map(line),
    info: informationalDifferences(reference, toolchain).map(
      (field) => `${line(field)}, information only: it does not change the bytes`,
    ),
  };
}

/**
 * The input differences worth reporting as information when the bytes
 * match: only when both sides record an identity (a record without one says
 * nothing about its inputs; a mismatch reports that instead).
 *
 * @param {Identity | undefined} reference
 * @param {Identity | undefined} build
 * @param {string} label
 * @returns {string[]}
 */
function knownDifferences(reference, build, label) {
  return reference === undefined || build === undefined
    ? []
    : identityDifferences(reference, build, label);
}

/**
 * Runs the tool. Nothing is written unless every check passed.
 *
 * @param {Options} options
 * @param {Io} io
 * @returns {number} 0 done, 1 the input was refused or a comparison failed
 */
export function runManifest(options, io) {
  const context = new Context(io);
  switch (options.command) {
    case 'components':
      return components(options.arch, context);
    case 'collect':
      return collect(options.arch, options.out, context);
    case 'check-toolchain':
      return checkRecordToolchain(options.toolchain, context);
    case 'verify':
      return verify(options.dir, options.record, context);
    case 'write':
      return write(options, context);
    case 'compare':
      return compare(options.manifest, context);
  }
}

/**
 * @param {string} arch
 * @param {Context} context
 * @returns {number}
 */
function components(arch, context) {
  const record = context.record();
  if (typeof record === 'string') return context.refuse(record);
  const entry = record.manifest.arches[arch];
  if (entry === undefined) return context.refuse(`${record.path} records no ${arch} build`);
  const toolset = toolsetOfRecord(entry.toolchain);
  if (typeof toolset === 'string') return context.refuse(`${record.path}: ${toolset}`);
  for (const id of [toolset.tools, toolset.spectre, toolset.sdk]) context.io.log(id);
  return 0;
}

/**
 * @param {string} arch
 * @param {string} out
 * @param {Context} context
 * @returns {number}
 */
function collect(arch, out, context) {
  const tree = path.join('native', 'win32-job', 'build', arch);
  const addon = path.join(tree, 'Release', ADDON_FILE);
  const build = context.build({ addon, toolchain: path.join(tree, 'toolchain.json'), arch });
  if (typeof build === 'string') return context.refuse(build);
  /** @type {string | undefined} */
  let version;
  if (context.io.platform === 'win32' && context.io.hostArch === arch) {
    /** @type {unknown} */
    let loaded;
    try {
      loaded = context.io.loadVersion(context.resolve(addon));
    } catch (error) {
      return context.refuse(`cannot load ${addon}: ${String(error)}`);
    }
    if (!isAddonVersion(loaded)) {
      return context.refuse(
        `${addon} reports version ${JSON.stringify(loaded)}, not a semver version`,
      );
    }
    version = loaded;
  }
  const dir = context.resolve(out);
  context.io.makeDir(dir);
  context.io.writeFile(path.join(dir, ADDON_FILE), build.bytes);
  context.io.writeFile(
    path.join(dir, 'toolchain.json'),
    renderToolchain(build.toolchain, build.identity),
  );
  context.io.writeFile(path.join(dir, 'SHA256SUMS'), renderSha256Sums(build.sha256));
  if (version !== undefined) context.io.writeFile(path.join(dir, VERSION_FILE), `${version}\n`);
  context.io.log(
    `collected ${arch} ${ADDON_FILE}: sha256 ${build.sha256}, size ${String(build.size)}, version ${version ?? '(not loadable on this host)'}`,
  );
  context.io.log(renderToolchain(build.toolchain).trimEnd());
  return 0;
}

/**
 * @param {string} file
 * @param {Context} context
 * @returns {number}
 */
function checkRecordToolchain(file, context) {
  const record = context.record();
  if (typeof record === 'string') return context.refuse(record);
  const text = context.read(file);
  if (text.bytes === undefined) return context.refuse(`cannot read ${file} (${text.problem})`);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(text.bytes));
  } catch {
    parsed = null;
  }
  const toolchain = checkToolchain(parsed);
  if (typeof toolchain === 'string') return context.refuse(`${file}: ${toolchain}`);
  const entry = record.manifest.arches[String(toolchain['arch'])];
  if (entry === undefined) {
    return context.refuse(`${record.path} records no ${String(toolchain['arch'])} build`);
  }
  const differs = describeDifferences(entry.toolchain, toolchain, 'record');
  for (const line of differs.info) context.io.log(`toolchain differs from the record: ${line}`);
  for (const line of knownDifferences(entry.identity, toolchainIdentity(parsed), 'record')) {
    context.io.log(`inputs (information only): ${line}`);
  }
  if (differs.bytes.length > 0) {
    return context.refuse(
      `${file} is not the toolchain of record (${record.path}), so the record check would be skipped; differing fields: ${differs.bytes.join(', ')}`,
    );
  }
  context.io.log(`${file} is the toolchain of record (${record.path})`);
  return 0;
}

/**
 * The record a rebuild must reproduce: the one given (release phase 2: the
 * tag's record, which the table must be written from), else the one the
 * table names.
 *
 * @param {string | undefined} recordPath
 * @param {Context} context
 * @returns {{ path: string, manifest: Manifest } | string}
 */
function recordToVerify(recordPath, context) {
  const table = context.record();
  if (recordPath === undefined) return table;
  const wanted = recordPath.replaceAll('\\', '/');
  const release = releaseOf(wanted);
  if (release === null) {
    return `${recordPath} is not native/win32-job/release/<release>/manifest.json`;
  }
  const record = context.manifest(wanted);
  if (typeof record === 'string') return `${record}; commit the release record before tagging`;
  if (record.release !== release) {
    return `${wanted}: release ${record.release} is not its directory ${release}`;
  }
  if (typeof table === 'string') return table;
  if (table.path !== wanted) {
    return `${DIGESTS_MODULE} is written from ${table.path}, not ${wanted}; regenerate it: node scripts/addon/write-digests.mjs --from-manifest ${wanted}`;
  }
  return table;
}

/**
 * @param {string} dir
 * @param {string | undefined} recordPath
 * @param {Context} context
 * @returns {number}
 */
function verify(dir, recordPath, context) {
  const recorded = recordToVerify(recordPath, context);
  if (typeof recorded === 'string') return context.refuse(recorded);
  const { path: wanted, manifest: record } = recorded;
  const build = context.artifact(dir);
  if (typeof build === 'string') return context.refuse(build);
  const entry = record.arches[build.arch];
  if (entry === undefined) return context.refuse(`${wanted} records no ${build.arch} build`);
  const differs = describeDifferences(entry.toolchain, build.toolchain, 'record');
  for (const line of differs.info) {
    context.io.log(`${build.arch}: toolchain differs from the record: ${line}`);
  }
  /** @type {string[]} */
  const problems = [];
  if (differs.bytes.length > 0) {
    problems.push(
      `${build.arch}: the rebuild was not built with the toolchain of record (${wanted}); differing fields: ${differs.bytes.join(', ')}`,
    );
  }
  const inputs = identityDifferences(entry.identity, build.identity, 'record');
  if (build.sha256 !== entry.sha256 || build.size !== entry.size) {
    problems.push(
      `${build.arch}: the rebuild does not reproduce ${wanted}: sha256 ${build.sha256} (record ${entry.sha256}), size ${String(build.size)} (record ${String(entry.size)})`,
      ...(inputs.length === 0
        ? [
            `${build.arch}: inputs: none of the recorded inputs differs from the record; the change is in an input the identity does not cover`,
          ]
        : inputs.map((line) => `${build.arch}: inputs: ${line}`)),
    );
  } else {
    for (const line of knownDifferences(entry.identity, build.identity, 'record')) {
      context.io.log(`${build.arch}: inputs (information only, the bytes reproduce): ${line}`);
    }
  }
  if (build.version !== undefined && build.version !== record.version) {
    problems.push(
      `${build.arch}: the rebuild reports version ${build.version} (record ${record.version})`,
    );
  }
  if (problems.length > 0) {
    for (const problem of problems) context.refuse(problem);
    return 1;
  }
  context.io.log(
    `${build.arch}: reproduces ${wanted} (sha256 ${entry.sha256}, size ${String(entry.size)}, version ${record.version})`,
  );
  return 0;
}

/**
 * @param {{ release: string, dir: string, out: string }} options
 * @param {Context} context
 * @returns {number}
 */
function write(options, context) {
  /** @type {Record<string, ReleaseArch>} */
  const arches = {};
  /** @type {Record<string, string | undefined>} */
  const versions = {};
  for (const arch of RELEASE_ARCHES) {
    const build = context.artifact(path.join(options.dir, arch), arch);
    if (typeof build === 'string') return context.refuse(build);
    arches[arch] = {
      sha256: build.sha256,
      size: build.size,
      toolchain: build.toolchain,
      ...(build.identity === undefined ? {} : { identity: build.identity }),
    };
    versions[arch] = build.version;
  }
  const version = versions['x64'];
  if (version === undefined) {
    return context.refuse(
      `${path.join(options.dir, 'x64', VERSION_FILE)} is missing: the x64 build records the addon version`,
    );
  }
  for (const [arch, other] of Object.entries(versions)) {
    if (other !== undefined && other !== version) {
      return context.refuse(`the ${arch} build reports version ${other}, x64 ${version}`);
    }
  }
  const text = renderManifest({ release: options.release, version, arches });
  const checked = parseManifest(text);
  if (typeof checked === 'string')
    return context.refuse(`the manifest would be invalid: ${checked}`);
  const out = context.resolve(options.out);
  context.io.makeDir(out);
  context.io.writeFile(path.join(out, 'manifest.json'), text);
  context.io.writeFile(path.join(out, 'SHA256SUMS'), renderReleaseSums(checked));
  context.io.writeFile(path.join(out, 'toolchain.json'), renderReleaseToolchains(checked));
  context.io.log(`release record ${checked.release} (addon version ${version}):`);
  for (const arch of RELEASE_ARCHES) {
    const entry = /** @type {ReleaseArch} */ (checked.arches[arch]);
    context.io.log(`  ${arch} sha256 ${entry.sha256} size ${String(entry.size)}`);
  }
  return 0;
}

/**
 * @param {string} file
 * @param {Context} context
 * @returns {number}
 */
function compare(file, context) {
  const ci = context.manifest(file);
  if (typeof ci === 'string') return context.refuse(ci);
  context.io.log(
    `comparing the local builds with ${file} (release ${ci.release}, version ${ci.version})`,
  );
  let failed = 0;
  for (const arch of Object.keys(ci.arches).sort()) {
    const entry = /** @type {ReleaseArch} */ (ci.arches[arch]);
    const tree = path.join('native', 'win32-job', 'build', arch);
    const local = context.build({
      addon: path.join(tree, 'Release', ADDON_FILE),
      toolchain: path.join(tree, 'toolchain.json'),
      arch,
    });
    if (typeof local === 'string') {
      failed += 1;
      context.io.log(
        `${arch}: NO LOCAL BUILD (${local}); run node native/win32-job/build.mjs --toolset-of-record --arch ${arch}`,
      );
      continue;
    }
    const differs = describeDifferences(entry.toolchain, local.toolchain, 'CI', 'local ');
    const sameBytes = local.sha256 === entry.sha256 && local.size === entry.size;
    if (differs.bytes.length > 0 || !sameBytes) failed += 1;
    if (differs.bytes.length > 0) {
      context.io.log(
        `${arch}: TOOLCHAIN MISMATCH (not the same toolchain of record): ${differs.bytes.join(', ')}`,
      );
    }
    const inputs = identityDifferences(entry.identity, local.identity, 'CI');
    if (sameBytes) {
      context.io.log(`${arch}: MATCH sha256 ${entry.sha256} size ${String(entry.size)}`);
      for (const line of knownDifferences(entry.identity, local.identity, 'CI')) {
        context.io.log(`${arch}: inputs (information only): ${line}`);
      }
    } else {
      context.io.log(
        `${arch}: MISMATCH local sha256 ${local.sha256} size ${String(local.size)}, CI sha256 ${entry.sha256} size ${String(entry.size)}`,
      );
      for (const line of inputs) context.io.log(`${arch}: inputs: ${line}`);
    }
    for (const line of differs.info) context.io.log(`${arch}: toolchain differs: ${line}`);
  }
  if (failed > 0) {
    return context.refuse(
      `${String(failed)} of ${String(Object.keys(ci.arches).length)} architectures do not match ${file}`,
    );
  }
  context.io.log(`all ${String(Object.keys(ci.arches).length)} architectures match ${file}`);
  return 0;
}
