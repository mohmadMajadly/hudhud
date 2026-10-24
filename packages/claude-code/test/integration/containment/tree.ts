// Process-tree and event helpers of the containment suites (plan §4.7,
// §5.8 W6-T3). Reads only: every kill in these suites goes through the
// product, or through test-support's `killVerified` (pid plus start time
// confirmed in a fresh read first), never by a bare pid or an image name.

import type { HudhudEvent } from '@hudhudjs/core';

import type { JobAddonMode } from '../support/harness.js';

import { hostProcessTable } from '../../../../../tooling/test-support/src/leaks/process-table.js';
import type { ProcessRow } from '../../../../../tooling/test-support/src/leaks/process-table.js';
import { killVerified } from '../../../../../tooling/test-support/src/leaks/tracker.js';
import type {
  KillOutcome,
  ProcessIdentity,
} from '../../../../../tooling/test-support/src/leaks/tracker.js';

/** The host process table (Linux `/proc`, Windows one CIM query per read). */
export const table = hostProcessTable(process.platform, process.env);

/** Whether the tests run on Windows. */
export const WINDOWS = process.platform === 'win32';

/**
 * Whether the suites load the job addon (harness mode `'staged'`): Windows
 * x64, where every test run has the addon staged (plan §6.2).
 */
export const JOB_HOST = WINDOWS && process.arch === 'x64';

/** A containment mode of the suites: the job addon's source and the containment it gives. */
export interface ContainmentMode {
  readonly jobAddon: JobAddonMode;
  readonly containment: 'job' | 'best-effort';
}

/**
 * The modes the containment suites run in: on Windows x64 the staged addon
 * (`'job'`, the shipping default) and the addon forced unavailable
 * (`'best-effort'`, as without the platform package, on arm64 or after a
 * digest mismatch); off Windows the host's own (`'best-effort'`, ADR-0010).
 */
export const CONTAINMENT_MODES: readonly ContainmentMode[] = JOB_HOST
  ? [
      { jobAddon: 'staged', containment: 'job' },
      { jobAddon: 'unavailable', containment: 'best-effort' },
    ]
  : [{ jobAddon: 'staged', containment: 'best-effort' }];

/** Base64 of UTF-8 text, for mock scenario arguments. */
export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * The command of a long foreground workload: `sleep <tag>` behind a no-op
 * first statement.
 *
 * From CLI 2.1.310 on, the Bash tool refuses a foreground command whose
 * first statement is `sleep N` with N >= 25 (`Blocked: standalone sleep N`,
 * a `tool_use_error`, so no process starts) unless background tasks are
 * disabled; it points the model to `run_in_background` and the Monitor
 * tool. 2.1.296 to 2.1.309 carry the same check behind a feature flag
 * (`tengu_amber_sentinel`) that is off without the CLI's remote
 * configuration; 2.1.310 removed the flag (static reading of the bundles;
 * measured with the mock on Windows and Linux). The check reads only the
 * first statement, so `true && sleep <tag>` runs the same `sleep` child of
 * the tool's shell on every version of the tested window.
 */
export function foregroundSleep(tag: string): string {
  return `true && sleep ${tag}`;
}

/** The `[[mock:tool name=Bash ...]]` marker of a Bash tool call with the given input. */
export function bashTool(input: {
  readonly command: string;
  readonly run_in_background?: boolean;
}): string {
  return `[[mock:tool name=Bash in=${b64(JSON.stringify({ description: 'containment test', ...input }))}]]`;
}

/**
 * The live descendants of `root` in `rows`, by parent pid, each started no
 * earlier than its parent (the pid-reuse guard of the core's tree walk).
 */
export function descendantsOf(
  rows: readonly ProcessRow[],
  root: ProcessIdentity,
): readonly ProcessRow[] {
  const found: ProcessRow[] = [];
  const queue: ProcessIdentity[] = [root];
  const seen = new Set<number>([root.pid]);
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const row of rows) {
      if (row.ppid !== parent.pid || seen.has(row.pid)) continue;
      if (BigInt(row.startTime) < BigInt(parent.startTime)) continue;
      seen.add(row.pid);
      queue.push(row);
      found.push(row);
    }
  }
  return found;
}

/** Whether `identity` (pid and start time) is in `rows`. */
export function isListed(rows: readonly ProcessIdentity[], identity: ProcessIdentity): boolean {
  return rows.some((row) => row.pid === identity.pid && row.startTime === identity.startTime);
}

/** The rows of `identities` still listed in a fresh read. */
export async function stillListed(
  identities: readonly ProcessIdentity[],
): Promise<readonly ProcessRow[]> {
  const rows = await table.read();
  return rows.filter((row) => isListed(identities, row));
}

/** Waits `ms` on a real timer. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the table until `pick` returns a value, at most until `guardMs`
 * passed (a hang guard, not a timing assertion).
 *
 * @throws Error naming `what` when the guard expired.
 */
export async function readUntil<T>(
  pick: (rows: readonly ProcessRow[]) => T | undefined,
  guardMs: number,
  what: string,
): Promise<T> {
  const end = Date.now() + guardMs;
  for (;;) {
    const value = pick(await table.read());
    if (value !== undefined) return value;
    if (Date.now() >= end) throw new Error(`${what} not seen within ${String(guardMs)} ms`);
    // A Windows read is one CIM query (0.3 to 1.3 s measured, tracker.ts); Linux reads /proc.
    await sleep(WINDOWS ? 0 : 100);
  }
}

/** Whether a row is a `sleep` process (`sleep`, Git for Windows' `sleep.exe`) with argument `arg`. */
export function isSleep(row: ProcessRow, arg: string): boolean {
  return /^sleep(?:\.exe)?$/i.test(row.name) && row.commandLine.split(/[\s"]+/).includes(arg);
}

/**
 * The live `sleep <tag>` processes, `tag` from the harness's
 * `suite.workloadTag(seconds)`: on Windows no parent-pid walk reaches an
 * MSYS2 `sleep.exe`, so a test names its own workload by its exact argument.
 */
export async function sleepsOf(tag: string): Promise<readonly ProcessRow[]> {
  return (await table.read()).filter((row) => isSleep(row, tag));
}

/** Waits for the one `sleep <tag>` process to run (a hang guard of `guardMs`, not a timing assertion). */
export function waitForSleep(tag: string, guardMs: number): Promise<ProcessRow> {
  return readUntil(
    (rows) => {
      const found = rows.filter((row) => isSleep(row, tag));
      if (found.length > 1) throw new Error(`${String(found.length)} processes run sleep ${tag}`);
      return found[0];
    },
    guardMs,
    `sleep ${tag}`,
  );
}

/**
 * Kills each row by verified identity (test-support's `killVerified`: pid
 * and start time confirmed in a fresh read first) and returns the outcomes.
 */
export async function killEach(rows: readonly ProcessRow[]): Promise<readonly KillOutcome[]> {
  const outcomes: KillOutcome[] = [];
  for (const row of rows) outcomes.push(await killVerified(row, { table }));
  return outcomes;
}

/** Every event of a session, collected until its stream ends. */
export function collectEvents(session: { events(): AsyncIterable<HudhudEvent> }): {
  readonly events: HudhudEvent[];
  readonly done: Promise<void>;
} {
  const events: HudhudEvent[] = [];
  const done = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  return { events, done };
}

/** A `diagnostic` event. */
export type DiagnosticEvent = Extract<HudhudEvent, { readonly type: 'diagnostic' }>;

/** Whether `event` is a `diagnostic` event. */
export function isDiagnostic(event: HudhudEvent): event is DiagnosticEvent {
  return event.type === 'diagnostic' && 'code' in event;
}

/** The diagnostics with `code`, in order. */
export function diagnostics(events: readonly HudhudEvent[], code: string): DiagnosticEvent[] {
  return events.filter(isDiagnostic).filter((event) => event.code === code);
}

/** The one diagnostic with `code`. */
export function onlyDiagnostic(events: readonly HudhudEvent[], code: string): DiagnosticEvent {
  const found = diagnostics(events, code);
  const [only] = found;
  if (only === undefined || found.length !== 1) {
    throw new Error(`expected one ${code} diagnostic, got ${String(found.length)}`);
  }
  return only;
}

/** The step names of a `termination.ladder` report, with their outcomes and details. */
export function ladderSteps(event: DiagnosticEvent): string[] {
  const steps = (event.data?.['steps'] ?? []) as readonly {
    readonly name: string;
    readonly outcome: string;
    readonly detail?: string;
  }[];
  return steps.map((step) =>
    [step.name, step.outcome, step.detail].filter((part) => part !== undefined).join(':'),
  );
}

/** Allows every permission request (the tools these suites run are the test's own). */
export function allowAll(): Promise<{ readonly behavior: 'allow' }> {
  return Promise.resolve({ behavior: 'allow' });
}
