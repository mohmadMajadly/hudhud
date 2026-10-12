/**
 * Golden-fixture recorder (plan §1.11, §4.3; ADR-0006, ADR-0013 §10).
 *
 * @remarks
 * Records a scripted session of the sandboxed pinned CLI
 * (`session.ts`), normalizes and redacts it (`normalize.ts`) and writes
 * the record lines of `packages/claude-code/conformance/<suite>/<case>.jsonl`
 * (`{"t","dir","v"}` per line, `conformance.schema.json`). The `expect`
 * blocks are added by hand when the suite is minimized (W3-T6). Real-CLI
 * recordings are lead-run (plan §5.4); see the handshake test for the
 * command.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FAKE_API_KEY } from '../launcher/env.js';
import type { Sandbox } from '../launcher/sandbox.js';
import { normalizeRecords } from './normalize.js';
import type { FixtureRecordLine, NormalizeContext } from './normalize.js';
import { isFrame, RecordingSession } from './session.js';
import type { ExitInfo, JsonValue, OutRecord, RawRecord } from './session.js';

/** The normalization context of a session in `sandbox` (paths, pid, key, version, cwd). */
export function sandboxContext(sandbox: Sandbox, session: RecordingSession): NormalizeContext {
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
    pids: [session.process.pid],
    secrets: [FAKE_API_KEY],
    version: sandbox.cli.version,
    cwd: dirs.work,
  };
}

/** The fixture lines of a finished session. */
export function fixtureLines(
  sandbox: Sandbox,
  session: RecordingSession,
): readonly FixtureRecordLine[] {
  return normalizeRecords(session.records, sandboxContext(sandbox, session));
}

/** JSONL text of fixture lines: one compact JSON object per line, LF, trailing newline. */
export function formatJsonl(lines: readonly FixtureRecordLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

/** Writes fixture lines to `file` (directories created; an existing file is replaced). */
export async function writeFixture(
  file: string,
  lines: readonly FixtureRecordLine[],
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, formatJsonl(lines), 'utf8');
}

/** Timeouts of {@link recordHandshake}. */
export interface HandshakeTimeouts {
  /** For each awaited frame. Default 60 s. */
  readonly frameMs?: number | undefined;
  /** From EOF to exit. Default 30 s. */
  readonly exitMs?: number | undefined;
}

/** A finished recording. */
export interface Recording {
  readonly session: RecordingSession;
  readonly exit: ExitInfo;
  readonly lines: readonly FixtureRecordLine[];
}

/**
 * Records the `handshake` case (05 §5): `initialize`, one user turn
 * answered by the mock's `text` scenario, then EOF.
 */
export async function recordHandshake(
  sandbox: Sandbox,
  timeouts: HandshakeTimeouts = {},
): Promise<Recording> {
  const frameMs = timeouts.frameMs ?? 60_000;
  const exitMs = timeouts.exitMs ?? 30_000;
  const session = await RecordingSession.start(sandbox);
  try {
    session.control('init_1', 'initialize');
    await session.waitFor(
      (record) =>
        isFrame(record, 'control_response', 'success') && requestIdOf(record) === 'init_1',
      frameMs,
      'initialize response',
    );
    session.user('[[mock:text]] hello');
    await session.waitType('result', undefined, frameMs);
  } catch (error) {
    await session.stop(exitMs);
    throw error;
  }
  const exit = await session.stop(exitMs);
  return { session, exit, lines: fixtureLines(sandbox, session) };
}

function get(value: JsonValue | undefined, name: string): JsonValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)[name]
    : undefined;
}

function requestIdOf(record: OutRecord | RawRecord): JsonValue | undefined {
  return get(get(record.v, 'response'), 'request_id');
}

/** A one-line label of a record: `out control_response/success init_1`, `exit 0`, ... */
export function describeRecord(record: { readonly dir: string; readonly v: JsonValue }): string {
  const { v } = record;
  if (record.dir === 'exit') return `exit ${JSON.stringify(get(v, 'code'))}`;
  const type = get(v, 'type');
  if (typeof type !== 'string') return `${record.dir} ${typeof v === 'string' ? 'text' : 'json'}`;
  const response = get(v, 'response');
  const request = get(v, 'request');
  const subtype = get(v, 'subtype') ?? get(response, 'subtype') ?? get(request, 'subtype');
  const id = get(response, 'request_id') ?? get(v, 'request_id');
  return [
    record.dir,
    typeof subtype === 'string' ? `${type}/${subtype}` : type,
    typeof id === 'string' ? id : '',
  ]
    .join(' ')
    .trimEnd();
}

/** The 05 §5 handshake shape, as an ordered subsequence of {@link describeRecord} labels. */
export const HANDSHAKE_SHAPE: readonly string[] = [
  'in control_request/initialize init_1',
  'out control_response/success init_1',
  'in user',
  'out system/init',
  'out assistant',
  'out result/success',
  'exit 0',
];

/**
 * Returns the labels of `expected` missing from `lines` in order (empty when
 * the lines contain `expected` as an ordered subsequence).
 */
export function missingShape(
  lines: readonly { readonly dir: string; readonly v: JsonValue }[],
  expected: readonly string[],
): readonly string[] {
  const labels = lines.map(describeRecord);
  let at = 0;
  const missing: string[] = [];
  for (const label of expected) {
    const found = labels.indexOf(label, at);
    if (found < 0) missing.push(label);
    else at = found + 1;
  }
  return missing;
}
