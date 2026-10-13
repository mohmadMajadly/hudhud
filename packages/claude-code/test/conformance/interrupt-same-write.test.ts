// interrupt-same-write (GH#98713; 05 §7 run 36): why the replay's drain
// waits for the recorded exit, with evidence from the recordings (W4-Z
// ruling 8). Verdict: a recording artefact, not a product defect.
//
// - The recorder wrote turn 2's user message and an interrupt in the same
//   millisecond (the bug's trigger). The CLI answered that interrupt at once
//   with `still_queued: [turn 2]`, before turn 2's `system/init`, and then
//   ran turn 2 to completion (the bug).
// - hudhud never writes that sequence: it holds an interrupt until the
//   turn's `system/init` (ADR-0008, GH#98713 gating) and writes it there. The
//   recorder never made that write, so the recording has no answer to it, and
//   the machine keeps it as a pending control request: the drain (K13) ends
//   stdin only once nothing is pending, so it waits until the recorded exit.
// - An interrupt written after a turn's `system/init` is answered at once:
//   recorded in interrupt-midstream on both OSes (`still_queued: []` within
//   a few milliseconds; 05 §7 run 37: with a 50 ms gap the interrupt lands
//   after `system/init` and turn 2 aborts in 69 ms). With that answer in
//   place, the same recording drains at the CLI's idle, the close deadline
//   never fires, and the session ends `closed`.
//
// What could still hold the drain while nothing is pending is ruled out by
// the machine itself: an interrupt held for a turn that ends before its
// `system/init` settles with that turn (session unit test "does not wait for
// an interrupt held for a turn that ended before its system/init").

import type { JsonObject, JsonValue, MachineEffect } from '@hudhud/core/protocol';
import { describe, expect, it } from 'vitest';

import { loadConformanceSuites, type ConformanceVariant, type RecordLine } from './loader.js';
import { replayVariant } from './replay.js';
import { summarize } from './summary.js';

const suites = loadConformanceSuites();

function variantOf(id: string): ConformanceVariant {
  const found = suites.flatMap((suite) => suite.variants).find((item) => item.id === id);
  if (found === undefined) throw new Error(`${id} is recorded`);
  return found;
}

function field(value: JsonValue | undefined, ...path: string[]): JsonValue | undefined {
  let current = value;
  for (const key of path) {
    current =
      typeof current === 'object' && current !== null && !Array.isArray(current)
        ? (current as JsonObject)[key]
        : undefined;
  }
  return current;
}

function indexOf(records: readonly RecordLine[], match: (record: RecordLine) => boolean): number {
  return records.findIndex(match);
}

const isInit = (record: RecordLine): boolean =>
  record.dir === 'out' &&
  field(record.v, 'type') === 'system' &&
  field(record.v, 'subtype') === 'init';

const isInterrupt = (record: RecordLine): boolean =>
  record.dir === 'in' && field(record.v, 'request', 'subtype') === 'interrupt';

const answers = (requestId: string) => (record: RecordLine) =>
  record.dir === 'out' &&
  field(record.v, 'type') === 'control_response' &&
  field(record.v, 'response', 'request_id') === requestId;

for (const platform of ['linux', 'win32'] as const) {
  describe(`interrupt-same-write/${platform}`, () => {
    const variant = variantOf(`interrupt-same-write/${platform}`);
    const records = variant.records;
    const interrupt = indexOf(records, isInterrupt);
    const user = interrupt - 1;
    const answer = indexOf(records, answers('int_2'));
    const secondInit = records.findIndex((record, index) => index > interrupt && isInit(record));

    it('recorded the bug: one write, an at-once still_queued answer, the turn ran on', () => {
      expect(field(records[user]?.v, 'type')).toBe('user');
      expect(records[interrupt]?.t).toBe(records[user]?.t);
      const turnTwo = field(records[user]?.v, 'uuid');
      expect(field(records[answer]?.v, 'response', 'response', 'still_queued')).toEqual([turnTwo]);
      expect(answer).toBeLessThan(secondInit);
      expect((records[answer]?.t ?? 0) - (records[interrupt]?.t ?? 0)).toBeLessThan(20);
    });

    it("replays as recorded: the machine's own interrupt has no answer, the drain waits for the exit", () => {
      const result = replayVariant(variant);
      expect(result.violations).toEqual([]);
      expect(result.problems).toEqual([]);
      // hudhud's interrupt is written in the step of turn 2's system/init.
      const writes = (index: number): readonly MachineEffect[] =>
        (result.effects[index] ?? []).filter((effect) => effect.type === 'write');
      expect(writes(secondInit)).toHaveLength(1);
      expect(writes(secondInit)[0]).toMatchObject({
        line: expect.stringContaining('"subtype":"interrupt"') as unknown,
      });
      // No stdin.end before the exit; the interrupt settles at the exit.
      const exit = records.length - 1;
      expect(
        result.effects
          .slice(0, exit)
          .flat()
          .some((effect) => effect.type === 'stdin.end'),
      ).toBe(false);
      expect(result.effects[exit]).toContainEqual(
        expect.objectContaining({ type: 'control.settle', correlation: 'int_2', ok: true }),
      );
    });

    it('drains at the idle once the interrupt hudhud writes is answered as the CLI answers it', () => {
      // The answer the CLI gives an interrupt written after the turn's
      // system/init (interrupt-midstream, same OS).
      const midstream = variantOf(`interrupt-midstream/${platform}`).records;
      const asked = indexOf(midstream, isInterrupt);
      const answered = indexOf(midstream, answers('int_1'));
      expect(asked).toBeGreaterThan(indexOf(midstream, isInit));
      expect((midstream[answered]?.t ?? 0) - (midstream[asked]?.t ?? 0)).toBeLessThan(20);
      expect(field(midstream[answered]?.v, 'response', 'response')).toEqual({ still_queued: [] });

      // The same recording, with that answer right after turn 2's system/init.
      const at = records[secondInit]?.t ?? 0;
      const reply: RecordLine = {
        t: at,
        dir: 'out',
        v: {
          type: 'control_response',
          response: { subtype: 'success', request_id: 'int_2', response: { still_queued: [] } },
        },
      };
      const withAnswer: ConformanceVariant = {
        ...variant,
        records: [...records.slice(0, secondInit + 1), reply, ...records.slice(secondInit + 1)],
      };
      const result = replayVariant(withAnswer);
      expect(result.violations).toEqual([]);
      expect(result.problems).toEqual([]);
      // The interrupt settles at its answer; stdin ends at the CLI's idle
      // after the recorder's EOF, before the exit; the deadline never fires.
      expect(result.effects[secondInit + 1]).toContainEqual(
        expect.objectContaining({ type: 'control.settle', correlation: 'int_2', ok: true }),
      );
      const eof = withAnswer.records.findIndex((record) => record.dir === 'cmd');
      const ended = result.effects.findIndex((effects) =>
        effects.some((effect) => effect.type === 'stdin.end'),
      );
      expect(ended).toBeGreaterThan(eof);
      expect(ended).toBeLessThan(withAnswer.records.length - 1);
      expect(field(withAnswer.records[ended]?.v, 'state')).toBe('idle');
      expect(
        result.steps.some((step) => step.input.type === 'timer' && step.input.name === 'close'),
      ).toBe(false);
      expect(summarize(result.effects.flat())).toMatchObject({
        controls: ['int_2 ok'],
        session: 'closed',
      });
    });
  });
}
