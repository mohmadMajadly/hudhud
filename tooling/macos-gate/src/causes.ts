/**
 * Named causes the gate maps observations to (ADR-0011: "a Gatekeeper /
 * quarantine spawn failure mapped to a named cause"; ADR-0014 items 3 and 4:
 * the first-frame and idle watchdogs must name a Keychain prompt and a shell
 * snapshot hang). Pure. These names are the gate's proposal for the error
 * causes of W2-T7 and W3-T2; the gate records which ones it observed.
 */

import type { ProcessRecord } from '../../../packages/core/src/process/tree/types.js';
import type { RunResult } from './host.js';
import { commandName } from './ps.js';

/** Why a launch of the binary did or did not work. */
export type LaunchCause =
  /** Exit 0. */
  | 'ok'
  /** The file is not there (`ENOENT`). */
  | 'binary-missing'
  /** `execve` refused (`EACCES`, `EPERM`): permissions or a policy denial. */
  | 'launch-denied'
  /** Killed by SIGKILL before writing anything: the kernel's code-signing enforcement or Gatekeeper. */
  | 'killed-at-launch'
  /** No exit within the timeout: a headless Gatekeeper prompt waits forever. */
  | 'launch-hang'
  /** Started and exited non-zero or by another signal. */
  | 'exit-failure'
  /** Any other spawn error. */
  | 'spawn-error';

/** Maps the result of a short launch (`claude --version`) to a {@link LaunchCause}. */
export function classifyLaunch(result: RunResult): LaunchCause {
  switch (result.error) {
    case undefined:
      break;
    case 'ENOENT':
      return 'binary-missing';
    case 'EACCES':
    case 'EPERM':
      return 'launch-denied';
    case 'ETIMEDOUT':
      return 'launch-hang';
    default:
      return 'spawn-error';
  }
  if (result.code === 0) return 'ok';
  if (result.signal === 'SIGKILL' && result.stdout.byteLength === 0) return 'killed-at-launch';
  return 'exit-failure';
}

/** Why a CLI stopped producing frames. */
export type StallCause =
  /** A `security` child is alive: a Keychain lookup (a GUI prompt never returns headless). */
  | 'keychain-access'
  /** A shell child is alive and the shell snapshot was never written: the login-shell snapshot hangs. */
  | 'shell-snapshot'
  /** A tool use is open and the shell snapshot exists: the tool itself is slow. */
  | 'tool-running'
  /** Nothing identifiable. */
  | 'unknown';

const SHELLS = new Set(['zsh', 'bash', 'sh']);

/** What {@link classifyStall} looks at. */
export interface StallInput {
  /** The CLI's live descendants. */
  readonly descendants: readonly ProcessRecord[];
  /** A tool use was started and has no result yet. */
  readonly toolRunning: boolean;
  /** A `snapshot-*` file exists in `<config>/shell-snapshots`. */
  readonly shellSnapshotReady: boolean;
}

/** Names the cause of a stall (the idle watchdog's `stalled` path). */
export function classifyStall(input: StallInput): StallCause {
  const names = input.descendants.map((record) => commandName(record.name));
  if (names.includes('security')) return 'keychain-access';
  if (!input.shellSnapshotReady && names.some((name) => SHELLS.has(name))) return 'shell-snapshot';
  return input.toolRunning ? 'tool-running' : 'unknown';
}
/** Watchdog limits of a session. */
export interface WatchdogLimits {
  /** No frame at all this long after the first input: `first-frame` timeout. */
  readonly firstFrameMs: number;
  /** No frame this long while a turn is open: `idle` timeout (the `stalled` path). */
  readonly idleMs: number;
}

/** The watchdog's view of a session. */
export interface WatchdogInput {
  readonly now: number;
  /** When the first input was written. */
  readonly startedAt: number;
  /** When the latest frame arrived; undefined before the first one. */
  readonly lastFrameAt: number | undefined;
  /** A user message was sent and its `result` has not arrived. */
  readonly turnOpen: boolean;
}

export type WatchdogState = 'ok' | 'first-frame-timeout' | 'stalled';

/** The first-frame and idle watchdogs of hudhud as the gate models them (ADR-0007). */
export function watchdogState(input: WatchdogInput, limits: WatchdogLimits): WatchdogState {
  if (input.lastFrameAt === undefined) {
    return input.now - input.startedAt >= limits.firstFrameMs ? 'first-frame-timeout' : 'ok';
  }
  return input.turnOpen && input.now - input.lastFrameAt >= limits.idleMs ? 'stalled' : 'ok';
}
