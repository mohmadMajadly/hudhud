/**
 * Gate item 6, path identity (ADR-0014; ADR-0011 §9, research 07 §1).
 *
 * `/tmp` is a link to `/private/tmp`, and APFS volumes are usually
 * case-insensitive. hudhud passes the cwd through core `validateCwd`
 * (realpath), so one directory always reaches the CLI under one spelling.
 *
 * - `validateCwd` maps the `/tmp` alias to `/private/tmp` and, on a
 *   case-insensitive volume, a case variant to the same canonical path.
 * - A session started in the canonical cwd resumes (`--resume=<id>`) from the
 *   canonical cwd: same session id, history loaded, the CLI sees the same
 *   working directory (no "Environment update" injected, research 07 a8).
 * - Evidence only: the same resume from the `/tmp` alias, showing whether the
 *   CLI treats the alias as another directory.
 * - Evidence only: a resume whose user message is written before the
 *   `initialize` response (the order of gate run 1, research 09).
 * - Evidence only: a resume whose user message reuses the `uuid` of the
 *   start run's message. Gate runs 1 and 2 did that by accident (each process
 *   numbered its messages from 1), and CLI 2.1.296 dropped every such
 *   message: `command_lifecycle` `completed` for it, no turn, no `result`
 *   (reproduced on Linux, research 10). This run shows the same on macOS.
 *
 * Every user message carries a fresh `uuid` ({@link CliSession.user}).
 */

import path from 'node:path';

import { validateCwd } from '../../../../packages/core/src/process/cwd.js';
import type { CapturedRequest } from '../../../test-support/src/mock/server.js';
import type { ItemRecorder } from '../report.js';
import { createSandbox, mockMarker, type Sandbox } from '../sandbox.js';
import { field, frameKind, runScenario, type CliSession, type SessionContext } from '../session.js';
import { errorMessage, initField, isSuccess, sessionEvidence, TURN_MS } from './common.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVIRONMENT_UPDATE = 'Environment update';

/** What one run of the session saw. */
interface RunView {
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
  readonly ok: boolean;
  /** `result/<subtype>`, or `undefined` when no result arrived. */
  readonly result: string | undefined;
  /** The `uuid` of the run's user message. */
  readonly uuid: string;
  /** The `command_lifecycle` states of that message, in order. */
  readonly lifecycle: readonly string[];
  /** Messages in the last Messages API request of the run. */
  readonly messages: number;
  /** The CLI told the model that the working directory changed. */
  readonly environmentUpdate: boolean;
}

/**
 * The `messages` of the longest captured request that carries `text` (the
 * turn's own request, not a side request such as a title).
 */
export function turnMessages(
  requests: readonly CapturedRequest[],
  text: string,
): readonly unknown[] {
  let longest: readonly unknown[] = [];
  for (const request of requests) {
    const messages: unknown = field(request.body, 'messages');
    if (
      Array.isArray(messages) &&
      messages.length > longest.length &&
      JSON.stringify(messages).includes(text)
    ) {
      longest = messages;
    }
  }
  return longest;
}

/**
 * True when the lifecycle states of a message show that it ended without
 * ever starting: `completed` or `cancelled` and no `started`. CLI 2.1.296
 * answers a user message it drops (a `uuid` the resumed transcript already
 * holds) with `completed` alone and never writes a `result` (research 10).
 */
export function droppedUnstarted(lifecycle: readonly string[]): boolean {
  return (
    !lifecycle.includes('started') &&
    (lifecycle.includes('completed') || lifecycle.includes('cancelled'))
  );
}

/**
 * True once the wait for the message `uuid` is over: a `result` arrived, or
 * the message ended without starting ({@link droppedUnstarted}), which no
 * longer costs the whole turn timeout.
 */
export function messageEnded(session: CliSession, uuid: string): boolean {
  return session.findKind('result') !== undefined || droppedUnstarted(session.lifecycle(uuid));
}

/**
 * How the first user message is written: `after-init` waits for the
 * `initialize` response first (research 07 §1); `eager` writes it right
 * behind `initialize`, before any response (the order of gate run 1).
 */
type FirstWrite = 'after-init' | 'eager';

/** Time allowed for an evidence-only resume. */
const EVIDENCE_RESUME_MS = 30_000;

/** Options of {@link oneRun}. */
interface RunOptions {
  readonly resume?: string;
  readonly firstWrite?: FirstWrite;
  readonly timeoutMs?: number;
  /** Reuses this `uuid` for the user message (the duplicate-`uuid` evidence run only). */
  readonly uuid?: string;
}

/** The {@link RunView} of a finished turn wait. */
function view(
  session: CliSession,
  requests: readonly CapturedRequest[],
  text: string,
  uuid: string,
): RunView {
  const result = session.findKind('result');
  const messages = turnMessages(requests, text);
  return {
    sessionId: initField(session, 'session_id'),
    cwd: initField(session, 'cwd'),
    ok: isSuccess(result),
    result: result === undefined ? undefined : frameKind(result),
    uuid,
    lifecycle: session.lifecycle(uuid),
    messages: messages.length,
    environmentUpdate: JSON.stringify(messages).includes(ENVIRONMENT_UPDATE),
  };
}

async function oneRun(
  context: SessionContext,
  sandbox: Sandbox,
  cwd: string,
  label: string,
  r: ItemRecorder,
  options: RunOptions = {},
): Promise<RunView & { readonly survivors: number; readonly violations: number }> {
  const { resume, firstWrite = 'after-init', timeoutMs = TURN_MS } = options;
  const outcome = await runScenario(
    context,
    { sandbox, cwd: () => cwd, ...(resume === undefined ? {} : { args: [`--resume=${resume}`] }) },
    async ({ session, mock }) => {
      session.initialize();
      if (firstWrite === 'after-init') await session.initialized(timeoutMs);
      const text = `gate item 6 ${label}`;
      const uuid = session.user(`${mockMarker('echo')} ${text}`, options.uuid);
      await session.waitFor(() => messageEnded(session, uuid), timeoutMs);
      r.note(`${label}Session`, sessionEvidence(session));
      return view(session, mock.requests, text, uuid);
    },
  );
  return {
    ...outcome.value,
    survivors: outcome.shutdown.sweep.survivors.length,
    violations: outcome.violations,
  };
}

/** A one-line account of a run for a check detail. */
function describeRun(run: RunView): string {
  return `session ${String(run.sessionId)}, ${run.result ?? 'no result'}, lifecycle [${run.lifecycle.join(', ')}]`;
}

/** Runs item 6. */
export async function pathIdentityItem(context: SessionContext, r: ItemRecorder): Promise<void> {
  const { host } = context;
  const tmpReal = await host.fs.realpath('/tmp');
  r.check('/tmp resolves to /private/tmp', tmpReal === '/private/tmp', tmpReal);

  const sandbox = await createSandbox(host.fs, '/tmp');
  const probe = path.posix.join(sandbox.root, 'CaseProbe');
  await host.fs.writeFile(probe, 'x');
  const caseInsensitive = (await host.fs.kind(path.posix.join(sandbox.root, 'caseprobe'))) !== null;
  r.note('caseInsensitiveVolume', caseInsensitive);

  const canonical = await validateCwd(sandbox.work, 'posix', host.cwdFs);
  r.check(
    'validateCwd maps the /tmp alias to its realpath',
    canonical === `${tmpReal}${sandbox.work.slice('/tmp'.length)}`,
    `${sandbox.work} -> ${canonical}`,
  );
  const variant = path.posix.join(sandbox.root, 'WORK');
  const variantResolved = await validateCwd(variant, 'posix', host.cwdFs).catch(errorMessage);
  r.check(
    'validateCwd gives a case variant the canonical spelling (case-insensitive volume)',
    !caseInsensitive || variantResolved === canonical,
    caseInsensitive ? `${variant} -> ${variantResolved}` : 'case-sensitive volume: not applicable',
  );

  const first = await oneRun(context, sandbox, canonical, 'start', r);
  r.check(
    'start: the turn completes and the CLI reports the canonical cwd',
    first.ok && first.cwd === canonical,
    `cwd ${String(first.cwd)}`,
  );
  const sessionId = first.sessionId;
  if (
    !r.check(
      'start: a session id is reported',
      sessionId !== undefined && SESSION_ID.test(sessionId),
      String(sessionId),
    ) ||
    sessionId === undefined
  ) {
    return;
  }
  const resumed = await oneRun(context, sandbox, canonical, 'resume', r, { resume: sessionId });
  r.check(
    'resume (canonical cwd): same session, turn completes',
    resumed.ok && resumed.sessionId === sessionId,
    describeRun(resumed),
  );
  r.check(
    'resume (canonical cwd): the history is loaded',
    resumed.messages >= 3,
    `${String(resumed.messages)} messages`,
  );
  r.check(
    'resume (canonical cwd): the CLI sees the same working directory',
    !resumed.environmentUpdate && resumed.cwd === canonical,
    `cwd ${String(resumed.cwd)}, environment update: ${String(resumed.environmentUpdate)}`,
  );
  const alias = await oneRun(context, sandbox, sandbox.work, 'aliasResume', r, {
    resume: sessionId,
  });
  r.note('aliasResume', alias);
  // Evidence only: the gate run 1 write order (user message before the
  // initialize response) on a resumed session, now with a fresh uuid.
  const eager = await oneRun(context, sandbox, canonical, 'eagerResume', r, {
    resume: sessionId,
    firstWrite: 'eager',
    timeoutMs: EVIDENCE_RESUME_MS,
  });
  r.note('eagerResume', eager);
  // Evidence only: the cause of the gate run 1 and 2 stalls, a user message
  // whose uuid the resumed transcript already holds.
  const duplicate = await oneRun(context, sandbox, canonical, 'duplicateUuidResume', r, {
    resume: sessionId,
    timeoutMs: EVIDENCE_RESUME_MS,
    uuid: first.uuid,
  });
  r.note('duplicateUuidResume', {
    ...duplicate,
    dropped: duplicate.result === undefined && droppedUnstarted(duplicate.lifecycle),
  });
  const runs = [first, resumed, alias, eager, duplicate];
  r.check(
    'no egress violation, nothing survives',
    runs.every((run) => run.violations === 0 && run.survivors === 0),
    JSON.stringify({ first, resumed, alias, eager, duplicate }),
  );
}
