/**
 * Failures of the sandboxed test launcher (plan §1.11, §4.4). Every refusal
 * is fatal: a test that cannot get an isolated sandbox fails with
 * instructions, it never skips and never falls back to a weaker setup
 * (05 §13.1).
 */

/** Why the launcher refused. */
export type SandboxRefusalCode =
  /** The run directory has the real home, or a `.claude`/`CLAUDE.md`/`.mcp.json` ancestor. */
  | 'forbidden-ancestor'
  /** The test root is unusable (not absolute, not a directory, too long for the Linux socket). */
  | 'test-root'
  /** A launch option would weaken the sandbox (pinned env key, reserved flag, bad value). */
  | 'unsafe-option'
  /** The binary is not the verified pinned CLI, or changed since it was verified. */
  | 'binary'
  /** The mock (and with it the egress trap) is not a loopback URL. */
  | 'mock'
  /** A real-CLI run on a host where it is refused (a local macOS host, `host-policy.ts`). */
  | 'host';

/** Error raised when the sandbox cannot be built or a launch would weaken it. */
export class SandboxRefusedError extends Error {
  /** Machine-readable reason. */
  readonly code: SandboxRefusalCode;

  constructor(code: SandboxRefusalCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxRefusedError';
    this.code = code;
  }
}
