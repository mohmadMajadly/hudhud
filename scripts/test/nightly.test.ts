import { describe, expect, it } from 'vitest';

import { CLI_PACKAGE, WINDOW_HOURS, decideNightly, parseTime } from '../lib/nightly.mjs';

const now = new Date('2026-10-12T03:00:00Z');
const hoursAgo = (hours: number): Date => new Date(now.getTime() - hours * 3_600_000);

describe('decideNightly (CLI releases only)', () => {
  it('skips when no CLI version was published inside the window', () => {
    expect(decideNightly({ now, registryModified: hoursAgo(WINDOW_HOURS + 1) })).toEqual({
      run: false,
      reasons: [],
    });
  });

  it('runs when a new CLI version was published, up to the window edge', () => {
    expect(decideNightly({ now, registryModified: hoursAgo(1) })).toEqual({
      run: true,
      reasons: [`${CLI_PACKAGE} published`],
    });
    expect(decideNightly({ now, registryModified: hoursAgo(WINDOW_HOURS) }).run).toBe(true);
  });

  it('does not run and reports an error when the registry state is unknown', () => {
    expect(decideNightly({ now, registryModified: null })).toEqual({
      run: false,
      reasons: [],
      error: `${CLI_PACKAGE} registry state unknown`,
    });
  });

  it('runs on manual dispatch, even when the registry is unreadable', () => {
    expect(decideNightly({ now, registryModified: null, forced: true })).toEqual({
      run: true,
      reasons: ['manual dispatch'],
    });
  });
});

describe('parseTime', () => {
  it('parses ISO-8601', () => {
    expect(parseTime('2026-10-12T03:00:00.000Z')?.toISOString()).toBe('2026-10-12T03:00:00.000Z');
  });

  it.each([[''], ['  '], ['not a date'], [42], [null], [undefined]])('rejects %j', (input) => {
    expect(parseTime(input)).toBeNull();
  });
});
