import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importBuilt } from '../../../scripts/test/support/import-built.mjs';
import { adapterApiVersion, wireSchemaVersion } from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

/** Run-time export names of each entry point (types are checked by the API reports). */
const ENTRY_NAMES = {
  '@hudhudjs/core': [
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
    'SubscriberOverflowError',
    'TurnDroppedError',
    'adapterApiVersion',
    'buildPosture',
    'credentialEnvNames',
    'defineAdapter',
    'isCredentialEnvName',
    'isEventType',
    'isHudhudError',
    'isSensitiveFieldName',
    'parsePosture',
    'postureDeviations',
    'postureEntry',
    'redactJson',
    'redactText',
    'secretsFromEnv',
    'serializePosture',
    'wireSchemaVersion',
  ],
  '@hudhudjs/core/protocol': [
    'DEFAULT_MAX_JSON_DEPTH',
    'DEFAULT_MAX_OUTBOUND_FRAME_BYTES',
    'ERROR_RETRYABLE',
    'HUDHUD_ERROR_CODES',
    'TERMINATION_INTENTS',
    'UNKNOWN_EXIT_CODE',
    'classifyExit',
    'encodeJsonLine',
    'isEventType',
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
  '@hudhudjs/core/binding': [
    'DEFAULT_OUTPUT_DRAIN_MS',
    'Fanout',
    'HUDHUD_ERROR_CODES',
    'HarnessBase',
    'HostExitHook',
    'LinkedSignal',
    'LoopbackTransport',
    'LoopbackViolation',
    'ManualClock',
    'PRE_HANDSHAKE_MAX_BYTES',
    'PRE_HANDSHAKE_MAX_EVENTS',
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
  '@hudhudjs/core/process': [
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

describe('@hudhudjs/core', () => {
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
      '@hudhudjs/core': expect.objectContaining({
        ok: true,
        file: 'dist/index.js',
        names: ENTRY_NAMES['@hudhudjs/core'],
      }) as unknown,
      '@hudhudjs/core/protocol': expect.objectContaining({
        ok: true,
        file: 'dist/protocol/index.js',
        names: ENTRY_NAMES['@hudhudjs/core/protocol'],
      }) as unknown,
      '@hudhudjs/core/binding': expect.objectContaining({
        ok: true,
        file: 'dist/binding/index.js',
        names: ENTRY_NAMES['@hudhudjs/core/binding'],
      }) as unknown,
      '@hudhudjs/core/process': expect.objectContaining({
        ok: true,
        file: 'dist/process/index.js',
        names: ENTRY_NAMES['@hudhudjs/core/process'],
      }) as unknown,
    });
    expect(results['@hudhudjs/core/binding']).toMatchObject({
      exports: { DEFAULT_OUTPUT_DRAIN_MS: 2000, SYNTHESIZED_EVENT_BYTES: 256 },
    });
    expect(results['@hudhudjs/core']).toMatchObject({
      exports: { adapterApiVersion: 1, wireSchemaVersion: 1, REDACTED: '<redacted>' },
    });
    expect(results['@hudhudjs/core/protocol']).toMatchObject({
      exports: { DEFAULT_MAX_OUTBOUND_FRAME_BYTES: 33_554_432, DEFAULT_MAX_JSON_DEPTH: 512 },
    });
    expect(results['@hudhudjs/core/process']).toMatchObject({
      exports: { DEFAULT_MAX_INBOUND_FRAME_BYTES: 67_108_864, WIN32_CWD_MAX_LENGTH: 258 },
    });
  });

  // R5-6: `./schemas/*` alone mapped `events.schema.json` to
  // `events.schema.json.json`; the documented specifier names the file.
  it('imports every schema by its file name and without .json', () => {
    const names = readdirSync(new URL('../schemas/', import.meta.url)).filter((name) =>
      name.endsWith('.json'),
    );
    expect(names).toContain('events.schema.json');
    const specifiers = names.flatMap((name) => [
      `@hudhudjs/core/schemas/${name}`,
      `@hudhudjs/core/schemas/${name.slice(0, -'.json'.length)}`,
    ]);
    const results = importBuilt(packageDir, specifiers);
    for (const name of names) {
      for (const specifier of [
        `@hudhudjs/core/schemas/${name}`,
        `@hudhudjs/core/schemas/${name.slice(0, -'.json'.length)}`,
      ]) {
        expect(results[specifier]).toMatchObject({
          ok: true,
          file: `schemas/${name}`,
          names: ['default'],
        });
      }
    }
    expect(results['@hudhudjs/core/schemas/events.schema.json']).toMatchObject({
      exports: { default: { title: 'hudhud events' } },
    });
    expect(results['@hudhudjs/core/schemas/version.json']).toMatchObject({
      exports: { default: { wireSchemaVersion } },
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
      '@hudhudjs/core/dist/index.js',
      '@hudhudjs/core/src/index.ts',
    ]);
    expect(results).toEqual({
      '@hudhudjs/core/dist/index.js': { ok: false, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
      '@hudhudjs/core/src/index.ts': { ok: false, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
    });
  });
});
