// The committed shape eras of the request-shape snapshots agree with the
// tested window and the snapshot files (ADR-0004 §4, amendment of
// 2026-10-25). The integration suite picks the snapshot set by the era of
// the CLI under test; this test keeps the data it picks from consistent.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compareReleases,
  releaseVersion,
} from '../../../../tooling/test-support/src/canary/bump.js';
import { parseSnapshot } from '../../../../tooling/test-support/src/snapshots/request-shape.js';
import { parseShapeEras } from '../../../../tooling/test-support/src/snapshots/shape-eras.js';
import { CLAUDE_CODE_COMPAT } from '../../src/compat.js';
import { KNOWN_BINARIES } from '../../src/known-binaries.js';

const SNAPSHOTS = path.join(import.meta.dirname, '..', 'integration', 'request-shape', 'snapshots');
const { eras } = parseShapeEras(readFileSync(path.join(SNAPSHOTS, 'eras.json'), 'utf8'));
const PLATFORMS = ['darwin', 'linux', 'win32'];

/** Compares two release versions (both must parse). */
function compare(a: string | undefined, b: string): number {
  const [x, y] = [releaseVersion(String(a)), releaseVersion(b)];
  if (x === undefined || y === undefined) throw new Error(`not a release: ${String(a)} or ${b}`);
  return compareReleases(x, y);
}

describe('the shape eras of the request-shape snapshots', () => {
  it('has one directory per era and nothing else next to the table', () => {
    expect(readdirSync(SNAPSHOTS).sort()).toEqual(
      [...eras.map((era) => era.from), 'eras.json'].sort(),
    );
  });

  it('gives every era the same scenarios, each on every platform, each file its own scenario', () => {
    const [first] = eras;
    const names = readdirSync(path.join(SNAPSHOTS, String(first?.from))).sort();
    const scenarios = [...new Set(names.map((name) => name.split('.')[0]))];
    expect(scenarios.length).toBeGreaterThan(0);
    expect(names).toEqual(
      scenarios.flatMap((scenario) => PLATFORMS.map((p) => `${String(scenario)}.${p}.shape`)),
    );
    for (const era of eras) {
      expect(readdirSync(path.join(SNAPSHOTS, era.from)).sort()).toEqual(names);
      for (const name of names) {
        const text = readFileSync(path.join(SNAPSHOTS, era.from, name), 'utf8');
        expect(parseSnapshot(text).scenario).toBe(name.split('.')[0]);
      }
    }
  });

  it('covers the tested window: the first era holds minTested, the newest is recorded at the pin', () => {
    const [first, second] = eras;
    expect(compare(first?.from, CLAUDE_CODE_COMPAT.minTested)).toBeLessThanOrEqual(0);
    if (second !== undefined) {
      // No era lies wholly below the window: it would leave with its releases.
      expect(compare(second.from, CLAUDE_CODE_COMPAT.minTested)).toBeGreaterThan(0);
    }
    expect(eras.at(-1)?.recordedWith).toBe(CLAUDE_CODE_COMPAT.maxTested);
  });

  it('starts and records every era at an admitted release of the digest table', () => {
    for (const era of eras) {
      expect(Object.keys(KNOWN_BINARIES)).toContain(era.from);
      expect(Object.keys(KNOWN_BINARIES)).toContain(era.recordedWith);
    }
  });
});
