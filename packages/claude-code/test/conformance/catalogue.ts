// The types of the catalogue of the Claude Code conformance suites (the
// catalogue itself is `CATALOGUE` in `declarations.ts`; plan §4.3): exactly
// the plan's suite list, in plan order, then the documented additions. The
// loader fails on any suite directory or recording that is not declared here
// and on any declared recording that is missing.
//
// Each declaration also states what the replay must show (`declared`): the
// outcome summary of every case (`summary.ts`) and the differences between
// the host writes of the recording and the writes of the session machine
// (`writes`). The expect files hold the exact effects and events; these
// declarations hold the intent a reviewer checks them against.

import type { ReplaySummary } from './summary.js';

/** A recorded platform. */
export type DeclaredPlatform = 'linux' | 'win32' | 'darwin';

/**
 * Where the machine's writes and the recording's host writes differ, as
 * labels (`replay.ts` `writeLabel`): `recorded` lists the host writes of the
 * recording the machine does not make, `machine` the writes of the machine
 * the recording does not have. Both empty when every write pairs.
 */
export interface WriteDifferences {
  readonly recorded: readonly string[];
  readonly machine: readonly string[];
}

/** What one case of a suite must show when replayed. */
export interface CaseDeclaration {
  readonly summary: ReplaySummary;
  readonly writes: WriteDifferences;
}

/** One suite. */
export interface SuiteDeclaration {
  readonly name: string;
  /** `plan §4.3` for the plan's list; the as-built note for an addition. */
  readonly source: string;
  readonly platforms: readonly DeclaredPlatform[];
  /** Cases in recording order: `['main']`, or `['setup', 'main']`. */
  readonly cases: readonly string[];
  /** Stored gzip-compressed. */
  readonly compressed?: boolean;
  /** The declared outcome of each case (the same on every platform). */
  readonly declared: Readonly<Record<string, CaseDeclaration>>;
}
