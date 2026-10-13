// Every Claude conformance variant through the loopback binding (plan §5.6
// acceptance; ADR-0006 "JSON-only boundary"; W4-Z ruling 2): the generic
// session driver of `@hudhud/core/binding`, the JSON round trip of every
// value, the public handles and the Claude user-input encoder give exactly
// what the direct replay of the session machine gives (`loopback.ts`), and
// the expect file of the recording.

import { describe, expect, it } from 'vitest';

import { projectBlock } from './expect.js';
import { loadConformanceSuites } from './loader.js';
import { compareLoopback, neutralInput, replayThroughLoopback } from './loopback.js';
import { replayVariant } from './replay.js';

const variants = loadConformanceSuites().flatMap((suite) => suite.variants);

describe('the loopback binding', () => {
  it('replays all 74 recorded variants', () => {
    expect(variants).toHaveLength(74);
  });

  for (const variant of variants) {
    it(`replays ${variant.id} with the direct replay's results`, async () => {
      const direct = replayVariant(variant);
      expect(direct.violations, 'machine-kit contract').toEqual([]);
      expect(direct.problems, 'direct replay').toEqual([]);
      const loop = await replayThroughLoopback(direct);
      expect(compareLoopback(direct, loop)).toEqual([]);
      // The expect file, from the loopback's own steps: per record line, the
      // effects in the driver's order.
      const blocks = variant.records.map((_, index) =>
        projectBlock(
          loop.steps.filter((step) => step.record === index).flatMap((step) => step.effects),
          direct.frames[index],
        ),
      );
      expect(blocks).toEqual(variant.expect);
    });
  }
});

describe('the comparison', () => {
  it('reports every kind of difference', async () => {
    const variant = variants.find((item) => item.id === 'permission-allow/linux');
    if (variant === undefined) throw new Error('permission-allow/linux is recorded');
    const direct = replayVariant(variant);
    const loop = await replayThroughLoopback(direct);
    expect(compareLoopback(direct, loop)).toEqual([]);
    const turnId = [...loop.turns.keys()][0] ?? '';
    const requestId = [...loop.requests.keys()][0] ?? '';
    const lastStep = loop.steps.length - 1;
    const tampered: [string, typeof loop][] = [
      ['problems', { ...loop, problems: ['x'] }],
      ['round trip', { ...loop, roundTripViolations: ['the step did not survive'] }],
      ['inputs', { ...loop, steps: loop.steps.slice(0, -1) }],
      [
        'effects',
        {
          ...loop,
          steps: loop.steps.map((step, index) =>
            index === lastStep ? { ...step, effects: [] } : step,
          ),
        },
      ],
      ['writes', { ...loop, written: loop.written.slice(1) }],
      ['events', { ...loop, events: loop.events.slice(1) }],
      ['start', { ...loop, start: undefined }],
      [
        'turn',
        {
          ...loop,
          turns: new Map([
            [turnId, { ok: false, code: 'X', message: 'x', details: undefined }],
          ] as const),
        },
      ],
      ['request', { ...loop, requests: new Map() }],
      ['end', { ...loop, end: { outcome: 'failed' } }],
    ];
    for (const [what, changed] of tampered) {
      expect(compareLoopback(direct, changed), what).not.toEqual([]);
    }
    expect(turnId).not.toBe('');
    expect(requestId).not.toBe('');
  });
});

describe('neutralInput', () => {
  it('reads strings, text blocks and base64 image blocks', () => {
    expect(neutralInput('hi')).toBe('hi');
    expect(
      neutralInput([
        { type: 'text', text: 'a' },
        { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lG' } },
      ]),
    ).toEqual({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', mediaType: 'image/gif', dataBase64: 'R0lG' },
      ],
    });
  });

  it('has no neutral form for anything else', () => {
    for (const content of [
      null,
      7,
      { type: 'text', text: 'not a list' },
      [{ type: 'text' }],
      [{ type: 'image', source: { type: 'url', url: 'x' } }],
      [{ type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'x' } }],
      [{ type: 'image', source: { type: 'base64', media_type: 'image/png' } }],
      ['text'],
    ]) {
      expect(neutralInput(content), JSON.stringify(content)).toBeUndefined();
    }
  });
});
