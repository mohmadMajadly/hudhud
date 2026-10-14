/**
 * Unstable raw tier of the Claude Code adapter.
 *
 * @remarks
 * Exempt from compatibility promises (ADR-0004): the wire frames of the
 * Claude Code CLI as they are, and, only when the Harness was connected with
 * `claudeCode.dangerouslyAllowRawControl`, raw control requests and frames.
 *
 * @packageDocumentation
 */

export { createSessionRaw, raw } from './session.js';
export type { RawFrame, RawGap, RawSession, RawSpawnOptions, RawWireFrame } from './session.js';

// Type-only re-exports of the root types the signatures above name, so this
// entry point's API report is self-contained (as `@hudhud/core/binding` does).
export type { ClaudeCodeHarness } from '../connect.js';
export type {
  ClaudeCodeSessionOptions,
  EnvOption,
  PermissionMode,
  ResumeOptions,
  SessionOptions,
  SettingSource,
  WorkspaceTrust,
} from '../options-types.js';
