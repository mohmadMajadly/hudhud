// The pinned Windows SDK of the job addon's release build (ADR-0014
// amendment 14; scripts/addon/toolchain.mjs supplies the I/O,
// .github/workflows/addon-prebuild.yml runs it, native/win32-job/build.mjs
// --toolset-of-record requires it), and the explicit choice of the Visual
// Studio instance.
//
// native/win32-job/toolchain-pin.json names, by URL, size and sha256, the
// MSIs and cabinets of one Windows SDK servicing build from the Visual
// Studio catalog. The SDK is machine-wide when installed, and an installer
// never downgrades a newer servicing build already on the machine (run
// 40161785779: the runner image moved from 10.1.26100.8249 to .9457 under
// the same 10.0.26100.0 directory, and the rebuild changed). So the SDK is
// never installed: its MSIs are unpacked with an administrative install
// (`msiexec /a`, extraction only, nothing registered) into a directory of
// our own, and the build points MSBuild and CMake at it.
//
// The MSVC toolset is not pinned this way: the release build uses the
// runner image's Visual Studio Enterprise instance, the licensing basis of
// the static runtime it links (ADR-0015 item 12), chosen explicitly
// (selectInstance); the input identity of every build
// (scripts/lib/addon-identity.mjs) names any change of its files.
//
// Command:
// - `provision-sdk --downloads <dir> --out <dir>`: downloads every pinned SDK
//   payload, checks size and sha256, unpacks the pinned MSIs into <dir> and
//   writes the marker build.mjs checks; does nothing when <dir> holds the
//   pinned SDK already.
//
// Every file access, download and process goes through the injected `io`.

import { createHash } from 'node:crypto';
import path from 'node:path';

/** The pin, relative to the repository root. */
export const PIN_FILE = 'native/win32-job/toolchain-pin.json';

/** The marker a provisioned SDK directory holds (see {@link renderSdkMarker}). */
export const SDK_MARKER = 'hudhud-sdk.json';

/** A hang guard for one MSI, far above the 2 s an MSI takes locally. */
const MSIEXEC_TIMEOUT_MS = 15 * 60 * 1000;

const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION4 = /^\d{1,5}\.\d{1,5}\.\d{1,7}\.\d{1,7}$/u;
const DOWNLOAD_URL =
  /^https:\/\/download\.visualstudio\.microsoft\.com\/download\/pr\/[A-Za-z0-9%._/-]{1,400}$/u;
const PAYLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}\.(?:msi|cab)$/u;
/** A directory the tool writes to: absolute, no space or quote (msiexec's TARGETDIR). */
const WINDOWS_DIR = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]{0,200}$/u;

/** A usage error (exit code 2). */
export class PinUsageError extends Error {}

/**
 * @typedef {object} Payload
 * @property {string} name File name (an MSI, or a cabinet an MSI names).
 * @property {number} size
 * @property {string} sha256
 * @property {string} url
 */

/**
 * @typedef {object} Pin
 * @property {{ version: string, build: string, package: string, msis: readonly string[],
 *   payloads: readonly Payload[] }} windowsSdk
 */

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @returns {value is Record<string, unknown>}
 */
function hasExactly(value, keys) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @returns {value is string}
 */
function matches(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

/**
 * Reads the pin; anything malformed is refused with a reason.
 *
 * @param {string} text
 * @returns {Pin | string}
 */
export function parsePin(text) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  if (!hasExactly(value, ['windowsSdk'])) return 'fields are not windowsSdk';
  const sdk = value['windowsSdk'];
  if (!hasExactly(sdk, ['build', 'msis', 'package', 'payloads', 'version'])) {
    return 'windowsSdk fields are not build, msis, package, payloads, version';
  }
  if (!matches(sdk['version'], /^10\.0\.\d{5}\.0$/u)) {
    return 'windowsSdk.version is not 10.0.<build>.0';
  }
  if (!matches(sdk['build'], VERSION4)) return 'windowsSdk.build is not a servicing build';
  if (!matches(sdk['package'], /^[A-Za-z0-9_.]{1,80},version=[0-9.]{1,40}$/u)) {
    return 'windowsSdk.package is not <id>,version=<version>';
  }
  const payloads = sdk['payloads'];
  if (!Array.isArray(payloads) || payloads.length === 0) return 'windowsSdk.payloads is empty';
  /** @type {Set<string>} */
  const names = new Set();
  for (const payload of /** @type {unknown[]} */ (payloads)) {
    if (
      !hasExactly(payload, ['name', 'sha256', 'size', 'url']) ||
      !matches(payload['name'], PAYLOAD_NAME) ||
      !matches(payload['sha256'], SHA256) ||
      !matches(payload['url'], DOWNLOAD_URL) ||
      typeof payload['size'] !== 'number' ||
      !Number.isSafeInteger(payload['size']) ||
      payload['size'] <= 0
    ) {
      return `windowsSdk.payloads: ${JSON.stringify(payload).slice(0, 120)} is not a payload`;
    }
    const name = payload['name'].toLowerCase();
    if (names.has(name)) return `windowsSdk.payloads names ${payload['name']} twice`;
    names.add(name);
  }
  const msis = sdk['msis'];
  if (
    !Array.isArray(msis) ||
    msis.length === 0 ||
    new Set(msis).size !== msis.length ||
    !msis.every(
      (name) => typeof name === 'string' && name.endsWith('.msi') && names.has(name.toLowerCase()),
    )
  ) {
    return 'windowsSdk.msis is not a list of distinct MSIs among the payloads';
  }
  return /** @type {Pin} */ (value);
}

/**
 * The sha256 of the pin in a canonical form: the marker of a provisioned
 * SDK names it, so a directory provisioned from another pin is refused.
 *
 * @param {Pin} pin
 * @returns {string}
 */
export function pinDigest(pin) {
  const sdk = pin.windowsSdk;
  const canonical = JSON.stringify({
    version: sdk.version,
    build: sdk.build,
    package: sdk.package,
    msis: sdk.msis,
    payloads: sdk.payloads.map((p) => ({ name: p.name, size: p.size, sha256: p.sha256 })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The marker of a provisioned SDK directory.
 *
 * @param {Pin} pin
 * @returns {string}
 */
export function renderSdkMarker(pin) {
  return `${JSON.stringify(
    { version: pin.windowsSdk.version, build: pin.windowsSdk.build, pin: pinDigest(pin) },
    null,
    2,
  )}\n`;
}

/**
 * Checks a provisioned SDK's marker against the pin.
 *
 * @param {string} text
 * @param {Pin} pin
 * @returns {{ build: string } | string} the servicing build, or why the directory is not the pinned SDK
 */
export function checkSdkMarker(text, pin) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return `${SDK_MARKER} is not JSON`;
  }
  if (!hasExactly(value, ['build', 'pin', 'version'])) {
    return `${SDK_MARKER} fields are not build, pin, version`;
  }
  if (value['pin'] !== pinDigest(pin)) {
    return `it was provisioned from another pin (Windows SDK ${String(value['build'])}, pin ${String(value['pin']).slice(0, 12)}), not ${PIN_FILE} (Windows SDK ${pin.windowsSdk.build}, pin ${pinDigest(pin).slice(0, 12)})`;
  }
  return { build: pin.windowsSdk.build };
}

/**
 * The Windows Kits root inside a provisioned SDK directory, with a trailing
 * separator (MSBuild's `WindowsSdkDir_10` form).
 *
 * @param {string} dir
 * @returns {string}
 */
export function kitsRoot(dir) {
  return `${path.win32.join(dir, 'Windows Kits', '10')}\\`;
}

/**
 * The files a provisioned SDK must hold for the addon build: the MSBuild
 * props (UAP.props anchors `WindowsSdkDir` at the SDKManifest.xml above it),
 * the headers and libraries of both architectures and rc.exe (CMake's
 * compiler check links a manifest).
 *
 * @param {Pin} pin
 * @returns {string[]} relative to {@link kitsRoot}
 */
export function sdkRequiredFiles(pin) {
  const v = pin.windowsSdk.version;
  return [
    'SDKManifest.xml',
    `DesignTime\\CommonConfiguration\\Neutral\\UAP\\${v}\\UAP.props`,
    'DesignTime\\CommonConfiguration\\Neutral\\uCRT.props',
    `Include\\${v}\\shared\\sdkddkver.h`,
    `Include\\${v}\\ucrt\\stdlib.h`,
    `Include\\${v}\\um\\Windows.h`,
    `Lib\\${v}\\ucrt\\x64\\libucrt.lib`,
    `Lib\\${v}\\ucrt\\arm64\\libucrt.lib`,
    `Lib\\${v}\\um\\x64\\kernel32.Lib`,
    `Lib\\${v}\\um\\arm64\\kernel32.Lib`,
    `bin\\${v}\\x64\\rc.exe`,
  ];
}

/**
 * The Visual Studio instance of a build of record among vswhere's JSON
 * output: the one at `wanted` (HUDHUD_VS_INSTALL; the release workflow names
 * the runner image's Visual Studio Enterprise instance), else the only
 * complete instance that holds the record's MSVC toolset. Never "the
 * latest" or the default instance.
 *
 * @param {string} text `vswhere -all -products * -format json` output.
 * @param {{ wanted: string | undefined, toolset: string,
 *   hasToolset: (installationPath: string) => boolean }} choice `toolset`
 *   names the toolset in messages (`MSVC 14.44.35207 for x64`).
 * @returns {{ path: string, version: string, product: string } | string} the instance, or why there is none
 */
export function selectInstance(text, choice) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  if (!Array.isArray(value)) return 'vswhere printed no instance list';
  /**
   * @param {unknown} entry
   * @param {string} key
   */
  const field = (entry, key) =>
    String(typeof entry === 'object' && entry !== null ? Reflect.get(entry, key) : undefined);
  /** @param {string} dir */
  const normal = (dir) => dir.replaceAll('/', '\\').replace(/\\+$/u, '').toLowerCase();
  const describe = (/** @type {unknown[]} */ list) =>
    list
      .map(
        (entry) =>
          `${field(entry, 'installationPath')} (${field(entry, 'productId')} ${field(entry, 'installationVersion')})`,
      )
      .join('; ') || 'none';
  const usable = (/** @type {unknown} */ entry) =>
    typeof entry === 'object' &&
    entry !== null &&
    typeof Reflect.get(entry, 'installationPath') === 'string' &&
    Reflect.get(entry, 'isComplete') !== false;
  /** @type {unknown} */
  let chosen;
  if (choice.wanted !== undefined) {
    const wanted = normal(choice.wanted);
    chosen = value.find(
      (entry) => usable(entry) && normal(field(entry, 'installationPath')) === wanted,
    );
    if (chosen === undefined) {
      return `no complete Visual Studio instance at ${choice.wanted} (instances: ${describe(value)})`;
    }
    if (!choice.hasToolset(field(chosen, 'installationPath'))) {
      return `the Visual Studio instance at ${choice.wanted} has no ${choice.toolset}`;
    }
  } else {
    const holding = value.filter(
      (entry) => usable(entry) && choice.hasToolset(field(entry, 'installationPath')),
    );
    if (holding.length !== 1) {
      return holding.length === 0
        ? `no complete Visual Studio instance has ${choice.toolset} (instances: ${describe(value)})`
        : `${String(holding.length)} Visual Studio instances have ${choice.toolset} (${describe(holding)}); choose one with HUDHUD_VS_INSTALL`;
    }
    chosen = holding[0];
  }
  return {
    path: field(chosen, 'installationPath'),
    version: field(chosen, 'installationVersion'),
    product: field(chosen, 'productId'),
  };
}

// ---- arguments -------------------------------------------------------------

/** @typedef {{ command: 'provision-sdk', downloads: string, out: string }} PinOptions */

export const PIN_USAGE = 'usage: toolchain.mjs provision-sdk --downloads <dir> --out <dir>';

/**
 * @param {readonly string[]} argv
 * @returns {PinOptions}
 * @throws {PinUsageError}
 */
export function parsePinArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'provision-sdk') throw new PinUsageError(PIN_USAGE);
  const flags = ['--downloads', '--out'];
  /** @type {Record<string, string>} */
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = String(rest[i]);
    const value = rest[i + 1];
    if (!flags.includes(flag)) {
      throw new PinUsageError(`${command} takes no ${JSON.stringify(flag)}\n${PIN_USAGE}`);
    }
    if (value === undefined || value === '') throw new PinUsageError(`missing value for ${flag}`);
    if (Object.hasOwn(values, flag)) throw new PinUsageError(`${flag} given twice`);
    if (!WINDOWS_DIR.test(value)) {
      throw new PinUsageError(
        `${flag} must be an absolute Windows directory without spaces: ${value}`,
      );
    }
    values[flag] = value;
  }
  for (const flag of flags) {
    if (!Object.hasOwn(values, flag)) {
      throw new PinUsageError(`${command} needs ${flag}\n${PIN_USAGE}`);
    }
  }
  return { command, downloads: String(values['--downloads']), out: String(values['--out']) };
}

// ---- the tool --------------------------------------------------------------

/**
 * @typedef {object} PinIo
 * @property {string} root The repository root.
 * @property {string} systemRoot `%SystemRoot%`
 * @property {(file: string) => boolean} exists
 * @property {(file: string) => Uint8Array} readFile Throws when the file cannot be read.
 * @property {(file: string, data: string) => void} writeFile
 * @property {(dir: string) => void} makeDir Creates a directory and its parents.
 * @property {(file: string) => void} removeFile Removes a file if it exists.
 * @property {(file: string) => Promise<{ size: number, sha256: string }>} hashFile
 * @property {(url: string, file: string) => Promise<void>} download Throws on any failure.
 * @property {(file: string, args: readonly string[], timeoutMs: number) => { status: number | null, error?: string }} run
 * @property {(line: string) => void} log
 * @property {(line: string) => void} error
 */

/**
 * Provisions the pinned SDK. Nothing is unpacked unless the pin and every
 * download check out.
 *
 * @param {PinOptions} options
 * @param {PinIo} io
 * @returns {Promise<number>} 0 done, 1 refused
 */
export async function runPin(options, io) {
  /** @param {string} message */
  const refuse = (message) => {
    io.error(`toolchain: ${message}`);
    return 1;
  };
  /** @type {Uint8Array} */
  let pinBytes;
  try {
    pinBytes = io.readFile(path.join(io.root, PIN_FILE));
  } catch (error) {
    return refuse(
      `cannot read ${PIN_FILE} (${String(/** @type {{ code?: unknown }} */ (error).code ?? error)})`,
    );
  }
  const pin = parsePin(new TextDecoder().decode(pinBytes));
  if (typeof pin === 'string') return refuse(`${PIN_FILE}: ${pin}`);
  const sdk = pin.windowsSdk;
  const marker = path.win32.join(options.out, SDK_MARKER);
  if (io.exists(marker)) {
    const checked = checkSdkMarker(new TextDecoder().decode(io.readFile(marker)), pin);
    if (typeof checked === 'string') {
      return refuse(`${options.out}: ${checked}; delete it and provision again`);
    }
    io.log(`${options.out} holds the pinned Windows SDK ${sdk.build} already`);
    return 0;
  }
  io.makeDir(options.downloads);
  let bytes = 0;
  for (const payload of sdk.payloads) {
    const fetched = await fetchPinned(
      payload,
      path.win32.join(options.downloads, payload.name),
      io,
    );
    if (fetched !== null) return refuse(fetched);
    bytes += payload.size;
  }
  io.log(
    `${String(sdk.payloads.length)} Windows SDK ${sdk.build} payloads, ${String(Math.round(bytes / 1e6))} MB, match ${PIN_FILE}`,
  );
  io.makeDir(options.out);
  const msiexec = path.win32.join(io.systemRoot, 'System32', 'msiexec.exe');
  for (const name of sdk.msis) {
    const msi = path.win32.join(options.downloads, name);
    const log = path.win32.join(options.downloads, `${name}.log`);
    const result = io.run(
      msiexec,
      ['/a', msi, '/qn', `TARGETDIR=${options.out}`, '/l*v', log],
      MSIEXEC_TIMEOUT_MS,
    );
    if (result.status !== 0) {
      return refuse(
        `msiexec /a ${name} exited with ${String(result.status)}${result.error === undefined ? '' : ` (${result.error})`}; log ${log}`,
      );
    }
    io.log(`unpacked ${name}`);
  }
  const root = kitsRoot(options.out);
  const missing = sdkRequiredFiles(pin).filter((file) => !io.exists(path.win32.join(root, file)));
  if (missing.length > 0) {
    return refuse(`the unpacked SDK lacks ${missing.join(', ')} under ${root}`);
  }
  io.writeFile(marker, renderSdkMarker(pin));
  io.log(`Windows SDK ${sdk.build} (${sdk.version}) provisioned at ${root}`);
  return 0;
}

/**
 * Downloads a pinned file unless a file of its size and sha256 is there
 * already, and checks the download's size and sha256.
 *
 * @param {Payload} expected
 * @param {string} file
 * @param {PinIo} io
 * @returns {Promise<string | null>} null when the file is the pinned one, else why not
 */
async function fetchPinned(expected, file, io) {
  if (io.exists(file)) {
    const have = await io.hashFile(file);
    if (have.sha256 === expected.sha256 && have.size === expected.size) return null;
    io.removeFile(file);
  }
  try {
    await io.download(expected.url, file);
  } catch (error) {
    return `downloading ${expected.url} failed: ${String(error)}`;
  }
  const got = await io.hashFile(file);
  if (got.size !== expected.size) {
    io.removeFile(file);
    return `${expected.name} is ${String(got.size)} bytes, the pin says ${String(expected.size)} (${expected.url})`;
  }
  if (got.sha256 !== expected.sha256) {
    io.removeFile(file);
    return `${expected.name} is sha256 ${got.sha256}, the pin says ${expected.sha256} (${expected.url})`;
  }
  return null;
}
