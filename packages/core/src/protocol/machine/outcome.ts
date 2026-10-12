/**
 * Termination intent and exit-code semantics (ADR-0008 "Termination intent
 * and exit-code semantics", plan §3.3).
 *
 * @remarks
 * Harness-neutral: the classification uses only the intent hudhud recorded
 * before it signalled anything, the OS exit facts, whether a turn was still
 * open and whether the last harness result was an error. An exit code never
 * proves success (exit 0 is also what a Windows job close and a POSIX
 * terminal Ctrl+C produce, 05 §9, 07 §2). hudhud installs no signal handlers
 * (K22), so it never records an intent for a signal it did not send.
 *
 * @packageDocumentation
 */

/**
 * Why hudhud ended the process, recorded before any signal or job
 * termination. `none` means hudhud did not end it.
 *
 * @public
 */
export type TerminationIntent =
  | 'none'
  | 'close'
  | 'close-timeout'
  | 'abort'
  | 'dispose'
  | 'watchdog'
  | 'auth-fail-fast'
  | 'oversized-frame'
  | 'handshake-failed';

/**
 * Every termination intent, in declaration order.
 *
 * @public
 */
export const TERMINATION_INTENTS: readonly TerminationIntent[] = [
  'none',
  'close',
  'close-timeout',
  'abort',
  'dispose',
  'watchdog',
  'auth-fail-fast',
  'oversized-frame',
  'handshake-failed',
];

/**
 * How the process ended, as the OS reported it.
 *
 * @public
 */
export interface ExitObservation {
  readonly code: number | null;
  readonly signal: string | null;
}

/**
 * How a session ended.
 *
 * @public
 */
export type SessionOutcome =
  'closed' | 'aborted' | 'failed' | 'crashed' | 'killed-externally' | 'unknown';

/**
 * The input of {@link classifyExit}.
 *
 * @public
 */
export interface ClassifyExitInput {
  readonly intent: TerminationIntent;
  readonly exit: ExitObservation;
  /** Whether the last result the harness reported was an error result. */
  readonly lastResultIsError?: boolean;
  /** Whether a turn was open (started, no result yet) when the process exited. */
  readonly turnActive: boolean;
  readonly platform: 'win32' | 'posix';
}

/**
 * The error a session ends with, per the "Error" column of plan §3.3.
 *
 * - `none`: the session ends without an error.
 * - `recorded`: the error the machine recorded together with the intent (for
 *   `watchdog` and `handshake-failed`: the handshake error).
 * - an error code: the machine builds an error with that code.
 *
 * @public
 */
export type ExitError =
  'none' | 'recorded' | 'PROCESS_EXITED' | 'AUTHENTICATION_FAILED' | 'OVERSIZED_FRAME';

/**
 * The result of {@link classifyExit}.
 *
 * @public
 */
export interface ExitClassification {
  readonly outcome: SessionOutcome;
  /**
   * How the open turn ends: synthesized `cancelled` or `error` result, or
   * `none` when no turn was open (or its result already arrived).
   */
  readonly turnSynthesis: 'cancelled' | 'error' | 'none';
  readonly error: ExitError;
}

/**
 * The exit code Windows reports for a process that ended with `-1`, seen
 * under VS Code on native Windows (01 §3). Always `unknown`.
 *
 * @public
 */
export const UNKNOWN_EXIT_CODE = 4294967295;

/** 128 + SIGTERM and 128 + SIGHUP: the POSIX shell form of a signal exit. */
const POSIX_SIGNAL_EXIT_CODES: ReadonlySet<number> = new Set([143, 129]);

/** Intents for which the application asked the session to end. */
const REQUESTED_INTENTS: ReadonlySet<TerminationIntent> = new Set([
  'close',
  'close-timeout',
  'abort',
  'dispose',
]);

/**
 * Classifies a process exit (plan §3.3). Rules apply top to bottom; the
 * function is total over every intent and exit observation.
 *
 * @remarks
 * Interpretations of the table, all in the direction of "a turn never stays
 * open":
 *
 * - `turnSynthesis` is `none` whenever no turn was open; a turn whose result
 *   already arrived is not open.
 * - `close` that does not match its own row (a turn still open, a code other
 *   than 0 or 1, a signal) is classified by the `none` rows: hudhud asked for
 *   a graceful end, so anything else is not hudhud's doing.
 * - `none`, code 1 after an error result, with a turn still open: the code
 *   agrees with the last result but the open turn got none, which is the
 *   same evidence as code 0 with an open turn, hence `unknown`.
 * - `watchdog` and `handshake-failed` normally have no open turn ("n/a");
 *   if one is open it ends as `error` so it still settles.
 * - Codes 143 and 129 count as signal exits on POSIX only; on Windows a
 *   foreign `TerminateProcess` reports a `signal` and these codes are
 *   ordinary exit codes.
 *
 * @public
 */
export function classifyExit(input: ClassifyExitInput): ExitClassification {
  const { intent, exit, turnActive } = input;
  const failTurn = turnActive ? 'error' : 'none';
  const cancelTurn = turnActive ? 'cancelled' : 'none';

  if (exit.code === UNKNOWN_EXIT_CODE) {
    return {
      outcome: 'unknown',
      turnSynthesis: failTurn,
      error: REQUESTED_INTENTS.has(intent) ? 'none' : 'PROCESS_EXITED',
    };
  }
  switch (intent) {
    case 'abort':
    case 'dispose':
    case 'close-timeout':
      return { outcome: 'aborted', turnSynthesis: cancelTurn, error: 'none' };
    case 'watchdog':
    case 'handshake-failed':
      return { outcome: 'failed', turnSynthesis: failTurn, error: 'recorded' };
    case 'auth-fail-fast':
      return { outcome: 'failed', turnSynthesis: failTurn, error: 'AUTHENTICATION_FAILED' };
    case 'oversized-frame':
      return { outcome: 'failed', turnSynthesis: failTurn, error: 'OVERSIZED_FRAME' };
    case 'close':
      if (!turnActive && exit.signal === null && (exit.code === 0 || exit.code === 1)) {
        return { outcome: 'closed', turnSynthesis: 'none', error: 'none' };
      }
      return classifyUnrequested(input);
    case 'none':
      return classifyUnrequested(input);
  }
}

/** The `none` rows of plan §3.3: hudhud did not end the process. */
function classifyUnrequested(input: ClassifyExitInput): ExitClassification {
  const { exit, turnActive, platform } = input;
  const lastResultIsError = input.lastResultIsError === true;
  if (exit.signal === null) {
    // The code the harness exits with when it ends on its own after its last result.
    const agrees = exit.code === (lastResultIsError ? 1 : 0);
    if (!turnActive && agrees) {
      return { outcome: 'closed', turnSynthesis: 'none', error: 'none' };
    }
    if (turnActive && (agrees || exit.code === 0)) {
      return { outcome: 'unknown', turnSynthesis: 'error', error: 'PROCESS_EXITED' };
    }
  }
  const failTurn = turnActive ? 'error' : 'none';
  if (
    exit.signal !== null ||
    (platform === 'posix' && exit.code !== null && POSIX_SIGNAL_EXIT_CODES.has(exit.code))
  ) {
    return { outcome: 'killed-externally', turnSynthesis: failTurn, error: 'PROCESS_EXITED' };
  }
  return { outcome: 'crashed', turnSynthesis: failTurn, error: 'PROCESS_EXITED' };
}
