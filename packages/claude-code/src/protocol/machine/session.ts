/**
 * The composed Claude Code session machine on the neutral contract (plan
 * §1.5, ADR-0006, ADR-0007, ADR-0008, ADR-0012, K3).
 *
 * @remarks
 * Sans-IO: `step` is a pure function of a JSON state and one input; the
 * clock arrives with every input, every UUID arrives from the binding (the
 * session id in the config, turn ids in `cmd.send`), and the only ids this
 * machine makes are deterministic (`hudhud_<n>` control request ids, `bg-<n>`
 * harness turns, `int-<n>` interrupts). It composes four pure parts:
 *
 * - the control correlator (`control.ts`): every control request and answer;
 * - the permission machine (`permission.ts`): the `can_use_tool` lifecycle;
 * - the turn machine (`turn.ts`): turns, interrupt gating and turn results;
 * - the event normalizer (`../events/normalize.ts`): conversation frames.
 *
 * Each event has exactly one owner: the turn machine builds `turn.queued`,
 * `turn.started` and `turn.completed`; the permission machine
 * `permission.requested` and `permission.resolved`; the normalizer every
 * frame event; this machine `session.started`, `stalled`, `session.terminated`
 * and its own diagnostics. Event `seq` starts at 1: `seq` 0 is the `compat`
 * event the binding replays first (K20).
 *
 * Stdin authority (ADR-0012 §8): this machine writes only frames it builds
 * itself (`initialize`, user messages, `interrupt`, `set_permission_mode`,
 * permission answers, control error answers), each through the strict
 * outbound schema. There is no raw path: the raw tier (plan §2.6) never goes
 * through this machine. Inbound data never produces an outbound request.
 *
 * Permissions fail closed: a request is allowed only by a valid application
 * decision; a missing handler, an invalid decision, a failed handler and an
 * answer that cannot be encoded all write a non-interrupting deny. On drain
 * pending requests get the closing deny; on abort nothing is written (K12).
 *
 * @packageDocumentation
 */

import {
  classifyExit,
  makeErrorData,
  ownArray,
  ownNumber,
  ownObject,
  ownString,
  parseJsonLine,
  type ErrorData,
  type HarnessMachine,
  type ExitError,
  type ExitObservation,
  type HudhudEvent,
  type JsonObject,
  type JsonValue,
  type MachineEffect,
  type MachineInput,
  type MachineStep,
  type PermissionRequestData,
  type SessionInfoData,
  type SessionOutcome,
  type TerminationIntent,
} from '@hudhud/core/protocol';

import { classifyResult, normalizeFrame } from '../events/normalize.js';
import { classifyInbound } from '../wire/inbound.js';
import { encodeOutboundFrame, userMessage } from '../wire/outbound.js';
import type {
  ControlErrorResponseFrame,
  InitializeBody,
  PermissionDecisionWire,
  PermissionModeWire,
  PermissionResponseFrame,
  UserContentBlockWire,
  UserContentWire,
} from '../wire/types.js';
import {
  answerInbound,
  closeControl,
  controlTimerFired,
  initialControlState,
  receiveControlFrame,
  sendControlRequest,
  type ControlConfig,
  type ControlEffect,
  type ControlState,
  type InboundAnswer,
  type OutboundRequest,
} from './control.js';
import {
  initialPermissionState,
  stepPermission,
  type PermissionAskData,
  type PermissionEffect,
  type PermissionInput,
  type PermissionMachineState,
} from './permission.js';
import {
  INTERRUPT_RETRY_TIMER_PREFIX,
  initialTurnState,
  sendIdRefused,
  turnStep,
  type TurnEffect,
  type TurnInput,
  type TurnMachineState,
} from './turn.js';

// ---- configuration and state ---------------------------------------------------

/**
 * Configuration of one Claude Code session (plan §1.5). Plain JSON.
 *
 * @internal
 */
export interface ClaudeSessionConfig {
  readonly mode: 'create' | 'resume' | 'fork';
  /**
   * The id the first `system/init.session_id` must carry: the `--session-id`
   * of `create`, the resumed id of `resume`, the hudhud-chosen new id of
   * `fork`. Also the key of the per-Harness live-session lock (J6, see
   * {@link sessionLockKey}).
   */
  readonly sessionId: string;
  /** `fork` only: the session the fork was made from (`SessionInfo.forkedFrom`). */
  readonly forkedFrom?: string;
  /** First-frame watchdog, armed on the `initialize` write. Default 60000. */
  readonly firstFrameTimeoutMs: number;
  /** Silence while a turn is queued or running before `stalled`. Default 300000. */
  readonly idleStallMs: number;
  /** The single drain deadline, measured from `cmd.close` (K13). Default 30000. */
  readonly closeTimeoutMs: number;
  /** How long abort waits for the `interrupt` answer before ending stdin. Default 1000. */
  readonly interruptWaitMs: number;
  /** Outbound line cap in bytes (ADR-0011 §7). Default 33554432. */
  readonly maxOutboundBytes: number;
  readonly onOversizedFrame: 'fail' | 'skip';
  readonly onAuthFailure: 'fail-fast' | 'harness-retry';
  /**
   * Credential sources fail-fast applies to, matched against `apiKeySource`
   * and `tokenSource` of the `initialize` response:
   * {@link DEFAULT_AUTH_FAIL_FAST_SOURCES} (K10 as decided after the
   * `auth-token-source` fixture).
   */
  readonly authFailFastSources: readonly string[];
  /** Whether the application registered a permission handler. */
  readonly permissionHandler: boolean;
  /** `dangerouslyAllowConfigWrites` (ADR-0012 §3). */
  readonly allowConfigWrites: boolean;
  /**
   * `dangerouslyAllowBypassPermissions`: `set_permission_mode` to
   * `bypassPermissions` is refused without it (K11, ruling F2). Defence in
   * depth: the binding refuses it too.
   */
  readonly allowBypassPermissions: boolean;
  readonly platform: 'win32' | 'posix';
  /** `{}` in v1 (ADR-0015 provenance ruling); nothing of it is written. */
  readonly initialize: InitializeBody;
}

/**
 * The lifecycle phase (plan §1.5): `created -> handshaking -> ready ->
 * draining -> terminating -> ended`, plus `failed` (a fatal error was
 * recorded and the ladder runs). Derived from the other fields; informative.
 *
 * @internal
 */
export type ClaudeSessionPhase =
  'created' | 'handshaking' | 'ready' | 'draining' | 'terminating' | 'failed' | 'ended';

/**
 * State of the session machine. Plain JSON.
 *
 * @internal
 */
export interface ClaudeSessionState {
  readonly config: ClaudeSessionConfig;
  readonly phase: ClaudeSessionPhase;
  readonly ended: boolean;
  readonly handshake: 'pending' | 'ok' | 'failed';
  /** Recorded before any ladder starts (ADR-0008 E8). */
  readonly intent: TerminationIntent;
  /** The error a fatal condition recorded (handshake, auth, oversized, identity). */
  readonly failure: ErrorData | null;
  /** Auth fail-fast fired: later commands fail `SESSION_POISONED` (K10). */
  readonly poisoned: boolean;
  /** `seq` of the next event. */
  readonly seq: number;
  /** `process.started` arrived. */
  readonly started: boolean;
  /** The spawned pid, from `process.started` (0 before it). */
  readonly pid: number;
  readonly stdinOpen: boolean;
  /** Lines written before the handshake completed, flushed after it (02 §4.1). */
  readonly outbox: readonly string[];
  /** Every timer this machine armed and has not cleared or seen fire. */
  readonly timers: readonly string[];
  /** When the `idle` timer was last armed. */
  readonly idleArmedAtMs: number;
  /** `stalled` was emitted for the current silence period. */
  readonly stalled: boolean;
  /** The harness reported (or is presumed) idle: no user message since its last `idle`. */
  readonly harnessIdle: boolean;
  /** `account.apiKeySource` of the `initialize` response. */
  readonly apiKeySource: string | null;
  /** `account.tokenSource` of the `initialize` response (`ANTHROPIC_AUTH_TOKEN` for the auth token). */
  readonly tokenSource: string | null;
  /** The first `system/init.session_id` (J6), `null` until one arrives. */
  readonly observedSessionId: string | null;
  /** Whether the last observed `result` frame was an error result. */
  readonly lastResultIsError: boolean | null;
  /**
   * Every `can_use_tool` request id this session has seen. The binding keys
   * permission handlers by request id, so a reused id is never asked again
   * (W3-Z ruling 7). Grows by one short id per permission request.
   */
  readonly permissionRequestIds: readonly string[];
  readonly control: ControlState;
  readonly permission: PermissionMachineState;
  readonly turns: TurnMachineState;
}

// ---- constants -------------------------------------------------------------------

/** First-frame watchdog timer, armed on the `initialize` write. @internal */
export const FIRST_FRAME_TIMER = 'first-frame';
/** Idle (stalled) watchdog timer. @internal */
export const IDLE_TIMER = 'idle';
/** Drain deadline timer, armed at `cmd.close` (K13). @internal */
export const CLOSE_TIMER = 'close';

/**
 * Correlation of the `control.settle` that reports the answer to the
 * `interrupt{cancel_queued:true}` written by abort, dispose or close-timeout.
 * The binding's ladder interrupt hook resolves on it (plan §1.7): `ok: true`
 * when the CLI acknowledged, `ok: false` when it refused or when
 * `interruptWaitMs` passed (the request's correlator timeout plays the
 * `interrupt-wait` timer of plan §1.5). Either way `stdin.end` follows in the
 * same step. Binding correlations never use the `hudhud:` prefix.
 *
 * @internal
 */
export const ABORT_INTERRUPT_CORRELATION = 'hudhud:abort-interrupt';

/**
 * Default of `authFailFastSources` (K10, lead decision after the
 * `auth-token-source` fixture): the two static env credentials.
 *
 * @internal
 */
export const DEFAULT_AUTH_FAIL_FAST_SOURCES: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

/** The deny written when no permission handler is registered (fail closed). @internal */
export const NO_HANDLER_ERROR = 'no permission handler is registered';

/** The deny written when an answer could not be encoded (fail closed). @internal */
export const ANSWER_FAILED_DENY_MESSAGE = 'hudhud: permission answer could not be sent';

/** The deny written for a permission request that reuses an earlier id (fail closed). @internal */
export const DUPLICATE_REQUEST_DENY_MESSAGE = 'hudhud: permission request id reused';

/** Permission modes hudhud may set (K11). */
const PERMISSION_MODES: readonly PermissionModeWire[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'auto',
  'bypassPermissions',
];

const IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const INIT_CORRELATION = 'hudhud:initialize';
const TURN_PREFIX = 'turn:';
const APP_PREFIX = 'app:';
const AUTH_FAILED = 'authentication_failed';
/** Longest untrusted string copied into an error or diagnostic. */
const MAX_ECHO = 128;

// ---- public helpers ------------------------------------------------------------

/**
 * The key the per-Harness live-session registry locks for this session (J6):
 * the id the session runs under. A `system/init` reporting another id emits
 * `session.id-mismatch` with both ids, so the registry can lock the observed
 * id too ({@link ClaudeSessionState.observedSessionId}).
 *
 * @internal
 */
export function sessionLockKey(config: ClaudeSessionConfig): string {
  return config.sessionId;
}

/**
 * The initial state.
 *
 * @internal
 */
export function initialSessionState(config: ClaudeSessionConfig): ClaudeSessionState {
  return {
    config,
    phase: 'created',
    ended: false,
    handshake: 'pending',
    intent: 'none',
    failure: null,
    poisoned: false,
    seq: 1,
    started: false,
    pid: 0,
    stdinOpen: true,
    outbox: [],
    timers: [],
    idleArmedAtMs: 0,
    stalled: false,
    harnessIdle: true,
    apiKeySource: null,
    tokenSource: null,
    observedSessionId: null,
    lastResultIsError: null,
    permissionRequestIds: [],
    control: initialControlState(),
    permission: initialPermissionState({
      dangerouslyAllowConfigWrites: config.allowConfigWrites,
    }),
    turns: initialTurnState({ sessionId: config.sessionId }),
  };
}

// ---- draft -------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type WithoutBase<E> = E extends unknown ? Omit<E, 'seq' | 'ts' | 'sessionId'> : never;

/** An event before `seq`, `ts` and `sessionId` are assigned. */
type EventFields = WithoutBase<HudhudEvent>;

function cap(text: string): string {
  return text.length > MAX_ECHO ? `${text.slice(0, MAX_ECHO)}…` : text;
}

function strings(values: readonly JsonValue[] | undefined): string[] {
  return (values ?? []).filter((item): item is string => typeof item === 'string');
}

/** One step's mutable working copy. */
class Draft {
  readonly s: Mutable<ClaudeSessionState>;
  readonly effects: MachineEffect[] = [];
  readonly atMs: number;
  readonly at: string;
  /** The encoded user frame of the `cmd.send` being processed. */
  pendingUser = '';
  /** The frame being processed, for `raw` of `session.started`. */
  frame: JsonObject = {};
  /** Permission answers that fell back to a deny in this step. */
  readonly denied: string[] = [];
  /** Set while abort writes its `interrupt`, which gets the `interruptWaitMs` timeout. */
  abortInterrupt = false;

  constructor(state: ClaudeSessionState, atMs: number, at: string) {
    this.s = { ...state };
    this.atMs = atMs;
    this.at = at;
  }

  get config(): ClaudeSessionConfig {
    return this.s.config;
  }

  commit(): MachineStep<ClaudeSessionState> {
    this.s.phase = phaseOf(this.s);
    return { state: this.s, effects: this.effects };
  }

  // -- primitive effects ---------------------------------------------------------

  emit(effect: MachineEffect): void {
    this.effects.push(effect);
  }

  event(fields: EventFields): void {
    this.effects.push({
      type: 'event',
      event: { ...fields, seq: this.s.seq, ts: this.at, sessionId: this.config.sessionId },
    });
    this.s.seq += 1;
  }

  diagnostic(code: string, message: string, data: JsonObject): void {
    this.event({ type: 'diagnostic', code, message, data });
  }

  /** Writes a line now, or holds it until the handshake completes. Nothing after stdin ended. */
  write(line: string, direct = false): void {
    if (!this.s.stdinOpen) return;
    if (!direct && this.s.handshake !== 'ok') {
      this.s.outbox = [...this.s.outbox, line];
      return;
    }
    this.emit({ type: 'write', line });
  }

  setTimer(name: string, ms: number): void {
    this.clearTimer(name);
    this.s.timers = [...this.s.timers, name];
    this.emit({ type: 'timer.set', name, ms });
  }

  clearTimer(name: string): void {
    if (!this.s.timers.includes(name)) return;
    this.s.timers = this.s.timers.filter((other) => other !== name);
    this.emit({ type: 'timer.clear', name });
  }

  endStdin(): void {
    if (!this.s.stdinOpen) return;
    this.emit({ type: 'stdin.end' });
    this.stdinGone();
  }

  /** Stdin can take no more writes (ended by hudhud or broken). */
  stdinGone(): void {
    this.s.stdinOpen = false;
    this.s.outbox = [];
    this.feedTurn({ type: 'stdin.closed' });
  }

  /** The error every later command gets once the session is ending. */
  endError(): ErrorData {
    if (this.s.poisoned) {
      return makeErrorData(
        'SESSION_POISONED',
        'The session is poisoned by an authentication failure; create a new session.',
      );
    }
    return (
      this.s.failure ?? makeErrorData('SESSION_CLOSED', 'The session is closing or has ended.')
    );
  }

  /** The oldest turn that is running (not queued). */
  currentTurn(): string | undefined {
    return this.s.turns.turns.find((turn) => turn.phase !== 'queued')?.turnId;
  }

  // -- sub-machines --------------------------------------------------------------

  feedTurn(input: TurnInput): void {
    const out = turnStep(this.s.turns, input);
    this.s.turns = out.state;
    for (const effect of out.effects) this.onTurnEffect(effect);
  }

  feedPermission(input: PermissionInput, dropAsk = false): boolean {
    const out = stepPermission(this.s.permission, input);
    this.s.permission = out.state;
    let asked = false;
    for (const effect of out.effects) {
      if (effect.type === 'permission.ask') {
        asked = true;
        this.onAsk(effect.request, dropAsk);
      } else {
        this.onPermissionEffect(effect);
      }
    }
    return asked;
  }

  sendControl(request: OutboundRequest, direct = false): void {
    const out = sendControlRequest(this.s.control, controlConfig(this.config), request, this.atMs);
    this.s.control = out.state;
    this.onControlEffects(out.effects, direct);
  }

  /** Ends the correlator: pending requests settle with `error`; inbound entries are dropped. */
  closeControl(error: ErrorData): void {
    const out = closeControl(this.s.control, error);
    this.s.control = out.state;
    // The permission machine already ended its requests; inbound cancels are moot.
    this.onControlEffects(
      out.effects.filter((effect) => effect.type !== 'inbound.cancel'),
      false,
    );
  }

  // -- control effects -------------------------------------------------------------

  onControlEffects(effects: readonly ControlEffect[], direct: boolean): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'write':
          this.write(effect.line, direct);
          break;
        case 'timer.set':
          this.setTimer(effect.name, effect.ms);
          break;
        case 'timer.clear':
          this.clearTimer(effect.name);
          break;
        case 'settle':
          this.onSettle(effect);
          break;
        case 'inbound.request':
          this.onCanUseTool(effect.requestId, effect.frame);
          break;
        case 'inbound.cancel':
          // Only `can_use_tool` reaches the permission machine; never-answered kinds end here.
          if (effect.subtype === 'can_use_tool') {
            this.feedPermission({
              type: 'cli.cancel',
              requestId: effect.requestId,
              atMs: this.atMs,
            });
          }
          break;
        case 'diagnostic':
          this.diagnostic(effect.code, effect.message, effect.data);
          break;
      }
    }
  }

  onSettle(effect: Extract<ControlEffect, { type: 'settle' }>): void {
    const { correlation } = effect;
    if (correlation === INIT_CORRELATION) {
      onInitializeSettled(this, effect);
    } else if (correlation.startsWith(TURN_PREFIX)) {
      const interruptId = correlation.slice(TURN_PREFIX.length);
      this.feedTurn(
        effect.ok
          ? effect.response === undefined
            ? { type: 'interrupt.response', interruptId, ok: true }
            : { type: 'interrupt.response', interruptId, ok: true, response: effect.response }
          : { type: 'interrupt.response', interruptId, ok: false, error: cliErrorOf(effect.error) },
      );
    } else {
      const app = correlation.slice(APP_PREFIX.length);
      this.emit(
        effect.ok
          ? {
              type: 'control.settle',
              correlation: app,
              ok: true,
              response: effect.response ?? null,
            }
          : { type: 'control.settle', correlation: app, ok: false, error: effect.error },
      );
    }
  }

  // -- permissions -------------------------------------------------------------------

  onCanUseTool(requestId: string, frame: JsonObject): void {
    // An in-flight duplicate never gets here (the correlator ignores it). An
    // id reused after its request ended is never asked again: the binding
    // keys handlers by request id. Fail closed with a non-interrupting deny,
    // so the CLI is not left waiting.
    if (this.s.permission.phase !== 'aborted' && this.s.permissionRequestIds.includes(requestId)) {
      this.diagnostic(
        'permission.duplicate-request-id',
        'A permission request reused the id of an earlier request; denied without asking.',
        { requestId: cap(requestId) },
      );
      this.answer(requestId, {
        type: 'decision',
        decision: { behavior: 'deny', message: DUPLICATE_REQUEST_DENY_MESSAGE, interrupt: false },
      });
      return;
    }
    this.s.permissionRequestIds = [...this.s.permissionRequestIds, requestId];
    const turnId = this.currentTurn();
    const input: PermissionInput =
      turnId === undefined
        ? { type: 'cli.can-use-tool', requestId, frame, atMs: this.atMs }
        : { type: 'cli.can-use-tool', requestId, frame, turnId, atMs: this.atMs };
    if (this.config.permissionHandler) {
      this.feedPermission(input);
      return;
    }
    // No handler: never ask, deny at once (fail closed).
    if (this.feedPermission(input, true)) {
      this.feedPermission({
        type: 'cmd.permission-error',
        requestId,
        error: NO_HANDLER_ERROR,
        atMs: this.atMs,
      });
    }
  }

  onAsk(ask: PermissionAskData, dropAsk: boolean): void {
    const base = {
      type: 'permission.requested',
      requestId: ask.requestId,
      toolName: ask.toolName,
      toolUseId: ask.toolUseId,
      raw: ask.raw,
    } as const;
    this.event(ask.turnId === undefined ? base : { ...base, turnId: ask.turnId });
    if (dropAsk) return;
    const request: Mutable<PermissionRequestData> = {
      requestId: ask.requestId,
      sessionId: this.config.sessionId,
      toolName: ask.toolName,
      toolUseId: ask.toolUseId,
      input: ask.input,
      suggestions: ask.suggestions,
      raw: ask.raw,
    };
    if (ask.turnId !== undefined) request.turnId = ask.turnId;
    if (ask.displayName !== undefined) request.displayName = ask.displayName;
    if (ask.blockedPath !== undefined) request.blockedPath = ask.blockedPath;
    if (ask.decisionReasonType !== undefined) request.decisionReason = ask.decisionReasonType;
    if (ask.title !== undefined) request.title = ask.title;
    if (ask.description !== undefined) request.description = ask.description;
    this.emit({ type: 'permission.ask', requestId: ask.requestId, request });
  }

  onPermissionEffect(effect: Exclude<PermissionEffect, { type: 'permission.ask' }>): void {
    switch (effect.type) {
      case 'write':
        this.answer(effect.frame.response.request_id, inboundAnswerOf(effect.frame));
        break;
      case 'permission.cancel':
        this.emit({
          type: 'permission.cancel',
          requestId: effect.requestId,
          reason: effect.reason,
        });
        break;
      case 'permission.resolved': {
        const { requestId } = effect.entry;
        const behavior = this.denied.includes(requestId) ? 'deny' : effect.behavior;
        this.event({ type: 'permission.resolved', requestId, behavior, by: effect.by });
        break;
      }
      case 'diagnostic':
        this.diagnostic(effect.code, effect.message, effect.data);
        break;
    }
  }

  /** Writes an answer through the correlator; an answer that cannot be sent becomes a deny. */
  answer(requestId: string, answer: InboundAnswer): void {
    const config = controlConfig(this.config);
    const out = answerInbound(this.s.control, config, requestId, answer);
    this.s.control = out.state;
    this.onControlEffects(out.effects, false);
    if (out.outcome !== 'failed') return;
    this.diagnostic('control.answer-failed', 'A permission answer could not be encoded.', {
      requestId: cap(requestId),
      code: out.error.code,
    });
    // Fail closed: the request still waits, so it gets the fixed deny instead.
    this.denied.push(requestId);
    const deny: PermissionDecisionWire = {
      behavior: 'deny',
      message: ANSWER_FAILED_DENY_MESSAGE,
      interrupt: false,
    };
    const retry = answerInbound(this.s.control, config, requestId, {
      type: 'decision',
      decision: deny,
    });
    this.s.control = retry.state;
    this.onControlEffects(retry.effects, false);
  }

  // -- turns -------------------------------------------------------------------------

  onTurnEffect(effect: TurnEffect): void {
    switch (effect.type) {
      case 'write.user':
        // Set by the `cmd.send` that produced this effect, always in the same step.
        this.write(this.pendingUser);
        this.s.harnessIdle = false;
        break;
      case 'write.interrupt': {
        const request = {
          purpose: 'interrupt',
          cancelQueued: effect.cancelQueued,
          correlation: `${TURN_PREFIX}${effect.interruptId}`,
        } as const;
        this.sendControl(
          this.abortInterrupt ? { ...request, timeoutMs: this.config.interruptWaitMs } : request,
        );
        break;
      }
      case 'timer.set':
        this.setTimer(effect.name, effect.ms);
        break;
      case 'timer.clear':
        this.clearTimer(effect.name);
        break;
      case 'turn.queued':
        this.event({ type: 'turn.queued', turnId: effect.turnId });
        break;
      case 'turn.started': {
        this.s.harnessIdle = false;
        const base = {
          type: 'turn.started',
          turnId: effect.turnId,
          origin: effect.origin,
          features: effect.features,
          raw: effect.raw,
        } as const;
        this.event(effect.model === undefined ? base : { ...base, model: effect.model });
        break;
      }
      case 'turn.settle':
        this.emit({ type: 'turn.settle', turnId: effect.turnId, result: effect.result });
        this.event({ type: 'turn.completed', turnId: effect.turnId, result: effect.result });
        break;
      case 'turn.fail':
        this.emit({ type: 'turn.fail', turnId: effect.turnId, error: effect.error });
        break;
      case 'send.rejected':
        // Bound to the `cmd.send` of this step; a live turn with the same id
        // is never touched (W3-Z ruling 7).
        this.emit({ type: 'send.rejected', turnId: effect.turnId, error: effect.error });
        break;
      case 'interrupt.settle':
        // Answered, refused, timed out or moot: abort's interrupt step is over.
        if (effect.correlation === ABORT_INTERRUPT_CORRELATION) this.endStdin();
        this.emit(
          effect.ok
            ? { type: 'control.settle', correlation: effect.correlation, ok: true, response: null }
            : {
                type: 'control.settle',
                correlation: effect.correlation,
                ok: false,
                error: effect.error,
              },
        );
        break;
      case 'diagnostic':
        // Every turn diagnostic carries its own data; passed through as is.
        this.event(effect);
        break;
    }
  }

  // -- endings -----------------------------------------------------------------------

  /**
   * Records a fatal error (first one wins): fails the handshake or the turns,
   * cancels pending permissions without writing, settles pending control
   * requests, then (with `ladder`) ends stdin and starts the ladder.
   */
  fatal(error: ErrorData, intent: TerminationIntent, ladder: boolean): void {
    if (this.s.intent !== 'none' && this.s.intent !== 'close') return;
    this.clearTimer(CLOSE_TIMER);
    this.clearTimer(FIRST_FRAME_TIMER);
    this.s.intent = intent;
    this.s.failure = error;
    if (this.s.handshake === 'pending') {
      this.s.handshake = 'failed';
      this.emit({ type: 'handshake.fail', error });
    }
    this.s.outbox = [];
    this.feedTurn({ type: 'end', disposition: { kind: 'fail', error } });
    this.feedPermission({ type: 'cmd.abort', atMs: this.atMs });
    this.closeControl(this.endError());
    if (!ladder) return;
    this.endStdin();
    this.emit({ type: 'ladder.start', intent });
  }

  /**
   * Abort, dispose and close-timeout: interrupt with `cancel_queued` when the
   * handshake completed and stdin is open, start the ladder, cancel pending
   * permissions without writing (K12).
   */
  abortLadder(intent: 'abort' | 'dispose' | 'close-timeout'): void {
    this.clearTimer(CLOSE_TIMER);
    this.s.intent = intent;
    if (this.s.handshake === 'pending') {
      this.s.handshake = 'failed';
      this.clearTimer(FIRST_FRAME_TIMER);
      this.emit({
        type: 'handshake.fail',
        error: makeErrorData('ABORTED', 'The session was aborted before the handshake completed.'),
      });
    }
    if (this.s.handshake === 'ok' && this.s.stdinOpen) {
      // The wait for the answer is the correlator's timeout of this request.
      this.abortInterrupt = true;
      this.feedTurn({
        type: 'interrupt',
        cancelQueued: true,
        correlation: ABORT_INTERRUPT_CORRELATION,
      });
      this.abortInterrupt = false;
    } else {
      this.endStdin();
    }
    this.emit({ type: 'ladder.start', intent });
    this.feedPermission({ type: 'cmd.abort', atMs: this.atMs });
  }

  /** The process exited: classify the exit (plan §3.3) and end the session. */
  exited(exit: ExitObservation): void {
    if (this.s.handshake === 'pending') {
      this.fatal(
        handshakeFailed(
          'exited-before-response',
          'The harness exited before answering initialize.',
        ),
        'handshake-failed',
        false,
      );
    }
    const classified = classifyExit({
      intent: this.s.intent,
      exit,
      ...(this.s.lastResultIsError === null ? {} : { lastResultIsError: this.s.lastResultIsError }),
      turnActive: this.s.turns.turns.length > 0,
      platform: this.config.platform,
    });
    const error = this.exitError(classified.error, classified.outcome, exit);
    this.end(
      classified.outcome,
      error,
      exit,
      classified.turnSynthesis === 'cancelled' ? 'cancelled' : 'error',
    );
  }

  /**
   * Terminates every turn, permission and control request, clears every
   * timer and emits `session.terminated` and `session.end`.
   */
  end(
    outcome: SessionOutcome,
    error: ErrorData | undefined,
    exit: ExitObservation | null,
    synthesis: 'cancelled' | 'error',
  ): void {
    this.feedTurn({
      type: 'end',
      disposition:
        error === undefined ? { kind: 'settle', outcome: synthesis } : { kind: 'fail', error },
    });
    this.feedPermission({ type: 'cli.gone', atMs: this.atMs });
    this.closeControl(error ?? this.endError());
    const terminated: Mutable<Extract<EventFields, { type: 'session.terminated' }>> = {
      type: 'session.terminated',
      intent: this.s.intent,
      outcome,
    };
    if (exit !== null) {
      if (exit.code !== null) terminated.exitCode = exit.code;
      if (exit.signal !== null) terminated.signal = exit.signal;
    }
    this.event(terminated);
    for (const name of this.s.timers) this.emit({ type: 'timer.clear', name });
    this.s.timers = [];
    this.emit(
      error === undefined
        ? { type: 'session.end', outcome }
        : { type: 'session.end', outcome, error },
    );
    this.s.ended = true;
  }

  /** The session error of an exit (plan §3.3 "Error" column). */
  exitError(
    kind: ExitError,
    outcome: SessionOutcome,
    exit: ExitObservation,
  ): ErrorData | undefined {
    if (kind === 'none') return undefined;
    const recorded = this.s.failure;
    // `recorded`, auth and oversized intents are only ever set with their error.
    if (kind !== 'PROCESS_EXITED' && recorded !== null) return recorded;
    return makeErrorData('PROCESS_EXITED', 'The harness process ended without a hudhud intent.', {
      outcome,
      exitCode: exit.code,
      signal: exit.signal,
    });
  }
}

// ---- derived values ------------------------------------------------------------------

/**
 * The correlator answer of a frame the permission machine wants written.
 * Error answers come only from malformed requests, which the correlator
 * already refuses before they reach the permission machine.
 *
 * @internal
 */
export function inboundAnswerOf(
  frame: PermissionResponseFrame | ControlErrorResponseFrame,
): InboundAnswer {
  const { response } = frame;
  return response.subtype === 'success'
    ? { type: 'decision', decision: response.response }
    : { type: 'error', message: response.error };
}

function phaseOf(s: ClaudeSessionState): ClaudeSessionPhase {
  if (s.ended) return 'ended';
  if (s.failure !== null) return 'failed';
  if (s.intent === 'close') return 'draining';
  if (s.intent !== 'none') return 'terminating';
  if (!s.started) return 'created';
  return s.handshake === 'ok' ? 'ready' : 'handshaking';
}

function controlConfig(config: ClaudeSessionConfig): ControlConfig {
  // No raw control through the machine: the raw tier never reaches it (plan §2.6).
  return {
    maxOutboundBytes: config.maxOutboundBytes,
    allowRawControl: false,
    allowConfigWrites: config.allowConfigWrites,
  };
}

/** The CLI's own error text of a failed control request, for the turn machine. */
function cliErrorOf(error: ErrorData): string {
  const cliError = error.details === undefined ? undefined : ownString(error.details, 'cliError');
  return cliError ?? error.message;
}

function spawnError(code: string): ErrorData {
  const cause =
    code === 'ENOENT'
      ? 'enoent'
      : code === 'EACCES'
        ? 'eacces'
        : code === 'EPERM'
          ? 'eperm'
          : 'unknown';
  return makeErrorData('SPAWN_FAILED', 'The harness process could not be started.', {
    cause,
    code: cap(code),
  });
}

function handshakeFailed(cause: string, message: string, extra: JsonObject = {}): ErrorData {
  return makeErrorData('HANDSHAKE_FAILED', message, { cause, ...extra });
}

/** Checks user content against the wire shape exactly; `undefined` when it is not one. */
function asUserContent(value: JsonValue): UserContentWire | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const blocks: UserContentBlockWire[] = [];
  for (const item of value as readonly JsonValue[]) {
    const block = asContentBlock(item);
    if (block === undefined) return undefined;
    blocks.push(block);
  }
  return blocks;
}

function onlyKeys(obj: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(obj).every((key) => keys.includes(key));
}

function asContentBlock(item: JsonValue): UserContentBlockWire | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
  const block = item as JsonObject;
  const type = ownString(block, 'type');
  const text = ownString(block, 'text');
  if (type === 'text' && text !== undefined && onlyKeys(block, ['type', 'text'])) {
    return { type: 'text', text };
  }
  const source = ownObject(block, 'source');
  if (type !== 'image' || source === undefined || !onlyKeys(block, ['type', 'source'])) {
    return undefined;
  }
  const mediaType = ownString(source, 'media_type');
  const data = ownString(source, 'data');
  if (
    ownString(source, 'type') !== 'base64' ||
    mediaType === undefined ||
    !IMAGE_MEDIA_TYPES.includes(mediaType) ||
    data === undefined ||
    !onlyKeys(source, ['type', 'media_type', 'data'])
  ) {
    return undefined;
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      data,
    },
  };
}

// ---- handshake ------------------------------------------------------------------------

function onProcessStarted(d: Draft, pid: number): void {
  if (d.s.started) return;
  d.s.started = true;
  d.s.pid = pid;
  // Aborted or failed before the process ran: nothing is written.
  if (d.s.handshake === 'failed') return;
  // initialize first (ADR-0008 §2); the first-frame watchdog is armed on its write.
  d.sendControl(
    { purpose: 'initialize', body: d.config.initialize, correlation: INIT_CORRELATION },
    true,
  );
  if (d.s.handshake === 'pending') d.setTimer(FIRST_FRAME_TIMER, d.config.firstFrameTimeoutMs);
}

function onInitializeSettled(d: Draft, effect: Extract<ControlEffect, { type: 'settle' }>): void {
  if (d.s.handshake !== 'pending') return;
  if (!effect.ok) {
    const cliError = cliErrorOf(effect.error);
    d.fatal(
      effect.error.code === 'CONTROL_REQUEST_FAILED'
        ? handshakeFailed('error-response', 'The harness answered initialize with an error.', {
            cliError,
          })
        : effect.error,
      'handshake-failed',
      true,
    );
    return;
  }
  d.clearTimer(FIRST_FRAME_TIMER);
  d.s.handshake = 'ok';
  const response = effect.response ?? {};
  const pid = d.s.pid;
  const cliPid = ownNumber(response, 'pid');
  const version = ownString(response, 'claude_code_version') ?? 'unknown';
  const account = ownObject(response, 'account');
  const apiKeySource = account === undefined ? undefined : ownString(account, 'apiKeySource');
  const tokenSource = account === undefined ? undefined : ownString(account, 'tokenSource');
  const permissionMode = ownString(response, 'current_permission_mode');
  const features = strings(ownArray(response, 'capabilities'));
  d.s.apiKeySource = apiKeySource ?? null;
  d.s.tokenSource = tokenSource ?? null;
  const info: Mutable<SessionInfoData> = {
    id: d.config.sessionId,
    mode: d.config.mode,
    pid,
    version,
    features,
  };
  if (d.config.mode === 'fork' && d.config.forkedFrom !== undefined) {
    info.forkedFrom = d.config.forkedFrom;
  }
  if (cliPid !== undefined) info.cliPid = cliPid;
  if (apiKeySource !== undefined) info.apiKeySource = apiKeySource;
  if (tokenSource !== undefined) info.tokenSource = tokenSource;
  d.emit({ type: 'handshake.ok', info });
  const started: Mutable<Extract<EventFields, { type: 'session.started' }>> = {
    type: 'session.started',
    mode: d.config.mode,
    pid,
    version,
    raw: d.frame,
  };
  if (cliPid !== undefined) started.cliPid = cliPid;
  if (apiKeySource !== undefined) started.apiKeySource = apiKeySource;
  if (tokenSource !== undefined) started.tokenSource = tokenSource;
  if (permissionMode !== undefined) started.permissionMode = permissionMode;
  d.event(started);
  if (cliPid !== undefined && cliPid !== pid) {
    d.diagnostic(
      'binary.launcher-detected',
      'The harness reports a pid other than the spawned one: a launcher sits in between.',
      { spawnedPid: pid, cliPid },
    );
  }
  const outbox = d.s.outbox;
  d.s.outbox = [];
  for (const line of outbox) d.write(line);
}

/** A `result` before the `initialize` response (J7, 07 §1 a11). */
function onEarlyResult(d: Draft, frame: JsonObject): void {
  const notFound =
    d.config.mode !== 'create' &&
    ownString(frame, 'subtype') === 'error_during_execution' &&
    ownNumber(frame, 'num_turns') === 0;
  d.fatal(
    notFound
      ? makeErrorData('SESSION_NOT_FOUND', 'The harness found no session with this id.', {
          sessionId: d.config.sessionId,
        })
      : handshakeFailed(
          'result-before-response',
          'The harness ended a turn before answering initialize.',
        ),
    'handshake-failed',
    true,
  );
}

// ---- frames ---------------------------------------------------------------------------

function onLine(d: Draft, text: string, bytes: number): void {
  const parsed = parseJsonLine(text);
  if (!parsed.ok) {
    d.diagnostic('stdout.non-json-line', 'A stdout line was not a JSON object; skipped.', {
      bytes,
      reason: parsed.reason,
    });
    return;
  }
  const frame = parsed.value;
  d.frame = frame;
  const cls = classifyInbound(frame);
  const routed = receiveControlFrame(d.s.control, controlConfig(d.config), cls, d.currentTurn());
  if (routed.handled) {
    d.s.control = routed.state;
    d.onControlEffects(routed.effects, false);
    return;
  }
  if (cls.kind === 'conversation') {
    onConversation(d, frame, cls.type, cls.subtype);
    return;
  }
  // Malformed routing envelope: surfaced as data, never acted on.
  emitNormalized(d, frame);
}

function emitNormalized(d: Draft, frame: JsonObject): void {
  const turnId = d.currentTurn();
  for (const event of normalizeFrame(frame, turnId === undefined ? {} : { turnId })) {
    d.event(event);
  }
}

function onConversation(
  d: Draft,
  frame: JsonObject,
  type: string,
  subtype: string | undefined,
): void {
  if (type === 'result') {
    d.s.lastResultIsError = classifyResult(frame).isError;
    if (d.s.handshake === 'pending') {
      onEarlyResult(d, frame);
      return;
    }
  }
  if (type === 'system' && subtype === 'init') checkIdentity(d, frame);
  emitNormalized(d, frame);
  const trigger = authTrigger(frame, type, subtype);
  const credential = trigger === undefined ? null : failFastCredential(d);
  if (trigger !== undefined && credential !== null) poison(d, trigger, credential);
  if (!d.s.turns.ended) d.feedTurn({ type: 'frame', frame });
  if (type === 'system' && subtype === 'session_state_changed') {
    const state = ownString(frame, 'state');
    if (state !== undefined) d.s.harnessIdle = state === 'idle';
  }
}

/** The first `system/init.session_id` must be the expected id (J6). */
function checkIdentity(d: Draft, frame: JsonObject): void {
  if (d.s.observedSessionId !== null) return;
  const observed = ownString(frame, 'session_id');
  d.s.observedSessionId = observed ?? '';
  if (observed === d.config.sessionId) return;
  const data = {
    expected: d.config.sessionId,
    observed: observed === undefined ? null : cap(observed),
    mode: d.config.mode,
  };
  d.diagnostic(
    'session.id-mismatch',
    'The harness runs under a session id other than the expected one.',
    data,
  );
  if (d.config.mode === 'create') {
    d.fatal(
      makeErrorData('PROTOCOL_ERROR', 'The harness ignored the requested session id.', {
        reason: 'session-id-mismatch',
        ...data,
      }),
      'handshake-failed',
      true,
    );
  }
}

/** The K10 trigger a frame carries, if any; 403 is not one. */
function authTrigger(
  frame: JsonObject,
  type: string,
  subtype: string | undefined,
): 'api_retry' | 'assistant' | 'result' | undefined {
  if (type === 'system' && subtype === 'api_retry' && ownString(frame, 'error') === AUTH_FAILED) {
    return 'api_retry';
  }
  if (type === 'assistant' && ownString(frame, 'error') === AUTH_FAILED) return 'assistant';
  if (type === 'result' && ownNumber(frame, 'api_error_status') === 401) return 'result';
  return undefined;
}

/**
 * The static credential fail-fast applies to, or `null` (K10): the
 * `apiKeySource` or the `tokenSource` of the `initialize` response when it
 * is one of `authFailFastSources`. A static env credential that got a 401
 * does not succeed on retry. OAuth (`apiKeySource` `none` with no listed
 * token source) and `apiKeyHelper` can refresh, so they are not listed.
 */
function failFastCredential(d: Draft): string | null {
  if (d.config.onAuthFailure !== 'fail-fast') return null;
  for (const source of [d.s.apiKeySource, d.s.tokenSource]) {
    if (source !== null && d.config.authFailFastSources.includes(source)) return source;
  }
  return null;
}

function poison(d: Draft, trigger: string, credential: string): void {
  if (d.s.intent !== 'none' && d.s.intent !== 'close') return;
  d.s.poisoned = true;
  d.fatal(
    makeErrorData(
      'AUTHENTICATION_FAILED',
      `The harness reported an authentication failure for ${credential}; the session is poisoned. Create a new session.`,
      {
        trigger,
        credentialSource: credential,
        apiKeySource: d.s.apiKeySource,
        tokenSource: d.s.tokenSource,
      },
    ),
    'auth-fail-fast',
    true,
  );
}

// ---- commands -------------------------------------------------------------------------

function onSend(d: Draft, turnId: string, content: JsonValue): void {
  // Binding contract: every send carries a fresh UUID. A reused id (a live
  // turn has it) or a non-UUID is a binding bug: the new command is rejected
  // (`send.rejected`, bound to this command) and the live turn is never
  // touched, so this check runs before anything that could fail by turn id.
  if (sendIdRefused(d.s.turns, turnId)) {
    // The turn machine answers with `send.rejected` and writes nothing.
    d.feedTurn({ type: 'send', turnId, content });
    return;
  }
  if (d.s.intent !== 'none') {
    d.emit({ type: 'turn.fail', turnId, error: d.endError() });
    return;
  }
  const wire = asUserContent(content);
  if (wire === undefined) {
    d.emit({
      type: 'turn.fail',
      turnId,
      error: makeErrorData(
        'INVALID_OPTIONS',
        'User content must be a string or text and base64 image blocks.',
        { rule: 'user-content' },
      ),
    });
    return;
  }
  const encoded = encodeOutboundFrame(userMessage(turnId, wire), d.config.maxOutboundBytes);
  if (!encoded.ok) {
    d.emit({ type: 'turn.fail', turnId, error: encoded.error });
    return;
  }
  d.pendingUser = encoded.line;
  d.feedTurn({ type: 'send', turnId, content });
}

function onInterrupt(d: Draft, input: Extract<MachineInput, { type: 'cmd.interrupt' }>): void {
  if (d.s.intent !== 'none' && d.s.intent !== 'close') {
    d.emit({
      type: 'control.settle',
      correlation: input.correlation,
      ok: false,
      error: d.endError(),
    });
    return;
  }
  const base = {
    type: 'interrupt',
    cancelQueued: input.cancelQueued,
    correlation: input.correlation,
  } as const;
  d.feedTurn(input.turnId === undefined ? base : { ...base, turnId: input.turnId });
}

function onSetPermissionMode(d: Draft, mode: string, correlation: string): void {
  const refuse = (error: ErrorData): void => {
    d.emit({ type: 'control.settle', correlation, ok: false, error });
  };
  if ((d.s.intent !== 'none' && d.s.intent !== 'close') || !d.s.stdinOpen) {
    refuse(d.endError());
    return;
  }
  const wire = PERMISSION_MODES.find((known) => known === mode);
  if (wire === undefined) {
    refuse(
      makeErrorData('INVALID_OPTIONS', 'Unknown permission mode.', {
        rule: 'permission-mode',
        mode: cap(mode),
      }),
    );
    return;
  }
  if (wire === 'bypassPermissions' && !d.config.allowBypassPermissions) {
    refuse(
      makeErrorData(
        'INVALID_OPTIONS',
        'bypassPermissions needs dangerouslyAllowBypassPermissions: true.',
        { rule: 'bypass-permissions' },
      ),
    );
    return;
  }
  d.sendControl({
    purpose: 'set_permission_mode',
    mode: wire,
    correlation: `${APP_PREFIX}${correlation}`,
  });
}

function onClose(d: Draft): void {
  if (d.s.intent !== 'none') return;
  d.s.intent = 'close';
  // One deadline from the call, covering the wait for idle and for exit (K13).
  d.setTimer(CLOSE_TIMER, d.config.closeTimeoutMs);
  d.feedPermission({ type: 'cmd.close', atMs: d.atMs });
}

function onAbort(d: Draft, intent: 'abort' | 'dispose'): void {
  if (d.s.intent !== 'none' && d.s.intent !== 'close') return;
  d.abortLadder(intent);
}

// ---- transport ------------------------------------------------------------------------

function onTimer(d: Draft, name: string): void {
  if (!d.s.timers.includes(name)) return;
  d.s.timers = d.s.timers.filter((other) => other !== name);
  if (name === FIRST_FRAME_TIMER) {
    d.fatal(
      makeErrorData('HANDSHAKE_TIMEOUT', 'The harness did not answer initialize in time.', {
        cause: 'no-response',
        timeoutMs: d.config.firstFrameTimeoutMs,
      }),
      'watchdog',
      true,
    );
  } else if (name === IDLE_TIMER) {
    d.s.stalled = true;
    const turnId = d.currentTurn();
    const fields = {
      type: 'stalled',
      silentForMs: Math.max(0, d.atMs - d.s.idleArmedAtMs),
      pendingPermissions: d.s.permission.pending.length,
    } as const;
    d.event(turnId === undefined ? fields : { ...fields, turnId });
  } else if (name === CLOSE_TIMER) {
    d.abortLadder('close-timeout');
  } else if (name.startsWith(INTERRUPT_RETRY_TIMER_PREFIX)) {
    d.feedTurn({ type: 'timer', name });
  } else {
    // The correlator's request timeout (abort's interrupt wait).
    const fired = controlTimerFired(d.s.control, name);
    d.s.control = fired.state;
    d.onControlEffects(fired.effects, false);
  }
}

function onStdinError(d: Draft, code: string): void {
  if (!d.s.stdinOpen) return;
  if (d.s.handshake === 'ok') {
    // After the handshake a broken stdin is not fatal by itself (the process
    // exit decides the outcome), but it must not pass silently.
    d.diagnostic('stdin.error', 'Writing to the harness failed; stdin is closed.', {
      code: cap(code),
    });
  }
  d.stdinGone();
  d.feedPermission({ type: 'cli.gone', atMs: d.atMs });
  if (d.s.handshake === 'pending') {
    d.fatal(
      handshakeFailed('stdin-error', 'Writing to the harness failed during the handshake.', {
        code: cap(code),
      }),
      'handshake-failed',
      true,
    );
  }
}

function onOversized(d: Draft, bytes: number): void {
  if (d.config.onOversizedFrame === 'skip') {
    d.diagnostic('frame.skipped-oversized', 'Skipped a stdout line above the frame cap.', {
      bytes,
    });
    return;
  }
  d.fatal(
    makeErrorData('OVERSIZED_FRAME', 'A stdout line exceeded the frame cap.', { bytes }),
    'oversized-frame',
    true,
  );
}

/** Drain (K13): once nothing is running and the harness is idle, end stdin. */
function tryDrain(d: Draft): void {
  const s = d.s;
  if (
    s.intent === 'close' &&
    s.stdinOpen &&
    s.handshake === 'ok' &&
    s.harnessIdle &&
    s.turns.turns.length === 0 &&
    s.permission.pending.length === 0 &&
    s.control.outbound.length === 0
  ) {
    d.endStdin();
  }
}

/** The idle watchdog runs while a turn is queued or running; every frame re-arms it. */
function syncIdle(d: Draft, frameSeen: boolean): void {
  const s = d.s;
  const wanted =
    !s.ended &&
    s.handshake === 'ok' &&
    (s.intent === 'none' || s.intent === 'close') &&
    s.turns.turns.length > 0;
  if (!wanted) {
    d.clearTimer(IDLE_TIMER);
    s.stalled = false;
    return;
  }
  if (frameSeen) s.stalled = false;
  if (frameSeen || (!s.stalled && !s.timers.includes(IDLE_TIMER))) {
    d.setTimer(IDLE_TIMER, d.config.idleStallMs);
    s.idleArmedAtMs = d.atMs;
  }
}

// ---- step ------------------------------------------------------------------------------

function dispatch(d: Draft, input: MachineInput): boolean {
  switch (input.type) {
    case 'process.started':
      onProcessStarted(d, input.pid);
      return false;
    case 'process.spawn-error':
      if (!d.s.started && d.s.handshake !== 'failed') {
        const error = spawnError(input.code);
        d.fatal(error, 'handshake-failed', false);
        d.end('failed', error, null, 'error');
      }
      return false;
    case 'line':
      onLine(d, input.text, input.bytes);
      return true;
    case 'line.oversized':
      onOversized(d, input.bytes);
      return true;
    case 'line.invalid-utf8':
      d.diagnostic('stdout.non-json-line', 'A stdout line was not valid UTF-8; skipped.', {
        bytes: input.bytes,
        reason: 'invalid-utf8',
      });
      return true;
    case 'stdout.end':
      if (d.s.handshake === 'pending' && d.s.started) {
        d.fatal(
          handshakeFailed(
            'stdout-closed',
            'The harness closed stdout before answering initialize.',
          ),
          'handshake-failed',
          true,
        );
      }
      return false;
    case 'stdin.error':
      onStdinError(d, input.code);
      return false;
    case 'process.exit':
      d.exited({ code: input.code, signal: input.signal });
      return false;
    case 'timer':
      onTimer(d, input.name);
      return false;
    case 'stderr.line':
    case 'ladder.done':
      return false;
    case 'cmd.send':
      onSend(d, input.turnId, input.content);
      return false;
    case 'cmd.interrupt':
      onInterrupt(d, input);
      return false;
    case 'cmd.permission':
      d.feedPermission({
        type: 'cmd.permission',
        requestId: input.requestId,
        decision: input.decision,
        atMs: d.atMs,
      });
      return false;
    case 'cmd.permission-abort':
      d.feedPermission({ type: 'cmd.permission-abort', requestId: input.requestId, atMs: d.atMs });
      return false;
    case 'cmd.set-permission-mode':
      onSetPermissionMode(d, input.mode, input.correlation);
      return false;
    case 'cmd.close':
      onClose(d);
      return false;
    case 'cmd.abort':
      onAbort(d, input.intent);
      return false;
  }
}

/**
 * One step of the session machine. Never throws; after `session.end` every
 * input yields no effects.
 *
 * @internal
 */
export function stepSession(
  state: ClaudeSessionState,
  input: MachineInput,
): MachineStep<ClaudeSessionState> {
  if (state.ended) return { state, effects: [] };
  const d = new Draft(state, input.atMs, input.at);
  const frameSeen = dispatch(d, input);
  if (!d.s.ended) {
    tryDrain(d);
    syncIdle(d, frameSeen);
  }
  return d.commit();
}

/**
 * The Claude Code session machine on the neutral contract (plan §1.5).
 *
 * @internal
 */
export const claudeSessionMachine: HarnessMachine<ClaudeSessionState, ClaudeSessionConfig> = {
  initialState: initialSessionState,
  step: stepSession,
};
