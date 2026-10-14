/**
 * Request-shape snapshots: normalized structural records of what the pinned
 * CLI sends to the mock Messages API (plan §1.11, §4.4; ADR-0013 §4).
 *
 * @remarks
 * A snapshot keeps what a request is made of and drops what varies from run
 * to run or machine to machine:
 *
 * - structure: every object key, array order (messages, content blocks),
 *   value types, discriminators (`type`, `role`, `model`, tool names, effort
 *   and cache settings), booleans, `null`, the few numbers that are settings
 *   (`max_tokens`, `budget_tokens`, sampling parameters);
 * - sets: the `anthropic-beta` values, the tools (a map keyed by tool name)
 *   and the `required`/`enum` lists of a JSON schema, so their order is not
 *   part of the shape;
 * - ids (`id`, `tool_use_id`) become `<id-N>` by first appearance, so the
 *   tool_use / tool_result correlation survives;
 * - every other string (prompts, descriptions, tool results, the account
 *   metadata) becomes `<string>`, every other number `<number>`; the
 *   fixtures normalizer (`fixtures/normalize.ts`) still runs over the kept
 *   strings and the header values, so a path, uuid, timestamp, version or
 *   secret that reaches one is replaced as in the golden fixtures;
 * - transport headers (`host`, `content-length`, `connection`,
 *   `accept-encoding`) are dropped; platform-dependent `x-stainless-*`
 *   values become `<string>`;
 * - the `tools` of a later request equal to the first request's are written
 *   as `<same-as-request-1>` (the tool schemas are most of the bytes).
 *
 * Comparison (ADR-0013 §4): a removed key or set member, a changed literal,
 * a changed type, a different array length or a different number of
 * requests is a semantic change and fails; a new key or set member is an
 * additive change and warns. Snapshots change only through an explicit
 * update run, which also fails (see the integration suite).
 *
 * Pure: no I/O, no clock. Evidence of the shapes: research 05 §2 (headers,
 * the mid-conversation `role:"system"` messages and the billing-header
 * system block, D16), 07 §1 (resume replays the history).
 */

import { Normalizer, type NormalizeContext } from '../fixtures/normalize.js';

/** A normalized value: JSON without `undefined`. */
export type ShapeValue =
  string | number | boolean | null | readonly ShapeValue[] | { readonly [key: string]: ShapeValue };

/** An object of a normalized value. */
export type ShapeObject = Readonly<Record<string, ShapeValue>>;

/** The part of a captured request a snapshot uses (structurally `CapturedRequest`). */
export interface ShapeInput {
  readonly method: string;
  /** Origin-form target, for example `/v1/messages?beta=true`. */
  readonly target: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body; `undefined` when the body was not JSON. */
  readonly body: unknown;
}

/** One request of a snapshot. */
export interface RequestShape {
  readonly method: string;
  readonly target: string;
  readonly headers: ShapeObject;
  readonly body: ShapeValue;
}

/** The committed file: the requests one scenario sent, in order. */
export interface RequestShapeSnapshot {
  readonly format: 1;
  readonly scenario: string;
  readonly requests: readonly RequestShape[];
}

/** Placeholder of a string whose text is not part of the shape. */
export const STRING_PLACEHOLDER = '<string>';
/** Placeholder of a number whose value is not part of the shape. */
export const NUMBER_PLACEHOLDER = '<number>';
/** Body of a request that was not valid JSON. */
export const NOT_JSON_PLACEHOLDER = '<not-json>';
/** Placeholder of a value JSON cannot carry (never produced by a parsed body). */
export const UNSUPPORTED_PLACEHOLDER = '<unsupported>';

/** Key of the object that stands for a set of strings. */
export const SET_KEY = '$set';

/** Strings under these keys are discriminators or settings and are kept. */
const LITERAL_STRING_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'display',
  'effort',
  'format',
  'keep',
  'model',
  'name',
  'role',
  'ttl',
  'type',
]);

/** Numbers under these keys are settings and are kept. */
const LITERAL_NUMBER_KEYS: ReadonlySet<string> = new Set([
  'budget_tokens',
  'max_tokens',
  'temperature',
  'top_k',
  'top_p',
]);

/** Strings under these keys are ids, numbered by first appearance. */
const ID_KEYS: ReadonlySet<string> = new Set(['id', 'tool_use_id']);

/** Arrays of strings under these keys are sets. */
const SET_KEYS: ReadonlySet<string> = new Set(['enum', 'required']);

/** Headers of the transport, not of the CLI's request. */
const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
]);

/** Headers whose value depends on the platform or the SDK build. */
const VOLATILE_HEADERS: ReadonlySet<string> = new Set([
  'x-stainless-arch',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-runtime-version',
]);

/** The header that carries a comma-separated set. */
const BETA_HEADER = 'anthropic-beta';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: readonly unknown[]): value is readonly string[] {
  return value.every((item) => typeof item === 'string');
}

/** A set of strings as it is stored: sorted, without duplicates. */
function setOf(items: readonly string[]): ShapeValue {
  return { [SET_KEY]: [...new Set(items)].sort() };
}

/** Whether a stored value is a set (see {@link setOf}). */
function isSet(value: ShapeValue): value is { readonly [SET_KEY]: readonly string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0]?.[0] === SET_KEY && Array.isArray(entries[0][1]);
}

/** Builds snapshots: placeholder numbering is shared by every request it shapes. */
export class ShapeBuilder {
  readonly #normalizer: Normalizer;
  readonly #ids = new Map<string, string>();

  constructor(context: NormalizeContext) {
    this.#normalizer = new Normalizer(context);
  }

  #id(raw: string): string {
    let token = this.#ids.get(raw);
    if (token === undefined) {
      token = `<id-${String(this.#ids.size + 1)}>`;
      this.#ids.set(raw, token);
    }
    return token;
  }

  #string(value: string, key: string | undefined): string {
    if (key !== undefined && ID_KEYS.has(key)) return this.#id(value);
    if (key !== undefined && LITERAL_STRING_KEYS.has(key)) return this.#normalizer.string(value);
    return STRING_PLACEHOLDER;
  }

  /** Tools as a map keyed by name; a repeated name gets a `#N` suffix. */
  #tools(tools: readonly Readonly<Record<string, unknown>>[]): ShapeValue {
    const out: Record<string, ShapeValue> = {};
    for (const tool of tools) {
      const base = this.#normalizer.string(String(tool['name']));
      let name = base;
      for (let n = 2; name in out; n += 1) name = `${base}#${String(n)}`;
      out[name] = this.#shape(tool, undefined);
    }
    return out;
  }

  #shape(value: unknown, key: string | undefined): ShapeValue {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return this.#string(value, key);
    if (typeof value === 'number') {
      return key !== undefined && LITERAL_NUMBER_KEYS.has(key) ? value : NUMBER_PLACEHOLDER;
    }
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      if (key !== undefined && SET_KEYS.has(key) && isStringList(items)) {
        return setOf(items.map((item) => this.#normalizer.string(item)));
      }
      if (
        key === 'tools' &&
        items.every((item) => isRecord(item) && typeof item['name'] === 'string')
      ) {
        return this.#tools(items as readonly Readonly<Record<string, unknown>>[]);
      }
      return items.map((item) => this.#shape(item, undefined));
    }
    if (isRecord(value)) {
      const out: Record<string, ShapeValue> = {};
      for (const name of Object.keys(value).sort()) {
        out[this.#normalizer.string(name)] = this.#shape(value[name], name);
      }
      return out;
    }
    return UNSUPPORTED_PLACEHOLDER;
  }

  #headers(headers: Readonly<Record<string, string>>): ShapeObject {
    const out: Record<string, ShapeValue> = {};
    const entries = Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [lower, value] of entries) {
      if (DROPPED_HEADERS.has(lower)) continue;
      if (VOLATILE_HEADERS.has(lower)) out[lower] = STRING_PLACEHOLDER;
      else if (lower === BETA_HEADER) {
        out[lower] = setOf(
          value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '')
            .map((part) => this.#normalizer.string(part)),
        );
      } else out[lower] = this.#normalizer.string(value);
    }
    return out;
  }

  /** The shape of one captured request. */
  request(input: ShapeInput): RequestShape {
    return {
      method: input.method,
      target: this.#normalizer.string(input.target),
      headers: this.#headers(input.headers),
      body: input.body === undefined ? NOT_JSON_PLACEHOLDER : this.#shape(input.body, undefined),
    };
  }
}

/** Stands for the tools of the first request in a later request with the same tools. */
export const SAME_TOOLS_PLACEHOLDER = '<same-as-request-1>';

/**
 * Replaces the `tools` of every later request that equals the first
 * request's (the usual case: the tool schemas are most of a snapshot).
 */
function shareTools(requests: readonly RequestShape[]): readonly RequestShape[] {
  const first = requests[0]?.body;
  const baseline = isRecord(first) ? first['tools'] : undefined;
  if (baseline === undefined) return requests;
  const wanted = JSON.stringify(baseline);
  return requests.map((request, index) => {
    const { body } = request;
    return index > 0 && isRecord(body) && JSON.stringify(body['tools']) === wanted
      ? { ...request, body: { ...body, tools: SAME_TOOLS_PLACEHOLDER } }
      : request;
  });
}

/**
 * The snapshot of one scenario's requests, in the order the mock captured
 * them. A later request whose `tools` equal the first request's carries
 * {@link SAME_TOOLS_PLACEHOLDER} instead.
 */
export function snapshotOf(
  scenario: string,
  requests: readonly ShapeInput[],
  context: NormalizeContext,
): RequestShapeSnapshot {
  const builder = new ShapeBuilder(context);
  return {
    format: 1,
    scenario,
    requests: shareTools(requests.map((request) => builder.request(request))),
  };
}

/** What a sandbox contributes to the normalizer context (a subset of `Sandbox`). */
export interface ShapeSandbox {
  readonly dirs: {
    readonly root: string;
    readonly home: string;
    readonly cfg: string;
    readonly tmp: string;
    readonly work: string;
    readonly appData: string;
    readonly localAppData: string;
  };
  readonly cli: { readonly binaryPath: string; readonly version: string };
  readonly mockUrl: string;
}

/** The normalizer context of requests sent from `sandbox`; same tokens as the golden fixtures. */
export function shapeContext(sandbox: ShapeSandbox, secrets: readonly string[]): NormalizeContext {
  const { dirs } = sandbox;
  return {
    paths: [
      { path: sandbox.cli.binaryPath, token: '<bin>' },
      { path: dirs.work, token: '<work>' },
      { path: dirs.tmp, token: '<tmp>' },
      { path: dirs.cfg, token: '<cfg>' },
      { path: dirs.localAppData, token: '<localappdata>' },
      { path: dirs.appData, token: '<appdata>' },
      { path: dirs.home, token: '<home>' },
      { path: dirs.root, token: '<root>' },
      { path: sandbox.mockUrl, token: '<mock>' },
    ],
    pids: [],
    secrets,
    version: sandbox.cli.version,
    cwd: dirs.work,
  };
}

// ---- comparison ------------------------------------------------------------

/** What differs at a path. */
export type FindingKind =
  /** Present in the committed snapshot, absent now. */
  | 'removed'
  /** Absent in the committed snapshot, present now. */
  | 'added'
  /** A literal has another value. */
  | 'changed'
  /** The value has another type (or kind: set, object, array, scalar). */
  | 'type'
  /** An array has another length, or the number of requests differs. */
  | 'length';

/** One difference between a committed and a current snapshot. */
export interface Finding {
  /** JSON pointer into the snapshot, for example `/requests/0/body/model`. */
  readonly path: string;
  readonly kind: FindingKind;
  /** Committed value, JSON text bounded to {@link MAX_DISPLAY}. */
  readonly expected?: string;
  /** Current value, JSON text bounded to {@link MAX_DISPLAY}. */
  readonly actual?: string;
}

/** Result of comparing two snapshots. */
export interface Comparison {
  /** Semantic changes: the test fails. */
  readonly failures: readonly Finding[];
  /** Additive changes: the test warns. */
  readonly warnings: readonly Finding[];
}

/** Longest value text in a {@link Finding}. */
export const MAX_DISPLAY = 120;

function display(value: ShapeValue): string {
  const text = JSON.stringify(value);
  return text.length > MAX_DISPLAY ? `${text.slice(0, MAX_DISPLAY)}...` : text;
}

function pointer(parent: string, segment: string | number): string {
  const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${parent}/${escaped}`;
}

function kindOf(value: ShapeValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isSet(value)) return 'set';
  return typeof value;
}

class Differ {
  readonly failures: Finding[] = [];
  readonly warnings: Finding[] = [];

  #fail(path: string, kind: FindingKind, expected?: ShapeValue, actual?: ShapeValue): void {
    this.failures.push(finding(path, kind, expected, actual));
  }

  compare(path: string, expected: ShapeValue, actual: ShapeValue): void {
    if (kindOf(expected) !== kindOf(actual)) {
      this.#fail(path, 'type', expected, actual);
    } else if (isSet(expected) && isSet(actual)) {
      this.#sets(path, expected[SET_KEY], actual[SET_KEY]);
    } else if (Array.isArray(expected) && Array.isArray(actual)) {
      this.#arrays(path, expected as readonly ShapeValue[], actual as readonly ShapeValue[]);
    } else if (typeof expected === 'object' && expected !== null) {
      this.#objects(path, expected as ShapeObject, actual as ShapeObject);
    } else if (expected !== actual) {
      this.#fail(path, 'changed', expected, actual);
    }
  }

  #sets(path: string, expected: readonly string[], actual: readonly string[]): void {
    for (const member of expected) {
      if (!actual.includes(member)) this.#fail(pointer(path, member), 'removed', member);
    }
    for (const member of actual) {
      if (!expected.includes(member)) {
        this.warnings.push(finding(pointer(path, member), 'added', undefined, member));
      }
    }
  }

  #arrays(path: string, expected: readonly ShapeValue[], actual: readonly ShapeValue[]): void {
    if (expected.length !== actual.length) {
      this.failures.push({
        path,
        kind: 'length',
        expected: String(expected.length),
        actual: String(actual.length),
      });
    }
    const common = Math.min(expected.length, actual.length);
    for (let index = 0; index < common; index += 1) {
      this.compare(
        pointer(path, index),
        expected[index] as ShapeValue,
        actual[index] as ShapeValue,
      );
    }
  }

  #objects(path: string, expected: ShapeObject, actual: ShapeObject): void {
    for (const key of Object.keys(expected)) {
      const here = pointer(path, key);
      if (key in actual) this.compare(here, expected[key] as ShapeValue, actual[key] as ShapeValue);
      else this.#fail(here, 'removed', expected[key]);
    }
    for (const key of Object.keys(actual)) {
      if (!(key in expected)) {
        this.warnings.push(finding(pointer(path, key), 'added', undefined, actual[key]));
      }
    }
  }
}

function finding(
  path: string,
  kind: FindingKind,
  expected?: ShapeValue,
  actual?: ShapeValue,
): Finding {
  return {
    path,
    kind,
    ...(expected === undefined ? {} : { expected: display(expected) }),
    ...(actual === undefined ? {} : { actual: display(actual) }),
  };
}

/** Compares two shape values (see the module comment for what fails and what warns). */
export function compareShapes(expected: ShapeValue, actual: ShapeValue): Comparison {
  const differ = new Differ();
  differ.compare('', expected, actual);
  return { failures: differ.failures, warnings: differ.warnings };
}

/** Compares a committed snapshot with the current one. */
export function compareSnapshots(
  expected: RequestShapeSnapshot,
  actual: RequestShapeSnapshot,
): Comparison {
  return compareShapes(expected as unknown as ShapeValue, actual as unknown as ShapeValue);
}

/** One line per finding, for a test failure or warning. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((item) => {
      const detail =
        item.kind === 'removed'
          ? `removed (was ${item.expected ?? '?'})`
          : item.kind === 'added'
            ? `added (${item.actual ?? '?'})`
            : `${item.kind}: expected ${item.expected ?? '?'}, got ${item.actual ?? '?'}`;
      return `${item.path === '' ? '/' : item.path}: ${detail}`;
    })
    .join('\n');
}

// ---- files -----------------------------------------------------------------

/** A snapshot file that cannot be read as a snapshot. */
export class SnapshotFormatError extends Error {
  override readonly name = 'SnapshotFormatError';
}

/** The committed text of a snapshot: two-space JSON, LF, trailing newline. */
export function serializeSnapshot(snapshot: RequestShapeSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** Whether parsed JSON has the fields of a {@link RequestShape} (JSON values are shape values by construction). */
function isRequestShape(value: unknown): value is RequestShape {
  return (
    isRecord(value) &&
    typeof value['method'] === 'string' &&
    typeof value['target'] === 'string' &&
    isRecord(value['headers']) &&
    'body' in value
  );
}

/**
 * Reads the text of a committed snapshot.
 *
 * @throws SnapshotFormatError when the text is not a format-1 snapshot.
 */
export function parseSnapshot(text: string): RequestShapeSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SnapshotFormatError('the snapshot is not valid JSON');
  }
  if (!isRecord(parsed) || parsed['format'] !== 1) {
    throw new SnapshotFormatError('the snapshot is not format 1');
  }
  const { scenario, requests } = parsed;
  if (typeof scenario !== 'string' || !Array.isArray(requests)) {
    throw new SnapshotFormatError('the snapshot has no scenario name or request list');
  }
  if (!(requests as readonly unknown[]).every(isRequestShape)) {
    throw new SnapshotFormatError('the snapshot has a malformed request');
  }
  return { format: 1, scenario, requests: requests as readonly RequestShape[] };
}

// ---- verdict ---------------------------------------------------------------

/** How a current snapshot relates to the committed text. */
export type SnapshotVerdict =
  | { readonly status: 'match' }
  | { readonly status: 'additive'; readonly warnings: readonly Finding[] }
  | {
      readonly status: 'semantic';
      readonly failures: readonly Finding[];
      readonly warnings: readonly Finding[];
    }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly reason: string };

/**
 * Judges the current snapshot against the committed file text
 * (`undefined` when there is none).
 */
export function judgeSnapshot(
  committed: string | undefined,
  actual: RequestShapeSnapshot,
): SnapshotVerdict {
  if (committed === undefined) return { status: 'missing' };
  let expected: RequestShapeSnapshot;
  try {
    expected = parseSnapshot(committed);
  } catch (error) {
    return { status: 'invalid', reason: (error as Error).message };
  }
  if (expected.scenario !== actual.scenario) {
    return {
      status: 'invalid',
      reason: `the snapshot is for scenario ${expected.scenario}, not ${actual.scenario}`,
    };
  }
  const { failures, warnings } = compareSnapshots(expected, actual);
  if (failures.length > 0) return { status: 'semantic', failures, warnings };
  return warnings.length > 0 ? { status: 'additive', warnings } : { status: 'match' };
}

/**
 * A snapshot that does not hold: a semantic change, a missing or an
 * unreadable file. The canary classifier (`canary/classify.ts`) recognizes
 * it by its name and files the failure under `mock-inadequate`.
 */
export class RequestShapeError extends Error {
  override readonly name = 'RequestShapeError';
  /** The semantic findings (empty for a missing or unreadable file). */
  readonly findings: readonly Finding[];

  constructor(message: string, findings: readonly Finding[] = []) {
    super(message);
    this.findings = findings;
  }
}

/**
 * Turns a verdict into the test outcome.
 *
 * @returns the warning text of an additive change (the test prints it), or
 * `undefined` when the snapshot matches.
 * @throws RequestShapeError on a semantic change, a missing or an invalid file.
 */
export function enforceVerdict(scenario: string, verdict: SnapshotVerdict): string | undefined {
  switch (verdict.status) {
    case 'match':
      return undefined;
    case 'additive':
      return `request-shape ${scenario}: additive change (review at the next CLI bump)\n${formatFindings(verdict.warnings)}`;
    case 'semantic':
      throw new RequestShapeError(
        `request-shape ${scenario}: semantic change\n${formatFindings(verdict.failures)}`,
        verdict.failures,
      );
    case 'missing':
      throw new RequestShapeError(
        `request-shape ${scenario}: no committed snapshot; write it with ${UPDATE_ENV}=1 and review the diff`,
      );
    case 'invalid':
      throw new RequestShapeError(`request-shape ${scenario}: ${verdict.reason}`);
  }
}

// ---- privacy ---------------------------------------------------------------

/** Spellings of a forbidden string: as given, with `/`, and escaped for JSON text. */
function spellings(forbidden: string): readonly string[] {
  return [forbidden, forbidden.replaceAll('\\', '/'), JSON.stringify(forbidden).slice(1, -1)].map(
    (text) => text.toLowerCase(),
  );
}

/** Patterns that must never appear in a snapshot, whatever the machine. */
const LEAK_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'an Anthropic key', pattern: /sk-ant-/i },
  { name: 'a Windows drive path', pattern: /(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\\|\/)/ },
  { name: 'a home directory path', pattern: /(?:^|[^A-Za-z0-9])\/(?:home|Users)\/[^/\s"]/ },
];

/**
 * Looks for what a snapshot must not contain: the given secrets and paths
 * (in their raw spellings), keys, drive paths and home directory paths.
 *
 * @returns a description of each finding; the text found is not repeated.
 */
export function findLeaks(text: string, forbidden: readonly string[]): readonly string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  forbidden.forEach((entry, index) => {
    if (entry !== '' && spellings(entry).some((spelling) => lower.includes(spelling))) {
      found.push(`forbidden string #${String(index + 1)}`);
    }
  });
  for (const { name, pattern } of LEAK_PATTERNS) {
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

/** Environment variable that turns the integration suite into the snapshot writer. */
export const UPDATE_ENV = 'HUDHUD_REQUEST_SHAPE_UPDATE';

/** Whether the environment asks for the update mode (the value `1`). */
export function updateRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[UPDATE_ENV] === '1';
}
