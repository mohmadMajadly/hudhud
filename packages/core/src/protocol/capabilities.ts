/**
 * Harness-neutral capability and security posture types (plan §2.2).
 *
 * @remarks
 * Mirrored by `schemas/capabilities.schema.json` and
 * `schemas/posture.schema.json`; a type-level test asserts that each type and
 * its schema source accept the same values.
 *
 * @packageDocumentation
 */

import type { JsonValue } from './json.js';

/**
 * How a harness provides a feature: natively, emulated by hudhud, or not at
 * all. Open: later versions may add values (ADR-0005 §6).
 *
 * @public
 */
export type Capability = 'supported' | 'emulated' | 'unsupported' | (string & {});

/**
 * Process-tree containment: a Windows job object, best-effort tree tracking,
 * or a cgroup. Open: later versions may add values (ADR-0005 §6).
 *
 * @public
 */
export type ProcessContainment = 'job' | 'best-effort' | 'cgroup' | (string & {});

/**
 * What a harness can do, computed at connect.
 *
 * @public
 */
export interface HarnessCapabilities {
  /** Several turns in one session. */
  readonly multiTurn: Capability;
  /** Continuing a session by its id (`sessions.resume`). */
  readonly resume: Capability;
  /** Continuing a session under a new id (`resume` with `fork: true`). */
  readonly fork: Capability;
  /** Interrupting a turn (`turn.interrupt()`). */
  readonly interrupt: Capability;
  /** Permission questions answered by the application (`onPermission`). */
  readonly permissionsInBand: Capability;
  /** Each `workspaceTrust` level. */
  readonly workspaceTrust: {
    readonly none: Capability;
    readonly context: Capability;
    readonly full: Capability;
  };
  /** What this harness can provide; each session reports what it got (K2). */
  readonly processContainment: ProcessContainment;
  /** Human-readable reasons, keyed by capability path (for example `workspaceTrust.context`). */
  readonly reasons: Readonly<Record<string, string>>;
}

/**
 * One security-relevant setting and whether it deviates from the default.
 *
 * @public
 */
export interface SecurityPostureEntry {
  /** Dotted option path or a fixed name, for example `claudeCode.bare`. */
  readonly setting: string;
  /** The effective value: kinds and names, never secrets, environment values or paths. */
  readonly value: JsonValue;
  /** The value hudhud uses when the application sets nothing. */
  readonly defaultValue: JsonValue;
  /** Whether `value` differs from `defaultValue` (deep JSON equality). */
  readonly deviates: boolean;
}

/**
 * The security-relevant settings of a harness or session (ADR-0012).
 *
 * @public
 */
export interface SecurityPosture {
  /** One entry per security-relevant setting, in the adapter's order. */
  readonly entries: readonly SecurityPostureEntry[];
}
