/**
 * Drives one CLI process over stream-json for the gate: frames stdout with
 * the core framer, answers `can_use_tool` with allow, tracks the watchdog
 * view, and shuts the process down with the harness ladder (EOF, SIGTERM,
 * then SIGKILL plus the identity-verified sweep of `ps.ts`).
 *
 * Waiting is polling on the injected clock, so the driver runs unchanged
 * against the simulated host of the unit tests.
 */

import {
  createFramer,
  DEFAULT_MAX_INBOUND_FRAME_BYTES,
  type Framer,
} from '../../../packages/core/src/process/framer.js';
import type { ProcessRecord } from '../../../packages/core/src/process/tree/types.js';
import type { MockServer } from '../../test-support/src/mock/server.js';
import type { WatchdogInput } from './causes.js';
import type { ChildExit, ChildHandle, GateHost } from './host.js';
import type { ProcessLedger, SweepOutcome } from './ps.js';
import { createSandbox, SESSION_ARGS, sandboxEnv, type Sandbox } from './sandbox.js';

/** Poll interval of every wait. */
export const POLL_MS = 100;
/** Grace after EOF and after SIGTERM in {@link CliSession.shutdown}. */
export const SHUTDOWN_GRACE_MS = 5_000;
const MAX_STDERR_CHARS = 64 * 1024;

/** One parsed stdout frame. */
export interface Frame {
  /** Host time of arrival, ms. */
  readonly at: number;
  readonly value: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value[key]` when `value` is an object, else `undefined`. */
export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** `type` or `type/subtype` of a frame. */
export function frameKind(frame: Frame): string {
  const type = String(frame.value['type']);
  const subtype = frame.value['subtype'];
  return typeof subtype === 'string' ? `${type}/${subtype}` : type;
}

/** How the harness ended a session. */
export interface ShutdownReport {
  readonly exit: ChildExit | undefined;
  /** `eof`, `sigterm` or `sigkill`: the ladder step that ended the process. */
  readonly endedBy: 'exited' | 'eof' | 'sigterm' | 'sigkill';
  readonly sweep: SweepOutcome;
}

/** A running CLI. */
export class CliSession {
  readonly frames: Frame[] = [];
  /** Lines that were not JSON objects or not valid frames. */
  nonFrames = 0;
  stderr = '';
  exit: ChildExit | undefined;
  exitAt: number | undefined;
  /** The identity of the spawned pid from the first snapshot, `null` when it was already gone. */
  identity: ProcessRecord | null = null;
  /** When the first input was written. */
  startedAt: number | undefined;
  lastFrameAt: number | undefined;
  readonly spawnedAt: number;
  private turnOpen = false;
  private toolOpen = false;
  private userSeq = 0;
  private readonly host: GateHost;
  private readonly child: ChildHandle;
  private readonly framer: Framer;
  private readonly decoder = new TextDecoder();

  constructor(host: GateHost, child: ChildHandle) {
    this.host = host;
    this.child = child;
    this.spawnedAt = host.now();
    this.framer = createFramer({ maxLineBytes: DEFAULT_MAX_INBOUND_FRAME_BYTES });
    child.onStdout((chunk) => {
      for (const output of this.framer.push(chunk)) {
        if (output.kind === 'line') this.accept(output.text);
        else this.nonFrames += 1;
      }
    });
    child.onStderr((chunk) => {
      if (this.stderr.length < MAX_STDERR_CHARS) {
        this.stderr = (this.stderr + this.decoder.decode(chunk, { stream: true })).slice(
          0,
          MAX_STDERR_CHARS,
        );
      }
    });
    void child.exited.then((exit) => {
      this.exit = exit;
      this.exitAt = host.now();
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private accept(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.nonFrames += 1;
      return;
    }
    if (!isRecord(value) || typeof value['type'] !== 'string') {
      this.nonFrames += 1;
      return;
    }
    const frame: Frame = { at: this.host.now(), value };
    this.frames.push(frame);
    this.lastFrameAt = frame.at;
    const kind = frameKind(frame);
    if (value['type'] === 'result') this.turnOpen = false;
    if (kind === 'assistant' && JSON.stringify(field(value, 'message')).includes('"tool_use"')) {
      this.toolOpen = true;
    }
    if (kind === 'user' && JSON.stringify(field(value, 'message')).includes('"tool_result"')) {
      this.toolOpen = false;
    }
    const request = field(value, 'request');
    if (value['type'] === 'control_request' && field(request, 'subtype') === 'can_use_tool') {
      this.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: value['request_id'],
          response: { behavior: 'allow', updatedInput: field(request, 'input') },
        },
      });
    }
  }

  /** Writes one frame. */
  send(value: unknown): void {
    this.startedAt ??= this.host.now();
    this.child.write(`${JSON.stringify(value)}\n`);
  }

  /** Sends `initialize` (request id `init_1`). */
  initialize(): void {
    this.send({
      type: 'control_request',
      request_id: 'init_1',
      request: { subtype: 'initialize' },
    });
  }

  /**
   * Waits for the `initialize` response (request id `init_1`); `undefined`
   * on timeout or exit. Item 6 writes the first user message of a resumed
   * session only after it, as research 07 §1 did.
   */
  initialized(timeoutMs: number): Promise<Frame | undefined> {
    return this.waitFor(
      (frame) =>
        frame.value['type'] === 'control_response' &&
        field(frame.value['response'], 'request_id') === 'init_1',
      timeoutMs,
    );
  }

  /** Sends a user message and opens a turn. */
  user(text: string): void {
    this.userSeq += 1;
    this.turnOpen = true;
    this.send({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: `00000000-0000-4000-8000-${String(this.userSeq).padStart(12, '0')}`,
    });
  }

  /** True while a tool use has no result yet. */
  get toolRunning(): boolean {
    return this.toolOpen;
  }

  /** The watchdog's view at `now`. */
  watchdogInput(): WatchdogInput {
    return {
      now: this.host.now(),
      startedAt: this.startedAt ?? this.spawnedAt,
      lastFrameAt: this.lastFrameAt,
      turnOpen: this.turnOpen,
    };
  }

  /** The first frame from index `since` on that matches, or `undefined`. */
  find(predicate: (frame: Frame) => boolean, since = 0): Frame | undefined {
    return this.frames.slice(since).find(predicate);
  }

  /** The first frame of kind `kind` (`type` or `type/subtype`) from index `since` on. */
  findKind(kind: string, since = 0): Frame | undefined {
    return this.find((frame) => frameKind(frame) === kind || frame.value['type'] === kind, since);
  }

  /**
   * Waits until `predicate` holds for some frame from index `since` on, the
   * process exits, or `timeoutMs` passes.
   */
  async waitFor(
    predicate: (frame: Frame) => boolean,
    timeoutMs: number,
    since = 0,
  ): Promise<Frame | undefined> {
    const deadline = this.host.now() + timeoutMs;
    for (;;) {
      const found = this.find(predicate, since);
      if (found !== undefined || this.exit !== undefined || this.host.now() >= deadline) {
        return found;
      }
      await this.host.sleep(POLL_MS);
    }
  }

  /** {@link CliSession.waitFor} on a frame kind. */
  waitKind(kind: string, timeoutMs: number, since = 0): Promise<Frame | undefined> {
    return this.waitFor(
      (frame) => frameKind(frame) === kind || frame.value['type'] === kind,
      timeoutMs,
      since,
    );
  }

  /** Waits for the exit; `undefined` on timeout. */
  async waitExit(timeoutMs: number): Promise<ChildExit | undefined> {
    const deadline = this.host.now() + timeoutMs;
    while (this.exit === undefined && this.host.now() < deadline) {
      await this.host.sleep(POLL_MS);
    }
    return this.exit;
  }

  /**
   * Ends the process with the harness ladder and sweeps its tree by
   * verified identity. Safe to call after the process exited.
   */
  async shutdown(ledger: ProcessLedger): Promise<ShutdownReport> {
    let endedBy: ShutdownReport['endedBy'] = 'exited';
    if (this.exit === undefined) {
      endedBy = 'eof';
      this.child.endInput();
      if ((await this.waitExit(SHUTDOWN_GRACE_MS)) === undefined && this.child.pid !== undefined) {
        endedBy = 'sigterm';
        this.host.signal(this.child.pid, 'SIGTERM');
        if ((await this.waitExit(SHUTDOWN_GRACE_MS)) === undefined) endedBy = 'sigkill';
      }
    }
    const sweep =
      this.identity === null ? { signalled: [], survivors: [] } : await ledger.sweep(this.identity);
    return { exit: this.exit, endedBy, sweep };
  }
}

/** What a gate procedure needs to run the CLI. */
export interface SessionContext {
  readonly host: GateHost;
  readonly ledger: ProcessLedger;
  /** The verified binary for this runner's architecture. */
  readonly binary: string;
}

/** Options of {@link runScenario}. */
export interface ScenarioOptions {
  /** Parent of the run root; default the host's temp directory. */
  readonly base?: string;
  /** Name of the TMPDIR directory inside the run root (item 5). */
  readonly tmpName?: string;
  /** `false` runs without `ANTHROPIC_API_KEY` (item 3 control). */
  readonly apiKey?: boolean;
  /** Extra argv after the session flags. */
  readonly args?: readonly string[];
  /** Picks the cwd; default the sandbox's `work`. */
  readonly cwd?: (sandbox: Sandbox) => string | Promise<string>;
  /** Runs after the sandbox exists and before the spawn. */
  readonly prepare?: (sandbox: Sandbox) => Promise<void>;
  /** Reuses an existing sandbox (item 6 resume runs). */
  readonly sandbox?: Sandbox;
  /** A directory searched before the system `PATH` (item 3 `security` shim). */
  readonly pathPrefix?: (sandbox: Sandbox) => string;
}

/** One running scenario. */
export interface ScenarioRun {
  readonly session: CliSession;
  readonly sandbox: Sandbox;
  readonly mock: MockServer;
  readonly cwd: string;
}

/** The outcome of {@link runScenario}: the body's value plus how the process ended. */
export interface ScenarioOutcome<T> {
  readonly value: T;
  readonly shutdown: ShutdownReport;
  /** Egress violations recorded by the mock during the run. */
  readonly violations: number;
}

/**
 * Starts a mock, a sandbox and the CLI, runs `body`, then shuts the CLI down
 * (always) and closes the mock.
 */
export async function runScenario<T>(
  context: SessionContext,
  options: ScenarioOptions,
  body: (run: ScenarioRun) => Promise<T>,
): Promise<ScenarioOutcome<T>> {
  const { host, ledger } = context;
  const mock = await host.startMock();
  try {
    const sandbox =
      options.sandbox ??
      (await createSandbox(host.fs, options.base ?? host.tmpdir, options.tmpName));
    await options.prepare?.(sandbox);
    const cwd = options.cwd === undefined ? sandbox.work : await options.cwd(sandbox);
    const env = sandboxEnv({
      sandbox,
      mockUrl: mock.url,
      user: host.user,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix(sandbox) }),
    });
    const child = host.spawn(context.binary, [...SESSION_ARGS, ...(options.args ?? [])], {
      cwd,
      env,
    });
    const session = new CliSession(host, child);
    let value: T;
    try {
      if (child.pid !== undefined) session.identity = await ledger.register(child.pid);
      value = await body({ session, sandbox, mock, cwd });
    } catch (error) {
      await session.shutdown(ledger);
      throw error;
    }
    const shutdown = await session.shutdown(ledger);
    return { value, shutdown, violations: mock.violations.length };
  } finally {
    await mock.close();
  }
}
