/**
 * Normalizer and redactor of recorded frames (plan §1.11, §4.3; ADR-0013
 * §4, §10).
 *
 * @remarks
 * Turns raw records into golden-fixture values that are stable across runs
 * and machines and carry no secret:
 *
 * - secrets: the fake key and any other given secret become `<redacted>`;
 *   any `sk-ant-...` string and bearer token too;
 * - paths: the sandbox directories (and the binary) become `<root>`,
 *   `<cfg>`, `<home>`, `<tmp>`, `<work>`, `<bin>`, in back- and
 *   forward-slash spelling; the CLI's project slug of the work directory
 *   becomes `<proj>`;
 * - uuids become `<uuid-N>` and long hex ids `<hex-N>`, numbered by first
 *   appearance so correlations survive;
 * - pids (number fields named `pid` or `*_pid`/`*Pid`, and the same pids
 *   as path or name segments inside strings, such as `sessions/<pid>.json`)
 *   become `1000 + N`;
 * - ISO timestamps become `<timestamp>`; numbers under timestamp, duration
 *   and cost keys become `0`; the CLI version becomes `<version>`.
 *
 * Deterministic for a given input and context.
 */

import type { JsonValue, RawRecord } from './session.js';

/** A path to replace and its placeholder. */
export interface PathToken {
  readonly path: string;
  readonly token: string;
}

/** What the normalizer replaces. */
export interface NormalizeContext {
  /** Paths and their placeholders; longer paths are replaced first. */
  readonly paths: readonly PathToken[];
  /** Pids known to appear (the spawned pid); more are learned from `pid` fields. */
  readonly pids: readonly number[];
  /** Exact secret values to redact (at least the fake key). */
  readonly secrets: readonly string[];
  /** The CLI version to replace with `<version>`, when known. */
  readonly version?: string | undefined;
  /** The CLI's cwd, whose project slug becomes `<proj>`. */
  readonly cwd?: string | undefined;
}

/** A golden-fixture record line (`conformance.schema.json`). */
export interface FixtureRecordLine {
  readonly t: number;
  readonly dir: 'config' | 'in' | 'out' | 'err' | 'exit' | 'cmd' | 'timer';
  readonly v: JsonValue;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Hex ids of at least 16 digits with at least one letter (pure decimal numbers are left alone). */
const HEX_ID = /\b(?=[0-9]*[a-f])[0-9a-f]{16,}\b/gi;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const API_KEY = /sk-ant-[A-Za-z0-9_-]+/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const PID_KEY = /^(?:pid|.*_pid|.*[a-z]Pid)$/;
/** Number keys whose values vary per run: durations, costs, timestamps (case-sensitive on purpose). */
const ZERO_KEYS =
  /(?:^duration|_duration|Duration|_ms$|[a-z]Ms$|^ttft|^cost|_cost|Cost|^timestamp|Timestamp|_at$|[a-z]At$|_time$|[a-z]Time$)/;
const VERSION_KEY = /(?:^|_)version$/i;
/** Regular-expression source of a separator around a pid in a string: `\`, `/`, `.`, `_`, `-`. */
const PID_SEPARATOR = String.raw`[\\/._-]`;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The CLI's project directory name for `cwd`: every non-alphanumeric character becomes `-` (05 §13). */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A stateful normalizer: placeholder numbering is shared across every value it sees. */
export class Normalizer {
  readonly #context: NormalizeContext;
  readonly #uuids = new Map<string, string>();
  readonly #hex = new Map<string, string>();
  readonly #pids = new Map<number, number>();
  readonly #paths: readonly { readonly from: RegExp; readonly to: string }[];

  constructor(context: NormalizeContext) {
    this.#context = context;
    for (const pid of context.pids) this.#pid(pid);
    const pairs: { from: string; to: string }[] = [];
    if (context.cwd !== undefined) pairs.push({ from: projectSlug(context.cwd), to: '<proj>' });
    for (const { path, token } of context.paths) {
      pairs.push({ from: path, to: token });
      pairs.push({ from: path.replaceAll('\\', '/'), to: token });
    }
    this.#paths = pairs
      .filter((pair) => pair.from.length > 0)
      .sort((a, b) => b.from.length - a.from.length)
      .map((pair) => ({ from: new RegExp(escapeRegExp(pair.from), 'gi'), to: pair.to }));
  }

  #pid(pid: number): number {
    let mapped = this.#pids.get(pid);
    if (mapped === undefined) {
      mapped = 1001 + this.#pids.size;
      this.#pids.set(pid, mapped);
    }
    return mapped;
  }

  #numbered(map: Map<string, string>, prefix: string, raw: string): string {
    const lower = raw.toLowerCase();
    let token = map.get(lower);
    if (token === undefined) {
      token = `<${prefix}-${String(map.size + 1)}>`;
      map.set(lower, token);
    }
    return token;
  }

  /** Learns the pids of every pid field in `value` (call on every value before normalizing). */
  learn(value: JsonValue, key?: string): void {
    if (typeof value === 'number') {
      if (key !== undefined && PID_KEY.test(key) && Number.isSafeInteger(value) && value > 0) {
        this.#pid(value);
      }
    } else if (Array.isArray(value)) {
      for (const item of value as readonly JsonValue[]) this.learn(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [name, item] of Object.entries(value)) this.learn(item, name);
    }
  }

  /** Normalizes one string (see the module comment). */
  string(text: string): string {
    let out = text;
    for (const secret of this.#context.secrets) {
      if (secret !== '') out = out.replaceAll(secret, '<redacted>');
    }
    out = out.replace(API_KEY, '<redacted>').replace(BEARER, 'Bearer <redacted>');
    for (const { from, to } of this.#paths) out = out.replace(from, to);
    out = out.replace(UUID, (raw) => this.#numbered(this.#uuids, 'uuid', raw));
    out = out.replace(ISO_TIME, '<timestamp>');
    out = out.replace(HEX_ID, (raw) => this.#numbered(this.#hex, 'hex', raw));
    const { version } = this.#context;
    if (version !== undefined && version !== '') out = out.replaceAll(version, '<version>');
    for (const [pid, mapped] of this.#pids) {
      const around = new RegExp(`(?<=${PID_SEPARATOR})${String(pid)}(?=${PID_SEPARATOR}|$)`, 'g');
      out = out.replace(around, String(mapped));
    }
    return out;
  }

  /** Normalizes any JSON value; `key` is the property name it sits under. */
  value(value: JsonValue, key?: string): JsonValue {
    if (typeof value === 'string') {
      return key !== undefined && VERSION_KEY.test(key) && SEMVER.test(value)
        ? '<version>'
        : this.string(value);
    }
    if (typeof value === 'number') {
      if (key === undefined) return value;
      if (PID_KEY.test(key) && Number.isSafeInteger(value) && value > 0) return this.#pid(value);
      return ZERO_KEYS.test(key) ? 0 : value;
    }
    if (Array.isArray(value)) return value.map((item: JsonValue) => this.value(item));
    if (value === null || typeof value === 'boolean') return value;
    const out: Record<string, JsonValue> = {};
    for (const [name, item] of Object.entries(value))
      out[this.string(name)] = this.value(item, name);
    return out;
  }
}

/**
 * Normalizes raw records into golden-fixture record lines with one shared
 * {@link Normalizer}.
 */
export function normalizeRecords(
  records: readonly RawRecord[],
  context: NormalizeContext,
): readonly FixtureRecordLine[] {
  const normalizer = new Normalizer(context);
  for (const record of records) normalizer.learn(record.v);
  return records.map((record) => ({ t: record.t, dir: record.dir, v: normalizer.value(record.v) }));
}
