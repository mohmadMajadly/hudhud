// A fake host for the adapter assembly tests (W5-T1): every seam of
// `ClaudeHost` is in memory and records what it is asked into one ordered
// log, so a test can assert the pipeline order (validation, guard, cwd,
// resolve, verify, probe, posture, re-verify, claim, spawn, job assignment,
// process.started). Nothing real is spawned, read or written: no installed
// `claude`, no user config, no keychain, no network. The fake CLI answers
// the frames hudhud writes the way the recorded CLI does (research 05 §5).

import type { HudhudEvent } from '@hudhud/core';
import { counterIds, ManualClock, type HostExitHook } from '@hudhud/core/binding';
import {
  ExecutableResolutionError,
  JobAddonError,
  type BoundedCommand,
  type CommandOutcome,
  type FileIdentity,
  type HarnessProcess,
  type JobAddon,
  type JobAddonLoad,
  type JobObject,
  type OsCalls,
  type ProcessExit,
  type ResolvedExecutable,
  type SpawnSpec,
} from '@hudhud/core/process';

import type { ClaudeHost } from '../../../src/adapter.js';
import { CLAUDE_CODE_COMPAT_POLICY, type CompatPolicy } from '../../../src/compat.js';
import type { SettingsFileReader } from '../../../src/posture.js';
import { FakeFs } from '../settings-guard-fake-fs.js';

export const BINARY = '/opt/claude/versions/2.1.296';
export const LAUNCHER = '/home/user/.local/bin/claude';
export const PROJECT = '/work/project';
export const VERSION = '2.1.296';
/** A digest of the fake binary (not the real CLI's). */
export const DIGEST = 'a'.repeat(64);
export const OTHER_DIGEST = 'b'.repeat(64);
export const SIZE = 1000;
export const CLI_PID = 4321;
export const CLI_START = '777';

/** One fake file of the binary: its identity and digest. */
export interface FakeBinary {
  realpath: string;
  size: number;
  mtimeMs: number;
  ino: number;
  sha256: string;
  /** What `--version` prints. */
  version: string;
}

// ---- the fake CLI -------------------------------------------------------------------------

type Frame = Record<string, unknown>;

/** How the fake CLI behaves; every field has the recorded behaviour as default. */
export interface CliScript {
  /** The `initialize` response body, merged over the default. */
  readonly init?: Frame;
  /**
   * Answer `initialize` with this frame instead (for example a control
   * error); `null` leaves it unanswered, `undefined` sends the default.
   */
  readonly initFrame?: (requestId: string) => Frame | null | undefined;
  /** The `session_id` of `system/init`; the argv's id by default. */
  readonly sessionId?: string;
  /** Exit by itself right after the spawn, with this code. */
  readonly exitAtStart?: number;
  /** Ignore `interrupt` requests (the ladder then waits). */
  readonly ignoreInterrupt?: boolean;
  /** Called with every parsed frame hudhud writes; `true` suppresses the default answer. */
  readonly onWrite?: (frame: Frame, cli: FakeCli) => boolean | undefined;
}

const encoder = new TextEncoder();

/** A scripted CLI process (implements the core's `HarnessProcess`). */
export class FakeCli implements HarnessProcess {
  readonly pid: number;
  readonly identity: HarnessProcess['identity'];
  readonly identitySource = 'linux-proc' as const;
  readonly exited: Promise<ProcessExit>;
  readonly spec: SpawnSpec;
  readonly written: Frame[] = [];
  stdinEnded = false;
  #exit: ProcessExit | null = null;
  readonly #resolveExit: (exit: ProcessExit) => void;
  readonly #chunks: Uint8Array[] = [];
  #wake: (() => void) | undefined;
  #stdoutDone = false;
  readonly #host: FakeHost;
  readonly #script: CliScript;

  constructor(host: FakeHost, spec: SpawnSpec, pid: number, script: CliScript) {
    this.#host = host;
    this.spec = spec;
    this.pid = pid;
    this.#script = script;
    const { promise, resolve } = Promise.withResolvers<ProcessExit>();
    this.exited = promise;
    this.#resolveExit = resolve;
    // As spawnHarnessProcess does: the start-time read (the containment's
    // assignment) runs synchronously inside the spawn.
    const read = spec.startTime?.read(pid) ?? Promise.resolve(null);
    this.identity = read.then((startTime) =>
      startTime === null
        ? { identity: null, problem: 'not-listed' as const }
        : { identity: { pid, startTime }, problem: null },
    );
  }

  get exitStatus(): ProcessExit | null {
    return this.#exit;
  }

  /** The value of `--name=` in the argv. */
  flag(name: string): string | undefined {
    const prefix = `--${name}=`;
    return this.spec.args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  }

  get sessionId(): string {
    return this.#script.sessionId ?? this.flag('session-id') ?? this.flag('resume') ?? '';
  }

  write(data: string | Uint8Array): Promise<void> {
    if (this.stdinEnded) return Promise.reject(new Error('stdin ended'));
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const frame = JSON.parse(text) as Frame;
    this.written.push(frame);
    const request = frame['request'] as Frame | undefined;
    this.#host.log.push(
      `write:${String(frame['type'])}${request === undefined ? '' : `:${String(request['subtype'])}`}`,
    );
    if (this.#script.onWrite?.(frame, this) !== true) this.#answer(frame);
    return Promise.resolve();
  }

  #answer(frame: Frame): void {
    if (frame['type'] === 'control_request') {
      const requestId = String(frame['request_id']);
      const subtype = String((frame['request'] as Frame)['subtype']);
      if (subtype === 'initialize') {
        const custom = this.#script.initFrame?.(requestId);
        if (custom !== null) this.emit(custom ?? this.initResponse(requestId));
      } else if (subtype === 'interrupt' && this.#script.ignoreInterrupt !== true) {
        this.emit(controlOk(requestId, { still_queued: [] }));
      } else if (subtype !== 'interrupt') {
        this.emit(controlOk(requestId, {}));
      }
      return;
    }
    if (frame['type'] === 'user') {
      const uuid = String(frame['uuid']);
      this.emit({ type: 'system', subtype: 'init', session_id: this.sessionId, uuid: 'i-1' });
      this.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        num_turns: 1,
        session_id: this.sessionId,
        user_message_uuid: uuid,
        uuid: 'r-1',
      });
      this.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    }
  }

  initResponse(requestId: string): Frame {
    return controlOk(requestId, {
      pid: this.pid,
      claude_code_version: this.#host.binary.version,
      account: { apiKeySource: 'ANTHROPIC_API_KEY' },
      capabilities: ['ui_surface_v1'],
      ...this.#script.init,
    });
  }

  /** Writes one frame to stdout. */
  emit(frame: Frame): void {
    if (this.#stdoutDone) return;
    this.#chunks.push(encoder.encode(`${JSON.stringify(frame)}\n`));
    this.#wake?.();
  }

  endStdin(): void {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    this.#host.log.push('eof');
    // The recorded CLI exits by itself once its input ended.
    queueMicrotask(() => {
      this.exit({ code: 0, signal: null });
    });
  }

  get stdout(): AsyncIterable<Uint8Array> {
    return { [Symbol.asyncIterator]: () => this.#read() };
  }

  async *#read(): AsyncGenerator<Uint8Array, void, undefined> {
    for (;;) {
      const chunk = this.#chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (this.#stdoutDone) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }

  stderrTail(): string {
    return '';
  }

  /** The process ends: stdout closes, the exit is observed, the table forgets it. */
  exit(exit: ProcessExit): void {
    if (this.#exit !== null) return;
    this.#exit = exit;
    this.#host.log.push(`exit:${String(exit.code)}:${String(exit.signal)}`);
    this.#host.processes.delete(this.pid);
    this.#stdoutDone = true;
    this.#wake?.();
    this.#resolveExit(exit);
  }

  killViaHandle(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    if (this.#exit !== null) return false;
    this.#host.log.push(`kill:${signal}`);
    this.exit({ code: null, signal });
    return true;
  }
}

export function controlOk(requestId: string, response: Frame): Frame {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  };
}

// ---- the fake host -------------------------------------------------------------------------

/** One process in the fake `/proc`. */
interface ProcEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly name: string;
}

function statBytes(entry: ProcEntry): Uint8Array {
  const line = `${String(entry.pid)} (${entry.name}) S ${String(entry.ppid)} ${String(entry.pgid)} 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 ${entry.startTime} 0 0\n`;
  return encoder.encode(line);
}

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: fake`), { code });
}

export interface FakeHostOptions {
  readonly platform?: NodeJS.Platform;
  /** The host's working directory (it exists); {@link PROJECT} by default. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly script?: CliScript;
  readonly compat?: CompatPolicy;
  readonly job?: 'unavailable' | 'loaded' | 'assign-fails';
}

/**
 * The fake host: a `ClaudeHost` whose every seam is in memory (see the
 * file comment). `log` records the order of everything that happened.
 */
export class FakeHost {
  readonly log: string[] = [];
  readonly clock = new ManualClock();
  readonly guardFs: FakeFs;
  /** Directories that exist (cwd checks). */
  readonly dirs = new Set<string>([PROJECT, '/home/user', '/work']);
  /** The fake binary file; tests change it to simulate an update. */
  binary: FakeBinary = {
    realpath: BINARY,
    size: SIZE,
    mtimeMs: 1000,
    ino: 1,
    sha256: DIGEST,
    version: VERSION,
  };
  /** Requested path -> what it resolves to (`null`: missing). */
  readonly links = new Map<string, string | null>([[BINARY, BINARY]]);
  /** The user settings file content, or `'absent'`. */
  userSettings: Uint8Array | 'absent' = 'absent';
  /** What the probe outputs; the binary's version line by default. */
  probe: (() => CommandOutcome) | undefined;
  /** Called before each spawn; may throw to make it fail. */
  beforeSpawn: ((spec: SpawnSpec) => void) | undefined;
  script: CliScript;
  readonly clis: FakeCli[] = [];
  /** Every probe command, with its file, argv, environment and cwd. */
  readonly probes: BoundedCommand[] = [];
  readonly processes = new Map<number, ProcEntry>();
  /** Signals the sweep sent: `pid:signal`. */
  readonly signals: string[] = [];
  readonly jobs: string[] = [];
  readonly host: ClaudeHost;
  #nextPid = CLI_PID;

  constructor(options: FakeHostOptions = {}) {
    const platform = options.platform ?? 'linux';
    this.script = options.script ?? {};
    this.guardFs = new FakeFs(platform === 'win32' ? 'win32' : 'posix');
    this.processes.set(100, { pid: 100, ppid: 1, pgid: 90, startTime: '10', name: 'host' });
    const jobMode = options.job ?? 'unavailable';
    const cwd = options.cwd ?? PROJECT;
    this.dirs.add(cwd);
    this.host = {
      platform,
      arch: 'x64',
      env: options.env ?? {
        PATH: '/usr/bin',
        HOME: '/home/user',
        ANTHROPIC_API_KEY: 'sk-ant-fake-hudhud-0000000000000000',
      },
      homedir: '/home/user',
      cwd: () => cwd,
      discovery: {
        platform: platform === 'win32' ? 'win32' : 'posix',
        env: { PATH: '' },
        home: undefined,
        cwd,
        resolve: (value) => this.resolve(value),
        fs: {
          lstat: () => Promise.reject(fsError('ENOENT')),
          realpath: () => Promise.reject(fsError('ENOENT')),
          stat: () => Promise.reject(fsError('ENOENT')),
        },
      },
      verify: {
        hash: (file) => {
          this.log.push('hash');
          return Promise.resolve(this.digestOf(file));
        },
        fs: this.identityFs(),
      },
      identityFs: this.identityFs(),
      probe: {
        run: (command) => this.runProbe(command),
        workDir: {
          create: () =>
            Promise.resolve(
              platform === 'win32' ? 'C:\\Temp\\hudhud-probe-1' : '/tmp/hudhud-probe-1',
            ),
          remove: () => Promise.resolve(),
        },
      },
      cwdFs: {
        realpath: (value) => {
          this.log.push(`cwd ${value}`);
          return this.dirs.has(value) ? Promise.resolve(value) : Promise.reject(fsError('ENOENT'));
        },
        stat: () => Promise.resolve(directory()),
      },
      guardFs: {
        lstat: (file) => {
          this.log.push('guard');
          return this.guardFs.lstat(file);
        },
        readlink: (file) => this.guardFs.readlink(file),
        readFile: (file, max) => this.guardFs.readFile(file, max),
      },
      settingsReader: this.settingsReader(),
      loadJobAddon: () => this.jobLoad(jobMode),
      os: () => this.os(platform),
      spawn: (spec) => this.spawn(spec),
      clock: this.clock,
      ids: counterIds(),
      hostExit: null as HostExitHook | null,
      compat: options.compat ?? CLAUDE_CODE_COMPAT_POLICY,
      knownBinaries: { [VERSION]: { [`${platform}-x64`]: { sha256: DIGEST, size: SIZE } } },
    };
  }

  resolve(value: string): Promise<ResolvedExecutable> {
    this.log.push(`resolve ${value}`);
    const target = this.links.get(value);
    if (target === undefined || target === null) {
      return Promise.reject(new ExecutableResolutionError('not-found', value));
    }
    return Promise.resolve({
      requested: value,
      path: target,
      size: this.binary.size,
      mtimeMs: this.binary.mtimeMs,
    });
  }

  digestOf(file: string): {
    sha256: string;
    size: number;
    mtimeMs: number;
    fileId: string;
  } {
    if (file !== this.binary.realpath) throw fsError('ENOENT');
    return {
      sha256: this.binary.sha256,
      size: this.binary.size,
      mtimeMs: this.binary.mtimeMs,
      fileId: `1:${String(this.binary.ino)}`,
    };
  }

  identityFs(): {
    realpath(path: string): Promise<string>;
    stat(path: string): Promise<FileIdentity>;
  } {
    return {
      realpath: (file) => {
        this.log.push('identity');
        return file === this.binary.realpath || this.links.get(file) === this.binary.realpath
          ? Promise.resolve(this.binary.realpath)
          : Promise.reject(fsError('ENOENT'));
      },
      stat: (file) =>
        file === this.binary.realpath
          ? Promise.resolve({
              isFile: () => true,
              isDirectory: () => false,
              dev: 1n,
              ino: BigInt(this.binary.ino),
              size: BigInt(this.binary.size),
              mtimeMs: BigInt(this.binary.mtimeMs),
            })
          : Promise.reject(fsError('ENOENT')),
    };
  }

  runProbe(command: BoundedCommand): Promise<CommandOutcome> {
    this.log.push(`probe ${command.args.join(' ')}`);
    this.probes.push(command);
    return Promise.resolve(
      this.probe?.() ?? {
        kind: 'exited',
        exitCode: 0,
        signal: null,
        stdout: `${this.binary.version} (Claude Code)\n`,
      },
    );
  }

  settingsReader(): SettingsFileReader {
    return {
      readPrefix: (file) => {
        this.log.push(`user-settings ${file}`);
        return Promise.resolve(this.userSettings);
      },
    };
  }

  jobLoad(mode: 'unavailable' | 'loaded' | 'assign-fails'): JobAddonLoad {
    if (mode === 'unavailable') {
      return { status: 'unavailable', reason: 'not-windows', detail: 'linux' };
    }
    const addon: JobAddon = {
      version: '1',
      file: 'C:\\addon.node',
      createJob: (): JobObject => {
        this.log.push('job:create');
        let closed = false;
        return {
          get closed() {
            return closed;
          },
          assign: (pid) => {
            if (mode === 'assign-fails') throw new JobAddonError('WIN32_5', 'assignProcess');
            this.log.push(`job:assign ${String(pid)}`);
            this.jobs.push(`assign ${String(pid)}`);
            return CLI_START;
          },
          terminate: () => {
            this.log.push('job:terminate');
          },
          listPids: () => [],
          close: () => {
            closed = true;
            this.log.push('job:close');
          },
        };
      },
      processTimes: (pid) => ({ pid, startTime: CLI_START }),
    };
    return { status: 'loaded', addon };
  }

  os(platform: NodeJS.Platform): OsCalls {
    if (platform === 'win32') {
      return {
        platform: 'win32',
        hostPid: 100,
        processTable: {
          source: 'win32-cim',
          queryProcesses: () =>
            Promise.resolve(
              encoder.encode(
                JSON.stringify(
                  [...this.processes.values()].map((entry) => ({
                    p: entry.pid,
                    pp: entry.ppid,
                    t: entry.startTime,
                    n: entry.name,
                  })),
                ),
              ),
            ),
        },
        terminate: {
          taskkillTree: (pid) => {
            this.signals.push(`${String(pid)}:taskkill-tree`);
            return Promise.resolve({ exitCode: 0 });
          },
          taskkillProcess: (pid) => {
            this.signals.push(`${String(pid)}:taskkill`);
            this.processes.delete(pid);
            return Promise.resolve({ exitCode: 0 });
          },
        },
      };
    }
    return {
      platform: 'linux',
      hostPid: 100,
      processTable: {
        source: 'linux-proc',
        listPids: () => Promise.resolve([...this.processes.keys()]),
        readStat: (pid) => {
          const entry = this.processes.get(pid);
          return Promise.resolve(entry === undefined ? null : statBytes(entry));
        },
      },
      signals: {
        signalProcess: (pid, signal) => {
          this.signals.push(`${String(pid)}:${signal}`);
          if (signal === 'SIGKILL') this.processes.delete(pid);
          return 'sent';
        },
        signalGroup: (pgid, signal) => {
          this.signals.push(`-${String(pgid)}:${signal}`);
          return 'sent';
        },
      },
    };
  }

  spawn(spec: SpawnSpec): Promise<HarnessProcess> {
    this.log.push('spawn');
    this.beforeSpawn?.(spec);
    const pid = this.#nextPid;
    this.#nextPid += 1;
    this.processes.set(pid, { pid, ppid: 100, pgid: 90, startTime: CLI_START, name: 'claude' });
    const cli = new FakeCli(this, spec, pid, this.script);
    this.clis.push(cli);
    if (this.script.exitAtStart !== undefined) {
      const code = this.script.exitAtStart;
      queueMicrotask(() => {
        cli.exit({ code, signal: null });
      });
    }
    return Promise.resolve(cli);
  }

  /** The latest spawned CLI. */
  get cli(): FakeCli {
    const cli = this.clis.at(-1);
    if (cli === undefined) throw new Error('nothing was spawned');
    return cli;
  }

  /** The host factory of `connectWith` / `sessionWith`, logging when it is made. */
  readonly make = (): ClaudeHost => {
    this.log.push('host');
    return this.host;
  };
}

function directory(): FileIdentity {
  return {
    isFile: () => false,
    isDirectory: () => true,
    dev: 1n,
    ino: 2n,
    size: 0n,
    mtimeMs: 0n,
  };
}

/** A driver as the Harness tracks it while it starts. */
interface StartingDriver {
  subscribe(options: undefined): AsyncIterableIterator<HudhudEvent, undefined, undefined>;
}

/**
 * Subscribes to every session driver of `harness` before it starts, so a
 * test sees what the session published before `create` resolved (the
 * binding diagnostics and `session.started`), which an application's
 * `events()` does not replay. Returns the per-session event lists, filled
 * as the events arrive.
 */
export function captureEvents(harness: { readonly starting: unknown }): HudhudEvent[][] {
  const captured: HudhudEvent[][] = [];
  const starting = harness.starting as Set<StartingDriver>;
  const add = starting.add.bind(starting);
  starting.add = (driver: StartingDriver) => {
    const events: HudhudEvent[] = [];
    captured.push(events);
    const iterator = driver.subscribe(undefined);
    void (async () => {
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event);
    })();
    return add(driver);
  };
  return captured;
}

/** The `data` of the first `code` diagnostic in `events` (fails the test when absent). */
export function diagnosticData(
  events: readonly HudhudEvent[] | undefined,
  code: string,
): Record<string, unknown> {
  for (const event of events ?? []) {
    if (event.type === 'diagnostic' && 'code' in event && event.code === code) {
      return ('data' in event ? event.data : undefined) ?? {};
    }
  }
  throw new Error(`no ${code} diagnostic`);
}

/** Lets pending promise reactions and I/O callbacks run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Index of the first log entry starting with `prefix` (fails the test when absent). */
export function at(log: readonly string[], prefix: string): number {
  const index = log.findIndex((entry) => entry.startsWith(prefix));
  if (index < 0)
    throw new Error(`no log entry starts with ${JSON.stringify(prefix)}: ${log.join(', ')}`);
  return index;
}
