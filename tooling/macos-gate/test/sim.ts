// A simulated macOS host for the gate harness: virtual clock, process table
// rendered as `/bin/ps -A -o pid=,ppid=,pgid=,stat=,lstart=,comm=` output (C locale,
// UTC), an in-memory file system, a fake mock server and a scriptable CLI that
// speaks stream-json the way research 05 observed it. No process is spawned,
// no file outside the test's own temp directory is touched, nothing is fetched.

import type { CapturedRequest, MockServer } from '../../test-support/src/mock/server.js';
import type { EgressViolation } from '../../test-support/src/mock/egress-trap.js';
import type {
  ChildExit,
  ChildHandle,
  EntryKind,
  GateFs,
  GateHost,
  ProductSeams,
  RunOptions,
  RunResult,
} from '../src/host.js';

export const T0 = Date.UTC(2026, 9, 12, 17, 0, 0);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface SimProcess {
  pid: number;
  ppid: number;
  pgid: number;
  /** Seconds since the epoch. */
  start: number;
  /** `comm` as macOS prints it: a path, `-zsh`, or `(name)` when the arguments are unreadable. */
  name: string;
  /** The `stat` column; `S` when absent, `Z` for a zombie. */
  state?: string;
}

/** `lstart` in the C locale, UTC. */
export function lstart(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()] ?? ''} ${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${String(d.getUTCFullYear())}`;
}

export function result(stdout = '', partial: Partial<RunResult> = {}): RunResult {
  return {
    code: 0,
    signal: null,
    stdout: new TextEncoder().encode(stdout),
    stderr: '',
    error: undefined,
    ...partial,
  };
}

type RunHandler = (
  file: string,
  args: readonly string[],
  options: RunOptions,
) => RunResult | undefined | Promise<RunResult | undefined>;

interface FsEntry {
  kind: EntryKind;
  text: string;
}

export class SimMock implements MockServer {
  readonly url: string;
  readonly host = '127.0.0.1';
  readonly port: number;
  readonly openConnections = 0;
  captured: CapturedRequest[] = [];
  trapped: EgressViolation[] = [];
  closed = false;

  constructor(port: number) {
    this.port = port;
    this.url = `http://127.0.0.1:${String(port)}`;
  }

  get requests(): readonly CapturedRequest[] {
    return [...this.captured];
  }

  get violations(): readonly EgressViolation[] {
    return [...this.trapped];
  }

  assertNoViolations(): void {
    if (this.trapped.length > 0) throw new Error('violations');
  }

  reset(): void {
    this.captured = [];
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  capture(body: unknown): void {
    this.captured.push({
      seq: this.captured.length + 1,
      method: 'POST',
      target: '/v1/messages?beta=true',
      headers: {},
      body,
      bytes: 1,
    });
  }
}

/** A child as the simulated CLI sees it. */
export class SimChild implements ChildHandle {
  readonly pid: number | undefined;
  readonly exited: Promise<ChildExit>;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  inputEnded = false;
  done = false;
  private resolveExit!: (exit: ChildExit) => void;
  private readonly stdout: ((chunk: Uint8Array) => void)[] = [];
  private readonly stderr: ((chunk: Uint8Array) => void)[] = [];
  private readonly sim: SimHost;
  private readonly lines: (text: string) => void;
  private readonly eof: () => void;

  constructor(
    sim: SimHost,
    pid: number | undefined,
    spec: { args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string },
    handlers: { lines: (text: string) => void; eof: () => void },
  ) {
    this.sim = sim;
    this.pid = pid;
    this.args = spec.args;
    this.env = spec.env;
    this.cwd = spec.cwd;
    this.lines = handlers.lines;
    this.eof = handlers.eof;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  write(text: string): void {
    if (this.inputEnded || this.done) return;
    for (const line of text.split('\n').filter((part) => part !== '')) this.lines(line);
  }

  endInput(): void {
    if (this.inputEnded) return;
    this.inputEnded = true;
    if (!this.done) this.eof();
  }

  onStdout(listener: (chunk: Uint8Array) => void): void {
    this.stdout.push(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): void {
    this.stderr.push(listener);
  }

  emitRaw(text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const listener of this.stdout) listener(bytes);
  }

  emit(frame: unknown): void {
    this.emitRaw(`${JSON.stringify(frame)}\n`);
  }

  emitStderr(text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const listener of this.stderr) listener(bytes);
  }

  exit(code: number | null, signal: string | null, error?: string): void {
    if (this.done) return;
    this.done = true;
    if (this.pid !== undefined) this.sim.remove(this.pid);
    this.resolveExit({ code, signal, error });
  }
}

export interface SimOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Behaviour of every spawned CLI. */
  cli?: (child: SimChild, sim: SimHost) => SimCli;
  run?: RunHandler;
}

export class SimHost implements GateHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly pid = 900;
  readonly user = 'runner';
  readonly tmpdir = '/var/folders/zz/abc123/T';
  readonly env: Record<string, string | undefined> = {
    ImageOS: 'macos15',
    RUNNER_ARCH: 'ARM64',
    CI: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    HOME: '/Users/runner',
  };
  readonly nodeVersion = 'v22.20.0';
  time = T0;
  readonly table = new Map<number, SimProcess>();
  readonly files = new Map<string, FsEntry>();
  readonly aliases = new Map<string, string>([['/tmp', '/private/tmp']]);
  readonly logs: string[] = [];
  readonly runs: { file: string; args: readonly string[]; options: RunOptions }[] = [];
  readonly spawned: SimChild[] = [];
  readonly signals: string[] = [];
  readonly mocks: SimMock[] = [];
  caseInsensitive = true;
  psFails = false;
  denySignals = false;
  spawnFails = false;
  private nextPid = 1000;
  private tempSeq = 0;
  private uuidSeq = 0;
  /** The user-message uuids in each simulated session's transcript. */
  readonly transcripts = new Map<string, Set<unknown>>();
  /** Services of the generic passwords in the simulated login keychain. */
  readonly keychain = new Set<string>();
  private readonly events: { at: number; fn: () => void }[] = [];
  private readonly controls = new Map<number, SimCli>();
  private readonly options: SimOptions;

  constructor(options: SimOptions = {}) {
    this.options = options;
    this.platform = options.platform ?? 'darwin';
    this.arch = options.arch ?? 'arm64';
    this.table.set(1, { pid: 1, ppid: 0, pgid: 1, start: T0 / 1000 - 3600, name: '/sbin/launchd' });
    this.table.set(this.pid, {
      pid: this.pid,
      ppid: 1,
      pgid: this.pid,
      start: T0 / 1000 - 60,
      name: 'node',
    });
    this.files.set('/private/tmp', { kind: 'directory', text: '' });
    this.files.set(this.tmpdir, { kind: 'directory', text: '' });
  }

  // ---- clock and events

  now(): number {
    return this.time;
  }

  /** Distinct v4-shaped UUIDs, numbered across the whole simulated run. */
  uuid(): string {
    this.uuidSeq += 1;
    return `00000000-0000-4000-8000-${String(this.uuidSeq).padStart(12, '0')}`;
  }

  at(delayMs: number, fn: () => void): void {
    this.events.push({ at: this.time + delayMs, fn });
    this.events.sort((a, b) => a.at - b.at);
  }

  async sleep(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const next = this.events[0];
      if (next === undefined || next.at > until) break;
      this.events.shift();
      this.time = Math.max(this.time, next.at);
      next.fn();
      await flush();
    }
    this.time = until;
    await flush();
  }

  // ---- processes

  addProcess(ppid: number, name: string, ownGroup: boolean, pgid?: number): SimProcess {
    const pid = this.nextPid;
    this.nextPid += 7;
    const parent = this.table.get(ppid);
    const record: SimProcess = {
      pid,
      ppid,
      pgid: ownGroup ? pid : (pgid ?? parent?.pgid ?? pid),
      start: Math.floor(this.time / 1000),
      name,
    };
    this.table.set(pid, record);
    return record;
  }

  /** Removes `pid`; its live children move to launchd, which reaps its zombie children at once. */
  remove(pid: number): void {
    this.table.delete(pid);
    for (const record of [...this.table.values()]) {
      if (record.ppid !== pid) continue;
      if (record.state === 'Z') this.table.delete(record.pid);
      else record.ppid = 1;
    }
  }

  /**
   * The table as macOS `/bin/ps` prints it: numbers right-aligned in width
   * 5, `stat` left-justified in width 4, `lstart` left-justified in width 28
   * (4 spaces after the 24-character date), one space between columns.
   */
  ps(): string {
    return [...this.table.values()]
      .map(
        (p) =>
          `${String(p.pid).padStart(5)} ${String(p.ppid).padStart(5)} ${String(p.pgid).padStart(5)} ${(p.state ?? 'S').padEnd(4)} ${lstart(p.start).padEnd(28)} ${p.name}`,
      )
      .join('\n')
      .concat('\n');
  }

  descendantsOf(pid: number): SimProcess[] {
    const out: SimProcess[] = [];
    const queue = [pid];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const record of this.table.values()) {
        if (record.ppid === next) {
          out.push(record);
          queue.push(record.pid);
        }
      }
    }
    return out;
  }

  run(file: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
    this.runs.push({ file, args, options });
    if (file === '/bin/ps') {
      return Promise.resolve(this.psFails ? result('', { code: 1 }) : result(this.ps()));
    }
    return Promise.resolve(this.options.run?.(file, args, options)).then(
      (handled) => handled ?? defaultRun(this, file, args, options),
    );
  }

  spawn(
    file: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ): ChildHandle {
    let lineHandler: (text: string) => void = () => undefined;
    let eofHandler: () => void = () => undefined;
    const record = this.spawnFails ? undefined : this.addProcess(this.pid, file, false);
    const child = new SimChild(
      this,
      record?.pid,
      { args, env: options.env, cwd: options.cwd },
      {
        lines: (text) => {
          lineHandler(text);
        },
        eof: () => {
          eofHandler();
        },
      },
    );
    this.spawned.push(child);
    if (record === undefined) {
      child.exit(null, null, 'ENOENT');
      return child;
    }
    const cli = this.options.cli ?? ((c: SimChild, sim: SimHost) => new SimCli(c, sim, {}));
    const control = cli(child, this);
    lineHandler = (text) => {
      control.input(text);
    };
    eofHandler = () => {
      control.eof();
    };
    this.controls.set(record.pid, control);
    return child;
  }

  signal(pid: number, name: NodeJS.Signals): 'sent' | 'gone' | 'denied' {
    this.signals.push(`${String(pid)}:${name}`);
    if (this.denySignals) return 'denied';
    if (pid < 0) {
      const members = [...this.table.values()].filter((record) => record.pgid === -pid);
      if (members.length === 0) return 'gone';
      for (const member of members) this.deliver(member.pid, name);
      return 'sent';
    }
    if (!this.table.has(pid)) return 'gone';
    this.deliver(pid, name);
    return 'sent';
  }

  private deliver(pid: number, name: NodeJS.Signals): void {
    const control = this.controls.get(pid);
    const child = this.spawned.find((candidate) => candidate.pid === pid && !candidate.done);
    if (control !== undefined && child !== undefined) {
      control.signal(name);
      return;
    }
    if (name === 'SIGKILL' || name === 'SIGTERM' || name === 'SIGINT') this.remove(pid);
  }

  // ---- file system

  readonly fs: GateFs = {
    mkdtemp: (prefix) => {
      this.tempSeq += 1;
      const dir = `${prefix}${String(this.tempSeq).padStart(6, 'A')}`;
      this.files.set(this.resolve(dir), { kind: 'directory', text: '' });
      return Promise.resolve(dir);
    },
    mkdir: (dir) => {
      this.files.set(this.resolve(dir), { kind: 'directory', text: '' });
      return Promise.resolve();
    },
    writeFile: (file, text) => {
      this.files.set(this.resolve(file), { kind: 'file', text });
      return Promise.resolve();
    },
    appendFile: (file, text) => {
      const entry = this.files.get(file);
      this.files.set(file, { kind: 'file', text: `${entry?.text ?? ''}${text}` });
      return Promise.resolve();
    },
    readFile: (file) => {
      const entry = this.files.get(file);
      return entry === undefined
        ? Promise.reject(new Error(`ENOENT ${file}`))
        : Promise.resolve(entry.text);
    },
    copyFile: (from, to) => {
      this.files.set(to, { kind: 'file', text: this.files.get(from)?.text ?? 'binary' });
      return Promise.resolve();
    },
    realpath: (value) => Promise.resolve(this.resolve(value)),
    kind: (value) => {
      const direct = this.files.get(this.resolve(value));
      if (direct !== undefined) return Promise.resolve(direct.kind);
      if (this.caseInsensitive) {
        const lower = this.resolve(value).toLowerCase();
        for (const [name, entry] of this.files) {
          if (this.resolve(name).toLowerCase() === lower) return Promise.resolve(entry.kind);
        }
      }
      return Promise.resolve(null);
    },
    readdir: (dir) =>
      Promise.resolve(
        [...this.files.keys()]
          .filter((name) => name.startsWith(`${dir}/`) && !name.slice(dir.length + 1).includes('/'))
          .map((name) => name.slice(dir.length + 1)),
      ),
    rm: (value) => {
      this.files.delete(value);
      return Promise.resolve();
    },
  };

  resolve(value: string): string {
    for (const [alias, target] of this.aliases) {
      if (value === alias || value.startsWith(`${alias}/`))
        return `${target}${value.slice(alias.length)}`;
    }
    return value;
  }

  /**
   * What the product's hash of any binary returns (item 1): the pinned
   * darwin-arm64 2.1.296 binary unless a test changes it.
   */
  productDigest = {
    sha256: 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937',
    size: 240664432,
  };

  /**
   * The product's verification seams, routed through {@link SimHost.run} so
   * the codesign calls are recorded and answered by `defaultRun`.
   */
  readonly product: ProductSeams = {
    signature: {
      fs: {
        realpath: (value) => Promise.resolve(value),
        lstat: () => Promise.resolve({ isFile: () => true, isSymbolicLink: () => false }),
      },
      run: async (command) => {
        const ran = await this.run(command.file, command.args, {
          env: command.env,
          timeoutMs: command.timeoutMs,
        });
        return {
          kind: 'exited',
          exitCode: ran.code,
          signal: ran.signal as NodeJS.Signals | null,
          stdout: new TextDecoder().decode(ran.stdout),
        };
      },
    },
    executableFs: {
      realpath: (value) => Promise.resolve(value),
      stat: () => Promise.resolve(this.productIdentity()),
      canExecute: () => Promise.resolve(),
    },
    verify: {
      fs: {
        realpath: (value) => Promise.resolve(value),
        stat: () => Promise.resolve(this.productIdentity()),
      },
      hash: () =>
        Promise.resolve({
          ...this.productDigest,
          mtimeMs: 1000,
          mtimeNs: '1000000000',
          ctimeNs: '1000000000',
          fileId: '1:2',
        }),
    },
  };

  private productIdentity(): {
    isFile(): boolean;
    isDirectory(): boolean;
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeMs: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  } {
    return {
      isFile: () => true,
      isDirectory: () => false,
      dev: 1n,
      ino: 2n,
      size: BigInt(this.productDigest.size),
      mtimeMs: 1000n,
      mtimeNs: 1_000_000_000n,
      ctimeNs: 1_000_000_000n,
    };
  }

  readonly cwdFs = {
    realpath: (value: string): Promise<string> => {
      const resolved = this.resolve(value);
      if (this.files.has(resolved)) return Promise.resolve(resolved);
      if (this.caseInsensitive) {
        for (const name of this.files.keys()) {
          if (name.toLowerCase() === resolved.toLowerCase()) return Promise.resolve(name);
        }
      }
      return Promise.reject(Object.assign(new Error(`ENOENT ${value}`), { code: 'ENOENT' }));
    },
    stat: (value: string) =>
      Promise.resolve({
        isFile: () => false,
        isDirectory: () => true,
        dev: 1n,
        ino: BigInt(value.length),
        size: 0n,
        mtimeMs: 0n,
      }),
  };

  // ---- mock and registry

  startMock(): Promise<MockServer> {
    const mock = new SimMock(40_000 + this.mocks.length);
    this.mocks.push(mock);
    return Promise.resolve(mock);
  }

  mockFor(url: string | undefined): SimMock | undefined {
    return this.mocks.find((mock) => mock.url === url);
  }

  readonly registry = {
    fetch: (): Promise<Response> => Promise.reject(new Error('no network in the simulation')),
    documentTimeoutMs: 1000,
    tarballTimeoutMs: 1000,
  };

  log(line: string): void {
    this.logs.push(line);
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `security add-/find-/delete-generic-password` on the simulated login
 * keychain: reachable only with the runner's own HOME (gate run 2: the
 * search list follows HOME). Items are keyed by service.
 */
function keychainItem(sim: SimHost, args: readonly string[], options: RunOptions): RunResult {
  const service = args[args.indexOf('-s') + 1] ?? '';
  const reachable = options.env['HOME'] === sim.env['HOME'];
  if (args[0] === 'add-generic-password') {
    if (!reachable) return result('', { code: 1, stderr: 'no default keychain' });
    sim.keychain.add(service);
    return result();
  }
  if (!reachable || !sim.keychain.has(service)) {
    return result('', {
      code: 44,
      stderr: 'The specified item could not be found in the keychain.',
    });
  }
  if (args[0] === 'delete-generic-password') sim.keychain.delete(service);
  return result(`keychain: "/Users/runner/Library/Keychains/login.keychain-db"
`);
}

/** The default answers of the macOS tools the harness runs. */
function defaultRun(
  sim: SimHost,
  file: string,
  args: readonly string[],
  options: RunOptions,
): RunResult {
  switch (file) {
    case '/usr/bin/codesign':
      if (args[0] === '-dv')
        return result('', {
          stderr:
            'Identifier=com.anthropic.claude-code\nAuthority=Developer ID Application\nTeamIdentifier=Q6L2SF6YDW\nOther=1\n',
        });
      if (args[0] === '-d' && args[1] === '-r-') {
        return result(
          'designated => identifier "com.anthropic.claude-code" and anchor apple generic and certificate leaf[subject.OU] = Q6L2SF6YDW\n',
        );
      }
      // The product's check: a Developer ID requirement that names the team.
      if (args[0] === '--verify' && args.includes('-R')) {
        const requirement = String(args[args.indexOf('-R') + 1]);
        return requirement.endsWith('certificate leaf[subject.OU] = "Q6L2SF6YDW"')
          ? result('')
          : result('', {
              code: 3,
              stderr: 'test-requirement: code failed to satisfy specified code requirement(s)',
            });
      }
      if (
        args[0] === '--verify' &&
        String(args.at(-1)).includes('/unsigned/') &&
        sim.files.get(String(args.at(-1)))?.text === 'stripped'
      ) {
        return result('', { code: 1, stderr: 'code object is not signed at all' });
      }
      if (args[0] === '--remove-signature') {
        sim.files.set(String(args[1]), { kind: 'file', text: 'stripped' });
      }
      return result('', { stderr: 'valid on disk' });
    case '/usr/bin/xattr':
    case '/bin/chmod':
      return result();
    case '/usr/bin/security':
      if (args[0]?.endsWith('-generic-password') === true) return keychainItem(sim, args, options);
      // Gate run 2: the search list follows HOME; a sandbox HOME has none.
      if (options.env['HOME'] !== sim.env['HOME']) {
        return args[0] === 'list-keychains'
          ? result('')
          : result('', {
              code: 1,
              stderr:
                'security: SecKeychainCopyDomainDefault user: A default keychain could not be found.',
            });
      }
      return result('    "/Users/runner/Library/Keychains/login.keychain-db"\n');
    case '/usr/bin/uname':
      return result(sim.arch === 'x64' ? 'x86_64\n' : 'arm64\n');
    case '/usr/sbin/sysctl':
      return sim.arch === 'x64' ? result('', { code: 1 }) : result('0\n');
    case '/usr/bin/lipo':
      return result(sim.arch === 'x64' ? 'x86_64\n' : 'arm64\n');
    case '/usr/bin/sw_vers':
      return result('ProductName:\tmacOS\nProductVersion:\t15.7\n');
    default:
      if (args[0] === '--version') {
        if (sim.files.get(file)?.text === 'stripped')
          return result('', { code: null, signal: 'SIGKILL' });
        return result('2.1.296 (Claude Code)\n');
      }
      return result('', { code: 127, error: 'ENOENT' });
  }
}

/** Switches of the simulated CLI (all off: the behaviour research 05 saw on Linux). */
export interface CliFlags {
  /** The Bash tool shares the CLI's process group. */
  sharedGroup?: boolean;
  /** SIGTERM leaves the tool tree alive. */
  termLeavesTools?: boolean;
  /** SIGINT exits 130 and still emits a result. */
  intResult?: boolean;
  /** SIGINT emits `result/error_during_execution`, then exits 0 (macOS gate run 1). */
  intErrorResultExit0?: boolean;
  /**
   * Every turn leaves a `security` child that `ps` shows as the zombie
   * `(security)` until the CLI exits (macOS gate run 1); a `security` shim
   * first on `PATH` is called instead and logs its argv.
   */
  zombieSecurity?: boolean;
  /** `ps` cannot read the Bash tool's arguments: the shell and `sleep` show as `(zsh)`, `(sleep)`. */
  hiddenToolArgs?: boolean;
  /**
   * A resumed session never starts a user message written before the
   * initialize response: the hypothesis of research 09, refuted on Linux by
   * research 10 and kept so the evidence-only eager run stays tested.
   */
  resumeEagerStall?: boolean;
  /** SIGTERM is ignored. */
  ignoreTerm?: boolean;
  /** EOF is ignored. */
  ignoreEof?: boolean;
  /** No `messaging_socket_path` in system/init. */
  noSocket?: boolean;
  /** Socket path override. */
  socket?: (tmp: string, pid: number) => string;
  /** A `security` child appears during the turn. */
  security?: boolean;
  /** Without an API key the CLI hangs with a `security` child. */
  keychainHangWithoutKey?: boolean;
  /** A hanging .zshrc makes the CLI hang (no snapshot, zsh child) instead of completing. */
  zshHang?: boolean;
  /** Every turn fails. */
  failTurns?: boolean;
  /** Resume ignores the history. */
  resumeLosesHistory?: boolean;
  /** Reports the cwd it was given without resolving anything (default) or a fixed one. */
  reportCwd?: (cwd: string) => string;
  /** Writes nothing at all (never answers). */
  silent?: boolean;
  /** apiKeySource reported in the initialize response. */
  apiKeySource?: string;
  /** No `system/init` frame. */
  noInit?: boolean;
  /** Prints a non-JSON line and a JSON non-frame first. */
  noise?: boolean;
}

const sessions = new Map<string, number>();

/** A scripted CLI 2.1.296 (stream-json, research 05 §5-§10). */
export class SimCli {
  private readonly child: SimChild;
  private readonly sim: SimHost;
  private readonly flags: CliFlags;
  private readonly pid: number;
  private sessionId: string;
  private history: number;
  private turnOpen = false;
  private initAnswered = false;
  private noisy = false;
  private tool: SimProcess | undefined;
  private pendingTool: { id: string; command: string } | undefined;

  constructor(child: SimChild, sim: SimHost, flags: CliFlags) {
    this.child = child;
    this.sim = sim;
    this.flags = flags;
    this.pid = child.pid ?? 0;
    const resume = child.args.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length);
    this.sessionId = resume ?? `aaaaaaaa-bbbb-4ccc-8ddd-${String(this.pid).padStart(12, '0')}`;
    this.history =
      resume === undefined || flags.resumeLosesHistory === true ? 0 : (sessions.get(resume) ?? 0);
  }

  private get mock(): SimMock | undefined {
    return this.sim.mockFor(this.child.env['ANTHROPIC_BASE_URL']);
  }

  input(text: string): void {
    if (this.flags.silent === true) return;
    if (this.flags.noise === true && !this.noisy) {
      this.noisy = true;
      this.child.emitRaw('not json\n');
      this.child.emit([1, 2]);
      this.child.emitStderr('warning: simulated\n');
    }
    const frame = JSON.parse(text) as Record<string, unknown>;
    if (frame['type'] === 'control_request') {
      if (this.flags.resumeEagerStall === true && this.resumed) {
        // Answer later, so a user message written right behind `initialize` arrives first.
        this.sim.at(50, () => {
          this.answerInitialize(frame);
        });
        return;
      }
      this.answerInitialize(frame);
      return;
    }
    if (frame['type'] === 'control_response') {
      this.runTool();
      return;
    }
    if (frame['type'] === 'user') {
      if (this.flags.resumeEagerStall === true && this.resumed && !this.initAnswered) {
        this.child.emit({
          type: 'command_lifecycle',
          command_uuid: frame['uuid'],
          state: 'queued',
        });
        return;
      }
      // CLI 2.1.296 (research 10): a user message whose uuid the session's
      // transcript already holds is dropped, answered by `completed` alone.
      const uuid = frame['uuid'];
      const seen = this.sim.transcripts.get(this.sessionId) ?? new Set<unknown>();
      if (seen.has(uuid)) {
        this.child.emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' });
        return;
      }
      seen.add(uuid);
      this.sim.transcripts.set(this.sessionId, seen);
      const message = frame['message'] as { content: string };
      this.turn(message.content);
    }
  }

  private get resumed(): boolean {
    return this.child.args.some((arg) => arg.startsWith('--resume='));
  }

  private answerInitialize(frame: Record<string, unknown>): void {
    this.initAnswered = true;
    this.child.emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame['request_id'],
        response: {
          pid: this.pid,
          account: {
            apiKeySource:
              this.flags.apiKeySource ??
              (this.child.env['ANTHROPIC_API_KEY'] === undefined ? 'none' : 'ANTHROPIC_API_KEY'),
          },
        },
      },
    });
  }

  private socketPath(): string {
    const tmp = this.child.env['TMPDIR'] ?? '/tmp';
    if (this.flags.socket !== undefined) return this.flags.socket(tmp, this.pid);
    const preferred = `${tmp}/cc-socks/${String(this.pid)}.sock`;
    return Buffer.byteLength(preferred) < 104
      ? preferred
      : `/tmp/cc-socks-501/${String(this.pid)}.sock`;
  }

  private turn(content: string): void {
    this.turnOpen = true;
    this.history += 2;
    const cwd = this.flags.reportCwd?.(this.child.cwd) ?? this.child.cwd;
    if (this.flags.noInit !== true) {
      const socket = this.socketPath();
      this.child.emit({
        type: 'system',
        subtype: 'init',
        cwd,
        session_id: this.sessionId,
        ...(this.flags.noSocket === true ? {} : { messaging_socket_path: socket }),
      });
      if (this.flags.noSocket !== true) {
        this.sim.files.set(this.sim.resolve(socket), { kind: 'socket', text: '' });
      }
    }
    const mock = this.mock;
    const env = this.child.env;
    const history = Array.from({ length: this.history - 1 }, () => ({
      role: 'user',
      content: 'x',
    }));
    mock?.capture({ messages: [...history, { role: 'user', content }] });
    mock?.capture({ messages: [{ role: 'user', content: 'title' }] });
    if (
      sessions.has(this.sessionId) &&
      this.child.args.some((arg) => arg.startsWith('--resume='))
    ) {
      const last = mock?.captured.at(-2);
      const body = last?.body as { messages: unknown[] } | undefined;
      if (body !== undefined && this.child.cwd !== this.sim.resolve(this.child.cwd)) {
        body.messages.push({
          role: 'user',
          content: '# Environment update - Primary working directory',
        });
      }
    }
    sessions.set(this.sessionId, this.history);
    if (this.flags.failTurns === true) {
      this.sim.at(200, () => {
        this.result(false, 'failed');
      });
      return;
    }
    if (
      this.flags.security === true ||
      (this.flags.keychainHangWithoutKey === true && env['ANTHROPIC_API_KEY'] === undefined)
    ) {
      const security = this.sim.addProcess(this.pid, '/usr/bin/security', false);
      if (this.flags.keychainHangWithoutKey === true) return;
      this.sim.at(300, () => {
        this.sim.remove(security.pid);
      });
    }
    if (this.flags.zombieSecurity === true) this.callSecurity();
    const bash = /cmd=([A-Za-z0-9+/=]+)/.exec(content);
    if (content.includes('[[mock:slow')) {
      this.sim.at(10_000, () => {
        this.result(true, 'chunk0 chunk1');
      });
      return;
    }
    if (bash !== null) {
      const command = Buffer.from(bash[1] ?? '', 'base64').toString('utf8');
      const zshrc = this.sim.files.get(`${env['HOME'] ?? ''}/.zshrc`);
      if (zshrc !== undefined && this.flags.zshHang === true) {
        this.child.emit({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1' }] },
        });
        const zsh = this.sim.addProcess(this.pid, '-zsh', false);
        this.sim.addProcess(zsh.pid, '/bin/sleep', false);
        return;
      }
      this.pendingTool = { id: 'toolu_1', command };
      this.child.emit({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_1' }] },
      });
      this.child.emit({
        type: 'control_request',
        request_id: 'perm-1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command } },
      });
      return;
    }
    this.sim.at(150, () => {
      this.result(true, `ECHO:${content}`);
    });
  }

  /** `security` through `PATH`: the shim when one is first on `PATH`, else a child left as a zombie. */
  private callSecurity(): void {
    const first = (this.child.env['PATH'] ?? '').split(':')[0] ?? '';
    if (this.sim.files.has(`${first}/security`)) {
      const log = `${first.slice(0, first.lastIndexOf('/'))}/security-argv.log`;
      const previous = this.sim.files.get(log)?.text ?? '';
      this.sim.files.set(log, {
        kind: 'file',
        text: `${previous}[find-generic-password][-s][Claude Code-credentials]\n`,
      });
      return;
    }
    const zombie = this.sim.addProcess(this.pid, '(security)', false);
    zombie.state = 'Z';
  }

  private runTool(): void {
    const pending = this.pendingTool;
    if (pending === undefined) return;
    this.pendingTool = undefined;
    const config = this.child.env['CLAUDE_CONFIG_DIR'] ?? '';
    this.sim.files.set(`${config}/shell-snapshots/snapshot-zsh-1.sh`, { kind: 'file', text: '' });
    const hidden = this.flags.hiddenToolArgs === true;
    const shell = this.sim.addProcess(
      this.pid,
      hidden ? '(zsh)' : '/bin/zsh',
      this.flags.sharedGroup !== true,
    );
    if (pending.command.startsWith('sleep')) {
      this.tool = shell;
      this.sim.addProcess(shell.pid, hidden ? '(sleep)' : '/bin/sleep', false, shell.pgid);
      return;
    }
    const output = pending.command.replace(/^echo /, '');
    this.sim.at(200, () => {
      this.sim.remove(shell.pid);
      this.child.emit({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: output }] },
      });
      this.result(true, `Tool finished. RESULT<<${output}>>`);
    });
  }

  private result(ok: boolean, text: string): void {
    if (this.child.done) return;
    this.turnOpen = false;
    this.child.emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    this.child.emit({
      type: 'result',
      subtype: ok ? 'success' : 'error_during_execution',
      is_error: !ok,
      result: text,
      session_id: this.sessionId,
    });
  }

  private killTools(): void {
    if (this.tool !== undefined) {
      for (const record of this.sim.descendantsOf(this.tool.pid)) this.sim.remove(record.pid);
      this.sim.remove(this.tool.pid);
      this.tool = undefined;
    }
  }

  eof(): void {
    if (this.flags.ignoreEof === true) return;
    if (this.turnOpen || this.tool !== undefined) return;
    this.sim.at(50, () => {
      this.child.exit(0, null);
    });
  }

  signal(name: NodeJS.Signals): void {
    if (name === 'SIGKILL') {
      this.child.exit(null, 'SIGKILL');
      return;
    }
    if (name === 'SIGTERM' && this.flags.ignoreTerm === true) return;
    if (!(name === 'SIGTERM' && this.flags.termLeavesTools === true)) this.killTools();
    for (const record of this.sim.descendantsOf(this.pid)) {
      if (!(name === 'SIGTERM' && this.flags.termLeavesTools === true)) this.sim.remove(record.pid);
    }
    if (name === 'SIGINT' && this.flags.intErrorResultExit0 === true) {
      this.result(false, 'interrupted');
      this.child.exit(0, null);
      return;
    }
    if (name === 'SIGINT' && this.flags.intResult === true) {
      this.result(false, 'interrupted');
      this.child.exit(130, null);
      return;
    }
    this.child.exit(name === 'SIGINT' ? 0 : 143, null);
  }
}

export function clearSessions(): void {
  sessions.clear();
}
