import { describe, expect, it } from 'vitest';

import { CLI_PACKAGE, WINDOW_HOURS, decideNightly, parseTime } from '../lib/nightly.mjs';

const now = new Date('2026-10-12T03:00:00Z');
const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * 3_600_000);

describe('decideNightly', () => {
  it('skips when nothing changed inside the window', () => {
    expect(
      decideNightly({
        now,
        mainCommitTime: hoursAgo(WINDOW_HOURS + 1),
        registryModified: hoursAgo(48),
      }),
    ).toEqual({ run: false, reasons: [] });
  });

  it('runs when main changed', () => {
    expect(
      decideNightly({ now, mainCommitTime: hoursAgo(2), registryModified: hoursAgo(48) }),
    ).toEqual({
      run: true,
      reasons: ['main changed'],
    });
  });

  it('runs when a new CLI version was published', () => {
    expect(
      decideNightly({
        now,
        mainCommitTime: hoursAgo(48),
        registryModified: hoursAgo(WINDOW_HOURS),
      }),
    ).toEqual({
      run: true,
      reasons: [`${CLI_PACKAGE} published`],
    });
  });

  it('runs when either input is unknown (fails towards testing)', () => {
    expect(decideNightly({ now, mainCommitTime: null, registryModified: null })).toEqual({
      run: true,
      reasons: ['main head time unknown', 'registry state unknown'],
    });
  });

  it('runs on manual dispatch', () => {
    expect(
      decideNightly({
        now,
        mainCommitTime: hoursAgo(48),
        registryModified: hoursAgo(48),
        forced: true,
      }).run,
    ).toBe(true);
  });
});

describe('parseTime', () => {
  it.each([
    ['1760238000\n', '2025-10-12T03:00:00.000Z'],
    ['2026-10-12T03:00:00.000Z', '2026-10-12T03:00:00.000Z'],
  ])('parses %j', (input, iso) => {
    expect(parseTime(input)?.toISOString()).toBe(iso);
  });

  it.each([[''], ['  '], ['not a date'], [42], [null], [undefined]])('rejects %j', (input) => {
    expect(parseTime(input)).toBeNull();
  });
});
