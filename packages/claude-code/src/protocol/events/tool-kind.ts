/**
 * Claude tool name to neutral tool kind (plan §1.5; ACP vocabulary, 06 §H12).
 *
 * @packageDocumentation
 */

import type { ToolKind } from '@hudhudjs/core/protocol';

/**
 * The kind of every Claude tool the plan maps. Any other name is `other`.
 *
 * @remarks
 * The rule: a tool gets the kind of the effect it has on the user's machine
 * or the world, taken from the ACP vocabulary of `ToolKind`; a tool whose
 * effect is internal to Claude Code (subagents, tasks, plan mode, loading
 * deferred tool schemas with `ToolSearch`, questions to the user) stays
 * `other`. The kind is per tool name, not per call: a tool with several
 * forms gets the kind of its main one.
 *
 * - `Monitor` (on by default from CLI 2.1.310) starts a command in the
 *   background and reports each line it prints, like a Bash call with
 *   `run_in_background`: `execute`. Its rarer form that watches a WebSocket
 *   (`ws` instead of `command`) is the same tool and keeps that kind.
 *
 * @internal
 */
export const CLAUDE_TOOL_KINDS: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ['Bash', 'execute'],
  ['PowerShell', 'execute'],
  ['Monitor', 'execute'],
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
