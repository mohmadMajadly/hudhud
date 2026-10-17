/**
 * The per-session pipeline of the Claude Code adapter (plan §1.8, §2.4, §2.5,
 * §3.2, §5.7; ADR-0008, ADR-0009, ADR-0011, ADR-0012; W5 rulings 2 to 8).
 *
 * @remarks
 * Order (acceptance §5.7, W5 ruling 8); each step completes before the next
 * starts, and a failure at any step leaves nothing running:
 *
 * 1. Validation without any file system access: the options (by the caller),
 *    the session id, the argv (`buildArgv`, every element through
 *    `formatFlag`) and the child environment (`buildChildEnv`: preset,
 *    `remove`, `add`, pinned keys; names compared as the OS compares them).
 * 2. {@link prepareSession}: the project credential guard (K5; read-only,
 *    2 MiB cap, fail closed; under `projectCredentialEnv: 'allow'` the same
 *    scan without the refusal, whose findings feed `managedPolicy` and a
 *    diagnostic), then the cwd (`validateCwd`: exists, a directory,
 *    realpath'd; `CWD_TOO_LONG` on win32).
 * 3. The session's `securityPosture` (K19, K23): published as the diagnostic
 *    `security.posture` before anything else of the session, so no weakened
 *    default of a session option is silent.
 * 4. The spawn gate: `assertSpawnableOrReverify` on the Harness's binary. A
 *    file that changed since it was verified (a legitimate update) is
 *    resolved and verified once more and probed again (K4: its bytes have
 *    not been probed), refused under the same rules as at connect, and the
 *    identity is checked once more right before the spawn; the Harness then
 *    uses the new binary. A drift of the version is published as
 *    `binary.version-changed`.
 * 5. The registry claim (J6): a second live session with the same id in this
 *    Harness is `SESSION_ID_IN_USE`; the claim is released when the session
 *    ended, and rebound when the harness reports another id in `system/init`
 *    (a conflict there ends the session: two live processes on one session
 *    diverge).
 * 6. The spawn (`shell: false`, explicit environment, the realpath'd cwd). The
 *    session's containment (K2) plugs into the spawn's start-time read, so the
 *    Windows job is created and the process assigned synchronously inside the
 *    spawn, before anything is written and before the machine sees
 *    `process.started` (ADR-0009 §1).
 * 7. The session driver with `claudeSessionMachine`: the process transport
 *    (the abort ladders; on a graceful close the snapshot at EOF and the
 *    sweep after the exit), the permission bridge, the Claude user-input
 *    encoder, the version-drift policy (W5 ruling 1) and the diagnostics of
 *    the steps above; the transport goes through the session's raw channel
 *    (`raw-channel.ts`, the `/raw` tier). `create`/`resume` resolve once the
 *    handshake succeeded and reject only after the process is gone (plan
 *    §3.2).
 *
 * The diagnostics of steps 2 to 6 (`security.posture`, `binary.*`, `env.*`,
 * `settings-guard.*`, `containment.fallback`) are published before the
 * machine sees `process.started`, the channel the binding offers for them
 * (`DriverOptions.diagnostics`). The driver keeps everything published before
 * the handshake settled in its bounded pre-handshake buffer and replays it to
 * every `events()` subscriber after `compat`, so an application that
 * subscribes once `create` resolved still receives them (W5 lead review).
 *
 * An `AbortSignal` in the options is checked between the steps; during the
 * handshake it aborts the session (the abort ladder runs) and the call
 * rejects with `AbortError` once nothing is left running.
 *
 * @packageDocumentation
 */

import {
  AbortError,
  buildPosture,
  HarnessDisposedError,
  SessionIdInUseError,
  type HarnessCapabilities,
  type PermissionHandler,
  type Session,
  type SubscriberOptions,
} from '@hudhudjs/core';
import {
  createProcessTransport,
  createSession,
  SessionDriver,
  type BindingDiagnostic,
  type HarnessMachine,
  type HarnessTransport,
} from '@hudhudjs/core/binding';
import {
  assertSpawnable,
  createSessionContainment,
  processTableStartTime,
  validateCwd,
  type JobAddonLoad,
  type ProcessPlatform,
  type VerifiedBinary,
} from '@hudhudjs/core/process';

import {
  mapBinaryError,
  mapCwdError,
  mapSpawnError,
  platformOf,
  probeBinary,
  spawnableBinary,
  verifyExecutable,
  type BinaryContext,
  type ClaudeHost,
  type ProbedBinary,
} from './adapter.js';
import { buildArgv, checkCommandLine, type LaunchSpec } from './argv.js';
import { discoverBinary, type DiscoveredBinary } from './discovery.js';
import { buildChildEnv, type ChildEnv } from './env.js';
import type {
  EffectiveConnectOptions,
  EffectiveSessionOptions,
  SessionHostValues,
} from './options.js';
import {
  claudePostureEntries,
  projectSettingsFlagsOf,
  scanUserSettingsEnv,
  userConfigDir,
  type ProjectSettingsEnvFlags,
  type RawPostureInput,
} from './posture.js';
import {
  claudeSessionMachine,
  DEFAULT_AUTH_FAIL_FAST_SOURCES,
  type ClaudeSessionConfig,
  type ClaudeSessionState,
} from './protocol/machine/index.js';
import type { SessionClaim, SessionRegistry } from './registry.js';
import {
  checkProjectCredentialEnv,
  scanProjectSettings,
  type SettingsGuardDeps,
} from './settings-guard.js';
import { RawChannel } from './raw-channel.js';
import { encodeClaudeUserInput } from './user-input.js';

/** The driver of one Claude Code session. */
type ClaudeDriver = SessionDriver<ClaudeSessionState, ClaudeSessionConfig>;

/**
 * What the Harness hands the session factory (implemented by the Harness of
 * `connect.ts`).
 *
 * @internal
 */
export interface SessionHost {
  readonly host: ClaudeHost;
  readonly connect: EffectiveConnectOptions;
  readonly binaryContext: BinaryContext;
  /** The discovery result of `connect`: re-resolved when the binary changed. */
  readonly discovered: DiscoveredBinary;
  /** The binary sessions spawn; replaced after a session verified a changed file again. */
  current: ProbedBinary;
  readonly registry: SessionRegistry;
  readonly jobLoad: JobAddonLoad;
  readonly capabilities: HarnessCapabilities;
  /** Whether dispose started. */
  readonly disposed: boolean;
  /** Throws `HARNESS_DISPOSED` once dispose started. */
  assertOpen(): void;
  /** Drivers whose handshake is running: dispose aborts them. */
  readonly starting: Set<ClaudeDriver>;
  /**
   * Every `openSession` in flight, settled (never rejecting): dispose waits
   * for them, so it resolves only once nothing a start spawned still runs
   * (R4-2).
   */
  readonly opening: Set<Promise<void>>;
  /** Tracks a started session until it closed (dispose disposes it). */
  track(session: Session): void;
}

/**
 * The `/raw` spawn extras of a session (plan §2.6), already checked.
 *
 * @internal
 */
export interface RawSpawnExtras {
  readonly extraArgs: readonly string[];
  readonly extraEnv: Readonly<Record<string, string>>;
}

/**
 * The guard and the cwd of a session (step 2).
 *
 * @internal
 */
export interface PreparedSession {
  /** The realpath'd working directory. */
  readonly cwd: string;
  /** The guard's diagnostics. */
  readonly diagnostics: readonly BindingDiagnostic[];
  /** Under `projectCredentialEnv: 'allow'`: what the allowed files set. */
  readonly projectSettings?: ProjectSettingsEnvFlags;
}

/**
 * One session to open.
 *
 * @internal
 */
export interface SessionRequest {
  readonly effective: EffectiveSessionOptions;
  readonly values: SessionHostValues;
  readonly launch: LaunchSpec;
  readonly raw?: RawSpawnExtras;
  /** Step 1 already ran (`session()` runs it before `connect`). */
  readonly validated?: ValidatedSession;
  /** Step 2 already ran (`session()` runs it before `connect`). */
  readonly prepared?: PreparedSession;
}

/** The raw channel of every session this factory opened (plan §2.6). */
const channels = new WeakMap<Session, RawChannel>();

/**
 * The raw channel of a session of this adapter, or `undefined`.
 *
 * @internal
 */
export function rawChannelOf(session: Session): RawChannel | undefined {
  return channels.get(session);
}

// ---- small helpers -------------------------------------------------------------------

/**
 * Between two steps: a start whose Harness was disposed or whose signal
 * aborted goes no further (`HARNESS_DISPOSED` first, as `startSession` maps
 * an end).
 */
function checkpoint(harness: SessionHost, signal: AbortSignal | undefined): void {
  harness.assertOpen();
  if (signal?.aborted === true) throw AbortError.fromSignal(signal);
}

/** The id the session runs under: the registry key (J6). */
function sessionIdOf(launch: LaunchSpec): string {
  return launch.mode === 'resume' ? launch.resumeId : launch.sessionId;
}

/** `extraEnv` over the child environment; on win32 names compare without case. */
function withExtraEnv(
  env: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>>,
  platform: ProcessPlatform,
): Readonly<Record<string, string>> {
  const fold = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
  const replaced = new Set(Object.keys(extra).map(fold));
  const kept = Object.entries(env).filter(([name]) => !replaced.has(fold(name)));
  return Object.fromEntries([...kept, ...Object.entries(extra)]);
}

/**
 * The guard's host dependencies. The user's config directory is resolved
 * from the child environment `env`, the one the CLI runs with, exactly as
 * the posture resolves it (review R1-4): with an explicit env map the
 * parent's `CLAUDE_CONFIG_DIR` does not reach the CLI.
 */
function guardDeps(
  host: ClaudeHost,
  connect: EffectiveConnectOptions,
  env: Readonly<Record<string, string>>,
): SettingsGuardDeps {
  const platform = platformOf(host);
  return {
    fs: host.guardFs,
    platform,
    processCwd: host.cwd(),
    userConfigDir: userConfigDir({
      configDir: connect.configDir,
      env,
      homedir: host.homedir,
      platform,
    }),
  };
}

// ---- step 1: validation -----------------------------------------------------------------

/**
 * The argv and the environment of a session (step 1).
 *
 * @internal
 */
export interface ValidatedSession {
  readonly argv: readonly string[];
  readonly child: ChildEnv;
  /** The child environment with the raw `extraEnv` applied. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Builds the argv and the child environment (step 1): pure, no file system
 * access.
 *
 * @throws `InvalidOptionsError` (a malformed session id, an argv value that
 *   cannot be one element, win32 names that differ only in case)
 * @internal
 */
export function validateSession(
  host: ClaudeHost,
  connect: EffectiveConnectOptions,
  request: Pick<SessionRequest, 'effective' | 'launch' | 'raw'>,
): ValidatedSession {
  const platform = platformOf(host);
  const { effective, raw } = request;
  const argv = [...buildArgv(connect, effective, request.launch), ...(raw?.extraArgs ?? [])];
  const child = buildChildEnv(effective, connect, host.env, platform);
  const env = raw === undefined ? child.env : withExtraEnv(child.env, raw.extraEnv, platform);
  return { argv, child, env };
}

// ---- step 2: guard and cwd --------------------------------------------------------------

/**
 * The project credential guard, then the cwd (step 2 of the module remarks).
 *
 * @param env - the child environment of step 1 ({@link ValidatedSession.env})
 * @throws `ProjectCredentialEnvError`, `CwdInvalidError`, `CwdTooLongError`
 * @internal
 */
export async function prepareSession(
  host: ClaudeHost,
  connect: EffectiveConnectOptions,
  effective: EffectiveSessionOptions,
  env: Readonly<Record<string, string>>,
): Promise<PreparedSession> {
  const deps = guardDeps(host, connect, env);
  const diagnostics: BindingDiagnostic[] = [];
  let projectSettings: ProjectSettingsEnvFlags | undefined;
  if (effective.projectCredentialEnv === 'allow') {
    // 'allow' runs the same read-only scan; what it allowed is reported.
    const scan = await scanProjectSettings(effective, deps);
    diagnostics.push(...scan.diagnostics);
    projectSettings = projectSettingsFlagsOf(scan.variables, scan.unparseable.length > 0);
    if (scan.variables.length > 0 || scan.apiKeyHelper || scan.unparseable.length > 0) {
      diagnostics.push({
        code: 'settings-guard.allowed',
        message:
          "Project settings set credential or routing variables that projectCredentialEnv: 'allow' let through (names only).",
        data: {
          variables: [...scan.variables],
          apiKeyHelper: scan.apiKeyHelper,
          unparseable: [...scan.unparseable],
          scope: scan.scope,
        },
      });
    }
  } else {
    const report = await checkProjectCredentialEnv(effective, deps);
    diagnostics.push(...report.diagnostics);
  }
  let cwd: string;
  try {
    cwd = await validateCwd(effective.cwd ?? host.cwd(), platformOf(host), host.cwdFs);
  } catch (error) {
    throw mapCwdError(error);
  }
  return projectSettings === undefined
    ? { cwd, diagnostics }
    : { cwd, diagnostics, projectSettings };
}

// ---- step 4: the spawn gate ---------------------------------------------------------------

/** Resolves the discovered path again and verifies what it now names. */
async function reverify(harness: SessionHost): Promise<VerifiedBinary> {
  const again = await discoverBinary(harness.discovered.requestedPath, harness.host.discovery);
  return verifyExecutable(harness.binaryContext, again.executable);
}

/** The binary to spawn, with the diagnostics the gate produced. */
async function gate(
  harness: SessionHost,
  signal: AbortSignal | undefined,
): Promise<{ readonly probed: ProbedBinary; readonly diagnostics: BindingDiagnostic[] }> {
  const ctx = harness.binaryContext;
  const previous = harness.current;
  const checked = await spawnableBinary(ctx, previous.binary, () => reverify(harness));
  if (!checked.reverified) return { probed: previous, diagnostics: [] };
  // New bytes: probe them (K4), then check the identity once more before the
  // spawn. An abort stops the probe at once and is reported as the abort.
  const probed = await probeBinary(ctx, checked.binary, signal).catch((error: unknown) => {
    checkpoint(harness, signal);
    throw error;
  });
  try {
    await assertSpawnable(probed.binary, harness.host.identityFs);
  } catch (error) {
    throw mapBinaryError(error, ctx.mode);
  }
  harness.current = probed;
  const diagnostics: BindingDiagnostic[] =
    probed.version === previous.version
      ? []
      : [
          {
            code: 'binary.version-changed',
            message: 'The binary changed after connect; the new file was verified and probed.',
            data: { probedVersion: previous.version, version: probed.version, reverified: true },
          },
        ];
  return { probed, diagnostics };
}

// ---- step 7: the driver ---------------------------------------------------------------------

/**
 * The session machine with the registry rebind of J6: when the harness
 * reports its session id (the first `system/init`), the claim follows it.
 * The step itself is the Claude machine's, unchanged; only on a conflict
 * (another live session of this Harness holds the reported id) a
 * `session.id-in-use` diagnostic is added and the session is aborted.
 */
function claimingMachine(
  claim: SessionClaim,
  onConflict: () => void,
): HarnessMachine<ClaudeSessionState, ClaudeSessionConfig> {
  return {
    initialState: (config) => claudeSessionMachine.initialState(config),
    step(state, input) {
      const out = claudeSessionMachine.step(state, input);
      const observed = out.state.observedSessionId;
      if (state.observedSessionId !== null || observed === null || observed === '') return out;
      try {
        claim.rebind(observed);
        return out;
      } catch (error) {
        // A TypeError: an id the registry cannot hold (the machine reported
        // the mismatch already), or a claim released by the end.
        if (!(error instanceof SessionIdInUseError)) return out;
      }
      onConflict();
      return {
        state: out.state,
        effects: [
          ...out.effects,
          {
            type: 'event',
            event: {
              type: 'diagnostic',
              code: 'session.id-in-use',
              message:
                'The harness reports a session id another live session of this Harness holds; the session is aborted.',
              data: { sessionId: observed },
              seq: 0,
              ts: input.at,
              sessionId: state.config.sessionId,
            },
          },
        ],
      };
    },
  };
}

function envDiagnostics(child: ChildEnv): BindingDiagnostic[] {
  const diagnostics: BindingDiagnostic[] = [];
  if (child.dropped.length > 0 || child.spawnInjected.length > 0) {
    diagnostics.push({
      code: 'env.dropped',
      message: 'Variables of the parent environment were not passed to the harness (names only).',
      data: { names: [...child.dropped], spawnInjected: [...child.spawnInjected] },
    });
  }
  if (child.added.length > 0) {
    diagnostics.push({
      code: 'env.added',
      message: 'Variables added by env.add (names only).',
      data: { names: [...child.added] },
    });
  }
  if (child.removed.length > 0) {
    diagnostics.push({
      code: 'env.removed',
      message: 'Variables removed by env.remove (names only).',
      data: { names: [...child.removed] },
    });
  }
  return diagnostics;
}

/** The core's handler type for the validated callback (the bridge checks every decision). */
function permissionHandler(values: SessionHostValues): PermissionHandler | undefined {
  const callback = values.onPermission;
  if (callback === undefined) return undefined;
  // The option type only states "a function" (options-types.ts); the bridge
  // copies and checks whatever the callback returns, strictly.
  return async (request, ctx) => (await callback(request as never, ctx)) as never;
}

function subscriberDefaults(
  effective: EffectiveSessionOptions,
  values: SessionHostValues,
): SubscriberOptions {
  return values.eventsSignal === undefined
    ? { ...effective.events }
    : { ...effective.events, signal: values.eventsSignal };
}

function machineConfig(
  harness: SessionHost,
  request: SessionRequest,
  probed: ProbedBinary,
): ClaudeSessionConfig {
  const { effective, launch, values } = request;
  return {
    mode: launch.mode,
    sessionId: sessionIdOf(launch),
    ...(launch.mode === 'fork' ? { forkedFrom: launch.resumeId } : {}),
    firstFrameTimeoutMs: effective.firstFrameTimeoutMs,
    idleStallMs: effective.idleStallMs,
    closeTimeoutMs: effective.closeTimeoutMs,
    interruptWaitMs: effective.termination.interruptWaitMs,
    maxOutboundBytes: effective.maxOutboundFrameBytes,
    onOversizedFrame: effective.onOversizedFrame,
    onAuthFailure: effective.onAuthFailure,
    authFailFastSources: DEFAULT_AUTH_FAIL_FAST_SOURCES,
    permissionHandler: values.onPermission !== undefined,
    allowConfigWrites: effective.dangerouslyAllowConfigWrites,
    allowBypassPermissions: effective.dangerouslyAllowBypassPermissions,
    platform: platformOf(harness.host),
    initialize: {},
    probedVersion: probed.version,
    knownBroken: harness.host.compat.knownBroken.map(({ version, reason }) => ({
      version,
      reason,
    })),
    allowKnownBrokenVersion: harness.connect.dangerouslyAllowKnownBrokenVersion,
  };
}

/**
 * Opens one session (see the module remarks). The open is tracked in
 * `harness.opening` until it settled, so a dispose that lands at any step
 * waits for it: a start that has not spawned yet refuses at its next
 * `assertOpen` (`HARNESS_DISPOSED`), one that spawned ends its CLI first.
 *
 * @throws every error of plan §3.1 that `create` and `resume` list
 * @internal
 */
export async function openSession(harness: SessionHost, request: SessionRequest): Promise<Session> {
  harness.assertOpen();
  const opened = openSteps(harness, request);
  const settled = opened.then(
    () => undefined,
    () => undefined,
  );
  harness.opening.add(settled);
  void settled.then(() => harness.opening.delete(settled));
  return opened;
}

async function openSteps(harness: SessionHost, request: SessionRequest): Promise<Session> {
  const { host, connect } = harness;
  const { effective, values, launch } = request;
  const signal = values.signal;
  const platform = platformOf(host);

  // 1. Validation: pure, no file system access.
  const { argv, child, env } = request.validated ?? validateSession(host, connect, request);
  checkpoint(harness, signal);

  // 2. The guard, then the cwd.
  const prepared = request.prepared ?? (await prepareSession(host, connect, effective, env));
  checkpoint(harness, signal);

  // 3. The session's posture (K19, K23).
  const userSettings = await scanUserSettingsEnv({
    configDir: () =>
      userConfigDir({ configDir: connect.configDir, env, homedir: host.homedir, platform }),
    reader: host.settingsReader,
    platform,
  });
  const raw: RawPostureInput | undefined =
    request.raw === undefined
      ? undefined
      : { extraArgs: request.raw.extraArgs, extraEnv: request.raw.extraEnv };
  const posture = buildPosture(
    claudePostureEntries({
      connect,
      session: effective,
      env,
      userSettings,
      ...(prepared.projectSettings === undefined
        ? {}
        : { projectSettings: prepared.projectSettings }),
      ...(raw === undefined ? {} : { raw }),
      platform,
    }),
  );
  checkpoint(harness, signal);

  // 4. The spawn gate (TOCTOU between verification and spawn).
  const { probed, diagnostics: gateDiagnostics } = await gate(harness, signal);
  const binary = probed.binary;
  checkCommandLine(binary.path, argv, platform);
  checkpoint(harness, signal);

  // 5. The registry claim.
  harness.assertOpen();
  const claim = harness.registry.claim(sessionIdOf(launch));

  // 6. The spawn, with the containment inside it.
  let spawned: Spawned;
  try {
    spawned = await spawnContained(harness, {
      file: binary.path,
      args: argv,
      cwd: prepared.cwd,
      env,
      effective,
    });
  } catch (error) {
    claim.release();
    throw error;
  }

  // 7. The driver.
  const diagnostics: BindingDiagnostic[] = [
    {
      code: 'security.posture',
      message: "The session's security posture (plan §2.4).",
      data: {
        entries: posture.entries.map(({ setting, value, defaultValue, deviates }) => ({
          setting,
          value,
          defaultValue,
          deviates,
        })),
      },
    },
    ...gateDiagnostics,
    ...(binary.verification.status === 'verified'
      ? []
      : [
          {
            code: 'binary.unverified',
            message: `The binary is ${binary.verification.status} (${binary.verification.mode} verification).`,
            data: { ...binary.verification },
          },
        ]),
    ...envDiagnostics(child),
    ...prepared.diagnostics,
    ...spawned.diagnostics,
  ];
  const onPermission = permissionHandler(values);
  const channel = new RawChannel({
    clock: host.clock,
    maxOutboundBytes: effective.maxOutboundFrameBytes,
    policy: {
      allowRawControl: connect.dangerouslyAllowRawControl,
      allowConfigWrites: effective.dangerouslyAllowConfigWrites,
    },
    defaults: { ...effective.events },
    ...(values.eventsSignal === undefined ? {} : { signal: values.eventsSignal }),
  });
  // A registry conflict aborts the session after the step (never inside it).
  const conflict = Promise.withResolvers<undefined>();
  const started: ClaudeDriver = new SessionDriver({
    machine: claimingMachine(claim, () => {
      conflict.resolve(undefined);
    }),
    config: machineConfig(harness, request, probed),
    transport: channel.wrap(spawned.transport),
    sessionId: sessionIdOf(launch),
    compat: probed.compat,
    ...(onPermission === undefined ? {} : { onPermission }),
    events: subscriberDefaults(effective, values),
    containment: spawned.containment,
    diagnostics,
    encodeUserInput: encodeClaudeUserInput,
    clock: host.clock,
    ids: host.ids,
    hostExit: host.hostExit,
  });
  // Neither chain can reject: `conflict` only resolves, `abort` and `ended`
  // never reject (SessionDriver), and `release`/`close` never throw.
  void conflict.promise.then(() => started.abort('abort'));
  void started.ended.then(() => {
    claim.release();
    channel.close();
  });
  const session = await startSession(harness, started, signal);
  channels.set(session, channel);
  return session;
}

/** A spawned, contained CLI and its transport. */
interface Spawned {
  readonly transport: HarnessTransport;
  /** What the session got (K2). */
  readonly containment: 'job' | 'best-effort';
  /** `containment.fallback` when the job could not hold the process. */
  readonly diagnostics: readonly BindingDiagnostic[];
}

/** Spawns the CLI with the session's containment and builds its transport. */
async function spawnContained(
  harness: SessionHost,
  spec: {
    readonly file: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly effective: EffectiveSessionOptions;
  },
): Promise<Spawned> {
  const { host } = harness;
  const os = host.os();
  const containment = createSessionContainment(
    harness.jobLoad,
    processTableStartTime(os.processTable),
  );
  let proc;
  try {
    proc = await host.spawn({
      file: spec.file,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      startTime: containment.startTime,
    });
  } catch (error) {
    throw mapSpawnError(error);
  }
  // Before anything is written (ADR-0009 §1): the job holds the process
  // already when the spawn resolves; attach reports what the session got.
  const attached = containment.attach(proc);
  const transport = createProcessTransport({
    process: proc,
    os,
    job: attached.job,
    jobReleased: attached.released,
    timing: { ...spec.effective.termination },
    clock: host.clock,
    maxLineBytes: spec.effective.maxFrameBytes,
  });
  return {
    transport,
    containment: attached.containment,
    diagnostics: attached.diagnostics.map(({ code, message, data }) => ({
      code,
      message,
      data: { ...data },
    })),
  };
}

/** Starts the driver: resolves with the session once the handshake succeeded. */
async function startSession(
  harness: SessionHost,
  driver: ClaudeDriver,
  signal: AbortSignal | undefined,
): Promise<Session> {
  const onAbort = (): void => {
    // Never rejects (SessionDriver.abort resolves with the session's end).
    void driver.abort('abort');
  };
  harness.starting.add(driver);
  // A dispose or a signal abort that landed while the CLI was spawned fires
  // nothing any more: this start ends its CLI itself (R4-2).
  if (harness.disposed) void driver.abort('dispose');
  else if (signal?.aborted === true) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await driver.start();
  } catch (error) {
    // The driver rejects only after the session ended: nothing is left running.
    throw endingError(harness, signal, error);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    harness.starting.delete(driver);
  }
  if (harness.disposed || signal?.aborted === true) {
    await driver.abort(harness.disposed ? 'dispose' : 'abort');
    throw endingError(harness, signal, undefined);
  }
  const session = createSession(driver);
  harness.track(session);
  return session;
}

function endingError(
  harness: SessionHost,
  signal: AbortSignal | undefined,
  error: unknown,
): unknown {
  if (harness.disposed) return new HarnessDisposedError('The harness was disposed.');
  if (signal?.aborted === true) return AbortError.fromSignal(signal);
  return error;
}
