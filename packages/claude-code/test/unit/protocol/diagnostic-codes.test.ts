// Every diagnostic code the Claude protocol machines emit is registered in
// the neutral DiagnosticCode list and in events.schema.json (W2-Z ruling D).
// DiagnosticCode stays open, so assignability alone proves nothing: the
// registered list is read from the committed schema.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ControlDiagnosticCode } from '../../../src/protocol/machine/control.js';
import { PERMISSION_DIAGNOSTIC_CODES } from '../../../src/protocol/machine/permission.js';

/** Every member of ControlDiagnosticCode, checked exhaustively at compile time. */
const CONTROL_CODES: Readonly<Record<ControlDiagnosticCode, true>> = {
  'control.unknown-response': true,
  'control.late-response': true,
  'control.duplicate-request': true,
  'control.unknown-cancel': true,
  'control.unsupported-request': true,
  'control.unanswered-request': true,
  'control.malformed-request': true,
  'control.answer-not-pending': true,
  'control.answer-failed': true,
};

/** Codes the turn machine emits (its effect type keeps `code: string`). */
const TURN_CODES = ['turn.unmatched-result', 'interrupt.still-queued-retry'];

function registeredCodes(): string[] {
  const schemaUrl = new URL('../../../../core/schemas/events.schema.json', import.meta.url);
  const text = readFileSync(schemaUrl, 'utf8');
  // The open enum is an anyOf of the known literals and a plain string arm.
  const found = new Set<string>();
  for (const match of text.matchAll(/"((?:control|permission|turn|interrupt)\.[a-z-]+)"/g)) {
    found.add(match[1] ?? '');
  }
  return [...found].sort();
}

describe('diagnostic codes of the Claude machines', () => {
  it('are registered in the core events schema', () => {
    const registered = registeredCodes();
    for (const code of [
      ...Object.keys(CONTROL_CODES),
      ...PERMISSION_DIAGNOSTIC_CODES,
      ...TURN_CODES,
    ]) {
      expect(registered, code).toContain(code);
    }
  });
});
