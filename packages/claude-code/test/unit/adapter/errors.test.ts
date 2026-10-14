// Error mapping of the assembled adapter (plan §3.1, §3.2; W5 rulings 1, 2,
// 7): every failure of connect and of a session's start surfaces as its
// public error class, details name versions, paths and variable names only,
// and nothing is left running when a call rejects.

import { describe, expect, it } from 'vitest';

import {
  AbortError,
  BinaryNotFoundError,
  BinaryProbeError,
  BinaryVerificationError,
  CwdInvalidError,
  CwdTooLongError,
  HandshakeError,
  HarnessDisposedError,
  HarnessVersionKnownBrokenError,
  InvalidOptionsError,
  SpawnError,
} from '@hudhud/core';
import {
  CwdValidationError,
  ProcessSpawnError,
  SpawnSpecError,
  VersionProbeError,
} from '@hudhud/core/process';

import {
  mapBinaryError,
  mapCwdError,
  mapSpawnError,
  verificationError,
} from '../../../src/adapter.js';
import type { CompatPolicy } from '../../../src/compat.js';
import { connectWith, disposeWhenClosed, sessionWith } from '../../../src/connect.js';
import {
  BINARY,
  captureEvents,
  controlOk,
  FakeHost,
  OTHER_DIGEST,
  settle,
  VERSION,
} from './fake-host.js';

const LISTED: CompatPolicy = {
  minTested: VERSION,
  maxTested: VERSION,
  knownBroken: [{ version: VERSION, reason: 'drops permission answers (test listing)' }],
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('connect errors', () => {
  it('a missing binary is BINARY_NOT_FOUND with the candidate', async () => {
    const fake = new FakeHost();
    const error = await rejection(connectWith({ binaryPath: '/nowhere/claude' }, fake.make));
    expect(error).toBeInstanceOf(BinaryNotFoundError);
    expect(error).toMatchObject({ details: { path: '/nowhere/claude' } });
    expect(fake.log).not.toContain('hash');
  });

  it.each([
    [{ kind: 'timeout' }, { reason: 'timeout' }],
    [
      { kind: 'exited', exitCode: 2, signal: null, stdout: '' },
      { reason: 'exit-code', subject: '2' },
    ],
    [
      { kind: 'spawn-error', errno: 'EACCES' },
      { reason: 'spawn-error', subject: 'EACCES' },
    ],
    [{ kind: 'output-too-large' }, { reason: 'output-too-large' }],
  ] as const)('a probe outcome %j is BINARY_PROBE_FAILED (retryable)', async (outcome, details) => {
    const fake = new FakeHost();
    fake.probe = () => outcome;
    const error = await rejection(connectWith({ binaryPath: BINARY }, fake.make));
    expect(error).toBeInstanceOf(BinaryProbeError);
    expect(error).toMatchObject({ retryable: true, details });
  });

  it('probe output without a version is refused without copying it', async () => {
    const fake = new FakeHost();
    fake.probe = () => ({ kind: 'exited', exitCode: 0, signal: null, stdout: 'sk-ant-secret\n' });
    const error = await rejection(connectWith({ binaryPath: BINARY }, fake.make));
    expect(error).toBeInstanceOf(BinaryProbeError);
    expect(error).toMatchObject({ details: { reason: 'unparseable-output' } });
    expect(JSON.stringify(error)).not.toContain('sk-ant-secret');
  });

  it('strict mode refuses an unverified binary before the probe', async () => {
    const fake = new FakeHost();
    fake.binary = { ...fake.binary, sha256: OTHER_DIGEST };
    const error = await rejection(
      connectWith({ binaryPath: BINARY, binaryVerification: 'strict' }, fake.make),
    );
    expect(error).toBeInstanceOf(BinaryVerificationError);
    expect(error).toMatchObject({
      retryable: false,
      details: { path: BINARY, status: 'unverified', method: 'sha256-manifest', mode: 'strict' },
    });
    expect(fake.log.some((entry) => entry.startsWith('probe'))).toBe(false);
  });

  it('advisory mode reports an unverified binary and runs it', async () => {
    const fake = new FakeHost();
    fake.binary = { ...fake.binary, sha256: OTHER_DIGEST, version: '2.1.400' };
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    expect(harness.binary.verification).toMatchObject({ status: 'unverified', mode: 'advisory' });
    expect(harness.compat.status).toBe('untested');
    const captured = captureEvents(harness);
    const session = await harness.sessions.create();
    expect(captured[0]).toContainEqual(
      expect.objectContaining({
        code: 'binary.unverified',
        data: expect.objectContaining({ status: 'unverified', mode: 'advisory' }) as unknown,
      }),
    );
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('a probed version that disagrees with the matched digest is failed; strict refuses it', async () => {
    const fake = new FakeHost();
    fake.binary = { ...fake.binary, version: '2.1.297' };
    const advisory = await connectWith({ binaryPath: BINARY }, fake.make);
    expect(advisory.binary.verification).toMatchObject({ status: 'failed' });
    await advisory[Symbol.asyncDispose]();
    const error = await rejection(
      connectWith({ binaryPath: BINARY, binaryVerification: 'strict' }, fake.make),
    );
    expect(error).toBeInstanceOf(BinaryVerificationError);
    expect(error).toMatchObject({ details: { status: 'failed' } });
  });

  it('a binary that changes while it is verified is refused', async () => {
    const fake = new FakeHost();
    const hash = fake.host.verify?.hash;
    const host = {
      ...fake.host,
      verify: {
        ...fake.host.verify,
        hash: async (file: string) => {
          const digest = await hash?.(file);
          return { ...digest, mtimeMs: 99 } as never;
        },
      },
    };
    const error = await rejection(connectWith({ binaryPath: BINARY }, () => host));
    expect(error).toBeInstanceOf(BinaryVerificationError);
    expect(error).toMatchObject({ details: { status: 'failed', method: 'none' } });
  });

  it('a known-broken probed version is refused with the committed reason (ruling 1)', async () => {
    const fake = new FakeHost({ compat: LISTED });
    const error = await rejection(connectWith({ binaryPath: BINARY }, fake.make));
    expect(error).toBeInstanceOf(HarnessVersionKnownBrokenError);
    expect(error).toMatchObject({
      retryable: false,
      details: { version: VERSION, reason: 'drops permission answers (test listing)' },
    });
  });

  it('the opt-in runs it: compat stays known-broken and the posture lists the opt-in', async () => {
    const fake = new FakeHost({ compat: LISTED });
    const harness = await connectWith(
      { binaryPath: BINARY, claudeCode: { dangerouslyAllowKnownBrokenVersion: true } },
      fake.make,
    );
    expect(harness.compat).toMatchObject({ status: 'known-broken', knownBroken: [VERSION] });
    expect(harness.securityPosture.entries).toContainEqual({
      setting: 'claudeCode.dangerouslyAllowKnownBrokenVersion',
      value: true,
      defaultValue: false,
      deviates: true,
    });
    const session = await harness.sessions.create();
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('an aborted signal rejects with AbortError before anything runs, or between steps', async () => {
    const fake = new FakeHost();
    const aborted = AbortSignal.abort('stop');
    await expect(
      connectWith({ binaryPath: BINARY, signal: aborted }, fake.make),
    ).rejects.toBeInstanceOf(AbortError);
    expect(fake.log).toEqual([]);
    const controller = new AbortController();
    fake.probe = () => {
      controller.abort('during the probe');
      return { kind: 'exited', exitCode: 0, signal: null, stdout: `${VERSION} (Claude Code)\n` };
    };
    const error = await rejection(
      connectWith({ binaryPath: BINARY, signal: controller.signal }, fake.make),
    );
    expect(error).toBeInstanceOf(AbortError);
    expect(fake.log.some((entry) => entry.startsWith('user-settings'))).toBe(false);
  });
});

describe('session start errors', () => {
  it('a cwd that does not exist is CWD_INVALID; nothing is spawned', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    await expect(harness.sessions.create({ cwd: '/missing' })).rejects.toBeInstanceOf(
      CwdInvalidError,
    );
    await expect(harness.sessions.create({ cwd: 'relative' })).rejects.toMatchObject({
      code: 'CWD_INVALID',
      details: { reason: 'not-absolute' },
    });
    expect(fake.log).not.toContain('spawn');
    await harness[Symbol.asyncDispose]();
  });

  it('a spawn the OS refuses is SPAWN_FAILED and releases the claim', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    fake.beforeSpawn = () => {
      throw new ProcessSpawnError('EACCES');
    };
    const error = await rejection(harness.sessions.create());
    expect(error).toBeInstanceOf(SpawnError);
    expect(error).toMatchObject({ details: { cause: 'eacces', errno: 'EACCES' } });
    expect(harness.registry.size).toBe(0);
    await harness[Symbol.asyncDispose]();
  });

  it('an initialize error is HANDSHAKE_FAILED after the process ended', async () => {
    const fake = new FakeHost({
      script: {
        initFrame: (requestId) => ({
          type: 'control_response',
          response: { subtype: 'error', request_id: requestId, error: 'nope' },
        }),
      },
    });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const error = await rejection(harness.sessions.create());
    expect(error).toBeInstanceOf(HandshakeError);
    expect(error).toMatchObject({ details: { cause: 'error-response' } });
    expect(fake.cli.exitStatus).not.toBeNull();
    await settle();
    expect(harness.registry.size).toBe(0);
    await harness[Symbol.asyncDispose]();
  });

  it('a CLI that exits before answering is HANDSHAKE_FAILED', async () => {
    const fake = new FakeHost({ script: { exitAtStart: 1, initFrame: () => null } });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    await expect(harness.sessions.create()).rejects.toMatchObject({
      code: 'HANDSHAKE_FAILED',
      details: { cause: 'stdout-closed' },
    });
    await harness[Symbol.asyncDispose]();
  });

  it('a session whose harness drifted to a known-broken version fails closed (ruling 1)', async () => {
    const policy: CompatPolicy = {
      minTested: VERSION,
      maxTested: VERSION,
      knownBroken: [{ version: '2.1.297', reason: 'loses turns (test listing)' }],
    };
    const fake = new FakeHost({
      compat: policy,
      script: { init: { claude_code_version: '2.1.297' } },
    });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const captured = captureEvents(harness);
    const error = await rejection(harness.sessions.create());
    expect(error).toBeInstanceOf(HarnessVersionKnownBrokenError);
    expect(error).toMatchObject({
      details: { version: '2.1.297', reason: 'loses turns (test listing)', probedVersion: VERSION },
    });
    // No turn was ever written and the process is gone.
    expect(fake.cli.written.map((frame) => frame['type'])).toEqual(['control_request']);
    expect(fake.cli.exitStatus).not.toBeNull();
    expect(captured[0]).toContainEqual(expect.objectContaining({ code: 'binary.version-changed' }));
    // The opt-in runs it with the warning.
    const allowed = await connectWith(
      { binaryPath: BINARY, claudeCode: { dangerouslyAllowKnownBrokenVersion: true } },
      fake.make,
    );
    const session = await allowed.sessions.create();
    expect(session.info.version).toBe('2.1.297');
    await session.close();
    await harness[Symbol.asyncDispose]();
    await allowed[Symbol.asyncDispose]();
  });

  it('an aborted signal stops the start: before the spawn, or during the handshake', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    await expect(harness.sessions.create({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(fake.log).not.toContain('spawn');
    const controller = new AbortController();
    fake.script = { initFrame: () => null };
    fake.beforeSpawn = () => {
      queueMicrotask(() => {
        controller.abort('stop');
      });
    };
    const error = await rejection(harness.sessions.create({ signal: controller.signal }));
    expect(error).toBeInstanceOf(AbortError);
    expect(fake.cli.exitStatus).not.toBeNull();
    expect(harness.registry.size).toBe(0);
    await harness[Symbol.asyncDispose]();
  });

  it('disposing the Harness during a start aborts it with HARNESS_DISPOSED', async () => {
    const fake = new FakeHost({ script: { initFrame: () => null } });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const pending = rejection(harness.sessions.create());
    await settle();
    expect(harness.starting.size).toBe(1);
    await harness[Symbol.asyncDispose]();
    expect(await pending).toBeInstanceOf(HarnessDisposedError);
    expect(fake.cli.exitStatus).not.toBeNull();
    await expect(harness.sessions.create()).rejects.toBeInstanceOf(HarnessDisposedError);
    // A second dispose is a no-op.
    await harness[Symbol.asyncDispose]();
  });

  it('an initialize answer that arrives as dispose starts still ends HARNESS_DISPOSED', async () => {
    let release: (() => void) | undefined;
    const fake = new FakeHost({
      script: {
        initFrame: (requestId) => {
          release = () => {
            fake.cli.emit(controlOk(requestId, { claude_code_version: VERSION }));
          };
          return null;
        },
      },
    });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    // Dispose lands right after the handshake succeeded, before create resolves.
    Object.defineProperty(harness, 'track', {
      value: () => {
        throw new Error('a disposed Harness tracks nothing');
      },
    });
    const pending = rejection(harness.sessions.create());
    await settle();
    release?.();
    const dispose = harness[Symbol.asyncDispose]();
    expect(await pending).toBeInstanceOf(HarnessDisposedError);
    await dispose;
  });
});

describe('an abort or a dispose that lands as the handshake completes', () => {
  /** Calls `onStarted` right after the next driver's handshake resolved, before create continues. */
  function whenStarted(harness: { readonly starting: unknown }, onStarted: () => void): void {
    const starting = harness.starting as Set<{ start(): Promise<unknown> }>;
    const add = starting.add.bind(starting);
    starting.add = (driver) => {
      // Registered before the factory awaits start(), so it runs first.
      void driver.start().then(onStarted);
      return add(driver);
    };
  }

  it.each(['abort', 'dispose'] as const)(
    '%s: the started session is ended and the call rejects',
    async (kind) => {
      const fake = new FakeHost();
      const harness = await connectWith({ binaryPath: BINARY }, fake.make);
      const controller = new AbortController();
      whenStarted(harness, () => {
        if (kind === 'abort') controller.abort('late');
        else void harness[Symbol.asyncDispose]();
      });
      const pending = rejection(harness.sessions.create({ signal: controller.signal }));
      const error = await pending;
      expect(error).toBeInstanceOf(kind === 'abort' ? AbortError : HarnessDisposedError);
      expect(fake.cli.exitStatus).not.toBeNull();
      await harness[Symbol.asyncDispose]();
    },
  );
});

describe('the connect gate', () => {
  it('a binary that changes between verification and the probe is verified again first', async () => {
    const fake = new FakeHost();
    const hash = fake.host.verify?.hash;
    const host = {
      ...fake.host,
      verify: {
        ...fake.host.verify,
        hash: async (file: string) => {
          const digest = await hash?.(file);
          // Replaced right after it was hashed (once).
          if (fake.binary.ino === 1) fake.binary = { ...fake.binary, mtimeMs: 2000, ino: 2 };
          return digest as never;
        },
      },
    };
    const harness = await connectWith({ binaryPath: BINARY }, () => host);
    expect(fake.log.filter((entry) => entry.startsWith('resolve'))).toHaveLength(2);
    expect(fake.log.filter((entry) => entry.startsWith('probe'))).toHaveLength(1);
    expect(harness.current.binary.mtimeMs).toBe(2000);
    await harness[Symbol.asyncDispose]();
  });

  it('a verdict without a detail is still mapped', () => {
    const error = verificationError({
      path: BINARY,
      verification: { status: 'failed', method: 'none', mode: 'strict' },
    });
    expect(error.message).toBe(`Refusing to run ${BINARY}: binary verification failed.`);
    expect(error.details).toEqual({
      path: BINARY,
      status: 'failed',
      method: 'none',
      mode: 'strict',
    });
  });
});

describe('session(): the private Harness', () => {
  it('is disposed when the session fails to open', async () => {
    const fake = new FakeHost({ script: { exitAtStart: 1, initFrame: () => null } });
    await expect(sessionWith({ binaryPath: BINARY }, fake.make)).rejects.toBeInstanceOf(
      HandshakeError,
    );
  });

  it('a dispose that rejects (or a closed that rejects) never becomes an unhandled rejection (F1)', async () => {
    let calls = 0;
    disposeWhenClosed(Promise.resolve(), () => {
      calls += 1;
      return Promise.reject(new Error('dispose failed'));
    });
    disposeWhenClosed(Promise.reject(new Error('closed failed')), () => {
      calls += 1;
      return Promise.resolve();
    });
    disposeWhenClosed(Promise.resolve(), () => {
      calls += 1;
      throw new Error('dispose threw');
    });
    // An unhandled rejection would fail this test run.
    await settle();
    await settle();
    expect(calls).toBe(2);
  });

  it('is disposed when the session closed', async () => {
    const fake = new FakeHost();
    const session = await sessionWith({ binaryPath: BINARY }, fake.make);
    await session.close();
    await settle();
    expect(fake.cli.exitStatus).toEqual({ code: 0, signal: null });
  });
});

describe('the mappers leave unknown errors unchanged', () => {
  it('maps each process-layer error and passes others through', () => {
    const other = new Error('other');
    expect(mapBinaryError(other, 'advisory')).toBe(other);
    expect(mapCwdError(other)).toBe(other);
    expect(mapSpawnError(other)).toBe(other);
    expect(mapBinaryError(new VersionProbeError('timeout'), 'strict')).toMatchObject({
      code: 'BINARY_PROBE_FAILED',
      details: { reason: 'timeout' },
    });
    expect(mapCwdError(new CwdValidationError('too-long', 'C:\\x', 'C:\\long'))).toBeInstanceOf(
      CwdTooLongError,
    );
    expect(mapCwdError(new CwdValidationError('not-found', '/x'))).toMatchObject({
      code: 'CWD_INVALID',
      details: { path: '/x', reason: 'not-found' },
    });
    expect(mapSpawnError(new ProcessSpawnError(undefined))).toMatchObject({
      code: 'SPAWN_FAILED',
      details: { cause: 'unknown' },
    });
    const spec = mapSpawnError(new SpawnSpecError('env-missing-required', 'SYSTEMROOT'));
    expect(spec).toBeInstanceOf(InvalidOptionsError);
    expect(spec).toMatchObject({
      details: { rule: 'spawn-spec', problem: 'env-missing-required', subject: 'SYSTEMROOT' },
    });
  });
});
