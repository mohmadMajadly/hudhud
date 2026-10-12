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
 * all.
 *
 * @public
 */
export type Capability = 'supported' | 'emulated' | 'unsupported';

/**
 * Process-tree containment: a Windows job object, best-effort tree tracking,
 * or a cgroup.
 *
 * @public
 */
export type ProcessContainment = 'job' | 'best-effort' | 'cgroup';

/**
 * What a harness can do, computed at connect.
 *
 * @public
 */
export interface HarnessCapabilities {
  readonly multiTurn: Capability;
  readonly resume: Capability;
  readonly fork: Capability;
  readonly interrupt: Capability;
  readonly permissionsInBand: Capability;
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
  readonly setting: string;
  readonly value: JsonValue;
  readonly defaultValue: JsonValue;
  readonly deviates: boolean;
}

/**
 * The security-relevant settings of a harness or session (ADR-0012).
 *
 * @public
 */
export interface SecurityPosture {
  readonly entries: readonly SecurityPostureEntry[];
}
