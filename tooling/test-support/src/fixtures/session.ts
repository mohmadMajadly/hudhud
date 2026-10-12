/**
 * A recorded stream-json session with the sandboxed pinned CLI (plan
 * §1.11 `fixtures/recorder.ts`, §4.3; seed: the spike driver's `Session`).
 *
 * @remarks
 * Drives the CLI directly (not through hudhud): every stdin write, every
 * stdout line, every stderr chunk, stdin EOF and the exit are recorded with
 * the time since the launch in whole milliseconds. The raw records contain
 * whatever the CLI wrote; `normalize.ts` turns them into redacted,
 * normalized golden-fixture lines. The session kills only its own direct
 * child handle.
 */

import { createInterface } from 'node:readline';

import type { LaunchOptions, Sandbox, SandboxProcess } from '../launcher/sandbox.js';

/** A JSON value as it appears in a fixture. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Direction of a raw record (a subset of the conformance `dir` values). */
export type RecordDir = 'in' | 'out' | 'err' | 'exit' | 'cmd';

/** One raw record. */
export interface RawRecord {
  /** Milliseconds since the launch, rounded down. */
  readonly t: number;
  readonly dir: RecordDir;
  /**
   * `in`/`out`: the parsed JSON frame, or the raw line as a string when it is
   * not JSON. `err`: the decoded chunk. `exit`: `{code, signal}`. `cmd`:
   * `{stdin: "eof"}`.
   */
  readonly v: JsonValue;
}

/** How the process ended. */
export interface ExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
}

/** A stdout record with its parsed frame. */
export interface OutRecord extends RawRecord {
  readonly dir: 'out';
}

/** Options of {@link RecordingSession.start}. */
export interface RecordingOptions {
  /** Monotonic milliseconds; default `performance.now`. */
  readonly clock?: (() => number) | undefined;
}

interface Waiter {
  readonly match: (record: OutRecord) => boolean;
  readonly resolve: (record: OutRecord) => void;
}

function parseLine(line: string): JsonValue {
  try {
    return JSON.parse(line) as JsonValue;
  } catch {
    return line;
  }
}

function field(value: JsonValue, name: string): JsonValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)[name]
    : undefined;
}

/** Whether `record` is a frame of `type` (and, when given, `subtype` or request subtype). */
export function isFrame(record: OutRecord, type: string, subtype?: string): boolean {
  if (field(record.v, 'type') !== type) return false;
  if (subtype === undefined) return true;
  const request = field(record.v, 'request');
  const response = field(record.v, 'response');
  return (
    field(record.v, 'subtype') === subtype ||
    (request !== undefined && field(request, 'subtype') === subtype) ||
    (response !== undefined && field(response, 'subtype') === subtype)
  );
}

/** A launched, recorded CLI session. */
export class RecordingSession {
  readonly process: SandboxProcess;
  readonly #records: RawRecord[] = [];
  readonly #clock: () => number;
  readonly #t0: number;
  readonly #waiters: Waiter[] = [];
  readonly #consumed = new Set<OutRecord>();
  readonly #exited: Promise<ExitInfo>;
  #exit: ExitInfo | undefined;

  private constructor(process: SandboxProcess, clock: () => number) {
    this.process = process;
    this.#clock = clock;
    this.#t0 = clock();
    const { child } = process;
    this.#exited = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.#exit = { code, signal };
        this.#record('exit', { code, signal });
        resolve(this.#exit);
      });
    });
    child.stdin.on('error', () => {
      // EPIPE after the CLI exited; the exit record tells the story
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.#record('err', chunk));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const record = this.#record('out', parseLine(line)) as OutRecord;
      for (const waiter of [...this.#waiters]) {
        if (!this.#consumed.has(record) && waiter.match(record)) {
          this.#consumed.add(record);
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(record);
        }
      }
    });
  }

  /** Launches the sandbox's pinned CLI and starts recording. */
  static async start(
    sandbox: Sandbox,
    launch: LaunchOptions = {},
    options: RecordingOptions = {},
  ): Promise<RecordingSession> {
    const clock = options.clock ?? (() => performance.now());
    return new RecordingSession(await sandbox.launch(launch), clock);
  }

  #record(dir: RecordDir, v: JsonValue): RawRecord {
    const record: RawRecord = { t: Math.max(0, Math.floor(this.#clock() - this.#t0)), dir, v };
    this.#records.push(record);
    return record;
  }

  /** Every record so far, in order (a copy). */
  get records(): readonly RawRecord[] {
    return [...this.#records];
  }

  /** The exit, once it happened. */
  get exit(): ExitInfo | undefined {
    return this.#exit;
  }

  /** Writes one line (a newline is appended) and records it. */
  sendRaw(line: string): void {
    this.#record('in', parseLine(line));
    this.process.child.stdin.write(`${line}\n`);
  }

  /** Writes one JSON frame. */
  send(frame: JsonValue): void {
    this.sendRaw(JSON.stringify(frame));
  }

  /** Sends a user message with one text block. */
  user(text: string): void {
    this.send({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    });
  }

  /** Sends a control request and returns its id. */
  control(
    requestId: string,
    subtype: string,
    fields: Readonly<Record<string, JsonValue>> = {},
  ): string {
    this.send({ type: 'control_request', request_id: requestId, request: { subtype, ...fields } });
    return requestId;
  }

  /** Answers a control request with success. */
  respond(requestId: string, response: JsonValue): void {
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  /** Closes stdin (EOF) and records it as `cmd {stdin: "eof"}`. */
  closeStdin(): void {
    this.#record('cmd', { stdin: 'eof' });
    this.process.child.stdin.end();
  }

  /** Stdout records so far. */
  outputs(): readonly OutRecord[] {
    return this.#records.filter((record): record is OutRecord => record.dir === 'out');
  }

  /**
   * Resolves with the first stdout record matching `match` that no earlier
   * wait consumed; rejects after `timeoutMs`.
   */
  waitFor(
    match: (record: OutRecord) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<OutRecord> {
    const hit = this.outputs().find((record) => !this.#consumed.has(record) && match(record));
    if (hit !== undefined) {
      this.#consumed.add(hit);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(new Error(`timeout after ${String(timeoutMs)} ms waiting for ${label}`));
      }, timeoutMs);
      const waiter: Waiter = {
        match,
        resolve: (record) => {
          clearTimeout(timer);
          resolve(record);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  /** {@link waitFor} a frame of `type` (and `subtype`, see {@link isFrame}). */
  waitType(type: string, subtype: string | undefined, timeoutMs: number): Promise<OutRecord> {
    return this.waitFor(
      (record) => isFrame(record, type, subtype),
      timeoutMs,
      subtype === undefined ? type : `${type}/${subtype}`,
    );
  }

  /** Resolves with the exit, or `undefined` when it did not happen within `timeoutMs`. */
  async waitExit(timeoutMs: number): Promise<ExitInfo | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        resolve(undefined);
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.#exited, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ends the session: EOF, then a kill of the direct child after
   * `graceMs`. Resolves with the exit.
   */
  async stop(graceMs: number): Promise<ExitInfo> {
    if (!this.process.child.stdin.writableEnded) this.closeStdin();
    const exit = await this.waitExit(graceMs);
    if (exit !== undefined) return exit;
    this.process.child.kill('SIGKILL');
    return this.#exited;
  }
}
