/**
 * Host access of the macOS gate harness (plan §5.4 M1), injected.
 *
 * @remarks
 * Types only. The real implementation is the thin wrapper
 * `bin/macos-gate.mjs` (Node.js built-ins, no logic); every decision is made
 * in `src/` against this interface, so the harness is unit-tested on any OS
 * with a simulated host.
 */

import type { ExecutableFs } from '../../../packages/core/src/process/binary-path.js';
import type { CwdFs } from '../../../packages/core/src/process/cwd.js';
import type { SignatureDeps } from '../../../packages/core/src/process/verify/os-signature.js';
import type { VerifyBinaryOptions } from '../../../packages/core/src/process/verify/verify.js';
import type { RegistryOptions } from '../../test-support/src/cli/registry.js';
import type { MockServer } from '../../test-support/src/mock/server.js';

/** Options of {@link GateHost.run}. */
export interface RunOptions {
  /** The complete environment of the child; nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** The child is killed with SIGKILL after this many milliseconds. */
  readonly timeoutMs: number;
}

/** Outcome of a short command run to completion. */
export interface RunResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  /** UTF-8, lossy, bounded by the host. */
  readonly stderr: string;
  /**
   * `undefined` when the command ran; the errno code when it could not be
   * started (`ENOENT`, `EACCES`, ...); `ETIMEDOUT` when the timeout killed it.
   */
  readonly error: string | undefined;
}

/** How a spawned child ended. */
export interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** The errno code when the spawn itself failed. */
  readonly error: string | undefined;
}

/** A long-running child with piped stdio (the CLI under test). */
export interface ChildHandle {
  /** `undefined` when the spawn failed synchronously. */
  readonly pid: number | undefined;
  /** Writes to stdin; ignored after {@link ChildHandle.endInput} or exit. */
  write(text: string): void;
  /** Closes stdin (EOF). Idempotent. */
  endInput(): void;
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  /** Resolves once, when the child has exited; never rejects. */
  readonly exited: Promise<ChildExit>;
}

/** Result of `kill(2)`: delivered, no such process, or not permitted. */
export type SignalResult = 'sent' | 'gone' | 'denied';

/** The type of a directory entry, from `lstat` (links are not followed). */
export type EntryKind = 'file' | 'directory' | 'socket' | 'symlink' | 'other';

/** File system calls of the harness. Paths are absolute POSIX paths. */
export interface GateFs {
  /** `mkdtemp(prefix)`: a new owner-only directory. */
  mkdtemp(prefix: string): Promise<string>;
  /** Creates a directory and its parents, owner-only. */
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, text: string): Promise<void>;
  appendFile(file: string, text: string): Promise<void>;
  readFile(file: string): Promise<string>;
  copyFile(from: string, to: string): Promise<void>;
  realpath(value: string): Promise<string>;
  /** `lstat` type of the entry, or `null` when it does not exist. */
  kind(value: string): Promise<EntryKind | null>;
  /** Entry names, or an empty list when the directory does not exist. */
  readdir(dir: string): Promise<readonly string[]>;
  /** Removes a file or a tree; missing entries are ignored. */
  rm(value: string): Promise<void>;
}

/**
 * The seams of the product's binary verification (core `process/verify`),
 * run by item 1 on the real binary. Production passes the core's own
 * (`nodeSignatureDeps`, and the defaults of `resolveExecutable` and
 * `verifyBinary`), so the gate runs exactly the code a user runs.
 */
export interface ProductSeams {
  readonly signature: Pick<SignatureDeps, 'fs' | 'run'>;
  /** `resolveExecutable`'s filesystem; the host's when absent. */
  readonly executableFs?: ExecutableFs;
  /** `verifyBinary`'s hash and identity calls; the host's when absent. */
  readonly verify?: Omit<NonNullable<VerifyBinaryOptions['deps']>, 'signature'>;
}

/** Everything the harness needs from the machine it runs on. */
export interface GateHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** `process.pid`: never signalled, and its group is protected. */
  readonly pid: number;
  /** The login name of the runner user (`os.userInfo().username`). */
  readonly user: string;
  /** `os.tmpdir()`: `/var/folders/.../T` on macOS. */
  readonly tmpdir: string;
  /** The harness's own environment (read for runner metadata only, never passed on). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion: string;
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * A fresh random v4 UUID (`crypto.randomUUID`), the `uuid` of each user
   * message. It must never repeat within a gate run: CLI 2.1.296 drops a
   * user message whose `uuid` is already in a resumed session's transcript
   * (gate run 2, research 10).
   */
  uuid(): string;
  /** Runs `file` (an absolute path, no shell) to completion. */
  run(file: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
  /** Spawns `file` (an absolute path, no shell, not detached) with piped stdio. */
  spawn(
    file: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ): ChildHandle;
  /** `kill(pid, signal)`; a negative pid names a process group. */
  signal(pid: number, signal: NodeJS.Signals): SignalResult;
  readonly fs: GateFs;
  /** The calls `validateCwd` uses (core, plan §1.7). */
  readonly cwdFs: CwdFs;
  /** The product's verification seams (item 1). */
  readonly product: ProductSeams;
  /** Starts the in-process mock Messages API with its egress trap (test-support). */
  startMock(): Promise<MockServer>;
  /** The npm registry client options of the pinned-CLI fetch (test-support). */
  readonly registry: RegistryOptions;
  /** Progress output (stderr). */
  log(line: string): void;
}
