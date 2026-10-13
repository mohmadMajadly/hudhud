/**
 * Records the golden-fixture suites of plan §4.3 (`suites.ts`) from the
 * pinned CLI into `packages/claude-code/conformance/<suite>/<platform>[.<case>].jsonl[.gz]`
 * and updates `manifest.json` (W3-T6; ADR-0006, ADR-0013 §10). Moved here
 * from the W3-T6 scratch recorder by W3-Z; the canary reuses it.
 *
 * @remarks
 * Lead-run, never in CI (`main.ts`, `pnpm fixtures:record`). Every isolation
 * check of the recorder's real-CLI test is live for every case: the verified
 * pinned binary only, a fresh sandbox per suite (strict forbidden-ancestor
 * policy), the mock with its egress trap (any violation fails the run), the
 * leak tracker with descendant sampling plus the command-line sweep, and the
 * outside-write check of the real user's Claude locations (metadata only).
 *
 * The root of each case is recorded concurrently with the script, so the
 * process-table query (about 1 s on Windows) never delays the first stdin
 * write; the recording itself attaches at the spawn (`RecordingSession`,
 * W3-Z ruling 5), so a CLI that exits at once keeps its output.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import type { VerifiedCli } from '../../launcher/pinned-cli.js';
import { createSandbox } from '../../launcher/sandbox.js';
import type { LaunchOptions, Sandbox, SandboxOptions } from '../../launcher/sandbox.js';
import { assertNoOutsideWrites, diffOutside, snapshotOutside } from '../../leaks/outside.js';
import type { OutsideChange, OutsideWatch } from '../../leaks/outside.js';
import { assertNoSurvivors, LeakTracker } from '../../leaks/tracker.js';
import type { LeakHost } from '../../leaks/tracker.js';
import { startMockServer } from '../../mock/server.js';
import { normalizeRecords } from '../normalize.js';
import type { FixtureRecordLine } from '../normalize.js';
import { describeRecord, formatJsonl, sandboxContext } from '../recorder.js';
import { RecordingSession } from '../session.js';
import type { JsonValue, RawRecord } from '../session.js';
import type { CaseSpec, SuiteContext, SuiteSpec } from './suites.js';

/** The `recorder` field of every manifest entry. */
export const RECORDER = '@hudhud/test-support fixtures/record (RecordingSession, normalizeRecords)';

/** One manifest entry. */
export interface ManifestEntry {
  readonly suite: string;
  readonly case: string;
  readonly file: string;
  readonly platform: string;
  readonly cliVersion: string;
  readonly scenario: string;
  readonly research: string;
  readonly recordedOn: string;
  readonly recorder: string;
  readonly recorderRevision: string;
  readonly exit: { readonly code: number | null; readonly signal: string | null };
  readonly compressed: boolean;
  /** Labels of the research shape not found in order (empty when it matches). */
  readonly shapeMissing: readonly string[];
  /** The exit code the research observed, when this recording differs. */
  readonly researchExit?: number | null;
  /**
   * Descendants of the CLI still running when it had exited, which then
   * exited by themselves within the settle time (name and command line,
   * sandbox paths normalized). One still running after that fails the
   * recording.
   */
  readonly orphansSelfExited?: readonly string[];
}

/** The manifest file. */
export interface Manifest {
  readonly $comment: string;
  readonly format: string;
  readonly entries: readonly ManifestEntry[];
}

/** The mock the recorder needs: its URL, its violations and a way to close it. */
export interface RecorderMock {
  readonly url: string;
  assertNoViolations(): void;
  close(): Promise<void>;
}

/** Everything a recording run uses from the host; built by `main.ts`, faked by tests. */
export interface RecorderEnvironment {
  readonly cli: VerifiedCli;
  readonly platform: NodeJS.Platform;
  /** The process table (and, in tests, kill and sleep) of the leak checks. */
  readonly leakHost: LeakHost;
  /** The real user's Claude locations whose metadata must not change. */
  readonly watch: OutsideWatch;
  /** Changes of `watch` explained by something else (see `main.ts`). */
  readonly confound: (change: OutsideChange) => boolean;
  /** The conformance directory written to. */
  readonly outDir: string;
  /** Git revision of the recorder sources (manifest `recorderRevision`). */
  readonly revision: string;
  /** `YYYY-MM-DD` of the recording. */
  readonly today: string;
  /** Sandbox placement: the test root and, for the launcher's own tests, the ancestor policy. */
  readonly sandbox?: Pick<SandboxOptions, 'testRoot' | 'ancestorPolicy'>;
  /** Replaces the sandbox the cases launch in (tests: a fake CLI's script argument). */
  readonly wrapSandbox?: (sandbox: Sandbox) => Sandbox;
  /** Default: the in-process mock with its egress trap. */
  readonly startMock?: () => Promise<RecorderMock>;
  /** A `subst` test root and the physical directory behind it, normalized like the drive. */
  readonly physicalRoot?: { readonly testRoot: string; readonly physical: string };
  /** Directory for an uncompressed copy of each compressed fixture (privacy scan). */
  readonly plainDir?: string;
  /** How long an orphan may take to exit by itself before it is a leak. Default 5000. */
  readonly orphanSettleMs?: number;
  /** Descendant sampling interval. Default 1000 on Windows, else 250 (plan §4.7). */
  readonly samplingMs?: number;
}

/** Default bound of a case from its EOF to the exit ({@link CaseSpec.exitMs}). */
export const DEFAULT_CASE_EXIT_MS = 30_000;

/** Default of {@link RecorderEnvironment.orphanSettleMs}. */
export const ORPHAN_SETTLE_MS = 5000;

/** The fixture path of a case, relative to the conformance directory. */
export function caseFile(suite: SuiteSpec, spec: CaseSpec, platform: string): string {
  const base = spec.name === '' ? platform : `${platform}.${spec.name}`;
  return `${suite.name}/${base}.jsonl${suite.compress === true ? '.gz' : ''}`;
}

/** Splits an `in` record that held several frames (one write, `sendRaw` with `\n`) into one record each. */
export function splitWrites(records: readonly RawRecord[]): RawRecord[] {
  return records.flatMap((record) => {
    if (record.dir !== 'in' || typeof record.v !== 'string' || !record.v.includes('\n')) {
      return [record];
    }
    return record.v.split('\n').map((line): RawRecord => {
      let v: JsonValue = line;
      try {
        v = JSON.parse(line) as JsonValue;
      } catch {
        // kept as the raw line
      }
      return { t: record.t, dir: 'in', v };
    });
  });
}

/** The labels of `expected` not found, as prefixes, in order among the labels of `lines`. */
export function missingPrefixes(
  lines: readonly FixtureRecordLine[],
  expected: readonly string[],
): readonly string[] {
  const labels = lines.map(describeRecord);
  let at = 0;
  const missing: string[] = [];
  for (const label of expected) {
    const found = labels.findIndex(
      (candidate, index) => index >= at && candidate.startsWith(label),
    );
    if (found < 0) missing.push(label);
    else at = found + 1;
  }
  return missing;
}

/** A manifest with no entries. */
export function emptyManifest(): Manifest {
  return {
    $comment:
      'Golden fixtures of plan §4.3, recorded from the pinned CLI by @hudhud/test-support fixtures/record (W3-T6, W3-Z). Lines: conformance.schema.json; paths, uuids, pids, versions, timestamps, durations and costs normalized; the fake credentials redacted.',
    format: 'jsonl: {"t","dir","v"} record lines; the first line is the launch config',
    entries: [],
  };
}

/** Reads a manifest; a missing or unparsable file gives {@link emptyManifest}. */
export function readManifest(file: string): Manifest {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  } catch {
    return emptyManifest();
  }
}

/** Replaces the entries of the same files and sorts by file. */
export function mergeManifest(manifest: Manifest, entries: readonly ManifestEntry[]): Manifest {
  return {
    ...manifest,
    entries: [
      ...manifest.entries.filter((entry) => !entries.some((next) => next.file === entry.file)),
      ...entries,
    ].sort((a, b) => a.file.localeCompare(b.file)),
  };
}

/** A one-line summary of an entry for the run log. */
export function entryLine(entry: ManifestEntry, elapsedMs: number): string {
  const notes = [
    entry.shapeMissing.length > 0 ? `MISSING ${entry.shapeMissing.join(' | ')}` : '',
    entry.researchExit === undefined
      ? ''
      : `EXIT ${String(entry.exit.code)} (research ${String(entry.researchExit)})`,
    entry.orphansSelfExited === undefined
      ? ''
      : `ORPHANS (self-exited) ${entry.orphansSelfExited.join(' | ')}`,
  ].filter((note) => note !== '');
  return `${entry.file} exit=${String(entry.exit.code)} ${String(elapsedMs)}ms ${notes.join(' ; ') || 'ok'}`;
}

/**
 * Waits up to the settle time for every tracked process to be gone and
 * returns the ones seen alive after the CLI's exit; fails (killing them by
 * verified identity) when any is still alive then.
 */
async function settleOrphans(
  tracker: LeakTracker,
  sandbox: Sandbox,
  settleMs: number,
): Promise<readonly string[]> {
  const seen = new Set<string>();
  const deadline = Date.now() + settleMs;
  for (;;) {
    const leaks = await tracker.findLeaks();
    for (const leak of leaks) {
      const line = leak.commandLine
        .replaceAll(sandbox.dirs.work, '<work>')
        .replaceAll(sandbox.dirs.root, '<root>')
        .replaceAll(sandbox.cli.binaryPath, '<bin>');
      seen.add(`${leak.name}: ${line}`);
    }
    if (leaks.length === 0) return [...seen].sort();
    // At the deadline, a leak still alive fails (killed by verified
    // identity); one that exited meanwhile ends the loop on the next read.
    if (Date.now() >= deadline) await tracker.assertNoLeaks();
    else await sleep(250);
  }
}

/** The config record that opens every fixture. */
function configRecord(
  suite: SuiteSpec,
  spec: CaseSpec,
  platform: string,
  session: RecordingSession,
  launch: LaunchOptions,
): RawRecord {
  return {
    t: 0,
    dir: 'config' as unknown as RawRecord['dir'],
    v: {
      suite: suite.name,
      case: spec.name === '' ? 'main' : spec.name,
      platform,
      argv: [...session.process.argv],
      env: { ...(launch.env ?? {}) },
    },
  };
}

async function recordCase(
  env: RecorderEnvironment,
  sandbox: Sandbox,
  tracker: LeakTracker,
  suite: SuiteSpec,
  spec: CaseSpec,
  context: SuiteContext,
): Promise<ManifestEntry> {
  const { platform } = env;
  const launch: LaunchOptions = spec.launch(context);
  let rooted: Promise<unknown> = Promise.resolve();
  const tracked: Sandbox = {
    ...sandbox,
    launch: async (options, hooks) => {
      const child = await sandbox.launch(options, hooks);
      // Concurrent with the script: the root query must not delay stdin.
      rooted = tracker.recordRoot(child.pid);
      rooted.catch(() => undefined);
      return child;
    },
  };
  const session = await RecordingSession.start(tracked, launch);
  const driven = spec.drive(session, context).then(
    (): unknown => undefined,
    (error: unknown) => error ?? new Error('drive failed'),
  );
  try {
    await rooted;
  } catch (error) {
    // Only a root that already exited may be missing from the table; the
    // command-line sweep and descendant sampling still cover its tree.
    if ((await session.waitExit(1000)) === undefined) {
      await session.stop(spec.exitMs ?? DEFAULT_CASE_EXIT_MS);
      throw error;
    }
  }
  const stopSampling = tracker.startSampling(env.samplingMs ?? (platform === 'win32' ? 1000 : 250));
  const failure = await driven;
  const exit = await session.stop(spec.exitMs ?? DEFAULT_CASE_EXIT_MS);
  await stopSampling();
  const orphans = await settleOrphans(tracker, sandbox, env.orphanSettleMs ?? ORPHAN_SETTLE_MS);
  if (failure !== undefined) {
    const labels = session.records.map(describeRecord).join('\n  ');
    const reason = failure instanceof Error ? failure.message : JSON.stringify(failure);
    throw new Error(`${suite.name}/${spec.name || 'main'}: ${reason}\n  ${labels}`, {
      cause: failure,
    });
  }
  const base = sandboxContext(sandbox, session);
  const { physicalRoot } = env;
  const extraPaths =
    physicalRoot === undefined
      ? []
      : base.paths
          .filter((entry) =>
            entry.path.toLowerCase().startsWith(physicalRoot.testRoot.toLowerCase()),
          )
          .map((entry) => ({
            path: path.join(physicalRoot.physical, entry.path.slice(physicalRoot.testRoot.length)),
            token: entry.token,
          }));
  const lines = normalizeRecords(
    [configRecord(suite, spec, platform, session, launch), ...splitWrites(session.records)],
    { ...base, paths: [...base.paths, ...extraPaths] },
  );
  const file = caseFile(suite, spec, platform);
  const target = path.join(env.outDir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  const text = formatJsonl(lines);
  if (suite.compress === true) {
    writeFileSync(target, gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));
    if (env.plainDir !== undefined) {
      writeFileSync(path.join(env.plainDir, `${suite.name}.${platform}.jsonl`), text);
    }
  } else {
    writeFileSync(target, text);
  }
  return {
    suite: suite.name,
    case: spec.name === '' ? 'main' : spec.name,
    file,
    platform,
    cliVersion: env.cli.version,
    scenario: suite.scenario,
    research: suite.research,
    recordedOn: env.today,
    recorder: RECORDER,
    recorderRevision: env.revision,
    exit,
    compressed: suite.compress === true,
    shapeMissing: missingPrefixes(lines, spec.shape),
    ...(exit.code === spec.exit ? {} : { researchExit: spec.exit }),
    ...(orphans.length === 0 ? {} : { orphansSelfExited: orphans }),
  };
}

/**
 * Records every case of one suite in a fresh sandbox and mock, with the
 * leak, egress and outside-write checks; resolves with the manifest entries.
 *
 * @throws when a script fails, the egress trap saw a violation, anything
 *   leaked or the real user's Claude locations changed
 */
export async function recordSuite(
  suite: SuiteSpec,
  env: RecorderEnvironment,
): Promise<ManifestEntry[]> {
  const before = snapshotOutside(env.watch);
  const mock = await (env.startMock ?? startMockServer)();
  const created = await createSandbox({
    cli: env.cli,
    mock,
    name: suite.name.slice(0, 24),
    ...(suite.credential === undefined ? {} : { credential: suite.credential }),
    ...env.sandbox,
  });
  const sandbox = env.wrapSandbox?.(created) ?? created;
  const tracker = new LeakTracker({ ...env.leakHost, marker: sandbox.dirs.root });
  const entries: ManifestEntry[] = [];
  const context: SuiteContext = new Map();
  try {
    await tracker.begin();
    for (const spec of suite.cases) {
      entries.push(await recordCase(env, sandbox, tracker, suite, spec, context));
    }
    mock.assertNoViolations();
    await tracker.assertNoLeaks();
    await assertNoSurvivors(env.leakHost, sandbox.dirs.root);
  } finally {
    await mock.close();
    await sandbox.dispose();
  }
  assertNoOutsideWrites(diffOutside(before, snapshotOutside(env.watch)), env.confound);
  return entries;
}

/**
 * Records `suites` one after the other, rewriting `manifest.json` after each
 * suite; `log` gets one line per case. Resolves with the number of cases.
 */
export async function recordSuites(
  suites: readonly SuiteSpec[],
  env: RecorderEnvironment,
  log: (line: string) => void,
): Promise<number> {
  const manifestFile = path.join(env.outDir, 'manifest.json');
  let manifest = readManifest(manifestFile);
  let count = 0;
  for (const suite of suites) {
    const started = Date.now();
    const entries = await recordSuite(suite, env);
    manifest = mergeManifest(manifest, entries);
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const entry of entries) log(entryLine(entry, Date.now() - started));
    count += entries.length;
  }
  return count;
}
