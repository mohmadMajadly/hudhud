import { describe, expect, it } from 'vitest';

import { CLAUDE_TOOL_KINDS, claudeToolKind } from '../../../src/protocol/events/tool-kind.js';

const TABLE: readonly (readonly [string, string])[] = [
  ['Bash', 'execute'],
  ['PowerShell', 'execute'],
  ['Read', 'read'],
  ['NotebookRead', 'read'],
  ['Edit', 'edit'],
  ['Write', 'edit'],
  ['NotebookEdit', 'edit'],
  ['Glob', 'search'],
  ['Grep', 'search'],
  ['WebFetch', 'fetch'],
  ['WebSearch', 'fetch'],
  ['Task', 'other'],
  ['Skill', 'other'],
  ['TodoWrite', 'other'],
  ['mcp__server__tool', 'other'],
  ['bash', 'other'],
  ['read', 'other'],
  ['', 'other'],
  ['__proto__', 'other'],
  ['constructor', 'other'],
  ['toString', 'other'],
];

describe('claudeToolKind', () => {
  it.each(TABLE)('maps %s to %s', (name, kind) => {
    expect(claudeToolKind(name)).toBe(kind);
  });

  it('has exactly the planned mappings', () => {
    expect([...CLAUDE_TOOL_KINDS.entries()]).toEqual(TABLE.filter(([, kind]) => kind !== 'other'));
  });
});
