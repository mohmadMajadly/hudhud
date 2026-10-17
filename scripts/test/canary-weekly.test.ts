import { describe, expect, it } from 'vitest';

import {
  MACOS_CANARY_ENABLED,
  MARGIN_HOURS,
  WEEK_HOURS,
  decideWeekly,
} from '../lib/canary-weekly.mjs';
import { CLI_PACKAGE, registryFacts } from '../lib/nightly.mjs';
import type { ScheduleFacts } from '../lib/nightly.mjs';

const now = new Date('2026-10-19T04:41:00Z');
const WINDOW_MS = (WEEK_HOURS + MARGIN_HOURS) * 3_600_000;
const at = (offsetMs: number): string => new Date(now.getTime() - offsetMs).toISOString();

function facts(
  latest: string,
  time: Record<string, string>,
  overrides: Partial<ScheduleFacts> = {},
): ScheduleFacts {
  return {
    now,
    registry: registryFacts({ name: CLI_PACKAGE, 'dist-tags': { latest }, time }),
    registryError: undefined,
    pin: { version: '2.1.296', darwinPending: true },
    mode: 'canary',
    dispatched: false,
    ...overrides,
  };
}

describe('decideWeekly', () => {
  it('has the macOS switch on since the macOS gate passed', () => {
    expect(MACOS_CANARY_ENABLED).toBe(true);
  });

  it('tests the newest on Windows when a newer version was published in the window', () => {
    const decision = decideWeekly(
      facts('2.1.301', {
        '2.1.296': at(WINDOW_MS + 9e8),
        '2.1.300': at(WINDOW_MS + 1),
        '2.1.301': at(WINDOW_MS),
      }),
      false,
    );
    expect(decision).toEqual({
      run: true,
      mode: 'canary',
      version: '2.1.301',
      macos: false,
      lines: [
        `Window from ${at(WINDOW_MS)} to ${now.toISOString()} (this run, back to the previous weekly tick less a 2 h margin).`,
        'Published in it and newer than the pinned 2.1.296: 2.1.301. The weekly canary tests the newest, 2.1.301, on Windows.',
        'macOS: off (MACOS_CANARY_ENABLED is false until the macOS gate has passed).',
      ],
    });
  });

  it('adds macOS only when switched on and no darwin entry is pending its gate', () => {
    const time = { '2.1.301': at(1000) };
    const pending = decideWeekly(facts('2.1.301', time), true);
    expect(pending.macos).toBe(false);
    expect(pending.lines[2]).toBe(
      'macOS: off (a darwin entry of the pin is still pending the macOS gate).',
    );
    const pinned = { version: '2.1.296', darwinPending: false };
    const on = decideWeekly(facts('2.1.301', time, { pin: pinned }), true);
    expect(on.macos).toBe(true);
    expect(on.lines[1]).toContain('on Windows and macOS.');
    expect(on.lines[2]).toBe(
      'macOS: on (the macOS gate has passed and the darwin entries are pinned).',
    );
    // The committed switch is on: a pinned darwin entry runs macOS by default.
    expect(decideWeekly(facts('2.1.301', time, { pin: pinned })).macos).toBe(true);
    expect(decideWeekly(facts('2.1.301', time, { pin: pinned }), false).macos).toBe(false);
  });

  it('runs when only an older newer-than-pin version is in the window, testing the newest', () => {
    const decision = decideWeekly(
      facts('2.1.301', { '2.1.300': at(3_600_000), '2.1.301': at(WINDOW_MS + 1) }),
    );
    expect(decision).toMatchObject({ run: true, version: '2.1.301' });
  });

  it('skips when nothing newer than the pin and up to latest was published in the window', () => {
    const decision = decideWeekly(
      facts('2.1.301', {
        '2.1.301': at(WINDOW_MS + 1),
        '2.1.295': at(1000),
        // A `next` version above latest is not what users get yet.
        '2.1.302': at(1000),
      }),
    );
    expect(decision).toMatchObject({ run: false, version: '', macos: false });
    expect(decision.lines[1]).toBe(
      `No ${CLI_PACKAGE} version newer than the pinned 2.1.296 was published in it; the newest, 2.1.301, was covered by an earlier weekly run.`,
    );
  });

  it('ignores the window on a manual canary dispatch, but still never tests the pinned version', () => {
    const time = { '2.1.301': at(WINDOW_MS + 1) };
    const decision = decideWeekly(facts('2.1.301', time, { dispatched: true }));
    expect(decision).toMatchObject({ run: true, mode: 'canary', version: '2.1.301' });
    expect(decision.lines[1]).toBe(
      'Manual dispatch: no version newer than the pinned 2.1.296 was published in the window, and the canary tests the newest, 2.1.301, on Windows anyway.',
    );
    const macos = decideWeekly(
      facts('2.1.301', time, {
        dispatched: true,
        pin: { version: '2.1.296', darwinPending: false },
      }),
      true,
    );
    expect(macos.lines[1]).toContain('on Windows and macOS anyway.');
    expect(decideWeekly(facts('2.1.296', {}, { dispatched: true })).run).toBe(false);
  });

  it('never re-runs the pinned version, fails on an unknown registry and dry-runs on request', () => {
    expect(decideWeekly(facts('2.1.296', { '2.1.296': at(1000) })).run).toBe(false);
    expect(decideWeekly({ ...facts('2.1.301', {}), registry: null }).error).toContain(
      'registry state unknown',
    );
    expect(
      decideWeekly({ ...facts('2.1.301', {}), registry: null, mode: 'dry-run' }),
    ).toMatchObject({
      run: true,
      mode: 'dry-run',
      version: '2.1.296',
      macos: false,
    });
  });
});
