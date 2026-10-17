/**
 * `connect`, `session` and `hudhud`: the entry points of the Claude Code
 * adapter (plan §2.3, §1.8 "Connect", §5.7; ADR-0003, ADR-0004 §4,
 * ADR-0011, ADR-0012; K4, K7, K8, K9; W5 rulings 1, 2, 6, 8).
 *
 * @remarks
 * `connect()`, in order, each step complete before the next:
 *
 * 1. Option validation (strict, no file system access; the host is not
 *    even looked at before it passed).
 * 2. Discovery of the binary (K7: `binaryPath`, else the native installer
 *    launcher, else a `PATH` lookup over safe entries; `.cmd`/`.bat` never).
 * 3. Verification (K8, K9; `adapter.ts`), then the spawn gate and exactly one
 *    `--version` probe (K4), the version policy (a known-broken version is
 *    refused unless allowed; untested is a warning).
 * 4. The Harness's `securityPosture` (connect options plus `managedPolicy`
 *    from the parent environment and a read-only parse of the user settings
 *    file, K23) and its capabilities (the job addon decides
 *    `processContainment`, K2).
 *
 * The Harness owns one session registry (J6), one verification cache and the
 * probed binary; `sessions.create`/`sessions.resume` run the per-session
 * pipeline of `session-factory.ts`. Disposing the Harness aborts the
 * sessions still starting, disposes the live ones and refuses new ones
 * (`HARNESS_DISPOSED`).
 *
 * `session()` validates connect and session options together, runs the
 * session's guard and cwd checks before anything is spawned (the probe
 * included), then connects and opens the session. Its Harness is private:
 * it is disposed when the session closed or failed to open.
 *
 * @packageDocumentation
 */

import {
  AbortError,
  buildPosture,
  isCredentialEnvName,
  type BinaryInfo,
  type CompatInfo,
  type Harness,
  type HarnessCapabilities,
  type SecurityPosture,
  type Session,
} from '@hudhudjs/core';
import { HarnessBase } from '@hudhudjs/core/binding';
import {
  jobContainmentCapability,
  VerificationCache,
  type JobAddonLoad,
  type ProcessPlatform,
} from '@hudhudjs/core/process';

import {
  nodeHost,
  platformOf,
  probeBinary,
  spawnableBinary,
  verifyExecutable,
  type BinaryContext,
  type ClaudeHost,
  type ProbedBinary,
} from './adapter.js';
import type { LaunchSpec } from './argv.js';
import { claudeHarnessCapabilities } from './capabilities.js';
import { discoverBinary, type DiscoveredBinary } from './discovery.js';
import { buildChildEnv } from './env.js';
import {
  checkSessionId,
  resolveConnectOptions,
  resolveConnectSessionOptions,
  resolveResumeOptions,
  resolveSessionOptions,
  type ConnectOptions,
  type EffectiveConnectOptions,
  type ResumeOptions,
  type SessionOptions,
} from './options.js';
import { claudePostureEntries, scanUserSettingsEnv, userConfigDir } from './posture.js';
import { knownDigestsFor, platformKey } from './provenance.js';
import { SessionRegistry } from './registry.js';
import {
  openSession,
  prepareSession,
  validateSession,
  type RawSpawnExtras,
  type SessionHost,
} from './session-factory.js';

/**
 * The Harness of the Claude Code adapter (plan §2.3).
 *
 * @public
 */
export interface ClaudeCodeHarness extends Harness {
  /**
   * The binary as `connect` verified and probed it: facts from connect. When
   * a session later finds the file changed, it verifies and probes it again
   * (refused under the same rules) and reports the change as the diagnostic
   * `binary.version-changed` with `reverified: true`; this property stays.
   */
  readonly binary: BinaryInfo;
  /**
   * The tested window and the status of the probed version: facts from
   * connect. A session's `compat` replay carries the status of the binary it
   * runs (see {@link ClaudeCodeHarness.binary}).
   */
  readonly compat: CompatInfo;
  readonly sessions: {
    /** Starts a new session (`--session-id` with a fresh UUID). */
    create(opts?: SessionOptions): Promise<Session>;
    /** Resumes a session by its UUID; `fork: true` continues it under a new id. */
    resume(sessionId: string, opts?: ResumeOptions): Promise<Session>;
  };
}

/** Makes the host; called only after the options passed validation. */
type HostFactory = () => ClaudeHost;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw AbortError.fromSignal(signal);
}

/** What `connect` established; the Harness is built from it. */
interface Connected {
  readonly host: ClaudeHost;
  readonly connect: EffectiveConnectOptions;
  readonly binaryContext: BinaryContext;
  readonly discovered: DiscoveredBinary;
  readonly probed: ProbedBinary;
  readonly jobLoad: JobAddonLoad;
  readonly capabilities: HarnessCapabilities;
  readonly securityPosture: SecurityPosture;
}

/**
 * The environment of the probe: the default `'harness'` preset with hudhud's
 * pinned keys, without any credential variable (`isCredentialEnvName`):
 * `--version` needs none and makes no network request (05 §1), so the probe
 * gets no secret it does not need (least privilege).
 */
function probeEnv(
  host: ClaudeHost,
  connect: EffectiveConnectOptions,
  platform: ProcessPlatform,
): Readonly<Record<string, string>> {
  const defaults = resolveSessionOptions(undefined).effective;
  const env = buildChildEnv(defaults, connect, host.env, platform).env;
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isCredentialEnvName(name)));
}

/** Steps 2 to 4 of the module remarks. */
async function establish(
  host: ClaudeHost,
  connect: EffectiveConnectOptions,
  signal: AbortSignal | undefined,
): Promise<Connected> {
  const platform = platformOf(host);
  const binaryContext: BinaryContext = {
    host,
    mode: connect.binaryVerification,
    platform,
    digests: knownDigestsFor(
      platformKey(host.platform, host.arch),
      connect.binaryDigests,
      host.knownBinaries,
    ),
    cache: new VerificationCache(),
    probeEnv: probeEnv(host, connect, platform),
    allowKnownBroken: connect.dangerouslyAllowKnownBrokenVersion,
  };

  // Resolve and verify.
  const discovered = await discoverBinary(connect.binaryPath, host.discovery);
  throwIfAborted(signal);
  const verified = await verifyExecutable(binaryContext, discovered.executable);
  throwIfAborted(signal);

  // The spawn gate before the probe, then exactly one probe (K4).
  const spawnable = await spawnableBinary(binaryContext, verified, async () => {
    const again = await discoverBinary(discovered.requestedPath, host.discovery);
    return verifyExecutable(binaryContext, again.executable);
  });
  const probed = await probeBinary(binaryContext, spawnable.binary);
  throwIfAborted(signal);

  // The posture and the capabilities.
  const userSettings = await scanUserSettingsEnv({
    configDir: () =>
      userConfigDir({
        configDir: connect.configDir,
        env: host.env,
        homedir: host.homedir,
        platform,
      }),
    reader: host.settingsReader,
    platform,
  });
  const securityPosture = buildPosture(
    claudePostureEntries({ connect, env: host.env, userSettings, platform }),
  );
  const jobLoad = host.loadJobAddon();
  const job = jobContainmentCapability(jobLoad);
  const containmentReason = job.reasons['processContainment'];
  const capabilities = claudeHarnessCapabilities({
    processContainment: job.processContainment,
    ...(containmentReason === undefined ? {} : { containmentReason }),
  });
  throwIfAborted(signal);
  return {
    host,
    connect,
    binaryContext,
    discovered,
    probed,
    jobLoad,
    capabilities,
    securityPosture,
  };
}

function binaryInfo(discovered: DiscoveredBinary, probed: ProbedBinary): BinaryInfo {
  const { binary } = probed;
  return {
    path: binary.path,
    ...(discovered.requestedPath === binary.path
      ? {}
      : { requestedPath: discovered.requestedPath }),
    version: probed.version,
    source: discovered.source,
    verification: binary.verification,
  };
}

class ClaudeHarness extends HarnessBase implements ClaudeCodeHarness, SessionHost {
  readonly host: ClaudeHost;
  readonly connect: EffectiveConnectOptions;
  readonly binaryContext: BinaryContext;
  readonly discovered: DiscoveredBinary;
  current: ProbedBinary;
  readonly registry: SessionRegistry = new SessionRegistry();
  readonly jobLoad: JobAddonLoad;
  readonly starting: SessionHost['starting'] = new Set();
  readonly sessions: ClaudeCodeHarness['sessions'];

  constructor(connected: Connected) {
    super({
      capabilities: connected.capabilities,
      binary: binaryInfo(connected.discovered, connected.probed),
      compat: connected.probed.compat,
      securityPosture: connected.securityPosture,
    });
    this.host = connected.host;
    this.connect = connected.connect;
    this.binaryContext = connected.binaryContext;
    this.discovered = connected.discovered;
    this.current = connected.probed;
    this.jobLoad = connected.jobLoad;
    this.sessions = {
      create: (opts) => this.#create(opts),
      resume: (sessionId, opts) => this.#resume(sessionId, opts),
    };
  }

  async #create(input: SessionOptions | undefined): Promise<Session> {
    const { effective, host: values } = resolveSessionOptions(input);
    return this.open({ mode: 'create', sessionId: this.host.ids.uuid() }, effective, values);
  }

  async #resume(sessionId: string, input: ResumeOptions | undefined): Promise<Session> {
    const resumeId = checkSessionId(sessionId, 'sessionId');
    const { effective, fork, host: values } = resolveResumeOptions(input);
    const launch: LaunchSpec = fork
      ? { mode: 'fork', resumeId, sessionId: this.host.ids.uuid() }
      : { mode: 'resume', resumeId };
    return this.open(launch, effective, values);
  }

  /** Opens a session; also the entry of the raw tier (its spawn extras). */
  open(
    launch: LaunchSpec,
    effective: ReturnType<typeof resolveSessionOptions>['effective'],
    values: ReturnType<typeof resolveSessionOptions>['host'],
    raw?: RawSpawnExtras,
  ): Promise<Session> {
    return openSession(this, {
      effective,
      values,
      launch,
      ...(raw === undefined ? {} : { raw }),
    });
  }

  override [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return super[Symbol.asyncDispose]();
    this.registry.dispose();
    const starting = [...this.starting];
    // `SessionDriver.abort` never rejects (it resolves with the session's end).
    for (const driver of starting) void driver.abort('dispose');
    const live = super[Symbol.asyncDispose]();
    return Promise.all([live, ...starting.map((driver) => driver.ended)]).then(() => undefined);
  }
}

/**
 * `connect` with the host made by `makeHost` (unit tests pass a fake host).
 *
 * @internal
 */
export async function connectWith(
  input: ConnectOptions | undefined,
  makeHost: HostFactory,
): Promise<ClaudeCodeHarness & SessionHost> {
  const { effective, signal } = resolveConnectOptions(input);
  throwIfAborted(signal);
  return new ClaudeHarness(await establish(makeHost(), effective, signal));
}

/**
 * `session` with the host made by `makeHost` (unit tests pass a fake host).
 *
 * @internal
 */
export async function sessionWith(
  input: (ConnectOptions & SessionOptions) | undefined,
  makeHost: HostFactory,
): Promise<Session> {
  const { connect, session: effective, host: values } = resolveConnectSessionOptions(input);
  const signal = values.signal;
  const host = makeHost();
  const launch: LaunchSpec = { mode: 'create', sessionId: host.ids.uuid() };
  // Validation, then the guard and the cwd, before anything is spawned.
  const validated = validateSession(host, connect, { effective, launch });
  throwIfAborted(signal);
  const prepared = await prepareSession(host, connect, effective, validated.env);
  throwIfAborted(signal);
  const harness = new ClaudeHarness(await establish(host, connect, signal));
  let session: Session;
  try {
    session = await openSession(harness, { effective, values, launch, prepared, validated });
  } catch (error) {
    await harness[Symbol.asyncDispose]();
    throw error;
  }
  disposeWhenClosed(session.closed, () => harness[Symbol.asyncDispose]());
  return session;
}

/**
 * Disposes the private Harness of `session()` once its session closed.
 * Never rejects and never throws.
 *
 * @remarks
 * By contract neither promise rejects: `Session.closed` never does, and the
 * Harness's dispose catches every session's dispose and otherwise waits only
 * on driver ends, which never reject. The final `catch` keeps a broken
 * contract from becoming an unhandled rejection in the application's
 * process; it swallows deliberately: the session is over, the application
 * holds no handle to this private Harness, and there is no event stream left
 * to report to.
 *
 * @internal
 */
export function disposeWhenClosed(closed: Promise<void>, dispose: () => Promise<void>): void {
  closed.then(dispose).catch(() => undefined);
}

/**
 * Connects to the locally installed Claude Code (see the module remarks).
 *
 * @throws `InvalidOptionsError`, `CapabilityUnsupportedError`,
 *   `BinaryNotFoundError`, `BinaryRefusedError`, `BinaryVerificationError`,
 *   `BinaryProbeError`, `HarnessVersionKnownBrokenError`, `AbortError`
 * @public
 */
export function connect(opts?: ConnectOptions): Promise<ClaudeCodeHarness> {
  return connectWith(opts, nodeHost);
}

/**
 * Connects and opens one session in one call; the private Harness is
 * disposed with the session.
 *
 * @throws every error of `connect` and of `sessions.create`
 * @public
 */
export function session(opts?: ConnectOptions & SessionOptions): Promise<Session> {
  return sessionWith(opts, nodeHost);
}

/**
 * The adapter's entry points as one namespace (plan §2.3).
 *
 * @public
 */
export const hudhud: {
  readonly connect: typeof connect;
  readonly session: typeof session;
} = Object.freeze({ connect, session });

/**
 * The Harness of a `connect()` of this adapter, for the raw tier; `undefined`
 * for anything else.
 *
 * @internal
 */
export function claudeHarnessOf(value: unknown): ClaudeHarness | undefined {
  return value instanceof ClaudeHarness ? value : undefined;
}
