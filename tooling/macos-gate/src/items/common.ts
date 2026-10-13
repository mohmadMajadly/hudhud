/**
 * Helpers shared by the gate item procedures.
 */

import path from 'node:path';

import type {
  ProcessRecord,
  ProcessSnapshot,
} from '../../../../packages/core/src/process/tree/types.js';
import type { GateHost } from '../host.js';
import { commandName, recordLabel } from '../ps.js';
import type { Sandbox } from '../sandbox.js';
import {
  field,
  frameKind,
  POLL_MS,
  type CliSession,
  type Frame,
  type SessionContext,
} from '../session.js';

/** Time allowed for one turn against the mock. */
export const TURN_MS = 90_000;
/** First-frame and idle watchdog limits the gate applies (generous for cold starts). */
export const WATCHDOG = { firstFrameMs: 30_000, idleMs: 30_000 } as const;

/** Polls `done` every {@link POLL_MS}, calling `sample` before each check, until it holds or `timeoutMs` passes. */
export async function pollUntil(
  host: GateHost,
  done: () => boolean,
  timeoutMs: number,
  sample: () => Promise<void>,
): Promise<boolean> {
  const deadline = host.now() + timeoutMs;
  for (;;) {
    await sample();
    if (done()) return true;
    if (host.now() >= deadline) return false;
    await host.sleep(POLL_MS);
  }
}

/** True for a `result` frame that reports success. */
export function isSuccess(frame: Frame | undefined): boolean {
  return frame?.value['subtype'] === 'success' && frame.value['is_error'] !== true;
}

/** {@link frameKind} plus the `state` of a `command_lifecycle` frame (`queued`, `started`, ...). */
export function frameLabel(frame: Frame): string {
  const kind = frameKind(frame);
  const state = frame.value['state'];
  return frame.value['type'] === 'command_lifecycle' && typeof state === 'string'
    ? `${kind}:${state}`
    : kind;
}

/** A compact, bounded description of a session for the evidence. */
export function sessionEvidence(session: CliSession): Record<string, unknown> {
  return {
    pid: session.pid,
    identity: session.identity,
    frames: session.frames.slice(0, 80).map(frameLabel),
    frameCount: session.frames.length,
    nonFrames: session.nonFrames,
    exit: session.exit,
    stderrTail: session.stderr.slice(-2000),
  };
}

/** The `system/init` frame's string field `key`, or `undefined`. */
export function initField(session: CliSession, key: string): string | undefined {
  const value = session.findKind('system/init')?.value[key];
  return typeof value === 'string' ? value : undefined;
}

/** The `initialize` response body (`response.response`), or `undefined`. */
export function initializeResponse(session: CliSession): unknown {
  const frame = session.find(
    (candidate) =>
      candidate.value['type'] === 'control_response' &&
      field(candidate.value['response'], 'request_id') === 'init_1',
  );
  return field(frame?.value['response'], 'response');
}

/** The process tree of a session with a descendant named `name`. */
export interface NamedTree {
  readonly snapshot: ProcessSnapshot;
  readonly root: ProcessRecord;
  readonly descendants: readonly ProcessRecord[];
  readonly match: ProcessRecord;
}

/** Most distinct names an evidence list keeps. */
export const MAX_SEEN = 64;

/** Adds `value` to `set` while it holds fewer than {@link MAX_SEEN} entries (bounded evidence). */
export function addBounded(set: Set<string>, value: string): void {
  if (set.size < MAX_SEEN) set.add(value);
}

/**
 * Samples the session's tree until a live (non-zombie) descendant whose
 * command name is `name` appears; `undefined` on timeout, exit, or an
 * unknown identity. Every descendant seen is added to `seen` (as
 * {@link recordLabel}, at most 64), so a miss is explained in the evidence.
 */
export async function waitForDescendant(
  context: SessionContext,
  session: CliSession,
  name: string,
  timeoutMs: number,
  seen = new Set<string>(),
): Promise<NamedTree | undefined> {
  const identity = session.identity;
  if (identity === null) return undefined;
  let found: NamedTree | undefined;
  await pollUntil(
    context.host,
    () => found !== undefined || session.exit !== undefined,
    timeoutMs,
    async () => {
      const tree = await context.ledger.tree(identity);
      for (const record of tree.descendants) addBounded(seen, recordLabel(record));
      const match = tree.descendants.find(
        (record) => record.zombie !== true && commandName(record.name) === name,
      );
      if (tree.root !== null && match !== undefined) {
        found = { snapshot: tree.snapshot, root: tree.root, descendants: tree.descendants, match };
      }
    },
  );
  return found;
}

/** True when the CLI wrote a shell snapshot (`<config>/shell-snapshots/snapshot-*`). */
export async function shellSnapshotReady(host: GateHost, sandbox: Sandbox): Promise<boolean> {
  const names = await host.fs.readdir(path.posix.join(sandbox.config, 'shell-snapshots'));
  return names.some((name) => name.startsWith('snapshot-'));
}

/** Message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
