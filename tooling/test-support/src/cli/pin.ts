/**
 * The pin file `tooling/cli-pin.json` (plan §4.6): the Claude Code CLI version
 * under test and, per platform, the npm platform package, the tarball's sha512
 * integrity and the extracted binary's sha256 and size (research 05 §1).
 *
 * Every value that later becomes part of a URL or a file path is validated
 * here against a closed pattern, so neither the registry URL nor the cache
 * path can be steered by a malformed pin.
 */

import { readFile } from 'node:fs/promises';

import { CliFetchError } from './errors.js';

/** Upper bound for an extracted CLI binary (the 2.1.296 binaries are ~250 MiB). */
export const MAX_BINARY_BYTES: number = 1024 * 1024 * 1024;

/** Upper bound for the pin file itself. */
const MAX_PIN_FILE_BYTES = 64 * 1024;

/** Strict SemVer 2.0 without build metadata; safe as a single path segment. */
const VERSION_PATTERN =
  /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[0-9A-Za-z-]{1,32}(?:\.[0-9A-Za-z-]{1,32}){0,7})?$/;
const PLATFORM_PATTERN = /^(?:(?:darwin|win32)-(?:x64|arm64)|linux-(?:x64|arm64)(?:-musl)?)$/;
/** npm SRI for sha512: 64 bytes in padded base64. */
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The npm scope and name prefix of the native CLI platform packages (02 §2.1). */
export const CLI_PACKAGE = '@anthropic-ai/claude-code';

/** A platform with complete digests. */
export interface PinnedBinary {
  readonly package: string;
  readonly file: string;
  /** npm SRI of the tarball, `sha512-<base64>`. */
  readonly integrity: string;
  /** Lower-case hex sha256 of the extracted binary. */
  readonly sha256: string;
  /** Byte size of the extracted binary. */
  readonly size: number;
}

/** A platform listed for completeness whose digests land after its gate (M1). */
export interface PendingBinary {
  readonly package: string;
  readonly file: string;
  readonly pendingGate: true;
}

export type PinEntry = PinnedBinary | PendingBinary;

/** The parsed pin file. */
export interface CliPin {
  readonly version: string;
  readonly platforms: ReadonlyMap<string, PinEntry>;
}

/** True when `value` is a SemVer version accepted as a cache path segment. */
export function isValidVersion(value: string): boolean {
  return VERSION_PATTERN.test(value);
}

/** True when `value` names a supported platform package suffix. */
export function isValidPlatform(value: string): boolean {
  return PLATFORM_PATTERN.test(value);
}

/** True when `value` is a sha512 SRI string. */
export function isValidIntegrity(value: string): boolean {
  return INTEGRITY_PATTERN.test(value);
}

/** True when `value` is a lower-case hex sha256. */
export function isValidSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

/** True when `value` is an acceptable binary size. */
export function isValidSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_BINARY_BYTES
  );
}

/** The npm package that carries the binary of `platform`. */
export function platformPackage(platform: string): string {
  return `${CLI_PACKAGE}-${platform}`;
}

/** The binary's file name inside `package/` of the platform tarball. */
export function binaryFileName(platform: string): string {
  return platform.startsWith('win32-') ? 'claude.exe' : 'claude';
}

/** The C library of a Linux host. */
export type Libc = 'glibc' | 'musl';

/**
 * The C library a Linux Node.js runs on, from its diagnostic report
 * (`process.report.getReport()`): glibc builds state `glibcVersionRuntime` in
 * the header, musl builds do not.
 */
export function libcFromReport(report: unknown): Libc {
  const header: unknown =
    typeof report === 'object' && report !== null ? Reflect.get(report, 'header') : undefined;
  const glibc: unknown =
    typeof header === 'object' && header !== null
      ? Reflect.get(header, 'glibcVersionRuntime')
      : undefined;
  return typeof glibc === 'string' && glibc !== '' ? 'glibc' : 'musl';
}

/**
 * The platform key of a host; on Linux, `libc` selects the glibc or the
 * `-musl` package (ignored elsewhere).
 */
export function hostPlatform(platform: string, arch: string, libc: Libc): string {
  const key = `${platform}-${arch}${platform === 'linux' && libc === 'musl' ? '-musl' : ''}`;
  if (!isValidPlatform(key)) {
    throw new CliFetchError('platform-unavailable', `unsupported host platform ${key}`);
  }
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuseUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new CliFetchError('pin-invalid', `${where}: unknown key ${JSON.stringify(key)}`);
    }
  }
}

function stringField(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new CliFetchError('pin-invalid', `${where}: "${key}" must be a string`);
  }
  return value;
}

function parseEntry(platform: string, value: unknown, where: string): PinEntry {
  if (!isValidPlatform(platform)) {
    throw new CliFetchError(
      'pin-invalid',
      `${where}: unsupported platform ${JSON.stringify(platform)}`,
    );
  }
  if (!isRecord(value)) {
    throw new CliFetchError('pin-invalid', `${where}: entry must be an object`);
  }
  const pkg = stringField(value, 'package', where);
  if (pkg !== platformPackage(platform)) {
    throw new CliFetchError(
      'pin-invalid',
      `${where}: package must be ${platformPackage(platform)}`,
    );
  }
  const file = stringField(value, 'file', where);
  if (file !== binaryFileName(platform)) {
    throw new CliFetchError('pin-invalid', `${where}: file must be ${binaryFileName(platform)}`);
  }
  if ('pendingGate' in value) {
    refuseUnknownKeys(value, ['package', 'file', 'pendingGate'], where);
    if (value['pendingGate'] !== true) {
      throw new CliFetchError('pin-invalid', `${where}: "pendingGate" must be true when present`);
    }
    return { package: pkg, file, pendingGate: true };
  }
  refuseUnknownKeys(value, ['package', 'file', 'integrity', 'sha256', 'size'], where);
  const integrity = stringField(value, 'integrity', where);
  if (!isValidIntegrity(integrity)) {
    throw new CliFetchError('pin-invalid', `${where}: "integrity" must be a sha512 SRI string`);
  }
  const sha256 = stringField(value, 'sha256', where);
  if (!isValidSha256(sha256)) {
    throw new CliFetchError('pin-invalid', `${where}: "sha256" must be 64 lower-case hex digits`);
  }
  const size = value['size'];
  if (!isValidSize(size)) {
    throw new CliFetchError(
      'pin-invalid',
      `${where}: "size" must be an integer in 1..${String(MAX_BINARY_BYTES)}`,
    );
  }
  return { package: pkg, file, integrity, sha256, size };
}

/** Validates a parsed pin document. `source` names it in error messages. */
export function parsePin(value: unknown, source: string): CliPin {
  if (!isRecord(value)) {
    throw new CliFetchError('pin-invalid', `${source}: must be a JSON object`);
  }
  refuseUnknownKeys(value, ['$comment', 'version', 'platforms'], source);
  const version = stringField(value, 'version', source);
  if (!isValidVersion(version)) {
    throw new CliFetchError('pin-invalid', `${source}: "version" is not a SemVer version`);
  }
  const platforms = value['platforms'];
  if (!isRecord(platforms)) {
    throw new CliFetchError('pin-invalid', `${source}: "platforms" must be an object`);
  }
  const entries = new Map<string, PinEntry>();
  for (const [platform, entry] of Object.entries(platforms)) {
    entries.set(platform, parseEntry(platform, entry, `${source} platforms.${platform}`));
  }
  return { version, platforms: entries };
}

/** Reads and validates the pin file at `file`. */
export async function loadPin(file: string): Promise<CliPin> {
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > MAX_PIN_FILE_BYTES) {
    throw new CliFetchError(
      'pin-invalid',
      `${file}: larger than ${String(MAX_PIN_FILE_BYTES)} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliFetchError('pin-invalid', `${file}: not valid JSON`, { cause: error });
  }
  return parsePin(parsed, file);
}

/** The complete entry of `platform`; refuses missing and pending platforms. */
export function requirePinned(pin: CliPin, platform: string): PinnedBinary {
  const entry = pin.platforms.get(platform);
  if (entry === undefined) {
    throw new CliFetchError('platform-unavailable', `no pin entry for platform ${platform}`);
  }
  if ('pendingGate' in entry) {
    throw new CliFetchError(
      'platform-unavailable',
      `platform ${platform} is pending its gate; its digests are not pinned yet`,
    );
  }
  return entry;
}
