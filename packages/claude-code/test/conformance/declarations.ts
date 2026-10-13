// The declared outcome of every suite of the catalogue (see `catalogue.ts`).
// Each entry says what the scenario must show through the session machine
// and why; the expect files hold the exact effects and events behind it.
//
// Every recording is launched as hudhud launches it (single-source launch,
// W4-T2), so the CLI reports `session_state_changed` (`running`, `idle`)
// in every case. The recorder's EOF therefore always has its machine
// counterpart: on close the machine ends stdin once the harness is idle
// and nothing runs (the graceful drain, K13), and both writes pair. The
// one exception is `interrupt-same-write` (see there).
//
// hudhud writes `interrupt` with an explicit `cancel_queued` (the strict
// outbound schema); the recorder wrote it bare when false. Same request.
// Turns are named `turn-<k>` in the order they first appear (`summary.ts`).

import type { CaseDeclaration, SuiteDeclaration, WriteDifferences } from './catalogue.js';
import type { ReplaySummary } from './summary.js';

const BOTH = ['linux', 'win32'] as const;
const MAIN = ['main'] as const;
const SETUP_MAIN = ['setup', 'main'] as const;

/** Every write pairs, the recorder's EOF with the machine's graceful stdin end included. */
const SAME: WriteDifferences = { recorded: [], machine: [] };
/** A recorded bare `interrupt`, written by hudhud with `cancel_queued: false`. */
const INTERRUPT: WriteDifferences = {
  recorded: ['interrupt'],
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

function declare(
  summaryFields: Partial<ReplaySummary>,
  writes: WriteDifferences = SAME,
): CaseDeclaration {
  return { summary: summary(summaryFields), writes };
}

/** One turn, completed; closed gracefully. */
const ONE_TURN = declare({ turns: ['turn-1 completed'] });

/** A K10 fail-fast: the turn fails, the session is poisoned, the ladder starts, stdin ends at once. */
const FAIL_FAST = declare({
  turns: ['turn-1 fail AUTHENTICATION_FAILED'],
  ladder: ['auth-fail-fast'],
  session: 'failed AUTHENTICATION_FAILED',
});

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
  // initialize, one text turn, EOF: the graceful close.
  suite('handshake', { main: ONE_TURN }),
  // A user-message uuid: the turn id is the recorded uuid (command_lifecycle).
  suite('text-turn', { main: ONE_TURN }),
  suite('two-turns', { main: declare({ turns: ['turn-1 completed', 'turn-2 completed'] }) }),
  // Stream events become message deltas; one turn.
  suite('partial-messages', { main: ONE_TURN }),
  // An auto-allowed read-only Bash call: no permission request.
  suite('tool-bash', { main: ONE_TURN }),
  // The application allows with updatedInput: the same answer as the recording.
  suite('permission-allow', {
    main: declare({ turns: ['turn-1 completed'], permissions: ['allow by application'] }),
  }),
  suite('permission-deny', {
    main: declare({ turns: ['turn-1 completed'], permissions: ['deny by application'] }),
  }),
  // deny with interrupt: the CLI aborts the turn (error_during_execution, aborted).
  suite('permission-deny-interrupt', {
    main: declare({ turns: ['turn-1 cancelled'], permissions: ['deny by application'] }),
  }),
  // hudhud never answers a permission request with a control error: the
  // recorded error answer replays as the application withdrawing the ask,
  // which writes the fixed non-interrupting deny (fail closed); the turn
  // goes on as recorded.
  suite('permission-error-response', {
    main: declare(
      { turns: ['turn-1 completed'], permissions: ['cancelled by application'] },
      {
        recorded: ['error {"error":"host failed"}'],
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
        turns: ['turn-1 cancelled'],
        permissions: ['cancelled by harness'],
        controls: ['int_1 ok'],
      },
      INTERRUPT,
    ),
  }),
  // close with a pending ask (K12): the ask is cancelled by close and the
  // closing deny is written, where the recorder only sent EOF; the drain
  // then ends stdin once the CLI reports idle.
  suite('permission-eof', {
    main: declare(
      { turns: ['turn-1 completed'], permissions: ['cancelled by close'] },
      { recorded: [], machine: ['deny {"message":"hudhud session closing","interrupt":false}'] },
    ),
  }),
  // The interrupt of the streaming turn is written at once (its system/init was seen).
  suite('interrupt-midstream', {
    main: declare({ turns: ['turn-1 cancelled'], controls: ['int_1 ok'] }, INTERRUPT),
  }),
  // still_queued names the queued turn, not the target: no retry; the queued turn runs next.
  suite('interrupt-queued', {
    main: declare(
      { turns: ['turn-1 cancelled', 'turn-2 completed'], controls: ['int_1 ok'] },
      INTERRUPT,
    ),
  }),
  // cancel_queued: the response's cancelled list settles the queued turn
  // (synthesized) before the target's own result.
  suite('interrupt-cancel-queued', {
    main: declare({
      turns: ['turn-2 cancelled synthesized', 'turn-1 cancelled'],
      controls: ['int_1 ok'],
    }),
  }),
  // GH#98713: the interrupt sent in the user frame's write is held until
  // turn 2's system/init and written there (see the expect file), never in
  // the step of the user write. The recorded answer to the recorder's
  // immediate interrupt names a request hudhud never sent
  // (control.unknown-response), and the recording has no answer to the
  // held one: the request stays pending, so the drain (which waits for
  // every control request) does not end stdin before the recorded exit,
  // where the moot interrupt settles. A replay artifact: the CLI answers an
  // interrupt it receives (interrupt-midstream, interrupt-queued); the
  // evidence is asserted in interrupt-same-write.test.ts (W4-Z ruling 8).
  suite('interrupt-same-write', {
    main: declare(
      {
        turns: ['turn-1 completed', 'turn-2 completed'],
        controls: ['int_2 ok'],
        diagnostics: ['control.unknown-response'],
      },
      { recorded: ['interrupt', 'stdin.end'], machine: ['interrupt {"cancel_queued":false}'] },
    ),
  }),
  // No turn: the harness is idle, so close ends stdin at once.
  suite('eof-idle', { main: declare({}) }),
  // close while a reply streams, then while a tool runs: the turn finishes,
  // then the drain ends stdin on the CLI's idle.
  suite('eof-midstream', { main: ONE_TURN }),
  suite('eof-midtool', { main: ONE_TURN }),
  // Same session id in system/init: no id mismatch.
  resumed('resume'),
  // An error result before the initialize response with num_turns 0 under
  // resume (J7): SESSION_NOT_FOUND, the ladder starts.
  suite('resume-not-found', {
    main: declare({
      handshake: 'SESSION_NOT_FOUND',
      ladder: ['handshake-failed'],
      session: 'failed SESSION_NOT_FOUND',
    }),
  }),
  // A hudhud fork always names the new session id (the same launch for both suites).
  resumed('fork'),
  resumed('fork-session-id'),
  // K10 triggers: the authentication_failed assistant (no retry) and the
  // first api_retry (retries); ANTHROPIC_API_KEY.
  suite('auth-401-no-retry', { main: FAIL_FAST }),
  suite('auth-401-retries', { main: FAIL_FAST }),
  // 529 is no auth failure: the error result settles the turn as an error.
  suite('overloaded-529', { main: declare({ turns: ['turn-1 error'] }) }),
  suite('max-turns', { main: declare({ turns: ['turn-1 max-turns'] }) }),
  // After EOF the CLI runs a turn of its own when the background shell
  // completes: a harness turn bg-1 (07 §7).
  suite('bg-shell-turn-after-eof', {
    main: declare({ turns: ['turn-1 completed', 'bg-1 completed'] }),
  }),
  suite('session-state-events', { main: ONE_TURN }),
  // Frames of about 5 MB each, below the 64 MiB cap: one turn.
  suite('big-frame-5mb', { main: ONE_TURN }, { compressed: true }),
  suite('utf8-arabic', { main: declare({ turns: ['turn-1 completed', 'turn-2 completed'] }) }),
  // BOM and CRLF on stdin are the recorder's; hudhud writes plain LF lines
  // and no blank line.
  suite('crlf-bom', {
    main: declare({ turns: ['turn-1 completed'] }, { recorded: ['blank line'], machine: [] }),
  }),
  // Addition (W3-Z, K10): the auth token as the credential; fail-fast names it.
  suite('auth-token-source', { main: FAIL_FAST }, { source: 'plan §4.3 as built (W3-Z, K10)' }),
  // Addition (research 10 §3): the resumed session gets the uuid of a
  // message its transcript holds; the CLI answers command_lifecycle
  // completed only, then session_state_changed idle: TURN_DROPPED, and the
  // close drains at once (finding 2 of W4-T2, resolved by the recording).
  suite(
    'resume-duplicate-uuid',
    {
      setup: ONE_TURN,
      main: declare({ turns: ['turn-1 fail TURN_DROPPED'], diagnostics: ['turn.dropped'] }),
    },
    {
      source: 'plan §4.3 as built (macOS gate round 2, research 10 §3)',
      cases: SETUP_MAIN,
    },
  ),
];
