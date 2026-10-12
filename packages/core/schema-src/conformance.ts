// Golden conformance fixture line format (ADR-0006, plan §1.11): source of
// schemas/conformance.schema.json. Fixture lines are authored by hudhud, so
// unknown keys are refused (a typo must not pass as an ignored field).

import Type from 'typebox';

import { Count, JsonValueSchema, list, type SchemaDocument } from './common.js';

/** A recorded input or output at time `t` (ms since the case started). */
export const ConformanceRecordLine = Type.Object(
  {
    t: Count,
    dir: Type.Enum(['config', 'in', 'out', 'err', 'exit', 'cmd', 'timer']),
    v: JsonValueSchema,
  },
  { additionalProperties: false },
);

/** The effects and events expected after the preceding record lines. */
export const ConformanceExpectLine = Type.Object(
  {
    dir: Type.Literal('expect'),
    effects: list(JsonValueSchema),
    events: list(JsonValueSchema),
  },
  { additionalProperties: false },
);

export const ConformanceLine = Type.Union([ConformanceRecordLine, ConformanceExpectLine]);

export const conformanceDocument: SchemaDocument = {
  file: 'conformance.schema.json',
  title: 'hudhud conformance fixture line',
  description:
    'One line of a language-neutral golden conformance suite (JSONL): record lines replayed against a machine, then an expect line.',
  root: 'ConformanceLine',
  defs: { ConformanceRecordLine, ConformanceExpectLine, ConformanceLine },
};
