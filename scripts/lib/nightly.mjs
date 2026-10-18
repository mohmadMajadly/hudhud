// The `should-run` decision of the scheduled canaries (K16, ADR-0014
// amendment 3, plan §5.9 W7-T2) and the nightly's own rule.
//
// The canary tests the version behind the `latest` dist-tag of the Claude
// Code CLI (what `npm install` gives users) whenever it is newer than the
// pinned version in tooling/cli-pin.json; it never re-runs the pinned
// version. The nightly therefore runs every night while such a version
// exists, at most once a day (about 30 Linux runs a month at most); the
// weekly rule (canary-weekly.mjs) adds publish times.
//
// Runs before `pnpm install` on a bare runner: plain Node.js, no
// dependencies, no credentials. The registry is read from
// registry.npmjs.org only; an unreadable or malformed answer fails the job,
// so an outage is visible instead of silently skipping a release.

/** npm package of the CLI. */
export const CLI_PACKAGE = '@anthropic-ai/claude-code';

/** The registry document of the CLI (all versions, dist-tags and publish times). */
export const REGISTRY_DOCUMENT = 'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code';

/** Upper bound of the registry document (about 1.5 MB with 542 versions in 2026-10). */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** Timeout of the registry read. */
export const REGISTRY_TIMEOUT_MS = 30_000;

/** Run modes: the scheduled canary, or the labelled dry run against the pinned version. */
export const MODES = /** @type {const} */ (['canary', 'dry-run']);

const RELEASE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/**
 * A release version `X.Y.Z` as numbers; null for anything else (pre-releases
 * included). Only such strings ever reach a workflow output.
 *
 * @param {unknown} value
 * @returns {[number, number, number] | null}
 */
export function parseRelease(value) {
  if (typeof value !== 'string') return null;
  const match = RELEASE.exec(value);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {readonly [number, number, number]} a
 * @param {readonly [number, number, number]} b
 * @returns {number} negative, zero or positive
 */
export function compareReleases(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Parses an ISO-8601 timestamp; null when invalid.
 *
 * @param {unknown} value
 * @returns {Date | null}
 */
export function parseTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @typedef {object} RegistryFacts
 * @property {string} latest The `latest` dist-tag (a release version).
 * @property {ReadonlyMap<string, Date>} published Publish time of every
 *   release version in the document's `time` map.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the CLI's registry document.
 *
 * @param {unknown} document
 * @returns {RegistryFacts}
 */
export function registryFacts(document) {
  if (!isRecord(document) || document['name'] !== CLI_PACKAGE) {
    throw new Error(`the registry document is not ${CLI_PACKAGE}`);
  }
  const tags = document['dist-tags'];
  const latest = isRecord(tags) ? tags['latest'] : undefined;
  if (typeof latest !== 'string' || parseRelease(latest) === null) {
    throw new Error(`the latest dist-tag of ${CLI_PACKAGE} is not a release version`);
  }
  const time = document['time'];
  if (!isRecord(time)) throw new Error(`the registry document of ${CLI_PACKAGE} has no time map`);
  /** @type {Map<string, Date>} */
  const published = new Map();
  for (const [version, value] of Object.entries(time)) {
    const date = parseTime(value);
    if (parseRelease(version) !== null && date !== null) published.set(version, date);
  }
  return { latest, published };
}

/**
 * Reads the CLI's registry document (size-capped, no redirects).
 *
 * @param {(url: string, init: RequestInit) => Promise<Response>} fetchFn
 * @returns {Promise<RegistryFacts>}
 */
export async function readRegistry(fetchFn) {
  const response = await fetchFn(REGISTRY_DOCUMENT, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`GET ${REGISTRY_DOCUMENT}: HTTP ${String(response.status)}`);
  }
  if (Number(response.headers.get('content-length') ?? '0') > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel();
    throw new Error(`GET ${REGISTRY_DOCUMENT}: more than ${String(MAX_DOCUMENT_BYTES)} bytes`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) {
    throw new Error(`GET ${REGISTRY_DOCUMENT}: more than ${String(MAX_DOCUMENT_BYTES)} bytes`);
  }
  /** @type {unknown} */
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`GET ${REGISTRY_DOCUMENT}: not valid JSON`);
  }
  return registryFacts(document);
}

/**
 * @typedef {object} PinFacts
 * @property {string} version The pinned version.
 * @property {boolean} darwinPending Whether a darwin entry still waits for
 *   the macOS gate (`pendingGate`).
 */

/**
 * Reads what the decision needs from tooling/cli-pin.json.
 *
 * @param {unknown} document
 * @returns {PinFacts}
 */
export function pinFacts(document) {
  if (!isRecord(document) || parseRelease(document['version']) === null) {
    throw new Error('tooling/cli-pin.json: "version" is not a release version');
  }
  const platforms = document['platforms'];
  if (!isRecord(platforms)) throw new Error('tooling/cli-pin.json: no platforms');
  const darwin = Object.entries(platforms).filter(([key]) => key.startsWith('darwin-'));
  return {
    version: /** @type {string} */ (document['version']),
    darwinPending:
      darwin.length === 0 ||
      darwin.some(([, entry]) => isRecord(entry) && entry['pendingGate'] === true),
  };
}

/**
 * @typedef {object} ScheduleFacts
 * @property {Date} now
 * @property {RegistryFacts | null} registry null when it could not be read
 *   (a dry run does not need it).
 * @property {string | undefined} registryError Why the registry could not be read.
 * @property {PinFacts} pin
 * @property {'canary' | 'dry-run'} mode `canary` for every scheduled run.
 * @property {boolean} dispatched A manual dispatch (`CANARY_MODE` set): the
 *   weekly window does not apply.
 * @property {string} [requested] An exact release named by a manual dispatch
 *   (`CANARY_VERSION_REQUEST`, the workflow's `version` input): the
 *   admission and window runs of the rolling tested window (ADR-0004 §4,
 *   amendment of 2026-10-18). Unset on the schedule.
 */

/**
 * @typedef {object} ScheduleDecision
 * @property {boolean} run
 * @property {'canary' | 'dry-run'} mode
 * @property {string} version The version the canary job fetches and tests
 *   (empty when it does not run).
 * @property {boolean} macos Whether the macOS job runs (weekly only).
 * @property {string[]} lines What the job summary and the log say.
 * @property {string} [error] Set when the decision cannot be made; the
 *   check job fails.
 */

/**
 * A dry run: the whole canary path against the pinned version, labelled.
 *
 * @param {ScheduleFacts} facts
 * @returns {ScheduleDecision}
 */
export function dryRun(facts) {
  return {
    run: true,
    mode: 'dry-run',
    version: facts.pin.version,
    macos: false,
    lines: [
      `DRY RUN (manual dispatch): the canary path runs against the PINNED version ${facts.pin.version}; it validates the workflow and is not a canary result.`,
    ],
  };
}

/**
 * Whether the registry's newest release is newer than the pin; the shared
 * first step of both schedules.
 *
 * @param {ScheduleFacts} facts
 * @returns {{ decision: ScheduleDecision } | { registry: RegistryFacts }}
 */
export function newerThanPin(facts) {
  if (facts.registry === null) {
    return {
      decision: {
        run: false,
        mode: 'canary',
        version: '',
        macos: false,
        lines: [],
        error: `${CLI_PACKAGE} registry state unknown: ${facts.registryError ?? 'not read'}`,
      },
    };
  }
  const latest = /** @type {[number, number, number]} */ (parseRelease(facts.registry.latest));
  const pinned = /** @type {[number, number, number]} */ (parseRelease(facts.pin.version));
  const order = compareReleases(latest, pinned);
  if (order <= 0) {
    return {
      decision: {
        run: false,
        mode: 'canary',
        version: '',
        macos: false,
        lines: [
          order === 0
            ? `The newest ${CLI_PACKAGE} (${facts.registry.latest}) is the pinned version: nothing to test (the canary never re-runs the pinned version).`
            : `The newest ${CLI_PACKAGE} (${facts.registry.latest}) is older than the pinned ${facts.pin.version}: nothing to test.`,
        ],
      },
    };
  }
  return { registry: facts.registry };
}

/**
 * A dispatch that names an exact release: the canary path against that
 * version, whatever the pin and the weekly window say (ADR-0004 §4,
 * rolling-window amendment: admitting every release between the pin and the
 * newest, and re-running versions of the window on demand). The version must
 * be a published release no newer than `latest` (a `next` tag is not what
 * users get); anything else fails the check job, naming the cause.
 *
 * @param {ScheduleFacts & { requested: string }} facts
 * @param {string} where Where the canary runs, for the summary.
 * @param {boolean} macos Whether the macOS job runs.
 * @returns {ScheduleDecision}
 */
export function decideRequested(facts, where, macos) {
  /** @type {(error: string) => ScheduleDecision} */
  const refused = (error) => ({
    run: false,
    mode: 'canary',
    version: '',
    macos: false,
    lines: [],
    error,
  });
  if (facts.registry === null) {
    return refused(`${CLI_PACKAGE} registry state unknown: ${facts.registryError ?? 'not read'}`);
  }
  const requested = parseRelease(facts.requested);
  if (requested === null || !facts.registry.published.has(facts.requested)) {
    return refused(
      `${JSON.stringify(facts.requested)} is not a published release of ${CLI_PACKAGE}`,
    );
  }
  const latest = /** @type {[number, number, number]} */ (parseRelease(facts.registry.latest));
  if (compareReleases(requested, latest) > 0) {
    return refused(
      `${facts.requested} is newer than the latest dist-tag (${facts.registry.latest}): not what users get`,
    );
  }
  const pinned = /** @type {[number, number, number]} */ (parseRelease(facts.pin.version));
  const order = compareReleases(requested, pinned);
  const relation =
    order === 0
      ? 'the pinned version'
      : `${order < 0 ? 'older' : 'newer'} than the pinned ${facts.pin.version}`;
  return {
    run: true,
    mode: 'canary',
    version: facts.requested,
    macos,
    lines: [
      `Manual dispatch for ${CLI_PACKAGE} ${facts.requested} (${relation}; the newest is ${facts.registry.latest}): the canary path tests exactly this version ${where} (an admission or window run of the rolling tested window, ADR-0004 §4).`,
    ],
  };
}

/**
 * The nightly (Linux): runs whenever the newest release is newer than the pin.
 *
 * @param {ScheduleFacts} facts
 * @returns {ScheduleDecision}
 */
export function decideNightly(facts) {
  if (facts.mode === 'dry-run') return dryRun(facts);
  if (facts.requested !== undefined) {
    return decideRequested({ ...facts, requested: facts.requested }, 'on Linux', false);
  }
  const step = newerThanPin(facts);
  if ('decision' in step) return step.decision;
  return {
    run: true,
    mode: 'canary',
    version: step.registry.latest,
    macos: false,
    lines: [
      `The newest ${CLI_PACKAGE} (${step.registry.latest}) is newer than the pinned ${facts.pin.version}: the nightly canary tests it on Linux.`,
    ],
  };
}

/**
 * @typedef {object} CheckHost
 * @property {Readonly<Record<string, string | undefined>>} env
 * @property {(url: string, init: RequestInit) => Promise<Response>} fetch
 * @property {(file: string) => string} readFile
 * @property {(file: string, text: string) => void} appendFile
 * @property {() => Date} now
 * @property {(text: string) => void} stdout
 * @property {(text: string) => void} stderr
 */

/**
 * The `should-run` job (scripts/nightly-check.mjs): reads the pin and the
 * registry, decides with `decide`, writes `run`, `mode`, `version` and
 * `macos` to $GITHUB_OUTPUT and the decision to the job summary. Exit codes:
 * 0 decided, 1 the registry or the pin could not be read, 2 usage error.
 *
 * @param {CheckHost} host
 * @param {string} schedule `nightly` or `weekly`, for the summary heading.
 * @param {(facts: ScheduleFacts) => ScheduleDecision} decide
 * @returns {Promise<number>}
 */
export async function runScheduleCheck(host, schedule, decide) {
  const requested = host.env['CANARY_MODE'] ?? '';
  if (requested !== '' && !MODES.includes(/** @type {'canary'} */ (requested))) {
    host.stderr(
      `${schedule}-check: CANARY_MODE must be canary or dry-run, got ${JSON.stringify(requested)}\n`,
    );
    return 2;
  }
  const mode = requested === 'dry-run' ? 'dry-run' : 'canary';
  const version = host.env['CANARY_VERSION_REQUEST'] ?? '';
  if (version !== '' && (requested !== 'canary' || parseRelease(version) === null)) {
    host.stderr(
      `${schedule}-check: CANARY_VERSION_REQUEST must be a release X.Y.Z with CANARY_MODE=canary, got ${JSON.stringify(version)} with CANARY_MODE=${JSON.stringify(requested)}\n`,
    );
    return 2;
  }
  /** @type {PinFacts} */
  let pin;
  try {
    pin = pinFacts(JSON.parse(host.readFile('tooling/cli-pin.json')));
  } catch (error) {
    host.stderr(`${schedule}-check: ${String(error)}\n`);
    return 1;
  }
  /** @type {RegistryFacts | null} */
  let registry = null;
  /** @type {string | undefined} */
  let registryError;
  if (mode === 'canary') {
    try {
      registry = await readRegistry(host.fetch);
    } catch (error) {
      registryError = String(error);
    }
  }
  const decision = decide({
    now: host.now(),
    registry,
    registryError,
    pin,
    mode,
    dispatched: requested !== '',
    ...(version === '' ? {} : { requested: version }),
  });
  const output = host.env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') {
    host.appendFile(
      output,
      `run=${String(decision.run)}\nmode=${decision.mode}\nversion=${decision.version}\nmacos=${String(decision.macos)}\n`,
    );
  }
  const lines =
    decision.error === undefined ? decision.lines : [...decision.lines, `ERROR: ${decision.error}`];
  const summary = host.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') {
    host.appendFile(summary, [`## ${schedule} canary: should-run`, '', ...lines, ''].join('\n'));
  }
  for (const line of decision.lines) host.stdout(`${line}\n`);
  if (decision.error !== undefined) {
    host.stderr(`${schedule}-check: ${decision.error}\n`);
    return 1;
  }
  host.stdout(
    `run=${String(decision.run)} mode=${decision.mode} version=${decision.version} macos=${String(decision.macos)}\n`,
  );
  return 0;
}
