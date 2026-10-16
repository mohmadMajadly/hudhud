// The runner's smaller parts: the expect projection and its compactions,
// the outcome summary, the schema and JSON checks, the plan's suite list.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { MachineEffect } from '@hudhudjs/core/protocol';

import { planSuites, roundTrips, schemaIssues } from './checks.js';
import {
  FRAME_MARKER,
  MAX_TEXT,
  compact,
  formatExpect,
  projectBlock,
  staleExpectations,
  textMarker,
} from './expect.js';
import type { RecordLine } from './loader.js';
import { summarize, turnNames } from './summary.js';

const ERROR = { code: 'SESSION_CLOSED', message: 'closed', retryable: false };

describe('expect projection', () => {
  it('writes a raw equal to the line frame as <frame> and keeps any other raw', () => {
    const frame = { type: 'assistant', n: 1 };
    expect(compact({ raw: { type: 'assistant', n: 1 }, nested: { raw: frame } }, frame)).toEqual({
      raw: FRAME_MARKER,
      nested: { raw: FRAME_MARKER },
    });
    expect(compact({ raw: { type: 'other' } }, frame)).toEqual({ raw: { type: 'other' } });
    expect(compact({ raw: frame }, undefined)).toEqual({ raw: frame });
  });

  it('writes a long string as its length and SHA-256, a short one as is', () => {
    const long = 'é'.repeat(MAX_TEXT + 1);
    const digest = createHash('sha256').update(long, 'utf8').digest('hex');
    expect(textMarker(long)).toBe(`<text length=${String(MAX_TEXT + 1)} sha256=${digest}>`);
    expect(compact([long, 'short', 1, null, false], undefined)).toEqual([
      textMarker(long),
      'short',
      1,
      null,
      false,
    ]);
  });

  it('refuses an actual string that looks like a marker', () => {
    expect(() => compact('<frame>', undefined)).toThrow(/looks like a marker/u);
    expect(() => compact({ a: textMarker('x') }, undefined)).toThrow(/looks like a marker/u);
  });

  it('splits events from the other effects and formats one expect line per block', () => {
    const effects: MachineEffect[] = [
      { type: 'timer.set', name: 'idle', ms: 5 },
      {
        type: 'event',
        event: { type: 'session.state', state: 'idle', raw: {}, seq: 1, ts: 't', sessionId: 's' },
      },
    ];
    const block = projectBlock(effects, {});
    expect(block).toEqual({
      effects: [{ type: 'timer.set', name: 'idle', ms: 5 }],
      events: [
        {
          type: 'session.state',
          state: 'idle',
          raw: FRAME_MARKER,
          seq: 1,
          ts: 't',
          sessionId: 's',
        },
      ],
    });
    expect(formatExpect([block, { effects: [], events: [] }])).toBe(
      `${JSON.stringify({ dir: 'expect', ...block })}\n{"dir":"expect","effects":[],"events":[]}\n`,
    );
  });
});

describe('stale expect files', () => {
  const records: RecordLine[] = [
    { t: 0, dir: 'config', v: {} },
    { t: 1, dir: 'out', v: {} },
  ];
  const fresh = [
    { effects: [], events: [] },
    { effects: [{ type: 'stdin.end' }], events: [] },
  ];

  it('finds nothing when the expect file agrees with the replay', () => {
    expect(staleExpectations(fresh, fresh, records)).toEqual([]);
  });

  it('finds a well-formed but outdated line, a line count that differs, and no file', () => {
    const outdated = [fresh[0] ?? { effects: [], events: [] }, { effects: [], events: [] }];
    expect(staleExpectations(fresh, outdated, records)).toEqual(['2 (out)']);
    expect(staleExpectations(fresh, fresh.slice(0, 1), records)).toEqual([
      '1 expect lines for 2 blocks',
      '2 (out)',
    ]);
    expect(staleExpectations(fresh, undefined, records)).toEqual(['no expect file was read']);
    expect(staleExpectations(fresh, [...fresh, ...fresh], records)).toEqual([
      '4 expect lines for 2 blocks',
    ]);
  });
});

describe('summary', () => {
  it('names application turns in order of first appearance, harness turns by their own id', () => {
    const second = '00000000-0000-4000-8000-000000000012';
    const first = '00000000-0000-4000-9000-000000000003';
    const name = turnNames([
      { type: 'timer.set', name: 'idle', ms: 1 },
      {
        type: 'event',
        event: { type: 'turn.queued', turnId: first, seq: 1, ts: 't', sessionId: 's' },
      },
      { type: 'turn.fail', turnId: second, error: ERROR },
      { type: 'turn.fail', turnId: first, error: ERROR },
      { type: 'turn.fail', turnId: 'bg-1', error: ERROR },
    ]);
    expect(name(first)).toBe('turn-1');
    expect(name(second)).toBe('turn-2');
    expect(name('bg-1')).toBe('bg-1');
    expect(name('unknown')).toBe('unknown');
  });

  it('summarizes every effect kind it reads, in order', () => {
    const effects: MachineEffect[] = [
      { type: 'handshake.fail', error: ERROR },
      { type: 'send.rejected', turnId: 'x', error: ERROR },
      { type: 'control.settle', correlation: 'c1', ok: false, error: ERROR },
      { type: 'control.settle', correlation: 'c2', ok: true, response: null },
      { type: 'session.end', outcome: 'failed', error: ERROR },
      {
        type: 'event',
        event: { type: 'diagnostic', code: 'd', message: 'm', seq: 1, ts: 't', sessionId: 's' },
      },
      { type: 'write', line: '{}\n' },
    ];
    expect(summarize(effects)).toEqual({
      handshake: 'SESSION_CLOSED',
      turns: ['x rejected SESSION_CLOSED'],
      permissions: [],
      controls: ['c1 fail SESSION_CLOSED', 'c2 ok'],
      ladder: [],
      diagnostics: ['d'],
      session: 'failed SESSION_CLOSED',
    });
    expect(summarize([])).toMatchObject({ handshake: 'none', session: 'none' });
  });
});

describe('checks', () => {
  it('flags an event, a write and an error outside the committed schemas', () => {
    const effects = [
      { type: 'event', event: { type: 'turn.queued', seq: 1 } },
      { type: 'write', line: '{"type":"user"}\n' },
      { type: 'turn.fail', turnId: 't', error: { code: 'x' } },
      { type: 'handshake.fail', error: ERROR },
      { type: 'control.settle', correlation: 'c', ok: false, error: { code: 1 } },
      { type: 'control.settle', correlation: 'c', ok: true, response: null },
      { type: 'session.end', outcome: 'closed', error: {} },
      { type: 'session.end', outcome: 'closed' },
      { type: 'timer.set', name: 'idle', ms: 1 },
    ] as unknown as MachineEffect[];
    expect(schemaIssues(effects)).toEqual([
      'event turn.queued',
      'write {"type":"user"}',
      'turn.fail error',
      'control.settle error',
      'session.end error',
    ]);
  });

  it('tells values that survive JSON from those that do not', () => {
    expect(roundTrips({ a: [1, 'b', null, { c: true }] })).toBe(true);
    expect(roundTrips({ a: undefined })).toBe(false);
    expect(roundTrips({ at: new Date(0) })).toBe(false);
    expect(roundTrips(-0)).toBe(false);
  });

  it('reads the plan suite list and its additions, and refuses a plan without them', () => {
    const plan = [
      '### 4.3 Golden fixtures',
      'Recorded. Suites: `a`, `b-c`. Both OSes. As built: suite `d`; later suite `e`.',
      '### 4.4 Next',
      'suite `f`',
    ].join('\n');
    expect(planSuites(plan)).toEqual({ list: ['a', 'b-c'], additions: ['d', 'e'] });
    expect(planSuites(plan.split('\n### 4.4')[0])).toEqual({
      list: ['a', 'b-c'],
      additions: ['d', 'e'],
    });
    expect(() => planSuites('# nothing')).toThrow(/plan §4.3 not found/u);
    expect(() => planSuites('### 4.3 Golden fixtures\nno list')).toThrow(/no suite list/u);
  });
});
