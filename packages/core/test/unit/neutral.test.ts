// The core is harness-neutral (K3): no Claude Code wire vocabulary in its
// sources, schema sources or committed schemas. Everything that encodes the
// stream-json and control protocol lives in @hudhudjs/claude-code.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));

/** Claude Code wire vocabulary (plan §1.2). */
const CLAUDE_WIRE_VOCABULARY = [
  'control_request',
  'can_use_tool',
  'system/init',
  'stream-json',
  '--permission-mode',
] as const;

/** Directories of the core that must stay neutral. */
const SCANNED = ['src', 'schema-src', 'schemas'];

/**
 * @returns Every file below `dir`, relative to the package, forward slashes.
 */
function files(dir: string): string[] {
  return readdirSync(path.join(PACKAGE, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(PACKAGE, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
    );
}

/** Findings `file: term` for every vocabulary term in the given files. */
function findWireVocabulary(texts: ReadonlyMap<string, string>): string[] {
  const findings: string[] = [];
  for (const [file, text] of texts) {
    for (const term of CLAUDE_WIRE_VOCABULARY) {
      if (text.includes(term)) findings.push(`${file}: ${term}`);
    }
  }
  return findings;
}

describe('core neutrality (K3)', () => {
  it('scans the sources, schema sources and committed schemas', () => {
    const scanned = SCANNED.flatMap(files);
    expect(scanned).toContain('src/protocol/json.ts');
    expect(scanned).toContain('src/protocol/generated/validators.gen.ts');
    expect(scanned).toContain('schema-src/events.ts');
    expect(scanned).toContain('schemas/events.schema.json');
    expect(scanned).toContain('schemas/.baseline/events.schema.json');
  });

  it('contains no Claude Code wire vocabulary', () => {
    const texts = new Map(
      SCANNED.flatMap(files).map((file) => [file, readFileSync(path.join(PACKAGE, file), 'utf8')]),
    );
    expect(findWireVocabulary(texts)).toEqual([]);
  });

  it('would find each term', () => {
    const planted = new Map(CLAUDE_WIRE_VOCABULARY.map((term) => [`${term}.ts`, `x ${term} y`]));
    expect(findWireVocabulary(planted)).toHaveLength(CLAUDE_WIRE_VOCABULARY.length);
  });
});
