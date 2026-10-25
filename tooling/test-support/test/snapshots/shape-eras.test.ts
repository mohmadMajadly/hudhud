import { describe, expect, it } from 'vitest';

import {
  eraFallbackNote,
  parseShapeEras,
  ShapeEraError,
  shapeEraFor,
  type ShapeEraTable,
} from '../../src/snapshots/shape-eras.js';

const ERA_A = { from: '2.1.296', recordedWith: '2.1.302', change: 'first' };
const ERA_B = { from: '2.1.304', recordedWith: '2.1.304', change: 'tool search' };
const ERA_C = { from: '2.1.307', recordedWith: '2.1.310', change: 'no caching scope' };

function table(eras: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ $comment: 'x', format: 1, eras, ...extra });
}

function refusal(text: string): string {
  try {
    parseShapeEras(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ShapeEraError);
    expect((error as Error).name).toBe('ShapeEraError');
    return (error as Error).message;
  }
  throw new Error('expected a ShapeEraError');
}

describe('parseShapeEras', () => {
  it('accepts ascending eras and keeps them in order', () => {
    expect(parseShapeEras(table([ERA_A, ERA_B, ERA_C]))).toEqual({ eras: [ERA_A, ERA_B, ERA_C] });
    expect(parseShapeEras(JSON.stringify({ format: 1, eras: [ERA_A] }))).toEqual({ eras: [ERA_A] });
  });

  it.each([
    ['not JSON', '{', /not JSON/],
    ['an array', '[]', /must be an object/],
    ['null', 'null', /must be an object/],
    ['an unknown key', table([ERA_A], { extra: 1 }), /unknown keys: extra/],
    ['another format', table([ERA_A], { format: 2 }), /format 1/],
    ['no eras', table([]), /at least one era/],
    ['eras not a list', JSON.stringify({ format: 1, eras: {} }), /at least one era/],
    ['an era not an object', table(['x']), /eras\[0\] must be an object/],
    ['an unknown era key', table([{ ...ERA_A, dir: 'x' }]), /eras\[0\] has unknown keys: dir/],
    ['a bad from', table([{ ...ERA_A, from: '2.1' }]), /eras\[0\]\.from must be a release/],
    ['a pre-release from', table([{ ...ERA_A, from: '2.1.296-beta' }]), /eras\[0\]\.from/],
    ['a numeric from', table([{ ...ERA_A, from: 2 }]), /eras\[0\]\.from/],
    [
      'a bad recordedWith',
      table([{ ...ERA_A, recordedWith: 'x' }]),
      /eras\[0\]\.recordedWith must/,
    ],
    [
      'a recordedWith older than from',
      table([{ ...ERA_A, recordedWith: '2.1.295' }]),
      /recordedWith is older than its from/,
    ],
    ['an empty change', table([{ ...ERA_A, change: '  ' }]), /change must be a non-empty/],
    ['a missing change', table([{ from: '2.1.296', recordedWith: '2.1.296' }]), /change must/],
    ['eras out of order', table([ERA_B, ERA_A]), /eras\[1\]\.from must be newer/],
    ['two eras with one from', table([ERA_A, { ...ERA_B, from: '2.1.296' }]), /eras\[1\]\.from/],
    [
      'a recordedWith inside the next era',
      table([{ ...ERA_A, recordedWith: '2.1.304' }, ERA_B]),
      /eras\[0\]\.recordedWith must be older than the next era's from/,
    ],
  ])('refuses %s', (_name, text, message) => {
    expect(refusal(text)).toMatch(message);
  });
});

describe('shapeEraFor', () => {
  const eras: ShapeEraTable = { eras: [ERA_A, ERA_B, ERA_C] };

  it.each([
    ['2.1.296', ERA_A],
    ['2.1.302', ERA_A],
    ['2.1.303', ERA_A],
    ['2.1.304', ERA_B],
    ['2.1.306', ERA_B],
    ['2.1.307', ERA_C],
    ['2.1.310', ERA_C],
    ['2.2.0', ERA_C],
  ])('places %s in its era', (version, era) => {
    expect(shapeEraFor(eras, version).era).toBe(era);
  });

  it('reports no fallback inside the recorded range', () => {
    expect(shapeEraFor(eras, '2.1.305').fallback).toBe('none');
    expect(shapeEraFor(eras, '2.1.310').fallback).toBe('none');
  });

  it('judges a newer release than the newest recording by the newest era', () => {
    expect(shapeEraFor(eras, '2.1.311')).toEqual({ era: ERA_C, fallback: 'newer-than-recorded' });
    expect(shapeEraFor(eras, '3.0.0')).toEqual({ era: ERA_C, fallback: 'newer-than-recorded' });
  });

  it('judges a release older than the first era by the first era', () => {
    expect(shapeEraFor(eras, '2.1.295')).toEqual({ era: ERA_A, fallback: 'older-than-first' });
  });

  it('refuses a version that is not a release, and an empty table', () => {
    expect(() => shapeEraFor(eras, '2.1.310-beta.1')).toThrow(ShapeEraError);
    expect(() => shapeEraFor(eras, 'latest')).toThrow(/the CLI version under test/);
    expect(() => shapeEraFor({ eras: [] }, '2.1.310')).toThrow(/at least one era/);
  });
});

describe('eraFallbackNote', () => {
  it('says nothing without a fallback and names the era with one', () => {
    expect(eraFallbackNote('2.1.305', { era: ERA_B, fallback: 'none' })).toBeUndefined();
    expect(eraFallbackNote('2.1.311', { era: ERA_C, fallback: 'newer-than-recorded' })).toBe(
      'request-shape: CLI 2.1.311 is newer than the newest shape era (2.1.307, recorded with 2.1.310); judged against it, so any drift shows',
    );
    expect(eraFallbackNote('2.1.295', { era: ERA_A, fallback: 'older-than-first' })).toBe(
      'request-shape: CLI 2.1.295 is older than the first shape era (2.1.296); judged against it',
    );
  });
});
