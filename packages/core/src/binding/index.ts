/**
 * The binding layer for adapter authors: `@hudhud/core/binding` (plan §1.6,
 * §2.1; ADR-0004, ADR-0006, K3, K18).
 *
 * @remarks
 * Beta. Everything here is `@beta`: the generic session driver, the
 * transports (the process transport and the in-memory loopback), the clocks
 * and id sources, the host-exit hook, and the handle helpers an adapter
 * builds its public `Harness` and `Session` from. Applications use the root
 * entry `@hudhud/core`, the stable application tier; this entry may change
 * between minor versions until it is declared stable.
 *
 * The process and protocol types these APIs name are re-exported, so an
 * adapter can type its binding code against this entry alone. The core
 * never names a harness here: the adapter supplies its machine (K3).
 *
 * @packageDocumentation
 */

export type { BindingDiagnostic, DriverOptions, SessionEnd } from './driver.js';
export {
  DEFAULT_OUTPUT_DRAIN_MS,
  openSession,
  SessionDriver,
  SYNTHESIZED_EVENT_BYTES,
} from './driver.js';

export type {
  HarnessTransport,
  ProcessTransportOptions,
  TerminateRequest,
  TransportOutput,
} from './transport.js';
export { createProcessTransport, TransportWriteError } from './transport.js';

export type {
  LoopbackDriverOptions,
  LoopbackMachine,
  LoopbackSession,
  LoopbackTerminate,
  LoopbackTransportOptions,
} from './loopback.js';
export {
  createLoopbackDriver,
  loopbackLadder,
  loopbackMachine,
  LoopbackTransport,
  LoopbackViolation,
} from './loopback.js';

export type { Clock, IdSource } from './clock.js';
export { counterIds, cryptoIds, ManualClock, systemClock } from './clock.js';

export type { ExitEmitter, HostExitTarget } from './host-exit.js';
export { hostExit, HostExitHook } from './host-exit.js';

// The bounded broadcast behind `events()`, for an adapter's own streams (the
// Claude Code raw tier's frames, W5-T1).
export type {
  AbortSignalLike,
  FanoutDeps,
  FanoutSubscriberOptions,
  Selection,
  SizedEvent,
} from './fanout.js';
export { Fanout } from './fanout.js';
export type { OverflowInfo } from './queue.js';

export type { HarnessFacts, SessionCore, TurnCore } from './handles.js';
export { createSession, HarnessBase, normalizeUserInput } from './handles.js';

// The error code list the HudhudErrorCode type is derived from.
export { HUDHUD_ERROR_CODES } from '../protocol/index.js';

// ---- the types the binding APIs name ------------------------------------------------
// Re-exported type-only from their own entries, so an adapter can type its
// binding code against this entry alone.

export type {
  BinaryInfo,
  Harness,
  Session,
  SessionInfo,
  Turn,
  UserContentBlock,
  UserInput,
} from './handles.js';
export type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from './permission-bridge.js';
export type { SubscriberOptions } from './fanout.js';
export type { OverflowPolicy } from './queue.js';

export type {
  Capability,
  CommandInput,
  CompatInfo,
  DiagnosticCode,
  ErrorData,
  EventBase,
  ExitObservation,
  HarnessCapabilities,
  HarnessMachine,
  HudhudErrorCode,
  HudhudEvent,
  HudhudEventData,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  KnownErrorData,
  MachineClockInput,
  MachineEffect,
  MachineInput,
  MachineStep,
  PermissionErrorReason,
  PermissionRequestData,
  ProcessContainment,
  SecurityPosture,
  SecurityPostureEntry,
  SessionInfoData,
  SessionOutcome,
  StopReason,
  TerminationIntent,
  TimerName,
  ToolKind,
  TransportInput,
  TurnOutcome,
  TurnResult,
  TurnResultData,
  UsageTotals,
} from '../protocol/index.js';

export type {
  AfterExitKill,
  AfterExitSkipReason,
  AfterExitSweepReport,
  BinaryVerification,
  DarwinPsTableCalls,
  GroupSkipReason,
  GroupTarget,
  HarnessProcess,
  IdentityProblem,
  IdentityRead,
  InterruptOutcome,
  JobHandle,
  LadderReport,
  LadderStep,
  LadderStepName,
  LadderSweepSummary,
  LadderTiming,
  LinuxProcTableCalls,
  OsCalls,
  PosixSignal,
  PosixSignalCalls,
  ProcessExit,
  ProcessIdentity,
  ProcessTableSource,
  SignalOutcome,
  SweepPlan,
  SweepResult,
  SweepSignalOutcome,
  SweepSkipReason,
  TaskkillResult,
  VerificationMode,
  Win32CimTableCalls,
  Win32TerminateCalls,
} from '../process/index.js';
