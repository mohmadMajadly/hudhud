// Checks the conformance runner applies to every replay, beyond the machine
// kit and the expect blocks: the committed schemas, the JSON boundary and
// the plan's suite list.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import type { MachineEffect } from '@hudhudjs/core/protocol';

import {
  validateErrorData,
  validateKnownHudhudEvent,
} from '../../../core/src/protocol/generated/validators.gen.js';
import { validateOutboundFrame } from '../../src/protocol/generated/validators.gen.js';

const PLAN = fileURLToPath(new URL('../../../../docs/plan/v1-implementation.md', import.meta.url));

/**
 * The suites the plan names in §4.3: the list after "Suites:" and the
 * as-built additions ("suite `<name>`") of the same paragraph.
 */
export function planSuites(text = readFileSync(PLAN, 'utf8')): {
  readonly list: string[];
  readonly additions: string[];
} {
  const start = text.indexOf('### 4.3 Golden fixtures');
  if (start < 0) throw new Error('plan §4.3 not found');
  const end = text.indexOf('\n### ', start + 1);
  const paragraph = text.slice(start, end < 0 ? undefined : end);
  const listed = /Suites: (.*?)\. Both OSes/su.exec(paragraph)?.[1];
  if (listed === undefined) throw new Error('plan §4.3 has no suite list');
  const names = (source: string, pattern: RegExp): string[] =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? '');
  return {
    list: names(listed, /`([a-z0-9-]+)`/gu),
    additions: names(paragraph, /suite `([a-z0-9-]+)`/gu),
  };
}

/**
 * Effects that break a committed schema: an event outside
 * `events.schema.json` (known types, strict), an error outside
 * `errors.schema.json`, a write outside the strict outbound schema.
 */
export function schemaIssues(effects: readonly MachineEffect[]): string[] {
  const issues: string[] = [];
  const check = (label: string, outcome: { readonly ok: boolean }): void => {
    if (!outcome.ok) issues.push(label);
  };
  for (const effect of effects) {
    if (effect.type === 'event') {
      check(`event ${effect.event.type}`, validateKnownHudhudEvent(effect.event));
    } else if (effect.type === 'write') {
      check(`write ${effect.line.trimEnd()}`, validateOutboundFrame(JSON.parse(effect.line)));
    } else if (
      effect.type === 'handshake.fail' ||
      effect.type === 'turn.fail' ||
      effect.type === 'send.rejected'
    ) {
      check(`${effect.type} error`, validateErrorData(effect.error));
    } else if (effect.type === 'control.settle' && !effect.ok) {
      check('control.settle error', validateErrorData(effect.error));
    } else if (effect.type === 'session.end' && effect.error !== undefined) {
      check('session.end error', validateErrorData(effect.error));
    }
  }
  return issues;
}

/**
 * Whether a value survives a JSON round trip unchanged: plain objects and
 * arrays only (prototypes compared), no `undefined` member, no `-0`.
 */
export function roundTrips(value: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(value)) as unknown, value);
}
