/**
 * Claude Code adapter for hudhud.
 *
 * @remarks
 * `connect()` verifies the Claude Code binary and returns a Harness;
 * `session()` is the one-call form; `hudhud` bundles both. The unstable
 * wire-level tier is the separate `@hudhud/claude-code/raw` entry point
 * (ADR-0003, ADR-0004).
 *
 * @packageDocumentation
 */

export { connect, hudhud, session } from './connect.js';
export type { ClaudeCodeHarness } from './connect.js';
export { CLAUDE_CODE_COMPAT } from './compat.js';
export type {
  ClaudeCodeConnectOptions,
  ClaudeCodeSessionOptions,
  ConnectOptions,
  EnvOption,
  PermissionMode,
  ResumeOptions,
  SessionOptions,
  SettingSource,
  WorkspaceTrust,
} from './options-types.js';
