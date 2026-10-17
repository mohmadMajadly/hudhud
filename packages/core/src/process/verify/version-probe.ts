/**
 * The version probe at connect (K4, plan §1.8): one run of the verified
 * binary with a fixed argv such as `--version`.
 *
 * @remarks
 * Guarantees of {@link runVersionProbe}:
 *
 * - Runs only a binary that passed {@link assertSpawnable}: in strict mode
 *   only a `verified` one, and in every mode only while the realpath, file
 *   id, size, mtime and ctime (in nanoseconds) still equal the verified ones.
 * - argv hygiene: the argv is the caller's fixed list, each entry passed as
 *   one argument with `shell: false`; an entry with a NUL is refused.
 * - env hygiene: the child gets exactly `env` (on Windows plus the libuv
 *   names as empty strings, `childEnv`); env names and values with NUL, `=`
 *   in a name, case-insensitive duplicate names on Windows, and on Windows a
 *   map without a non-empty `SYSTEMROOT` are refused before anything runs.
 * - cwd: a hudhud-owned empty directory created for this probe
 *   (`mkdtemp` under `os.tmpdir()`) and removed after it, never the
 *   application's cwd or a project directory (W3-Z ruling 9), so nothing the
 *   binary might read from its cwd is under anyone else's control.
 * - Bounded: a timeout (default 15 s) and an stdout cap (default 4 KiB);
 *   stdin and stderr are not connected, so nothing the child writes to
 *   stderr is kept.
 *
 * The probe itself makes no network request for Claude Code `--version`
 * (05 §1); hudhud does not add any.
 *
 * @packageDocumentation
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ProcessPlatform } from '../cwd.js';
import { pathProblem } from '../cwd.js';
import { runBoundedCommand, type BoundedCommand, type CommandOutcome } from './command.js';
import { assertSpawnable, type IdentityFs, type VerifiedBinary } from './verify.js';

/**
 * Default timeout of the version probe (plan §3.1 `BINARY_PROBE_FAILED`).
 *
 * @public
 */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 15_000;

/**
 * Default stdout cap of the version probe.
 *
 * @public
 */
export const DEFAULT_VERSION_PROBE_MAX_BYTES = 4096;

/**
 * Why the probe failed.
 *
 * @public
 */
export type VersionProbeFailure =
  'spec-refused' | 'spawn-error' | 'timeout' | 'output-too-large' | 'exit-code' | 'aborted';

/**
 * Thrown by {@link runVersionProbe}. The adapter maps it to the public
 * `BinaryProbeError` (`BINARY_PROBE_FAILED`).
 *
 * @public
 */
export class VersionProbeError extends Error {
  override readonly name = 'VersionProbeError';
  readonly code = 'BINARY_PROBE_FAILED';
  readonly reason: VersionProbeFailure;
  /** The exit code, the signal or the errno; or the refused env name or argv index. */
  readonly subject: string | undefined;

  constructor(reason: VersionProbeFailure, subject?: string) {
    super(`version probe failed: ${reason}${subject === undefined ? '' : ` (${subject})`}`);
    this.reason = reason;
    this.subject = subject;
  }
}

/**
 * Options of {@link runVersionProbe}.
 *
 * @public
 */
export interface VersionProbeOptions {
  /** The fixed argv, for example `['--version']`. */
  readonly args: readonly string[];
  /** The child's complete environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly platform: ProcessPlatform;
  /** Defaults to {@link DEFAULT_VERSION_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Defaults to {@link DEFAULT_VERSION_PROBE_MAX_BYTES}. */
  readonly maxStdoutBytes?: number;
  /** Aborting it stops the probe at once (the child is killed): `aborted`. */
  readonly signal?: AbortSignal;
  /** Seams for tests; the host's by default. */
  readonly deps?: {
    readonly fs?: IdentityFs;
    readonly run?: (command: BoundedCommand) => Promise<CommandOutcome>;
    readonly workDir?: ProbeWorkDir;
  };
}

/**
 * Creates and removes the probe's working directory.
 *
 * @public
 */
export interface ProbeWorkDir {
  /** Creates a new, empty directory owned by this process; returns its absolute path. */
  create(): Promise<string>;
  /** Removes the directory and anything in it. */
  remove(dir: string): Promise<void>;
}

/**
 * A new directory under `os.tmpdir()` per probe (`mkdtemp`, mode 0700 on
 * POSIX), removed after the probe.
 *
 * @public
 */
export const tempProbeWorkDir: ProbeWorkDir = {
  create: () => mkdtemp(path.join(tmpdir(), 'hudhud-probe-')),
  remove: (dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
};

function checkProbeSpec(options: VersionProbeOptions): void {
  options.args.forEach((arg, index) => {
    if (arg.includes('\0')) throw new VersionProbeError('spec-refused', `arg ${String(index)}`);
  });
  const seen = new Set<string>();
  let systemRoot = '';
  for (const [name, value] of Object.entries(options.env)) {
    if (name === '' || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new VersionProbeError('spec-refused', `env ${JSON.stringify(name)}`);
    }
    const key = options.platform === 'win32' ? name.toUpperCase() : name;
    if (seen.has(key)) throw new VersionProbeError('spec-refused', `env ${JSON.stringify(name)}`);
    seen.add(key);
    if (key === 'SYSTEMROOT') systemRoot = value;
  }
  if (options.platform === 'win32' && systemRoot === '') {
    throw new VersionProbeError('spec-refused', 'env SYSTEMROOT');
  }
}

/**
 * Runs the version probe and returns its stdout (see the module remarks).
 *
 * @throws {@link VersionProbeError}, or from {@link assertSpawnable}
 * `BinaryNotVerifiedError` / `BinaryChangedError`
 * @public
 */
export async function runVersionProbe(
  binary: VerifiedBinary,
  options: VersionProbeOptions,
): Promise<string> {
  checkProbeSpec(options);
  await assertSpawnable(binary, options.deps?.fs);
  const run = options.deps?.run ?? ((command: BoundedCommand) => runBoundedCommand(command));
  const workDir = options.deps?.workDir ?? tempProbeWorkDir;
  const cwd = await workDir.create();
  let outcome: CommandOutcome;
  try {
    const cwdProblem = pathProblem(cwd, options.platform);
    if (cwdProblem !== undefined) throw new VersionProbeError('spec-refused', `cwd ${cwdProblem}`);
    outcome = await run({
      file: binary.path,
      args: options.args,
      env: options.env,
      cwd,
      platform: options.platform,
      timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS,
      maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_VERSION_PROBE_MAX_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    await workDir.remove(cwd);
  }
  if (outcome.kind === 'spawn-error') throw new VersionProbeError('spawn-error', outcome.errno);
  if (outcome.kind !== 'exited') throw new VersionProbeError(outcome.kind);
  if (outcome.exitCode !== 0) {
    throw new VersionProbeError(
      'exit-code',
      outcome.exitCode === null ? (outcome.signal ?? undefined) : String(outcome.exitCode),
    );
  }
  return outcome.stdout;
}
