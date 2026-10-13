// The declared outcome of every suite of the catalogue (see `catalogue.ts`).
// Each entry says what the scenario must show through the session machine
// and why; the expect files hold the exact effects and events behind it.
//
// Two recording facts shape many declarations:
//
// - Only `session-state-events` was recorded with
//   `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, which hudhud always pins
//   (plan §2.4). Without `session_state_changed` `idle` the machine never
//   sees the harness idle after a user message, so its drain on close
//   (K13) does not end stdin: the recorder's EOF (`stdin.end`) has no
//   machine counterpart, and those sessions end by the recorded exit
//   (`closed`). `NO_IDLE` below.
// - hudhud writes `interrupt` with an explicit `cancel_queued` (the strict
//   outbound schema); the recorder wrote it bare when false. Same request.

import type { CaseDeclaration, SuiteDeclaration, WriteDifferences } from './catalogue.js';
import type { ReplaySummary } from './summary.js';

const BOTH = ['linux', 'win32'] as const;
const MAIN = ['main'] as const;
const SETUP_MAIN = ['setup', 'main'] as const;

/** Every write pairs. */
const SAME: WriteDifferences = { recorded: [], machine: [] };
/** The recorder's EOF after a turn: no idle frame, so no drain (see above). */
const NO_IDLE: WriteDifferences = { recorded: ['stdin.end'], machine: [] };
/** A recorded bare `interrupt`, written with `cancel_queued: false` by hudhud; and NO_IDLE. */
const INTERRUPT: WriteDifferences = {
  recorded: ['interrupt', 'stdin.end'],
  machine: ['interrupt {"cancel_queued":false}'],
};

/** A summary with no turn, permission, control, ladder or diagnostic unless given. */
function summary(fields: Partial<ReplaySummary>): ReplaySummary {
  return {
    handshake: 'ok',
    turns: [],
    permissions: [],
    controls: [],
    ladder: [],
    diagnostics: [],
    session: 'closed',
    ...fields,
  };
}

function declare(summaryFields: Partial<ReplaySummary>, writes: WriteDifferences): CaseDeclaration {
  return { summary: summary(summaryFields), writes };
}

/** One text turn sent without a uuid, completed; closed by the recorded exit. */
const ONE_TURN = declare({ turns: ['send-1 completed'] }, NO_IDLE);

/** A K10 fail-fast: the turn fails, the session is poisoned, the ladder starts, stdin ends at once. */
const FAIL_FAST = declare(
  {
    turns: ['send-1 fail AUTHENTICATION_FAILED'],
    ladder: ['auth-fail-fast'],
    session: 'failed AUTHENTICATION_FAILED',
  },
  SAME,
);

function suite(
  name: string,
  declared: SuiteDeclaration['declared'],
  extra: Partial<SuiteDeclaration> = {},
): SuiteDeclaration {
  return { name, source: 'plan §4.3', platforms: BOTH, cases: MAIN, declared, ...extra };
}

/** Resume and fork suites: a setup session, then the resumed or forked one, one turn each. */
function resumed(name: string): SuiteDeclaration {
  return suite(name, { setup: ONE_TURN, main: ONE_TURN }, { cases: SETUP_MAIN });
}

export const CATALOGUE: readonly SuiteDeclaration[] = [
  // initialize, one text turn, EOF.
  suite('handshake', { main: ONE_TURN }),
  // A user-message uuid: the turn id is the recorded uuid (command_lifecycle).
  suite('text-turn', { main: declare({ turns: ['<uuid-1> completed'] }, NO_IDLE) }),
  suite('two-turns', {
    main: declare({ turns: ['<uuid-1> completed', '<uuid-8> completed'] }, NO_IDLE),
  }),
  // Stream events become message deltas; one turn.
  suite('partial-messages', { main: ONE_TURN }),
  // An auto-allowed read-only Bash call: no permission request.
  suite('tool-bash', { main: ONE_TURN }),
  // The application allows with updatedInput: the same answer as the recording.
  suite('permission-allow', {
    main: declare({ turns: ['send-1 completed'], permissions: ['allow by application'] }, NO_IDLE),
  }),
  suite('permission-deny', {
    main: declare({ turns: ['send-1 completed'], permissions: ['deny by application'] }, NO_IDLE),
  }),
  // deny with interrupt: the CLI aborts the turn (error_during_execution, aborted).
  suite('permission-deny-interrupt', {
    main: declare({ turns: ['send-1 cancelled'], permissions: ['deny by application'] }, NO_IDLE),
  }),
  // hudhud never answers a permission request with a control error: the
  // recorded error answer replays as the application withdrawing the ask,
  // which writes the fixed non-interrupting deny (fail closed); the turn
  // goes on as recorded.
  suite('permission-error-response', {
    main: declare(
      { turns: ['send-1 completed'], permissions: ['cancelled by application'] },
      {
        recorded: ['error {"error":"host failed"}', 'stdin.end'],
        machine: ['deny {"message":"hudhud permission request cancelled","interrupt":false}'],
      },
    ),
  }),
  // The CLI withdraws its request on interrupt (control_cancel_request):
  // the ask ends by the harness, the interrupt is acknowledged, the turn
  // ends cancelled.
  suite('permission-never-answered-interrupt', {
    main: declare(
      {
        turns: ['send-1 cancelled'],
        permissions: ['cancelled by harness'],
        controls: ['int_1 ok'],
      },
      INTERRUPT,
    ),
  }),
  // close with a pending ask (K12): the ask is cancelled by close and the
  // closing deny is written, where the recorder only sent EOF.
  suite('permission-eof', {
    main: declare(
      { turns: ['send-1 completed'], permissions: ['cancelled by close'] },
      {
        recorded: ['stdin.end'],
        machine: ['deny {"message":"hudhud session closing","interrupt":false}'],
      },
    ),
  }),
  // The interrupt of the streaming turn is written at once (its system/init was seen).
  suite('interrupt-midstream', {
    main: declare({ turns: ['<uuid-1> cancelled'], controls: ['int_1 ok'] }, INTERRUPT),
  }),
  // still_queued names the queued turn, not the target: no retry; the queued turn runs next.
  suite('interrupt-queued', {
    main: declare(
      { turns: ['<uuid-1> cancelled', '<uuid-6> completed'], controls: ['int_1 ok'] },
      INTERRUPT,
    ),
  }),
  // cancel_queued: the response's cancelled list settles the queued turn
  // (synthesized) before the target's own result.
  suite('interrupt-cancel-queued', {
    main: declare(
      {
        turns: ['<uuid-6> cancelled synthesized', '<uuid-1> cancelled'],
        controls: ['int_1 ok'],
      },
      NO_IDLE,
    ),
  }),
  // GH#98713: the interrupt sent in the user frame's write is held until
  // turn 2's system/init and written there (see the expect file), never in
  // the step of the user write. The recorded answer to the recorder's
  // immediate interrupt names a request hudhud never sent
  // (control.unknown-response); turn 2 completes as recorded and the
  // interrupt settles as moot when the session ends.
  suite('interrupt-same-write', {
    main: declare(
      {
        turns: ['<uuid-1> completed', '<uuid-8> completed'],
        controls: ['int_2 ok'],
        diagnostics: ['control.unknown-response'],
      },
      INTERRUPT,
    ),
  }),
  // No turn: the harness is idle, so close ends stdin at once.
  suite('eof-idle', { main: declare({}, SAME) }),
  // close while a reply streams, then while a tool runs: the turn finishes.
  suite('eof-midstream', { main: ONE_TURN }),
  suite('eof-midtool', { main: ONE_TURN }),
  // Same session id in system/init: no id mismatch.
  resumed('resume'),
  // An error result before the initialize response with num_turns 0 under
  // resume (J7): SESSION_NOT_FOUND, the ladder starts. On Windows the
  // recorder's EOF came after the exit.
  suite('resume-not-found', {
    main: declare(
      {
        handshake: 'SESSION_NOT_FOUND',
        ladder: ['handshake-failed'],
        session: 'failed SESSION_NOT_FOUND',
      },
      SAME,
    ),
  }),
  // A new session id chosen by the CLI (fork) and given by --session-id.
  resumed('fork'),
  resumed('fork-session-id'),
  // K10 triggers: the authentication_failed assistant (no retry) and the
  // first api_retry (retries); ANTHROPIC_API_KEY.
  suite('auth-401-no-retry', { main: FAIL_FAST }),
  suite('auth-401-retries', { main: FAIL_FAST }),
  // 529 is no auth failure: the error result settles the turn as an error.
  suite('overloaded-529', { main: declare({ turns: ['send-1 error'] }, NO_IDLE) }),
  suite('max-turns', { main: declare({ turns: ['send-1 max-turns'] }, NO_IDLE) }),
  // After EOF the CLI runs a turn of its own when the background shell
  // completes: a harness turn bg-1 (07 §7).
  suite('bg-shell-turn-after-eof', {
    main: declare({ turns: ['send-1 completed', 'bg-1 completed'] }, NO_IDLE),
  }),
  // The one recording with session_state_changed: close drains at once (stdin.end pairs).
  suite('session-state-events', { main: declare({ turns: ['send-1 completed'] }, SAME) }),
  // Frames of about 5 MB each, below the 64 MiB cap: one turn.
  suite('big-frame-5mb', { main: ONE_TURN }, { compressed: true }),
  suite('utf8-arabic', {
    main: declare({ turns: ['send-1 completed', 'send-2 completed'] }, NO_IDLE),
  }),
  // BOM and CRLF on stdin are the recorder's; hudhud writes plain LF lines
  // and no blank line.
  suite('crlf-bom', {
    main: declare(
      { turns: ['send-1 completed'] },
      { recorded: ['blank line', 'stdin.end'], machine: [] },
    ),
  }),
  // Addition (W3-Z, K10): the auth token as the credential; fail-fast names it.
  suite('auth-token-source', { main: FAIL_FAST }, { source: 'plan §4.3 as built (W3-Z, K10)' }),
  // Addition (research 10 §3): the resumed session gets the uuid of a
  // message its transcript holds; the CLI answers command_lifecycle
  // completed only: TURN_DROPPED.
  suite(
    'resume-duplicate-uuid',
    {
      setup: declare({ turns: ['<uuid-2> completed'] }, NO_IDLE),
      main: declare(
        { turns: ['<uuid-2> fail TURN_DROPPED'], diagnostics: ['turn.dropped'] },
        NO_IDLE,
      ),
    },
    {
      source: 'plan §4.3 as built (macOS gate round 2, research 10 §3)',
      platforms: ['linux'],
      cases: SETUP_MAIN,
    },
  ),
];
