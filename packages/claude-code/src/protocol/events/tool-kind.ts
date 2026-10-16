/**
 * Claude tool name to neutral tool kind (plan §1.5; ACP vocabulary, 06 §H12).
 *
 * @packageDocumentation
 */

import type { ToolKind } from '@hudhudjs/core/protocol';

/**
 * The kind of every Claude tool the plan maps. Any other name is `other`.
 *
 * @internal
 */
export const CLAUDE_TOOL_KINDS: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
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
]);

/**
 * Maps a Claude tool name to its neutral kind. The match is exact and
 * case-sensitive; MCP tools, subagent tools and unknown names are `other`.
 *
 * @internal
 */
export function claudeToolKind(toolName: string): ToolKind {
  return CLAUDE_TOOL_KINDS.get(toolName) ?? 'other';
}
