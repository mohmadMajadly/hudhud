import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importBuilt } from '../../../scripts/test/support/import-built.mjs';
import { adapterApiVersion, wireSchemaVersion } from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Run-time export names of each entry point (types are checked by the API reports). */
const ENTRY_NAMES = {
  '@hudhud/core': [
    'AbortError',
    'AdapterApiVersionError',
    'AuthenticationFailedError',
    'BinaryNotFoundError',
    'BinaryProbeError',
    'BinaryRefusedError',
    'BinaryVerificationError',
    'CapabilityUnsupportedError',
    'ControlRequestError',
    'CwdInvalidError',
    'CwdTooLongError',
    'HUDHUD_ERROR_CODES',
    'HandshakeError',
    'HandshakeTimeoutError',
    'HarnessDisposedError',
    'HarnessVersionKnownBrokenError',
    'HudhudError',
    'InvalidOptionsError',
    'MIN_ENV_SECRET_LENGTH',
    'OutboundFrameTooLargeError',
    'OversizedFrameError',
    'ProcessExitedError',
    'ProjectCredentialEnvError',
    'ProtocolError',
    'REDACTED',
    'SessionClosedError',
    'SessionIdInUseError',
    'SessionNotFoundError',
    'SessionPoisonedError',
    'SpawnError',
    'StderrTail',
    'SubscriberOverflowError',
    'TRUNCATED',
    'TurnDroppedError',
    'UsageEstimator',
    'adapterApiVersion',
    'buildPosture',
    'credentialEnvNames',
    'defineAdapter',
    'estimateUsageDelta',
    'isCredentialEnvName',
    'isHudhudError',
    'isSensitiveFieldName',
    'parsePosture',
    'postureDeviations',
    'postureEntry',
    'redactJson',
    'redactText',
    'sanitizeUsage',
    'secretsFromEnv',
    'serializePosture',
    'wireSchemaVersion',
  ],
  '@hudhud/core/protocol': [
    'DEFAULT_MAX_JSON_DEPTH',
    'DEFAULT_MAX_OUTBOUND_FRAME_BYTES',
    'ERROR_RETRYABLE',
    'HUDHUD_ERROR_CODES',
    'TERMINATION_INTENTS',
    'UNKNOWN_EXIT_CODE',
    'classifyExit',
    'encodeJsonLine',
    'isHudhudErrorCode',
    'isJsonObject',
    'isJsonValue',
    'isRetryable',
    'makeErrorData',
    'ownArray',
    'ownBoolean',
    'ownNumber',
    'ownObject',
    'ownString',
    'parseErrorData',
    'parseJsonLine',
    'sanitizeForDisplay',
  ],
  '@hudhud/core/binding': [
    'DEFAULT_OUTPUT_DRAIN_MS',
    'Fanout',
    'HUDHUD_ERROR_CODES',
    'HarnessBase',
    'HostExitHook',
    'LoopbackTransport',
    'LoopbackViolation',
    'ManualClock',
    'SYNTHESIZED_EVENT_BYTES',
    'SessionDriver',
    'TransportWriteError',
    'counterIds',
    'createLoopbackDriver',
    'createProcessTransport',
    'createSession',
    'cryptoIds',
    'hostExit',
    'loopbackLadder',
    'loopbackMachine',
    'normalizeUserInput',
    'openSession',
    'systemClock',
  ],
  '@hudhud/core/process': [
    'ArgvError',
    'BinaryChangedError',
    'BinaryNotVerifiedError',
    'CwdValidationError',
    'DARWIN_CHILD_SET_ENV_NAMES',
    'DEFAULT_LADDER_TIMING',
    'DEFAULT_MAX_INBOUND_FRAME_BYTES',
    'DEFAULT_SIGNATURE_TIMEOUT_MS',
    'DEFAULT_TASKKILL_TIMEOUT_MS',
    'DEFAULT_VERSION_PROBE_MAX_BYTES',
    'DEFAULT_VERSION_PROBE_TIMEOUT_MS',
    'ExecutableResolutionError',
    'FileChangedError',
    'JOB_TERMINATE_EXIT_CODE',
    'JobAddonError',
    'NotRegularFileError',
    'ProcessSpawnError',
    'ProcessStreamError',
    'SpawnSpecError',
    'StderrTail',
    'TRUNCATED',
    'TaskkillUnavailableError',
    'VerificationCache',
    'VersionProbeError',
    'WIN32_CWD_MAX_LENGTH',
    'WIN32_DEFAULT_SYSTEM_ROOT',
    'WIN32_JOB_ADDON_SPECIFIER',
    'WIN32_REQUIRED_ENV_NAMES',
    'assertNoReservedFlags',
    'assertSpawnable',
    'assertSpawnableOrReverify',
    'checkCwdPath',
    'checkExecutablePath',
    'checkKnownDigests',
    'checkOsSignature',
    'childEnv',
    'compareStartTime',
    'createFramer',
    'createSessionContainment',
    'createTaskkillCalls',
    'descendantsOf',
    'findIdentity',
    'formatFlag',
    'hostJobAddonDeps',
    'hostPlatform',
    'isCanonicalStartTime',
    'isFlagName',
    'jobContainmentCapability',
    'loadHostJobAddon',
    'loadJobAddon',
    'maxFramerLineBytes',
    'nodeTaskkillDeps',
    'osCallsFor',
    'parseFlag',
    'parseProcStat',
    'parsePsOutput',
    'parseWin32ProcessJson',
    'pathProblem',
    'processTableStartTime',
    'recheckBinary',
    'resolveExecutable',
    'resolveTaskkillPath',
    'runBoundedCommand',
    'runPosixLadder',
    'runVersionProbe',
    'runWindowsLadder',
    'safeSearchPathEntries',
    'sameIdentity',
    'settleProbedVersion',
    'sha256File',
    'signaturePlatformOf',
    'snapshotAtEof',
    'snapshotDescendants',
    'spawnHarnessProcess',
    'sweep',
    'sweepAfterExit',
    'systemRootFrom',
    'taskkillArgv',
    'tempProbeWorkDir',
    'validateCwd',
    'verifyBinary',
  ],
} as const;

describe('@hudhud/core', () => {
  it('exports the adapter API version as a positive integer', () => {
    expect(adapterApiVersion).toBe(1);
    expect(Number.isSafeInteger(adapterApiVersion)).toBe(true);
  });

  it('exports the wire schema version of the committed schemas', () => {
    const version = JSON.parse(
      readFileSync(new URL('../schemas/version.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(version).toEqual({ wireSchemaVersion });
  });

  it('resolves every entry point of the exports map from the built output', () => {
    const results = importBuilt(packageDir, Object.keys(ENTRY_NAMES));
    expect(results).toEqual({
      '@hudhud/core': expect.objectContaining({
        ok: true,
        file: 'dist/index.js',
        names: ENTRY_NAMES['@hudhud/core'],
      }) as unknown,
      '@hudhud/core/protocol': expect.objectContaining({
        ok: true,
        file: 'dist/protocol/index.js',
        names: ENTRY_NAMES['@hudhud/core/protocol'],
      }) as unknown,
      '@hudhud/core/binding': expect.objectContaining({
        ok: true,
        file: 'dist/binding/index.js',
        names: ENTRY_NAMES['@hudhud/core/binding'],
      }) as unknown,
      '@hudhud/core/process': expect.objectContaining({
        ok: true,
        file: 'dist/process/index.js',
        names: ENTRY_NAMES['@hudhud/core/process'],
      }) as unknown,
    });
    expect(results['@hudhud/core/binding']).toMatchObject({
      exports: { DEFAULT_OUTPUT_DRAIN_MS: 2000, SYNTHESIZED_EVENT_BYTES: 256 },
    });
    expect(results['@hudhud/core']).toMatchObject({
      exports: { adapterApiVersion: 1, wireSchemaVersion: 1, REDACTED: '<redacted>' },
    });
    expect(results['@hudhud/core/protocol']).toMatchObject({
      exports: { DEFAULT_MAX_OUTBOUND_FRAME_BYTES: 33_554_432, DEFAULT_MAX_JSON_DEPTH: 512 },
    });
    expect(results['@hudhud/core/process']).toMatchObject({
      exports: { DEFAULT_MAX_INBOUND_FRAME_BYTES: 67_108_864, WIN32_CWD_MAX_LENGTH: 258 },
    });
  });

  it('does not expose internals through any entry point', () => {
    const internals = [
      'framerRetention',
      'errnoCode',
      'decodeUtf8Lossy',
      'parsePid',
      'indexByPid',
      'filetimeToMicroseconds',
      'takeSnapshot',
      'redactNormalized',
      'prepareSecrets',
      'maskCutEnd',
      'Utf8StreamDecoder',
      'isJsonObjectValue',
      // The queue stays internal; the fanout over it is beta on the binding
      // entry since W5-T1 (the Claude Code raw tier's frames).
      'BoundedQueue',
      // The permission bridge and the decision copy stay inside the driver.
      'PermissionBridge',
      'validateDecision',
      'copyJson',
    ];
    const exported: readonly string[] = Object.values(ENTRY_NAMES).flat();
    for (const name of internals) expect(exported).not.toContain(name);
  });

  it('does not expose files outside the exports map', () => {
    const results = importBuilt(packageDir, [
      '@hudhud/core/dist/index.js',
      '@hudhud/core/src/index.ts',
    ]);
    expect(results).toEqual({
      '@hudhud/core/dist/index.js': { ok: false, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
      '@hudhud/core/src/index.ts': { ok: false, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
    });
  });
});
