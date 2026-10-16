// Expect blocks (plan §4.3, `conformance.schema.json` expect lines): the
// exact effects and events of each record line of a replay, in a compact,
// language-neutral form a reviewer can read next to the recording.
//
// Expect file: `<suite>/<platform>[.<case>].expect.jsonl` next to the
// recording, one line `{"dir":"expect","effects":[...],"events":[...]}` per
// record line (the config line included). `effects` are the line's effects
// except `event` effects, in order; `events` are the payloads of its `event`
// effects, in order. A line's effects are those of every step it caused:
// the timers that fired before it, the input it became, and for the exit
// line `stdout.end`, the exit and `ladder.done`.
//
// Two compactions, both exact:
//
// - a `raw` member whose value equals the frame the line fed is written as
//   the string `<frame>`;
// - a string longer than 1024 UTF-16 code units is written as
//   `<text length=<n> sha256=<hex of its UTF-8>>`.
//
// The projection fails (throws) on an actual string that already looks like
// one of these markers, so a marker can never stand for itself.

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { JsonValue, MachineEffect } from '@hudhudjs/core/protocol';

import type { ExpectBlock, RecordLine } from './loader.js';
import type { ReplayResult } from './replay.js';

/** The marker of a `raw` equal to the line's frame. */
export const FRAME_MARKER = '<frame>';

/** Strings longer than this are written as their length and digest. */
export const MAX_TEXT = 1024;

const MARKER = /^(?:<frame>|<text length=\d+ sha256=[0-9a-f]{64}>)$/u;

/** The marker of a long string. */
export function textMarker(text: string): string {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  return `<text length=${String(text.length)} sha256=${digest}>`;
}

/** Compacts one value (see above); `frame` is the line's frame, if any. */
export function compact(value: JsonValue, frame: JsonValue | undefined): JsonValue {
  if (typeof value === 'string') {
    if (MARKER.test(value)) throw new Error(`an actual string looks like a marker: ${value}`);
    return value.length > MAX_TEXT ? textMarker(value) : value;
  }
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).map((item) => compact(item, frame));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'raw' && frame !== undefined && isDeepStrictEqual(item, frame)
          ? FRAME_MARKER
          : compact(item, frame),
      ]),
    );
  }
  return value;
}

/** The expect block of one record line's effects. */
export function projectBlock(
  effects: readonly MachineEffect[],
  frame: JsonValue | undefined,
): ExpectBlock {
  const plain: JsonValue[] = [];
  const events: JsonValue[] = [];
  for (const effect of effects) {
    if (effect.type === 'event') {
      events.push(compact(effect.event as unknown as JsonValue, frame));
    } else {
      plain.push(compact(effect as unknown as JsonValue, frame));
    }
  }
  return { effects: plain, events };
}

/** The expect blocks of a replay, one per record line. */
export function projectReplay(result: ReplayResult): ExpectBlock[] {
  return result.effects.map((effects, index) => projectBlock(effects, result.frames[index]));
}

/** The text of an expect file. */
export function formatExpect(blocks: readonly ExpectBlock[]): string {
  return blocks
    .map(
      (block) =>
        `${JSON.stringify({ dir: 'expect', effects: block.effects, events: block.events })}\n`,
    )
    .join('');
}

/**
 * What makes an expect file stale against a replay: a different number of
 * blocks, or the record lines (1-based, with their direction) whose block
 * differs; empty when the file agrees. Without expectations (the update
 * mode's load) everything is stale. The normal mode of the runner fails on
 * any of these; only the update mode, which never passes, rewrites the file.
 */
export function staleExpectations(
  actual: readonly ExpectBlock[],
  expected: readonly ExpectBlock[] | undefined,
  records: readonly RecordLine[],
): string[] {
  if (expected === undefined) return ['no expect file was read'];
  const stale: string[] = [];
  if (actual.length !== expected.length) {
    stale.push(`${String(expected.length)} expect lines for ${String(actual.length)} blocks`);
  }
  actual.forEach((block, index) => {
    if (!isDeepStrictEqual(block, expected[index])) {
      stale.push(`${String(index + 1)} (${String(records[index]?.dir)})`);
    }
  });
  return stale;
}
