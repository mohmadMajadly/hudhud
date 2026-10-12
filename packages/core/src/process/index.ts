/**
 * Process layer of hudhud: framing, argv, binary and cwd checks, hashing,
 * process-table parsing and termination-ladder types.
 *
 * @remarks
 * Ordinary async code used by adapters (ADR-0009, ADR-0010, ADR-0011). Spawn,
 * the ladders, the sweep and binary verification land in later waves; the
 * OS call adapters (`os/`) stay internal.
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
export { parsePsOutput } from './tree/ps.js';
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
