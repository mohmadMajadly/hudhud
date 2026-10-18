/**
 * The Claude Code protocol machines (plan §1.5, K3): the composed session
 * machine on the neutral contract and the constants its binding needs.
 *
 * @remarks
 * Internal to the adapter: the session factory drives
 * {@link claudeSessionMachine}; the conformance suites reach it through a
 * test-only import. The sub-machines (`control.ts`, `permission.ts`,
 * `turn.ts`) are composed by the session machine and are not part of this
 * entry.
 *
 * @packageDocumentation
 */

export type {
  ClaudeSessionConfig,
  ClaudeSessionPhase,
  ClaudeSessionState,
  KnownBrokenListing,
} from './session.js';
export {
  ABORT_INTERRUPT_CORRELATION,
  ANSWER_FAILED_DENY_MESSAGE,
  CLOSE_TIMER,
  DEFAULT_AUTH_FAIL_FAST_SOURCES,
  DUPLICATE_REQUEST_DENY_MESSAGE,
  FIRST_FRAME_TIMER,
  IDLE_TIMER,
  MAX_REMEMBERED_PERMISSION_IDS,
  NO_HANDLER_ERROR,
  claudeSessionMachine,
  inboundAnswerOf,
  initialSessionState,
  sessionLockKey,
  stepSession,
} from './session.js';
