// Every diagnostic code the Claude protocol machines emit is registered in
// the neutral DiagnosticCode list and in events.schema.json (W2-Z ruling D).
// DiagnosticCode stays open, so assignability alone proves nothing: the
// registered list is read from the committed schema.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ControlDiagnosticCode } from '../../../src/protocol/machine/control.js';
import { PERMISSION_DIAGNOSTIC_CODES } from '../../../src/protocol/machine/permission.js';
import type { SettingsGuardDiagnostic } from '../../../src/settings-guard.js';

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
const TURN_CODES = [
  'turn.unmatched-result',
  'interrupt.still-queued-retry',
  'turn.dropped',
  'turn.repeated-init',
];

/**
 * Every code the project credential guard publishes as a session diagnostic
 * (session-factory.ts), checked exhaustively at compile time (review R6-6).
 */
const GUARD_CODES: Readonly<Record<SettingsGuardDiagnostic['code'], true>> = {
  'settings-guard.git-root-unresolved': true,
  'settings-guard.symlink-followed': true,
};

/** The code the adapter adds under `projectCredentialEnv: 'allow'` (session-factory.ts). */
const GUARD_ALLOWED_CODE = 'settings-guard.allowed';

function registeredCodes(): string[] {
  const schemaUrl = new URL('../../../../core/schemas/events.schema.json', import.meta.url);
  const text = readFileSync(schemaUrl, 'utf8');
  // The open enum is an anyOf of the known literals and a plain string arm.
  const found = new Set<string>();
  for (const match of text.matchAll(
    /"((?:control|permission|turn|interrupt|settings-guard|compat)\.[a-z-]+)"/g,
  )) {
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

describe('diagnostic codes of the project credential guard', () => {
  it('are registered in the core events schema (and so in DiagnosticCode)', () => {
    // core's schema-types.test.ts holds the DiagnosticCode union equal to
    // the schema's list.
    const registered = registeredCodes();
    for (const code of [...Object.keys(GUARD_CODES), GUARD_ALLOWED_CODE]) {
      expect(registered, code).toContain(code);
    }
  });

  it('are listed in the diagnostics guide', () => {
    const guide = readFileSync(
      new URL('../../../../../docs/guide/diagnostics.md', import.meta.url),
      'utf8',
    );
    for (const code of [...Object.keys(GUARD_CODES), GUARD_ALLOWED_CODE]) {
      expect(guide, code).toContain(`\`${code}\``);
    }
  });
});

describe('the compat diagnostic of the session start', () => {
  /** The code session-factory.ts publishes for an untested version (ADR-0004 §4). */
  const COMPAT_CODE = 'compat.untested';

  it('is registered in the core events schema and listed in the guides', () => {
    expect(registeredCodes()).toContain(COMPAT_CODE);
    for (const guide of ['diagnostics.md', 'compatibility.md']) {
      const text = readFileSync(
        new URL(`../../../../../docs/guide/${guide}`, import.meta.url),
        'utf8',
      );
      expect(text, guide).toContain(`\`${COMPAT_CODE}\``);
    }
  });
});
