/**
 * Shape eras of the request-shape snapshots (ADR-0004 §4, amendment of
 * 2026-10-25; plan §4.4; ADR-0013 §4).
 *
 * @remarks
 * The CLI versions of the tested window do not all send the same requests:
 * a release can change them semantically (2.1.304 turned tool search on
 * behind a custom `ANTHROPIC_BASE_URL`). A shape era is a run of consecutive
 * releases that send the same shapes; each era has its own snapshot set,
 * and a run compares the requests of the CLI under test with the set of its
 * era, so every admitted release is judged against the shapes recorded for
 * it, not against the pin's.
 *
 * The eras are data, in one committed file next to the snapshots
 * (`snapshots/eras.json`): each entry names the first release of the era
 * (`from`, also the name of the era's directory), the release its snapshots
 * were written with (`recordedWith`) and what changed at its start
 * (`change`). The era of a version is the last entry whose `from` is not
 * above it. Two fallbacks keep a run meaningful outside the recorded
 * range: a version newer than the newest era's `recordedWith` (a canary on
 * a release not yet admitted) is judged against the newest era, so the
 * canary still reports drift; a version older than the first era is judged
 * against the first. Both are reported, never silent.
 *
 * Pure: no I/O.
 */

import { compareReleases, releaseVersion } from '../canary/bump.js';

/** One era: a run of releases that send the same request shapes. */
export interface ShapeEra {
  /** The first release of the era; also its snapshot directory. */
  readonly from: string;
  /** The release the era's snapshots were written with (update mode). */
  readonly recordedWith: string;
  /** What changed at the start of the era, with its evidence. */
  readonly change: string;
}

/** The committed table: the eras in ascending order of `from`. */
export interface ShapeEraTable {
  readonly eras: readonly ShapeEra[];
}

/** How a version was placed in its era. */
export type EraFallback = 'none' | 'newer-than-recorded' | 'older-than-first';

/** The era of a version, and whether a fallback chose it. */
export interface EraChoice {
  readonly era: ShapeEra;
  readonly fallback: EraFallback;
}

/** The era table is malformed, or a version cannot be placed. */
export class ShapeEraError extends Error {
  override readonly name = 'ShapeEraError';
}

const TOP_KEYS: ReadonlySet<string> = new Set(['$comment', 'format', 'eras']);
const ERA_KEYS: ReadonlySet<string> = new Set(['from', 'recordedWith', 'change']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function release(value: unknown, where: string): readonly [number, number, number] {
  const parsed = typeof value === 'string' ? releaseVersion(value) : undefined;
  if (parsed === undefined) {
    throw new ShapeEraError(
      `${where} must be a release version X.Y.Z, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function parseEra(value: unknown, index: number): ShapeEra {
  const where = `eras[${String(index)}]`;
  if (!isRecord(value)) throw new ShapeEraError(`${where} must be an object`);
  const unknown = Object.keys(value).filter((key) => !ERA_KEYS.has(key));
  if (unknown.length > 0)
    throw new ShapeEraError(`${where} has unknown keys: ${unknown.join(', ')}`);
  const from = release(value['from'], `${where}.from`);
  const recorded = release(value['recordedWith'], `${where}.recordedWith`);
  if (compareReleases(recorded, from) < 0) {
    throw new ShapeEraError(`${where}.recordedWith is older than its from`);
  }
  const change = value['change'];
  if (typeof change !== 'string' || change.trim() === '') {
    throw new ShapeEraError(`${where}.change must be a non-empty string`);
  }
  return {
    from: String(value['from']),
    recordedWith: String(value['recordedWith']),
    change,
  };
}

/**
 * Parses and checks the committed era table: `format` 1, at least one era,
 * `from` strictly ascending, each `recordedWith` inside its own era (not
 * older than its `from`, older than the next era's `from`).
 *
 * @throws ShapeEraError naming the first problem.
 */
export function parseShapeEras(text: string): ShapeEraTable {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ShapeEraError(`the era table is not JSON: ${(error as Error).message}`);
  }
  if (!isRecord(document)) throw new ShapeEraError('the era table must be an object');
  const unknown = Object.keys(document).filter((key) => !TOP_KEYS.has(key));
  if (unknown.length > 0)
    throw new ShapeEraError(`the era table has unknown keys: ${unknown.join(', ')}`);
  if (document['format'] !== 1) throw new ShapeEraError('the era table must have format 1');
  const list = document['eras'];
  if (!Array.isArray(list) || list.length === 0) {
    throw new ShapeEraError('the era table must list at least one era');
  }
  const eras = list.map((value: unknown, index) => parseEra(value, index));
  let previous: ShapeEra | undefined;
  for (const [index, era] of eras.entries()) {
    const from = release(era.from, 'from');
    if (previous !== undefined) {
      if (compareReleases(release(previous.from, 'from'), from) >= 0) {
        throw new ShapeEraError(`eras[${String(index)}].from must be newer than the era before`);
      }
      if (compareReleases(release(previous.recordedWith, 'recordedWith'), from) >= 0) {
        throw new ShapeEraError(
          `eras[${String(index - 1)}].recordedWith must be older than the next era's from`,
        );
      }
    }
    previous = era;
  }
  return { eras };
}

/**
 * The era a CLI version is judged by: the last era whose `from` is not
 * above it, with the two reported fallbacks of the module comment.
 *
 * @throws ShapeEraError when `version` is not a release version.
 */
export function shapeEraFor(table: ShapeEraTable, version: string): EraChoice {
  const target = release(version, 'the CLI version under test');
  const [first] = table.eras;
  const newest = table.eras.at(-1);
  if (first === undefined || newest === undefined) {
    throw new ShapeEraError('the era table must list at least one era');
  }
  if (compareReleases(target, release(first.from, 'from')) < 0) {
    return { era: first, fallback: 'older-than-first' };
  }
  let era = first;
  for (const candidate of table.eras) {
    if (compareReleases(release(candidate.from, 'from'), target) <= 0) era = candidate;
  }
  const newer =
    era === newest && compareReleases(target, release(newest.recordedWith, 'recordedWith')) > 0;
  return { era, fallback: newer ? 'newer-than-recorded' : 'none' };
}

/** The note a run prints when a fallback chose the era; `undefined` otherwise. */
export function eraFallbackNote(version: string, choice: EraChoice): string | undefined {
  switch (choice.fallback) {
    case 'none':
      return undefined;
    case 'newer-than-recorded':
      return `request-shape: CLI ${version} is newer than the newest shape era (${choice.era.from}, recorded with ${choice.era.recordedWith}); judged against it, so any drift shows`;
    case 'older-than-first':
      return `request-shape: CLI ${version} is older than the first shape era (${choice.era.from}); judged against it`;
  }
}
