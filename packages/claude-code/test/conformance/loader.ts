// Loader of the Claude Code golden conformance suites (plan §4.3, §5.6
// W4-T2; ADR-0006, ADR-0013 §10).
//
// Contract (`loadConformanceSuites`), shared by the conformance runner
// (`conformance.test.ts`, W4-T2) and the core loopback replay (W4-Z):
//
// - Input: the data directory `packages/claude-code/conformance/` (or
//   `options.root`) and the suite catalogue (`catalogue.ts`, or
//   `options.catalogue`).
// - Output: one `ConformanceSuite` per catalogue entry, in catalogue order,
//   each with its variants (one per recorded platform and case: `setup`
//   before `main`), each variant with its manifest entry, its parsed record
//   lines and its expect blocks (one per record line).
// - Strict: nothing is skipped or defaulted. Any problem fails the whole load
//   with a `ConformanceDataError` that lists every problem found: a
//   catalogue suite without data, data or a directory the catalogue does not
//   list, a manifest entry without its file or its expect file, a file
//   without a manifest entry, unknown or missing fields (manifest, entries,
//   record lines, expect lines), a manifest whose CLI version is not the
//   pinned one, a recorder revision that is not a git revision, a recording
//   whose shape departed from the research, a broken or unexpected gzip
//   member, text that is not UTF-8, a byte-order mark, a carriage return, a
//   blank line, a missing final newline, record lines out of time order, a
//   config line that does not match the manifest, an exit line that does not
//   match the manifest, an expect file whose line count is not the record
//   count.
// - The loader does not run the machine: `replay.ts` turns a variant into
//   machine inputs and `expect.ts` compares the outcome with the expect
//   blocks. A driver other than the direct `step` (the loopback) passes its
//   machine to `replayVariant`.
//
// `options.expectations: 'ignored'` reads no expect file (every `expect` is
// undefined): only the update mode of the runner uses it, which rewrites
// them from the replay after a re-recording, and that mode always fails its
// run.

import { Buffer } from 'node:buffer';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import type { JsonObject, JsonValue } from '@hudhud/core/protocol';

import { validateConformanceLine } from '../../../core/src/protocol/generated/validators.gen.js';
import type { SuiteDeclaration } from './catalogue.js';
import { CATALOGUE } from './declarations.js';

/** The data directory of the Claude Code suites. */
export const CONFORMANCE_ROOT = fileURLToPath(new URL('../../conformance/', import.meta.url));

/** The pinned CLI description (plan §4.6); fixtures must come from its version. */
const CLI_PIN_FILE = fileURLToPath(new URL('../../../../tooling/cli-pin.json', import.meta.url));

/** Recorded platforms (`process.platform` names). */
export type RecordedPlatform = 'linux' | 'win32' | 'darwin';

/** A record line direction (`conformance.schema.json`). */
export type RecordDir = 'config' | 'in' | 'out' | 'err' | 'exit' | 'cmd' | 'timer';

/** One record line. */
export interface RecordLine {
  /** Milliseconds since the launch. */
  readonly t: number;
  readonly dir: RecordDir;
  readonly v: JsonValue;
}

/** The launch of a recording (its config line). */
export interface LaunchConfig {
  readonly suite: string;
  readonly case: string;
  readonly platform: RecordedPlatform;
  /** The CLI argv after the binary. */
  readonly argv: readonly string[];
  /** The extra environment of the launch. */
  /**
   * What the product's environment set beyond the sandbox it was built from;
   * `null` for a sandbox variable it dropped (`launchEnvDiff` of the recorder).
   */
  readonly env: Readonly<Record<string, string | null>>;
}

/** One expect block: the effects (without events) and the events of one record line. */
export interface ExpectBlock {
  readonly effects: readonly JsonValue[];
  readonly events: readonly JsonValue[];
}

/** One `manifest.json` entry (the recorder's `ManifestEntry`, checked field by field). */
export interface ManifestEntry {
  readonly suite: string;
  readonly case: string;
  readonly file: string;
  readonly platform: RecordedPlatform;
  readonly cliVersion: string;
  readonly scenario: string;
  readonly research: string;
  readonly recordedOn: string;
  readonly recorder: string;
  readonly recorderRevision: string;
  readonly exit: { readonly code: number | null; readonly signal: string | null };
  readonly compressed: boolean;
  readonly shapeMissing: readonly string[];
  readonly orphansSelfExited?: readonly string[];
}

/** One recorded CLI process of a suite on one platform. */
export interface ConformanceVariant {
  /** `<suite>/<platform>[.<case>]`, unique. */
  readonly id: string;
  readonly suite: string;
  /** `main`, or the case recorded before it (`setup`). */
  readonly case: string;
  readonly platform: RecordedPlatform;
  readonly entry: ManifestEntry;
  readonly launch: LaunchConfig;
  /** Every record line, the config line first. */
  readonly records: readonly RecordLine[];
  /** One block per record line; `undefined` only with `expectations: 'ignored'`. */
  readonly expect: readonly ExpectBlock[] | undefined;
  /** Absolute path of the expect file (written by the update mode). */
  readonly expectFile: string;
}

/** One suite of the catalogue with its recorded variants. */
export interface ConformanceSuite {
  readonly name: string;
  readonly declaration: SuiteDeclaration;
  readonly variants: readonly ConformanceVariant[];
}

/** Options of {@link loadConformanceSuites}. */
export interface LoadOptions {
  /** The data directory. Default {@link CONFORMANCE_ROOT}. */
  readonly root?: string;
  /** The suite catalogue. Default {@link CATALOGUE}. */
  readonly catalogue?: readonly SuiteDeclaration[];
  /** The pinned CLI version every entry must name. Default: `tooling/cli-pin.json`. */
  readonly cliVersion?: string;
  /** `'required'` (default) or `'ignored'` (the update mode only). */
  readonly expectations?: 'required' | 'ignored';
}

/** Every problem a load found. */
export class ConformanceDataError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`conformance data is invalid:\n  ${problems.join('\n  ')}`);
    this.name = 'ConformanceDataError';
    this.problems = problems;
  }
}

const MANIFEST = 'manifest.json';
const MANIFEST_KEYS = ['$comment', 'format', 'entries'];
const ENTRY_KEYS = [
  'suite',
  'case',
  'file',
  'platform',
  'cliVersion',
  'scenario',
  'research',
  'recordedOn',
  'recorder',
  'recorderRevision',
  'exit',
  'compressed',
  'shapeMissing',
];
const ENTRY_OPTIONAL_KEYS = ['orphansSelfExited'];
const RECORD_DIRS: readonly RecordDir[] = ['config', 'in', 'out', 'err', 'exit', 'cmd', 'timer'];
const PLATFORMS: readonly RecordedPlatform[] = ['linux', 'win32', 'darwin'];
const REVISION = /^[0-9a-f]{7,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GZIP_MAGIC = [0x1f, 0x8b];
/** A UTF-8 byte-order mark, as decoded. */
const BOM = String.fromCharCode(0xfeff);
/** Largest decompressed suite accepted (the 5 MB suite holds two frames of about 5 MB). */
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** The expect file of a record file: `<base>.expect.jsonl` next to it. */
export function expectFileOf(file: string): string {
  return file.replace(/\.jsonl(?:\.gz)?$/u, '.expect.jsonl');
}

/** The record file of a variant, relative to the data directory. */
export function recordFileOf(
  suite: string,
  platform: string,
  caseName: string,
  compressed: boolean,
): string {
  const base = caseName === 'main' ? platform : `${platform}.${caseName}`;
  return `${suite}/${base}.jsonl${compressed ? '.gz' : ''}`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Keys of `value` outside `allowed` and keys of `required` that are missing. */
function keyProblems(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) problems.push(`unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) problems.push(`missing field ${key}`);
  }
  return problems;
}

/** The pinned CLI version of `tooling/cli-pin.json`. */
export function pinnedCliVersion(file = CLI_PIN_FILE): string {
  const pin = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!isObject(pin) || typeof pin['version'] !== 'string') {
    throw new ConformanceDataError([`${file}: no version`]);
  }
  return pin['version'];
}

/** Decodes stored bytes: gunzip when compressed (CRC and length checked by zlib), then strict UTF-8. */
export function decodeStored(bytes: Buffer, compressed: boolean, label: string): string {
  const isGzip = bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
  if (compressed !== isGzip) {
    throw new ConformanceDataError([
      `${label}: ${compressed ? 'not a gzip stream' : 'gzip data in an uncompressed file'}`,
    ]);
  }
  let plain = bytes;
  if (compressed) {
    try {
      plain = gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    } catch (error) {
      throw new ConformanceDataError([`${label}: gzip data is corrupt: ${String(error)}`]);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
  } catch {
    throw new ConformanceDataError([`${label}: not valid UTF-8`]);
  }
}

/** Splits JSONL text into lines: LF-terminated, no CR, no BOM, no blank line. */
export function jsonlLines(text: string, label: string): string[] {
  const problems: string[] = [];
  if (text.startsWith(BOM)) problems.push(`${label}: starts with a byte-order mark`);
  if (text.includes('\r')) problems.push(`${label}: contains a carriage return`);
  if (!text.endsWith('\n')) problems.push(`${label}: does not end with a newline`);
  const lines = text.slice(0, -1).split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') problems.push(`${label}:${String(index + 1)}: blank line`);
  });
  if (problems.length > 0) throw new ConformanceDataError(problems);
  return lines;
}

function parseLine(line: string, label: string): JsonValue {
  try {
    return JSON.parse(line) as JsonValue;
  } catch {
    throw new ConformanceDataError([`${label}: not JSON`]);
  }
}

/** Checks one manifest entry; returns its problems. */
export function entryProblems(entry: JsonValue, cliVersion: string): string[] {
  if (!isObject(entry)) return ['an entry is not an object'];
  const label = typeof entry['file'] === 'string' ? entry['file'] : '(entry without file)';
  const problems = keyProblems(entry, ENTRY_KEYS, ENTRY_OPTIONAL_KEYS);
  const text = (key: string): void => {
    if (Object.hasOwn(entry, key) && (typeof entry[key] !== 'string' || entry[key] === '')) {
      problems.push(`${key} is not a non-empty string`);
    }
  };
  for (const key of ['suite', 'case', 'file', 'scenario', 'research', 'recorder']) text(key);
  if (!PLATFORMS.includes(entry['platform'] as RecordedPlatform)) {
    problems.push(`unknown platform ${JSON.stringify(entry['platform'])}`);
  }
  if (entry['cliVersion'] !== cliVersion) {
    problems.push(
      `cliVersion ${JSON.stringify(entry['cliVersion'])} is not the pinned ${cliVersion}`,
    );
  }
  if (typeof entry['recordedOn'] !== 'string' || !DATE.test(entry['recordedOn'])) {
    problems.push('recordedOn is not a YYYY-MM-DD date');
  }
  if (typeof entry['recorderRevision'] !== 'string' || !REVISION.test(entry['recorderRevision'])) {
    problems.push('recorderRevision is not a git revision');
  }
  const exit = entry['exit'];
  if (
    !isObject(exit) ||
    keyProblems(exit, ['code', 'signal']).length > 0 ||
    !(exit['code'] === null || Number.isSafeInteger(exit['code'])) ||
    !(exit['signal'] === null || typeof exit['signal'] === 'string')
  ) {
    problems.push('exit is not {code, signal}');
  }
  if (typeof entry['compressed'] !== 'boolean') problems.push('compressed is not a boolean');
  if (!isStringArray(entry['shapeMissing'])) {
    problems.push('shapeMissing is not a string array');
  } else if (entry['shapeMissing'].length > 0) {
    // The recording departed from the research it follows: review it, never replay it as is.
    problems.push(`the recording departed from the research: ${entry['shapeMissing'].join(' | ')}`);
  }
  if (Object.hasOwn(entry, 'orphansSelfExited') && !isStringArray(entry['orphansSelfExited'])) {
    problems.push('orphansSelfExited is not a string array');
  }
  if (problems.length === 0) {
    const expected = recordFileOf(
      entry['suite'] as string,
      entry['platform'] as string,
      entry['case'] as string,
      entry['compressed'] as boolean,
    );
    if (entry['file'] !== expected) problems.push(`file is not ${expected}`);
  }
  return problems.map((problem) => `${MANIFEST} ${label}: ${problem}`);
}

/** Parses and checks the record lines of a variant against its manifest entry. */
export function parseRecords(text: string, entry: ManifestEntry): RecordLine[] {
  const label = entry.file;
  const problems: string[] = [];
  const records = jsonlLines(text, label).map((line, index): RecordLine => {
    const at = `${label}:${String(index + 1)}`;
    const value = parseLine(line, at);
    if (!isObject(value)) throw new ConformanceDataError([`${at}: not an object`]);
    if (!validateConformanceLine(value).ok) {
      problems.push(`${at}: not a conformance.schema.json record line`);
    }
    const keys = keyProblems(value, ['t', 'dir', 'v']).map((problem) => `${at}: ${problem}`);
    if (keys.length > 0) throw new ConformanceDataError([...problems, ...keys]);
    const { t, dir, v } = value;
    if (!Number.isSafeInteger(t) || (t as number) < 0) problems.push(`${at}: t is not a time`);
    if (!RECORD_DIRS.includes(dir as RecordDir)) {
      problems.push(`${at}: unknown dir ${JSON.stringify(dir)}`);
    }
    return { t: t as number, dir: dir as RecordDir, v: v as JsonValue };
  });
  if (problems.length > 0) throw new ConformanceDataError(problems);
  const exits = records.filter((record) => record.dir === 'exit').length;
  if (exits !== 1) problems.push(`${label}: ${String(exits)} exit lines, not 1`);
  let exited = false;
  records.forEach((record, index) => {
    const at = `${label}:${String(index + 1)}`;
    const previous = records[index - 1];
    if (previous !== undefined && record.t < previous.t) problems.push(`${at}: t goes back`);
    if ((record.dir === 'config') !== (index === 0)) {
      problems.push(`${at}: the config line must be the first line, and only it`);
    }
    // After the exit only the host can still act (the recorder's EOF on a process already gone).
    if (exited && record.dir !== 'cmd') problems.push(`${at}: ${record.dir} after the exit`);
    if (record.dir === 'exit') exited = true;
    problems.push(...recordValueProblems(record, at, entry));
  });
  if (problems.length > 0) throw new ConformanceDataError(problems);
  return records;
}

/** The problems of one record line's value, by direction. */
function recordValueProblems(record: RecordLine, at: string, entry: ManifestEntry): string[] {
  const { v } = record;
  switch (record.dir) {
    case 'config': {
      if (!isObject(v)) return [`${at}: config is not an object`];
      const problems = keyProblems(v, ['suite', 'case', 'platform', 'argv', 'env']);
      if (
        v['suite'] !== entry.suite ||
        v['case'] !== entry.case ||
        v['platform'] !== entry.platform
      ) {
        problems.push('suite, case and platform differ from the manifest entry');
      }
      if (!isStringArray(v['argv'])) problems.push('argv is not a string array');
      const env = v['env'];
      if (
        !isObject(env) ||
        !Object.values(env).every((value) => typeof value === 'string' || value === null)
      ) {
        problems.push('env is not a map of strings and nulls');
      }
      return problems.map((problem) => `${at}: config ${problem}`);
    }
    case 'exit':
      return isObject(v) &&
        keyProblems(v, ['code', 'signal']).length === 0 &&
        v['code'] === entry.exit.code &&
        v['signal'] === entry.exit.signal
        ? []
        : [`${at}: exit differs from the manifest entry`];
    case 'in':
      return isObject(v) || typeof v === 'string' ? [] : [`${at}: in is not a frame or a line`];
    case 'out':
      return isObject(v) ? [] : [`${at}: out is not a frame`];
    case 'err':
      return typeof v === 'string' ? [] : [`${at}: err is not text`];
    case 'cmd':
      return isObject(v) && keyProblems(v, ['stdin']).length === 0 && v['stdin'] === 'eof'
        ? []
        : [`${at}: unknown cmd ${JSON.stringify(v)}`];
    case 'timer':
      return isObject(v) && keyProblems(v, ['name']).length === 0 && typeof v['name'] === 'string'
        ? []
        : [`${at}: timer is not {name}`];
  }
}

/** Parses and checks an expect file: exactly one expect line per record line. */
export function parseExpect(text: string, label: string, recordCount: number): ExpectBlock[] {
  const lines = jsonlLines(text, label);
  if (lines.length !== recordCount) {
    throw new ConformanceDataError([
      `${label}: ${String(lines.length)} expect lines for ${String(recordCount)} record lines`,
    ]);
  }
  return lines.map((line, index) => {
    const at = `${label}:${String(index + 1)}`;
    const value = parseLine(line, at);
    if (
      !isObject(value) ||
      !validateConformanceLine(value).ok ||
      keyProblems(value, ['dir', 'effects', 'events']).length > 0 ||
      value['dir'] !== 'expect' ||
      !Array.isArray(value['effects']) ||
      !Array.isArray(value['events'])
    ) {
      throw new ConformanceDataError([`${at}: not {"dir":"expect","effects":[],"events":[]}`]);
    }
    return { effects: value['effects'], events: value['events'] };
  });
}

/** Every file under `root`, relative, with `/` separators. */
function listFiles(root: string, dir = ''): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((item) => {
    const relative = dir === '' ? item.name : `${dir}/${item.name}`;
    if (item.isDirectory()) return listFiles(root, relative);
    return [relative];
  });
}

/** Reads and checks the manifest; returns its entries. */
export function readManifest(root: string, cliVersion: string): ManifestEntry[] {
  const file = path.join(root, MANIFEST);
  if (!existsSync(file)) throw new ConformanceDataError([`${MANIFEST}: missing`]);
  const manifest = parseLine(decodeStored(readFileSync(file), false, MANIFEST).trimEnd(), MANIFEST);
  if (!isObject(manifest)) throw new ConformanceDataError([`${MANIFEST}: not an object`]);
  const problems = keyProblems(manifest, MANIFEST_KEYS).map((problem) => `${MANIFEST}: ${problem}`);
  const listed = manifest['entries'];
  if (!Array.isArray(listed)) {
    throw new ConformanceDataError([...problems, `${MANIFEST}: entries is not an array`]);
  }
  const entries: readonly JsonValue[] = listed;
  for (const entry of entries) problems.push(...entryProblems(entry, cliVersion));
  const files = entries.map((entry) => (isObject(entry) ? entry['file'] : undefined));
  files.forEach((name, index) => {
    if (typeof name === 'string' && files.indexOf(name) !== index) {
      problems.push(`${MANIFEST}: ${name} is listed twice`);
    }
  });
  if (problems.length > 0) throw new ConformanceDataError(problems);
  return entries as unknown as ManifestEntry[];
}

/**
 * Loads every suite of the catalogue with strict validation (see the
 * contract at the top of this file).
 *
 * @throws ConformanceDataError listing every problem found
 */
export function loadConformanceSuites(options: LoadOptions = {}): ConformanceSuite[] {
  const root = options.root ?? CONFORMANCE_ROOT;
  const catalogue = options.catalogue ?? CATALOGUE;
  const ignored = options.expectations === 'ignored';
  const entries = readManifest(root, options.cliVersion ?? pinnedCliVersion());
  const problems: string[] = [];

  // The file set: the manifest, every entry's file and expect file, nothing else.
  const known = new Set<string>([MANIFEST]);
  for (const entry of entries) {
    known.add(entry.file);
    known.add(expectFileOf(entry.file));
  }
  for (const file of listFiles(root)) {
    if (!known.has(file)) problems.push(`${file}: no manifest entry lists it`);
  }
  const names = catalogue.map((suite) => suite.name);
  for (const item of readdirSync(root)) {
    if (statSync(path.join(root, item)).isDirectory() && !names.includes(item)) {
      problems.push(`${item}/: not a catalogue suite`);
    }
  }

  const suites = catalogue.map((declaration): ConformanceSuite => {
    const own = entries.filter((entry) => entry.suite === declaration.name);
    const wanted = declaration.platforms.flatMap((platform) =>
      declaration.cases.map((caseName) => ({ platform, caseName })),
    );
    for (const { platform, caseName } of wanted) {
      if (!own.some((entry) => entry.platform === platform && entry.case === caseName)) {
        problems.push(`${declaration.name}: no ${platform} ${caseName} recording`);
      }
    }
    const variants: ConformanceVariant[] = [];
    for (const entry of own) {
      const label = entry.file;
      if (!wanted.some((w) => w.platform === entry.platform && w.caseName === entry.case)) {
        problems.push(`${label}: platform or case not declared in the catalogue`);
        continue;
      }
      if (entry.compressed !== (declaration.compressed === true)) {
        problems.push(`${label}: compression differs from the catalogue`);
        continue;
      }
      try {
        variants.push(loadVariant(root, entry, ignored));
      } catch (error) {
        if (!(error instanceof ConformanceDataError)) throw error;
        problems.push(...error.problems);
      }
    }
    // Stable order: platforms and cases in catalogue order.
    variants.sort(
      (a, b) =>
        declaration.platforms.indexOf(a.platform) - declaration.platforms.indexOf(b.platform) ||
        declaration.cases.indexOf(a.case) - declaration.cases.indexOf(b.case),
    );
    return { name: declaration.name, declaration, variants };
  });
  if (problems.length > 0) throw new ConformanceDataError(problems);
  return suites;
}

function loadVariant(root: string, entry: ManifestEntry, ignored: boolean): ConformanceVariant {
  const recordPath = path.join(root, entry.file);
  if (!existsSync(recordPath)) throw new ConformanceDataError([`${entry.file}: missing`]);
  const text = decodeStored(readFileSync(recordPath), entry.compressed, entry.file);
  const records = parseRecords(text, entry);
  const expectName = expectFileOf(entry.file);
  const expectFile = path.join(root, expectName);
  let expect: ExpectBlock[] | undefined;
  if (!ignored) {
    if (!existsSync(expectFile)) {
      throw new ConformanceDataError([`${expectName}: missing (the suite has no expectations)`]);
    }
    expect = parseExpect(
      decodeStored(readFileSync(expectFile), false, expectName),
      expectName,
      records.length,
    );
  }
  const base = entry.case === 'main' ? entry.platform : `${entry.platform}.${entry.case}`;
  return {
    id: `${entry.suite}/${base}`,
    suite: entry.suite,
    case: entry.case,
    platform: entry.platform,
    entry,
    launch: records[0]?.v as unknown as LaunchConfig,
    records,
    expect,
    expectFile,
  };
}

/** The byte length of a line as the transport counts it (UTF-8). */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
