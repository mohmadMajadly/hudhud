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
 */

import path from 'node:path';

import { validateCwd } from '../../../../packages/core/src/process/cwd.js';
import type { CapturedRequest } from '../../../test-support/src/mock/server.js';
import type { ItemRecorder } from '../report.js';
import { createSandbox, mockMarker, type Sandbox } from '../sandbox.js';
import { field, runScenario, type SessionContext } from '../session.js';
import { errorMessage, initField, isSuccess, sessionEvidence, TURN_MS } from './common.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVIRONMENT_UPDATE = 'Environment update';

/** What one run of the session saw. */
interface RunView {
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
  readonly ok: boolean;
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
 * How the first user message is written: `after-init` waits for the
 * `initialize` response first (research 07 §1, where every resume worked);
 * `eager` writes it right behind `initialize`, before any response. Gate run
 * 1 wrote resumed sessions eagerly, and on macOS the resumed CLI then
 * answered `initialize` and one `command_lifecycle` frame and nothing else
 * for 90 s (research 09).
 */
type FirstWrite = 'after-init' | 'eager';

/** Time allowed for the evidence-only eager resume (gate run 1 waited 90 s for nothing). */
const EAGER_RESUME_MS = 30_000;

async function oneRun(
  context: SessionContext,
  sandbox: Sandbox,
  cwd: string,
  resume: string | undefined,
  label: string,
  r: ItemRecorder,
  firstWrite: FirstWrite = 'after-init',
  timeoutMs: number = TURN_MS,
): Promise<RunView & { readonly survivors: number; readonly violations: number }> {
  const outcome = await runScenario(
    context,
    { sandbox, cwd: () => cwd, ...(resume === undefined ? {} : { args: [`--resume=${resume}`] }) },
    async ({ session, mock }) => {
      session.initialize();
      if (firstWrite === 'after-init') await session.initialized(timeoutMs);
      const text = `gate item 6 ${label}`;
      session.user(`${mockMarker('echo')} ${text}`);
      const result = await session.waitKind('result', timeoutMs);
      const messages = turnMessages(mock.requests, text);
      r.note(`${label}Session`, sessionEvidence(session));
      return {
        sessionId: initField(session, 'session_id'),
        cwd: initField(session, 'cwd'),
        ok: isSuccess(result),
        messages: messages.length,
        environmentUpdate: JSON.stringify(messages).includes(ENVIRONMENT_UPDATE),
      };
    },
  );
  return {
    ...outcome.value,
    survivors: outcome.shutdown.sweep.survivors.length,
    violations: outcome.violations,
  };
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

  const first = await oneRun(context, sandbox, canonical, undefined, 'start', r);
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
    )
  ) {
    return;
  }
  const resumed = await oneRun(context, sandbox, canonical, sessionId, 'resume', r);
  r.check(
    'resume (canonical cwd): same session, turn completes',
    resumed.ok && resumed.sessionId === sessionId,
    String(resumed.sessionId),
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
  const alias = await oneRun(context, sandbox, sandbox.work, sessionId, 'aliasResume', r);
  r.note('aliasResume', alias);
  // Evidence only: the gate run 1 write order (user message before the
  // initialize response) on a resumed session, to tell a CLI race from a
  // harness fault (research 09).
  const eager = await oneRun(
    context,
    sandbox,
    canonical,
    sessionId,
    'eagerResume',
    r,
    'eager',
    EAGER_RESUME_MS,
  );
  r.note('eagerResume', eager);
  r.check(
    'no egress violation, nothing survives',
    first.violations + resumed.violations + alias.violations + eager.violations === 0 &&
      first.survivors + resumed.survivors + alias.survivors + eager.survivors === 0,
    JSON.stringify({ first, resumed, alias, eager }),
  );
}
