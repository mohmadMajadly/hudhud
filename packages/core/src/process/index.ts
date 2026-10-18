/**
 * Process layer of hudhud: framing, argv, binary and cwd checks, hashing,
 * process-table snapshots, spawn, the termination ladders and the sweep.
 *
 * @remarks
 * Beta: every export is `@beta`, for adapter authors, and may change in a
 * minor version until a second adapter exists (ADR-0004 amendment, R5-1).
 * `BinaryVerification` and `VerificationMode` are stable: the root entry
 * exports them too.
 *
 * Ordinary async code used by adapters (ADR-0009, ADR-0010, ADR-0011). The
 * OS call adapters (`os/`) stay internal; their interfaces are public and
 * {@link osCallsFor} composes them for the host. Binary verification (K8,
 * K9, K4), the job addon loader and containment (K2, K17), and the sweep of
 * the graceful close (W3-Z ruling 5) are here too.
 *
 * @packageDocumentation
 */

export type { Framer, FramerOptions, FramerOutput } from './framer.js';
export { DEFAULT_MAX_INBOUND_FRAME_BYTES, createFramer, maxFramerLineBytes } from './framer.js';

export type { ArgvProblem } from './argv.js';
export { ArgvError, assertNoReservedFlags, formatFlag, isFlagName, parseFlag } from './argv.js';

export type {
  ExecutableFs,
  ExecutableRefusal,
  ResolvedExecutable,
  ResolveExecutableOptions,
} from './binary-path.js';
export {
  checkExecutablePath,
  ExecutableResolutionError,
  resolveExecutable,
  safeSearchPathEntries,
} from './binary-path.js';

export type {
  CwdErrorReason,
  CwdFs,
  CwdProblem,
  ExecutableIdentity,
  FileIdentity,
  PathProblem,
  ProcessPlatform,
} from './cwd.js';
export {
  checkCwdPath,
  CwdValidationError,
  hostPlatform,
  pathProblem,
  validateCwd,
  WIN32_CWD_MAX_LENGTH,
} from './cwd.js';

export type { FileDigest, Sha256FileOptions } from './hash.js';
export { FileChangedError, NotRegularFileError, sha256File } from './hash.js';

export type {
  ParsedProcessTable,
  ProcessIdentity,
  ProcessRecord,
  ProcessSnapshot,
  ProcessTableSource,
} from './tree/types.js';
export { parseProcStat } from './tree/proc-stat.js';
export { parsePsOutput, type PsDialect } from './tree/ps.js';
export { parseWin32ProcessJson } from './tree/win32.js';
export { compareStartTime, isCanonicalStartTime } from './tree/start-time.js';
export type { DescendantTree } from './tree/descendants.js';
export { descendantsOf, findIdentity, sameIdentity } from './tree/descendants.js';

export type {
  InterruptOutcome,
  LadderHooks,
  LadderReport,
  LadderStep,
  LadderStepName,
  LadderSweepSummary,
  LadderTiming,
} from './ladder/types.js';
export { DEFAULT_LADDER_TIMING } from './ladder/types.js';
export type { LadderClock } from './ladder/types.js';

export type { DescendantSnapshot, SnapshotDeps } from './tree/snapshot.js';
export { snapshotDescendants } from './tree/snapshot.js';
export type {
  GroupSkipReason,
  GroupTarget,
  SignalTargetDecision,
  SweepPlan,
  SweepSkipReason,
} from './tree/select.js';

export type {
  DarwinPsTableCalls,
  LinuxProcTableCalls,
  OsCalls,
  PosixSignal,
  PosixSignalCalls,
  ProcessTableCalls,
  SignalOutcome,
  TaskkillResult,
  Win32CimTableCalls,
  Win32TerminateCalls,
} from './os/types.js';

export { childEnv, DARWIN_CHILD_SET_ENV_NAMES, WIN32_REQUIRED_ENV_NAMES } from './win32-env.js';

export type {
  HarnessProcess,
  IdentityProblem,
  IdentityRead,
  ProcessExit,
  SpawnFailureCause,
  SpawnSpec,
  SpawnSpecProblem,
  StartTimeReader,
} from './spawn.js';
export {
  osCallsFor,
  ProcessSpawnError,
  ProcessStreamError,
  processTableStartTime,
  spawnHarnessProcess,
  SpawnSpecError,
} from './spawn.js';

export type { LadderIdentity } from './ladder/types.js';
export type { PosixLadderDeps, PosixLadderProcess, PosixOsCalls } from './ladder/posix.js';
export { runPosixLadder } from './ladder/posix.js';
export type { SweepDeps, SweepRequest, SweepResult, SweepSignalOutcome } from './sweep.js';
export { sweep } from './sweep.js';

export type {
  JobHandle,
  WindowsLadderDeps,
  WindowsLadderProcess,
  WindowsOsCalls,
} from './ladder/windows.js';
export { runWindowsLadder } from './ladder/windows.js';
export type {
  TaskkillCalls,
  TaskkillDeps,
  TaskkillExecError,
  TaskkillExecFile,
  TaskkillExecOptions,
  TaskkillFs,
  TaskkillRefusal,
} from './taskkill.js';
export {
  createTaskkillCalls,
  DEFAULT_TASKKILL_TIMEOUT_MS,
  nodeTaskkillDeps,
  resolveTaskkillPath,
  systemRootFrom,
  taskkillArgv,
  TaskkillUnavailableError,
  WIN32_DEFAULT_SYSTEM_ROOT,
} from './taskkill.js';
// The bounded, redacted stderr tail of a spawned process.
export type { StderrTailOptions } from '../observability/stderr-tail.js';
export { StderrTail, TRUNCATED } from '../observability/stderr-tail.js';

// Graceful close: the snapshot at EOF and the sweep after the exit (W3-Z ruling 5).
export type {
  AfterExitDeps,
  AfterExitKill,
  AfterExitSkipReason,
  AfterExitSweepReport,
  EofSnapshot,
} from './ladder/after-exit.js';
export { snapshotAtEof, sweepAfterExit } from './ladder/after-exit.js';

// Binary verification (K8, K9) and the version probe (K4).
export type { BoundedCommand, BoundedSpawn, CommandOutcome } from './verify/command.js';
export { runBoundedCommand } from './verify/command.js';
export type {
  OsSignatureResult,
  PublisherPin,
  SignatureDeps,
  SignatureFs,
  SignaturePlatform,
} from './verify/os-signature.js';
export {
  checkOsSignature,
  DEFAULT_SIGNATURE_TIMEOUT_MS,
  signaturePlatformOf,
} from './verify/os-signature.js';
export type {
  BinaryIdentity,
  BinaryVerification,
  IdentityFs,
  KnownDigest,
  SpawnableBinary,
  VerificationMode,
  VerifiedBinary,
  VerifyBinaryOptions,
} from './verify/verify.js';
export {
  assertSpawnable,
  assertSpawnableOrReverify,
  BinaryChangedError,
  BinaryNotVerifiedError,
  checkKnownDigests,
  recheckBinary,
  settleProbedVersion,
  VerificationCache,
  verifyBinary,
} from './verify/verify.js';
export type {
  ProbeWorkDir,
  VersionProbeFailure,
  VersionProbeOptions,
} from './verify/version-probe.js';
export {
  DEFAULT_VERSION_PROBE_MAX_BYTES,
  DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  runVersionProbe,
  tempProbeWorkDir,
  VersionProbeError,
} from './verify/version-probe.js';

// The Windows job addon loader and per-session containment (K2, K17).
export type {
  JobAddon,
  JobAddonDeps,
  JobAddonLoad,
  JobAddonModuleObject,
  JobAddonUnavailableReason,
  JobContainment,
  JobContainmentCapability,
  JobObject,
} from './containment/win32-job.js';
export {
  hostJobAddonDeps,
  JobAddonError,
  JOB_TERMINATE_EXIT_CODE,
  jobContainmentCapability,
  loadHostJobAddon,
  loadJobAddon,
  WIN32_JOB_ADDON_SPECIFIER,
} from './containment/win32-job.js';
export type { JobAddonDigests } from './containment/win32-job-digests.js';
export type {
  ContainedProcess,
  ContainmentFallbackDiagnostic,
  SessionContainment,
  SessionContainmentResult,
} from './containment/session.js';
export { createSessionContainment } from './containment/session.js';
