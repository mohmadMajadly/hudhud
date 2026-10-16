// `cmd.permission-abort` is an internal protocol input (W7-T5 item 2, plan
// §5.9): no application-facing API offers it as an action. It is part of the
// adapter-author machine contract (`CommandInput`, the protocol and binding
// entry points), and the binding feeds it only through
// `SessionDriver.command`, which the conformance replay uses for a recorded
// control-error answer. The committed API reports are the public surface
// (API Extractor fails `pnpm check` when they drift), so this test reads
// them.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../../../../', import.meta.url));

function report(file: string): string {
  return readFileSync(`${PACKAGES}${file}`, 'utf8');
}

function reportLines(file: string): string[] {
  return report(file).split(/\r?\n/);
}

/** The entry points an application imports. */
const APPLICATION_REPORTS = [
  'core/api/core.api.md',
  'claude-code/api/claude-code.api.md',
  'claude-code/api/claude-code-raw.api.md',
  'hudhud/api/hudhud.api.md',
];

/** The adapter-author entry points of the core. */
const ADAPTER_REPORTS = ['core/api/core-protocol.api.md', 'core/api/core-binding.api.md'];

describe('cmd.permission-abort is not an application action', () => {
  it.each(APPLICATION_REPORTS)('%s offers no raw command input', (file) => {
    const text = report(file);
    for (const term of ['permission-abort', 'CommandInput', 'SessionDriver', 'command(']) {
      expect(text, term).not.toContain(term);
    }
  });

  it.each(ADAPTER_REPORTS)('%s names it only in CommandInput', (file) => {
    const lines = reportLines(file);
    const commandInput = lines.findIndex((line) => line.startsWith('export type CommandInput ='));
    expect(commandInput).toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > commandInput && line.endsWith('};'));
    const mentions = lines.flatMap((line, index) =>
      line.includes('permission-abort') ? [index] : [],
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toBeGreaterThan(commandInput);
    expect(mentions[0]).toBeLessThan(end);
  });

  it('is fed by SessionDriver.command alone in the binding', () => {
    const lines = reportLines('core/api/core-binding.api.md');
    const takers = lines.filter((line) => /\(\s*\w+\s*:\s*CommandInput\s*\)/.test(line));
    expect(takers.map((line) => line.trim())).toEqual(['command(input: CommandInput): void;']);
  });
});
