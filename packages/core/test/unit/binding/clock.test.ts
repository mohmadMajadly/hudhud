// The binding's clocks and ids (ADR-0006): the real clock, the manual
// clock of the deterministic tests and replays, and the id sources.

import { describe, expect, it } from 'vitest';

import { counterIds, cryptoIds, ManualClock, systemClock } from '../../../src/binding/clock.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('systemClock', () => {
  it('is monotonic and maps to ISO time', () => {
    const a = systemClock.nowMs();
    const b = systemClock.nowMs();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(Math.abs(Date.parse(systemClock.nowIso()) - Date.now())).toBeLessThan(60_000);
  });

  it('schedules with Node timers and cancels', async () => {
    const fired: string[] = [];
    const cancel = systemClock.schedule(0, () => fired.push('cancelled'));
    cancel();
    cancel();
    await new Promise<void>((resolve) => {
      systemClock.schedule(0, () => {
        fired.push('fired');
        resolve();
      });
    });
    expect(fired).toEqual(['fired']);
  });
});

describe('ids', () => {
  it('cryptoIds are fresh v4 UUIDs', () => {
    const a = cryptoIds.uuid();
    expect(a).toMatch(UUID);
    expect(cryptoIds.uuid()).not.toBe(a);
  });

  it('counterIds are deterministic UUID-shaped ids', () => {
    const ids = counterIds();
    expect([ids.uuid(), ids.uuid()]).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(counterIds(255).uuid()).toBe('00000000-0000-4000-8000-0000000000ff');
    expect(counterIds().uuid()).toMatch(UUID);
  });
});

describe('ManualClock', () => {
  it('fires timers in deadline order, ties in scheduling order, only when time moves', () => {
    const clock = new ManualClock(1000);
    expect(clock.nowIso()).toBe('1970-01-01T00:00:01.000Z');
    const fired: string[] = [];
    clock.schedule(20, () => fired.push('b'));
    clock.schedule(10, () => fired.push('a1'));
    clock.schedule(10, () => fired.push('a2'));
    const cancel = clock.schedule(15, () => fired.push('cancelled'));
    clock.schedule(-5, () => fired.push('now'));
    cancel();
    expect(clock.pending).toBe(4);
    expect(clock.nextAt).toBe(1000);
    clock.advance(10);
    expect(fired).toEqual(['now', 'a1', 'a2']);
    expect(clock.nowMs()).toBe(1010);
    clock.advance(-1);
    expect(clock.nowMs()).toBe(1010);
    expect(clock.fireNext()).toBe(true);
    expect(clock.nowMs()).toBe(1020);
    expect(clock.fireNext()).toBe(false);
    expect(clock.nextAt).toBeUndefined();
    expect(fired).toEqual(['now', 'a1', 'a2', 'b']);
  });

  it('fires timers scheduled by a firing timer when they fall due within the advance', () => {
    const clock = new ManualClock();
    const fired: number[] = [];
    clock.schedule(5, () => {
      fired.push(clock.nowMs());
      clock.schedule(5, () => fired.push(clock.nowMs()));
    });
    clock.advance(20);
    const start = Date.UTC(2026, 0, 1);
    expect(fired).toEqual([start + 5, start + 10]);
    expect(clock.nowMs()).toBe(start + 20);
  });

  it('keeps its order and counts across the compaction of cancelled timers', () => {
    // A driver re-arms its idle timer on every frame: 100 000 re-arms without
    // time moving leave one live timer, and the dead ones are compacted away.
    const clock = new ManualClock(0);
    const fired: string[] = [];
    let cancel = clock.schedule(1, () => fired.push('idle-0'));
    clock.schedule(5, () => fired.push('close'));
    for (let n = 1; n <= 100_000; n += 1) {
      cancel();
      cancel(); // a second cancel changes nothing
      cancel = clock.schedule(1, () => fired.push(`idle-${String(n)}`));
    }
    expect(clock.pending).toBe(2);
    expect(clock.nextAt).toBe(1);
    // Firing retires the timer too.
    expect(clock.fireNext()).toBe(true);
    cancel();
    clock.advance(10);
    expect(fired).toEqual(['idle-100000', 'close']);
    expect(clock.pending).toBe(0);
  });
});
