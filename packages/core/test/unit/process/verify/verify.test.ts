// Binary verification (ADR-0011, K8, K9, plan §1.7, §1.8, §4.2): advisory
// is the digest table only; strict runs the OS check first; the digest is
// bound to the file identity; the cache is keyed by realpath, size, mtime
// and ctime (nanoseconds).

import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveExecutable, type ResolvedExecutable } from '../../../../src/process/binary-path.js';
import type { ExecutableIdentity } from '../../../../src/process/cwd.js';
import type { FileDigest } from '../../../../src/process/hash.js';
import type { BoundedCommand, CommandOutcome } from '../../../../src/process/verify/command.js';
import {
  assertSpawnable,
  assertSpawnableOrReverify,
  BinaryChangedError,
  BinaryNotVerifiedError,
  checkKnownDigests,
  recheckBinary,
  settleProbedVersion,
  verifyBinary,
  VerificationCache,
  type IdentityFs,
  type KnownDigest,
  type VerifiedBinary,
  type VerifyBinaryOptions,
} from '../../../../src/process/verify/verify.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const BIN = '/opt/claude/versions/2.1.296';

/** A whole-millisecond time in nanoseconds, decimal. */
function ns(ms: number | bigint): string {
  return String(BigInt(ms) * 1_000_000n);
}

/** `mtimeNs` and `ctimeNs` of a fake file last changed at `mtimeMs`. */
const NS_1000 = ns(1000);

function resolved(overrides: Partial<ResolvedExecutable> = {}): ResolvedExecutable {
  const mtimeMs = overrides.mtimeMs ?? 1000;
  return {
    requested: BIN,
    path: BIN,
    size: 10,
    mtimeMs,
    mtimeNs: ns(mtimeMs),
    ctimeNs: ns(mtimeMs),
    ...overrides,
  };
}

function digestOf(overrides: Partial<FileDigest> = {}): FileDigest {
  const mtimeMs = overrides.mtimeMs ?? 1000;
  return {
    sha256: SHA_A,
    size: 10,
    mtimeMs,
    mtimeNs: ns(mtimeMs),
    ctimeNs: ns(mtimeMs),
    fileId: '1:2',
    ...overrides,
  };
}

/** A file identity; the times follow `mtimeMs` unless given (a write moves both). */
function fileIdentity(
  overrides: Partial<
    Record<'dev' | 'ino' | 'size' | 'mtimeMs' | 'mtimeNs' | 'ctimeNs', bigint>
  > = {},
): ExecutableIdentity {
  const mtimeMs = overrides.mtimeMs ?? 1000n;
  const mtimeNs = overrides.mtimeNs ?? mtimeMs * 1_000_000n;
  return {
    isFile: () => true,
    isDirectory: () => false,
    dev: 1n,
    ino: 2n,
    size: 10n,
    mtimeMs,
    mtimeNs,
    ctimeNs: mtimeNs,
    ...overrides,
  };
}

interface Recorded {
  readonly calls: string[];
  readonly options: VerifyBinaryOptions;
}

/** Fake deps that record the order of hash, stat and signature-check calls. */
function fakeOptions(
  options: Partial<VerifyBinaryOptions> & {
    readonly digest?: FileDigest | Error;
    readonly stats?: (ExecutableIdentity | Error)[];
    /** The checker's outcome; a list is consumed in order, its last entry repeating. */
    readonly signature?: CommandOutcome | readonly CommandOutcome[];
    readonly realpath?: string | Error;
  } = {},
): Recorded {
  const calls: string[] = [];
  const stats = [...(options.stats ?? [fileIdentity()])];
  const fs: IdentityFs = {
    realpath: (value) => {
      calls.push(`realpath ${value}`);
      const target = options.realpath ?? value;
      return target instanceof Error ? Promise.reject(target) : Promise.resolve(target);
    },
    stat: (value) => {
      calls.push(`stat ${value}`);
      const next = stats.length > 1 ? stats.shift() : stats[0];
      return next instanceof Error || next === undefined
        ? Promise.reject(next ?? new Error('no stat'))
        : Promise.resolve(next);
    },
  };
  const digest = options.digest ?? digestOf();
  const passing: CommandOutcome = { kind: 'exited', exitCode: 0, signal: null, stdout: '' };
  const signature = options.signature ?? passing;
  const outcomes: CommandOutcome[] = 'kind' in signature ? [signature] : [...signature];
  return {
    calls,
    options: {
      mode: options.mode ?? 'advisory',
      digests: options.digests ?? [],
      platform: options.platform ?? 'darwin',
      hostEnv: {},
      ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      deps: {
        fs,
        hash: (value) => {
          calls.push(`hash ${value}`);
          return digest instanceof Error ? Promise.reject(digest) : Promise.resolve(digest);
        },
        signature: {
          fs: {
            realpath: (value) => Promise.resolve(value),
            lstat: () => Promise.resolve({ isFile: () => true, isSymbolicLink: () => false }),
          },
          run: (command: BoundedCommand) => {
            calls.push(`run ${command.file}`);
            const next = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
            return Promise.resolve(next ?? passing);
          },
        },
      },
    },
  };
}

describe('checkKnownDigests', () => {
  it('accepts well-formed entries', () => {
    expect(() => {
      checkKnownDigests([
        { version: '2.1.296', sha256: SHA_A, size: 1 },
        { version: '1.0.0', sha256: SHA_B },
        { version: '1.0.1', sha256: SHA_B, size: 0 },
      ]);
    }).not.toThrow();
  });

  it.each<KnownDigest>([
    { version: '', sha256: SHA_A },
    { version: '1', sha256: 'A'.repeat(64) },
    { version: '1', sha256: 'a'.repeat(63) },
    { version: '1', sha256: SHA_A, size: -1 },
    { version: '1', sha256: SHA_A, size: 1.5 },
    { version: '1', sha256: SHA_A, size: Number.MAX_SAFE_INTEGER + 1 },
  ])('refuses %j', (entry) => {
    expect(() => {
      checkKnownDigests([entry]);
    }).toThrow(RangeError);
  });

  it('is applied by verifyBinary before anything is read', async () => {
    const { calls, options } = fakeOptions({ digests: [{ version: '1', sha256: 'x' }] });
    await expect(verifyBinary(resolved(), options)).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});

describe('advisory verification', () => {
  it('is verified when the digest and size match an entry', async () => {
    const { calls, options } = fakeOptions({
      digests: [
        { version: '2.1.295', sha256: SHA_B },
        { version: '2.1.296', sha256: SHA_A, size: 10 },
      ],
    });
    await expect(verifyBinary(resolved(), options)).resolves.toEqual({
      path: BIN,
      sha256: SHA_A,
      size: 10,
      mtimeMs: 1000,
      mtimeNs: NS_1000,
      ctimeNs: NS_1000,
      fileId: '1:2',
      matchedVersion: '2.1.296',
      verification: {
        status: 'verified',
        method: 'sha256-manifest',
        mode: 'advisory',
        detail: 'sha256 matches 2.1.296',
      },
    });
    // The digest table only: no stat of its own, no signature check.
    expect(calls).toEqual([`hash ${BIN}`]);
  });

  it('is unverified when no entry matches, including a size mismatch', async () => {
    const { options } = fakeOptions({
      digests: [
        { version: '2.1.295', sha256: SHA_B },
        { version: '2.1.296', sha256: SHA_A, size: 11 },
      ],
    });
    await expect(verifyBinary(resolved(), options)).resolves.toMatchObject({
      verification: {
        status: 'unverified',
        method: 'sha256-manifest',
        mode: 'advisory',
        detail: 'no known digest matches',
      },
    });
  });

  it('is unverified with method none when the table is empty', async () => {
    const { options } = fakeOptions();
    const result = await verifyBinary(resolved(), options);
    expect(result.verification).toEqual({
      status: 'unverified',
      method: 'none',
      mode: 'advisory',
      detail: 'no known digests',
    });
    expect(result.matchedVersion).toBeUndefined();
  });

  it('throws BinaryChangedError when the hashed file is not the resolved one', async () => {
    for (const digest of [digestOf({ size: 11 }), digestOf({ mtimeMs: 1001 })]) {
      const { options } = fakeOptions({ digest });
      await expect(verifyBinary(resolved(), options)).rejects.toThrow(BinaryChangedError);
    }
  });

  it('throws BinaryChangedError when the file cannot be hashed', async () => {
    const { options } = fakeOptions({ digest: new Error('ENOENT') });
    const error = await verifyBinary(resolved(), options).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BinaryChangedError);
    expect((error as BinaryChangedError).code).toBe('BINARY_CHANGED');
    expect((error as BinaryChangedError).path).toBe(BIN);
    expect((error as BinaryChangedError).cause).toBeInstanceOf(Error);
  });
});

describe('strict verification', () => {
  it('runs the OS signature check first, then the digest table', async () => {
    const { calls, options } = fakeOptions({
      mode: 'strict',
      digests: [{ version: '2.1.296', sha256: SHA_A }],
    });
    await expect(verifyBinary(resolved(), options)).resolves.toMatchObject({
      matchedVersion: '2.1.296',
      verification: {
        status: 'verified',
        method: 'sha256-manifest',
        mode: 'strict',
        detail: 'codesign valid; sha256 matches 2.1.296',
      },
    });
    expect(calls).toEqual([`stat ${BIN}`, 'run /usr/bin/codesign', `hash ${BIN}`]);
  });

  it('fails on an invalid signature without hashing', async () => {
    const { calls, options } = fakeOptions({
      mode: 'strict',
      digests: [{ version: '2.1.296', sha256: SHA_A }],
      signature: { kind: 'exited', exitCode: 1, signal: null, stdout: '' },
    });
    await expect(verifyBinary(resolved(), options)).resolves.toEqual({
      path: BIN,
      fileId: '1:2',
      size: 10,
      mtimeMs: 1000,
      mtimeNs: NS_1000,
      ctimeNs: NS_1000,
      verification: {
        status: 'failed',
        method: 'os-signature',
        mode: 'strict',
        detail: 'codesign failed: exit 1',
      },
    });
    expect(calls).not.toContain(`hash ${BIN}`);
  });

  it('requires the pinned publisher of the Windows signature (ruling 9)', async () => {
    const subject = 'CN="Example, Inc.", O="Example, Inc.", C=US';
    const signature: CommandOutcome = {
      kind: 'exited',
      exitCode: 0,
      signal: null,
      stdout: `Valid\n${subject}`,
    };
    const digests = [{ version: '2.1.296', sha256: SHA_A }];
    const pinned = fakeOptions({
      mode: 'strict',
      platform: 'win32',
      digests,
      signature,
      publisher: { windowsSubject: subject },
    });
    await expect(verifyBinary(resolved(), pinned.options)).resolves.toMatchObject({
      verification: {
        status: 'verified',
        detail: 'authenticode Valid, pinned publisher; sha256 matches 2.1.296',
      },
    });
    const unpinned = fakeOptions({ mode: 'strict', platform: 'win32', digests, signature });
    await expect(verifyBinary(resolved(), unpinned.options)).resolves.toMatchObject({
      verification: {
        status: 'failed',
        method: 'os-signature',
        detail: 'authenticode Valid, but no publisher is pinned',
      },
    });
    expect(unpinned.calls).not.toContain(`hash ${BIN}`);
    const other = fakeOptions({
      mode: 'strict',
      platform: 'win32',
      digests,
      signature,
      publisher: { windowsSubject: 'CN=Someone Else' },
    });
    await expect(verifyBinary(resolved(), other.options)).resolves.toMatchObject({
      verification: { status: 'failed', method: 'os-signature' },
    });
  });

  it('keys the cache by the pinned publisher', async () => {
    const cache = new VerificationCache();
    const signature: CommandOutcome = {
      kind: 'exited',
      exitCode: 0,
      signal: null,
      stdout: 'Valid\nCN=A',
    };
    const first = fakeOptions({
      mode: 'strict',
      platform: 'win32',
      cache,
      signature,
      publisher: { windowsSubject: 'CN=A' },
    });
    await verifyBinary(resolved(), first.options);
    const second = fakeOptions({
      mode: 'strict',
      platform: 'win32',
      cache,
      signature,
      publisher: { windowsSubject: 'CN=B' },
    });
    await expect(verifyBinary(resolved(), second.options)).resolves.toMatchObject({
      verification: { status: 'failed', method: 'os-signature' },
    });
    expect(second.calls.some((call) => call.startsWith('run '))).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('uses the digest table alone where there is no OS signature check', async () => {
    const { calls, options } = fakeOptions({ mode: 'strict', platform: 'other' });
    await expect(verifyBinary(resolved(), options)).resolves.toMatchObject({
      verification: {
        status: 'unverified',
        method: 'none',
        mode: 'strict',
        detail: 'no OS signature check on this platform; no known digests',
      },
    });
    expect(calls.some((call) => call.startsWith('run '))).toBe(false);
  });

  it('throws when the file before the check is not the resolved one', async () => {
    const { calls, options } = fakeOptions({ mode: 'strict', stats: [fileIdentity({ size: 9n })] });
    await expect(verifyBinary(resolved(), options)).rejects.toThrow(BinaryChangedError);
    expect(calls).toEqual([`stat ${BIN}`]);
  });

  it('throws when the file changes between the signature check and the hash', async () => {
    const { options } = fakeOptions({ mode: 'strict', digest: digestOf({ fileId: '1:3' }) });
    await expect(verifyBinary(resolved(), options)).rejects.toThrow(BinaryChangedError);
  });

  it('throws when the file cannot be read before the check', async () => {
    const { options } = fakeOptions({ mode: 'strict', stats: [new Error('ENOENT')] });
    await expect(verifyBinary(resolved(), options)).rejects.toThrow(BinaryChangedError);
  });

  it('uses the host platform and environment by default', async () => {
    const { calls, options } = fakeOptions({ mode: 'strict' });
    const rest: VerifyBinaryOptions = {
      mode: options.mode,
      digests: options.digests,
      ...(options.deps === undefined ? {} : { deps: options.deps }),
    };
    const result = await verifyBinary(resolved(), rest);
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(calls.some((call) => call.startsWith('run '))).toBe(true);
    } else {
      expect(result.verification.detail).toMatch(/^no OS signature check/);
    }
  });
});

describe('the verification cache', () => {
  it('returns the cached result while the identity is unchanged', async () => {
    const cache = new VerificationCache();
    const { calls, options } = fakeOptions({ cache });
    const first = await verifyBinary(resolved(), options);
    const second = await verifyBinary(resolved(), options);
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
    expect(calls.filter((call) => call.startsWith('hash'))).toHaveLength(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('is keyed by realpath, size, mtime, mode and the digest table', async () => {
    const cache = new VerificationCache();
    const base = fakeOptions({ cache });
    await verifyBinary(resolved(), base.options);
    await verifyBinary(resolved(), {
      ...base.options,
      digests: [{ version: '1', sha256: SHA_B, size: 3 }],
    });
    await verifyBinary(resolved(), { ...base.options, digests: [{ version: '1', sha256: SHA_B }] });
    await verifyBinary(resolved(), { ...base.options, mode: 'strict' });
    expect(cache.size).toBe(4);
  });

  it('verifies again when the identity changed', async () => {
    const cache = new VerificationCache();
    const { calls, options } = fakeOptions({
      cache,
      stats: [fileIdentity({ ino: 3n }), fileIdentity()],
    });
    await verifyBinary(resolved(), options);
    await verifyBinary(resolved(), options);
    expect(calls.filter((call) => call.startsWith('hash'))).toHaveLength(2);
  });

  it('verifies again when the file cannot be read', async () => {
    const cache = new VerificationCache();
    const { calls, options } = fakeOptions({ cache, stats: [new Error('ENOENT')] });
    await verifyBinary(resolved(), options);
    await verifyBinary(resolved(), options);
    expect(calls.filter((call) => call.startsWith('hash'))).toHaveLength(2);
  });
});

// Only definitive verdicts are cached; a check that did not complete fails
// that attempt and runs again on the next one.
describe('the verification cache and transient failures', () => {
  const DIGESTS = [{ version: '2.1.296', sha256: SHA_A }];
  const SUBJECT = 'CN=A';
  const VALID: CommandOutcome = {
    kind: 'exited',
    exitCode: 0,
    signal: null,
    stdout: `Valid\n${SUBJECT}`,
  };

  function strict(
    cache: VerificationCache,
    signature: CommandOutcome | readonly CommandOutcome[],
    platform: 'win32' | 'darwin' = 'win32',
  ): Recorded {
    return fakeOptions({
      mode: 'strict',
      platform,
      digests: DIGESTS,
      cache,
      signature,
      publisher: { windowsSubject: SUBJECT },
    });
  }

  function runs(calls: readonly string[]): number {
    return calls.filter((call) => call.startsWith('run ')).length;
  }

  it.each<[string, CommandOutcome, 'win32' | 'darwin', string]>([
    ['a timeout', { kind: 'timeout' }, 'win32', 'authenticode check failed: timeout'],
    [
      'a spawn failure',
      { kind: 'spawn-error', errno: 'ENOENT' },
      'win32',
      'authenticode check failed: spawn failed: ENOENT',
    ],
    [
      'a failing PowerShell',
      { kind: 'exited', exitCode: 1, signal: null, stdout: '' },
      'win32',
      'authenticode check failed: exit 1',
    ],
    [
      'truncated output',
      { kind: 'output-too-large' },
      'win32',
      'authenticode check failed: output-too-large',
    ],
    [
      'output without the expected lines',
      { kind: 'exited', exitCode: 0, signal: null, stdout: 'Valid' },
      'win32',
      'authenticode status unrecognized',
    ],
    ['a codesign timeout', { kind: 'timeout' }, 'darwin', 'codesign failed: timeout'],
    [
      'codesign ended by a signal',
      { kind: 'exited', exitCode: null, signal: 'SIGKILL', stdout: '' },
      'darwin',
      'codesign failed: exit SIGKILL',
    ],
  ])('does not cache %s, and checks again next time', async (_name, failure, platform, detail) => {
    const cache = new VerificationCache();
    const passing: CommandOutcome =
      platform === 'win32' ? VALID : { kind: 'exited', exitCode: 0, signal: null, stdout: '' };
    const { calls, options } = strict(cache, [failure, passing], platform);
    const first = await verifyBinary(resolved(), options);
    expect(first.verification).toEqual({
      status: 'failed',
      method: 'os-signature',
      mode: 'strict',
      detail,
      transient: true,
    });
    expect(first.sha256).toBeUndefined();
    expect(cache.size).toBe(0);
    // The attempt fails closed.
    await expect(assertSpawnable(first)).rejects.toBeInstanceOf(BinaryNotVerifiedError);
    // The next attempt runs the check again and gets the definitive verdict.
    const second = await verifyBinary(resolved(), options);
    expect(second.verification.status).toBe('verified');
    expect(second.verification.transient).toBeUndefined();
    expect(runs(calls)).toBe(2);
    expect(cache.size).toBe(1);
    // A third attempt is a cache hit.
    await expect(verifyBinary(resolved(), options)).resolves.toBe(second);
    expect(runs(calls)).toBe(2);
  });

  it.each<[string, CommandOutcome, 'win32' | 'darwin', string]>([
    [
      'another Authenticode status',
      { kind: 'exited', exitCode: 0, signal: null, stdout: 'NotSigned\n' },
      'win32',
      'authenticode NotSigned',
    ],
    [
      'another publisher',
      { kind: 'exited', exitCode: 0, signal: null, stdout: 'Valid\nCN=B' },
      'win32',
      'authenticode Valid, but the signer is not the pinned publisher: "CN=B"',
    ],
    [
      'a codesign verdict',
      { kind: 'exited', exitCode: 1, signal: null, stdout: '' },
      'darwin',
      'codesign failed: exit 1',
    ],
  ])('caches a definitive failure: %s', async (_name, failure, platform, detail) => {
    const cache = new VerificationCache();
    const { calls, options } = strict(cache, [failure, VALID], platform);
    const first = await verifyBinary(resolved(), options);
    expect(first.verification).toEqual({
      status: 'failed',
      method: 'os-signature',
      mode: 'strict',
      detail,
    });
    expect(cache.size).toBe(1);
    await expect(verifyBinary(resolved(), options)).resolves.toBe(first);
    expect(runs(calls)).toBe(1);
  });

  it('caches a digest that matches no entry', async () => {
    const cache = new VerificationCache();
    const { calls, options } = fakeOptions({
      mode: 'strict',
      digests: [{ version: '2.1.296', sha256: SHA_B }],
      cache,
    });
    const first = await verifyBinary(resolved(), options);
    expect(first.verification).toMatchObject({ status: 'unverified' });
    expect(first.verification.transient).toBeUndefined();
    await expect(verifyBinary(resolved(), options)).resolves.toBe(first);
    expect(runs(calls)).toBe(1);
  });

  it('caches nothing when the file cannot be read while hashing', async () => {
    const cache = new VerificationCache();
    const { options } = fakeOptions({ mode: 'strict', cache, digest: new Error('EIO') });
    await expect(verifyBinary(resolved(), options)).rejects.toBeInstanceOf(BinaryChangedError);
    expect(cache.size).toBe(0);
  });

  it('gives concurrent callers each its own failed attempt, and caches none of them', async () => {
    const cache = new VerificationCache();
    const { calls, options } = strict(cache, [{ kind: 'timeout' }, { kind: 'timeout' }, VALID]);
    const results = await Promise.all([
      verifyBinary(resolved(), options),
      verifyBinary(resolved(), options),
    ]);
    for (const result of results) {
      expect(result.verification).toMatchObject({ status: 'failed', transient: true });
    }
    expect(runs(calls)).toBe(2);
    expect(cache.size).toBe(0);
    await expect(verifyBinary(resolved(), options)).resolves.toMatchObject({
      verification: { status: 'verified' },
    });
    expect(runs(calls)).toBe(3);
    expect(cache.size).toBe(1);
  });

  it('keeps the transient flag through a JSON round trip, and adds none to a definitive verdict', async () => {
    const transient = await verifyBinary(
      resolved(),
      strict(new VerificationCache(), { kind: 'timeout' }).options,
    );
    const definitive = await verifyBinary(
      resolved(),
      strict(new VerificationCache(), {
        kind: 'exited',
        exitCode: 0,
        signal: null,
        stdout: 'NotSigned\n',
      }).options,
    );
    const parsed = JSON.parse(JSON.stringify(transient)) as VerifiedBinary;
    expect(parsed).toEqual(transient);
    expect(parsed.verification.transient).toBe(true);
    expect(JSON.parse(JSON.stringify(definitive))).toEqual(definitive);
    expect('transient' in definitive.verification).toBe(false);
  });
});

describe('settleProbedVersion', () => {
  const digests: KnownDigest[] = [{ version: '2.1.296', sha256: SHA_A }];
  const base: VerifiedBinary = {
    path: BIN,
    sha256: SHA_A,
    size: 10,
    mtimeMs: 1000,
    mtimeNs: NS_1000,
    ctimeNs: NS_1000,
    fileId: '1:2',
    matchedVersion: '2.1.296',
    verification: { status: 'verified', method: 'sha256-manifest', mode: 'advisory' },
  };

  it('keeps a verified binary that reports the matched version', () => {
    expect(settleProbedVersion(base, '2.1.296', digests)).toBe(base);
  });

  it('fails a verified binary that reports another version', () => {
    expect(settleProbedVersion(base, '2.1.297', digests).verification).toEqual({
      status: 'failed',
      method: 'sha256-manifest',
      mode: 'advisory',
      detail: 'the binary reports "2.1.297" but its sha256 is that of "2.1.296"',
    });
  });

  it('fails an unverified binary whose reported version has a known digest', () => {
    const unverified: VerifiedBinary = {
      ...base,
      sha256: SHA_B,
      verification: { status: 'unverified', method: 'sha256-manifest', mode: 'advisory' },
    };
    const noMatch: VerifiedBinary = {
      path: unverified.path,
      sha256: SHA_B,
      size: 10,
      mtimeMs: 1000,
      mtimeNs: NS_1000,
      ctimeNs: NS_1000,
      fileId: '1:2',
      verification: unverified.verification,
    };
    expect(settleProbedVersion(noMatch, '2.1.296', digests).verification).toEqual({
      status: 'failed',
      method: 'sha256-manifest',
      mode: 'advisory',
      detail: 'sha256 differs from the known digest of "2.1.296"',
    });
    expect(settleProbedVersion(noMatch, '9.9.9', digests)).toBe(noMatch);
  });

  it('keeps a failed binary failed', () => {
    const failed: VerifiedBinary = {
      ...base,
      verification: { status: 'failed', method: 'os-signature', mode: 'strict' },
    };
    expect(settleProbedVersion(failed, '2.1.296', digests)).toBe(failed);
  });
});

describe('recheckBinary and assertSpawnable', () => {
  const verified: VerifiedBinary = {
    path: BIN,
    sha256: SHA_A,
    size: 10,
    mtimeMs: 1000,
    mtimeNs: NS_1000,
    ctimeNs: NS_1000,
    fileId: '1:2',
    verification: { status: 'verified', method: 'sha256-manifest', mode: 'strict' },
  };

  function fs(realpathValue: string | Error, identity: ExecutableIdentity | Error): IdentityFs {
    return {
      realpath: () =>
        realpathValue instanceof Error
          ? Promise.reject(realpathValue)
          : Promise.resolve(realpathValue),
      stat: () =>
        identity instanceof Error ? Promise.reject(identity) : Promise.resolve(identity),
    };
  }

  it('passes for an unchanged file', async () => {
    await expect(recheckBinary(verified, fs(BIN, fileIdentity()))).resolves.toBeUndefined();
    await expect(assertSpawnable(verified, fs(BIN, fileIdentity()))).resolves.toBeUndefined();
  });

  it.each<[string, IdentityFs]>([
    ['realpath fails', fs(new Error('ENOENT'), fileIdentity())],
    ['redirected', fs('/tmp/evil', fileIdentity())],
    ['stat fails', fs(BIN, new Error('ENOENT'))],
    ['other file id', fs(BIN, fileIdentity({ ino: 9n }))],
    ['other device', fs(BIN, fileIdentity({ dev: 9n }))],
    ['other size', fs(BIN, fileIdentity({ size: 11n }))],
    ['other mtime', fs(BIN, fileIdentity({ mtimeMs: 1n }))],
    // Within the same millisecond: the identity compares nanoseconds.
    ['other mtime in the same ms', fs(BIN, fileIdentity({ mtimeNs: 1_000_000_001n }))],
    // A same-size rewrite whose mtime was set back (utimes): only the ctime,
    // which an unprivileged process cannot set back on POSIX, moved.
    ['other ctime, mtime restored', fs(BIN, fileIdentity({ ctimeNs: 5_000_000_000n }))],
  ])('throws BinaryChangedError when %s', async (_name, identityFs) => {
    await expect(recheckBinary(verified, identityFs)).rejects.toThrow(BinaryChangedError);
    await expect(assertSpawnable(verified, identityFs)).rejects.toThrow(BinaryChangedError);
  });

  it('refuses a strict result that is not verified, before reading anything', async () => {
    let touched = false;
    const watching: IdentityFs = {
      realpath: () => {
        touched = true;
        return Promise.resolve(BIN);
      },
      stat: () => Promise.resolve(fileIdentity()),
    };
    for (const status of ['unverified', 'failed'] as const) {
      const refused: VerifiedBinary = {
        ...verified,
        verification: { status, method: 'none', mode: 'strict' },
      };
      const error = await assertSpawnable(refused, watching).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BinaryNotVerifiedError);
      expect((error as BinaryNotVerifiedError).code).toBe('BINARY_VERIFICATION_FAILED');
      expect((error as BinaryNotVerifiedError).path).toBe(BIN);
      expect((error as BinaryNotVerifiedError).message).toBe(
        `refusing to run ${JSON.stringify(BIN)}: verification ${status}`,
      );
    }
    const withDetail = new BinaryNotVerifiedError({
      ...verified,
      verification: { status: 'failed', method: 'os-signature', mode: 'strict', detail: 'x' },
    });
    expect(withDetail.message).toMatch(/\(x\)$/);
    expect(withDetail.verification.detail).toBe('x');
    expect(touched).toBe(false);
  });

  it('lets an advisory result run whatever its status', async () => {
    const advisory: VerifiedBinary = {
      ...verified,
      verification: { status: 'failed', method: 'sha256-manifest', mode: 'advisory' },
    };
    await expect(assertSpawnable(advisory, fs(BIN, fileIdentity()))).resolves.toBeUndefined();
  });
});

describe('assertSpawnableOrReverify (ruling 9)', () => {
  const first: VerifiedBinary = {
    path: BIN,
    sha256: SHA_A,
    size: 10,
    mtimeMs: 1000,
    mtimeNs: NS_1000,
    ctimeNs: NS_1000,
    fileId: '1:2',
    matchedVersion: '2.1.296',
    verification: { status: 'verified', method: 'sha256-manifest', mode: 'strict' },
  };
  const updated: VerifiedBinary = {
    ...first,
    sha256: SHA_B,
    fileId: '1:3',
    mtimeMs: 2000,
    mtimeNs: ns(2000),
    ctimeNs: ns(2000),
  };

  /** An identity fs whose stat answers from a queue (the last answer repeats). */
  function queuedFs(...identities: ExecutableIdentity[]): IdentityFs {
    const queue = [...identities];
    return {
      realpath: (value) => Promise.resolve(value),
      stat: () => {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return next === undefined ? Promise.reject(new Error('no stat')) : Promise.resolve(next);
      },
    };
  }

  const firstIdentity = fileIdentity();
  const updatedIdentity = fileIdentity({ ino: 3n, mtimeMs: 2000n });

  it('spawns the verified binary without re-verifying while it is unchanged', async () => {
    let reverified = 0;
    const result = await assertSpawnableOrReverify(
      first,
      () => {
        reverified += 1;
        return Promise.resolve(updated);
      },
      queuedFs(firstIdentity),
    );
    expect(result).toEqual({ binary: first, reverified: false });
    expect(reverified).toBe(0);
  });

  it('re-verifies once when the file was replaced, and spawns the new result', async () => {
    let reverified = 0;
    const result = await assertSpawnableOrReverify(
      first,
      () => {
        reverified += 1;
        return Promise.resolve(updated);
      },
      queuedFs(updatedIdentity),
    );
    expect(result).toEqual({ binary: updated, reverified: true });
    expect(reverified).toBe(1);
  });

  it('refuses a second change after the re-verification', async () => {
    const error: unknown = await assertSpawnableOrReverify(
      first,
      () => Promise.resolve(updated),
      queuedFs(updatedIdentity, fileIdentity({ ino: 4n })),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BinaryNotVerifiedError);
    expect((error as BinaryNotVerifiedError).code).toBe('BINARY_VERIFICATION_FAILED');
    expect((error as BinaryNotVerifiedError).verification).toEqual({
      status: 'failed',
      method: 'sha256-manifest',
      mode: 'strict',
      detail: 'the binary changed again while it was verified a second time',
    });
    expect((error as Error).cause).toBeInstanceOf(BinaryChangedError);
  });

  it('refuses a change during the re-verification', async () => {
    const error: unknown = await assertSpawnableOrReverify(
      first,
      () => Promise.reject(new BinaryChangedError(BIN)),
      queuedFs(updatedIdentity),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BinaryNotVerifiedError);
    expect((error as BinaryNotVerifiedError).verification.status).toBe('failed');
  });

  it('refuses a strict re-verification that is not verified', async () => {
    const failed: VerifiedBinary = {
      ...updated,
      verification: { status: 'failed', method: 'sha256-manifest', mode: 'strict' },
    };
    await expect(
      assertSpawnableOrReverify(first, () => Promise.resolve(failed), queuedFs(updatedIdentity)),
    ).rejects.toMatchObject({
      code: 'BINARY_VERIFICATION_FAILED',
      verification: { status: 'failed' },
    });
  });

  it('returns an advisory re-verification whatever its status', async () => {
    const advisoryFirst: VerifiedBinary = {
      ...first,
      verification: { status: 'verified', method: 'sha256-manifest', mode: 'advisory' },
    };
    const advisoryNew: VerifiedBinary = {
      ...updated,
      verification: { status: 'unverified', method: 'sha256-manifest', mode: 'advisory' },
    };
    await expect(
      assertSpawnableOrReverify(
        advisoryFirst,
        () => Promise.resolve(advisoryNew),
        queuedFs(updatedIdentity),
      ),
    ).resolves.toEqual({ binary: advisoryNew, reverified: true });
  });

  it('passes on other errors of the re-verification and of the first check', async () => {
    const gone = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    await expect(
      assertSpawnableOrReverify(first, () => Promise.reject(gone), queuedFs(updatedIdentity)),
    ).rejects.toBe(gone);
    let reverified = 0;
    const notVerified: VerifiedBinary = {
      ...first,
      verification: { status: 'unverified', method: 'none', mode: 'strict' },
    };
    await expect(
      assertSpawnableOrReverify(
        notVerified,
        () => {
          reverified += 1;
          return Promise.resolve(updated);
        },
        queuedFs(firstIdentity),
      ),
    ).rejects.toBeInstanceOf(BinaryNotVerifiedError);
    expect(reverified).toBe(0);
  });
});

describe('verification of a real file with the host defaults', () => {
  let root = '';
  let file = '';
  let sha = '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hudhud-verify-'));
    file = path.join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
    await writeFile(file, 'not really a binary', { mode: 0o755 });
    sha = createHash('sha256').update('not really a binary').digest('hex');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });

  it('binds the digest to the file identity and rechecks it', async () => {
    const binary = await resolveExecutable(file);
    const cache = new VerificationCache();
    const result = await verifyBinary(binary, {
      mode: 'advisory',
      digests: [{ version: '0.0.1', sha256: sha, size: binary.size }],
      cache,
    });
    expect(result.verification.status).toBe('verified');
    expect(result.sha256).toBe(sha);
    const stats = await stat(binary.path, { bigint: true });
    expect(result.fileId).toBe(`${String(stats.dev)}:${String(stats.ino)}`);
    await expect(assertSpawnable(result)).resolves.toBeUndefined();
    // A cache hit reads the identity again.
    await expect(
      verifyBinary(binary, {
        mode: 'advisory',
        digests: [{ version: '0.0.1', sha256: sha, size: binary.size }],
        cache,
      }),
    ).resolves.toBe(result);

    // Touch the file: the identity no longer matches.
    await utimes(binary.path, new Date(), new Date(Date.now() + 5000));
    await expect(recheckBinary(result)).rejects.toThrow(BinaryChangedError);
  });

  // A same-size rewrite in place with the mtime set back to the verified
  // value keeps the file id, the size and mtimeMs (the identity before
  // W7-T5); the status change time moves with the write and with utimes, so
  // the recheck refuses it. On POSIX that is the security property (only
  // root can set ctime back); on win32 the change time moves the same way
  // here, but a writer could set it back explicitly.
  it('detects a same-size rewrite whose mtime was restored', async () => {
    const target = path.join(root, process.platform === 'win32' ? 'rewrite.exe' : 'rewrite');
    await writeFile(target, 'original bytes', { mode: 0o755 });
    const verifiedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await utimes(target, verifiedAt, verifiedAt);
    const binary = await resolveExecutable(target);
    const result = await verifyBinary(binary, { mode: 'advisory', digests: [] });
    await expect(recheckBinary(result)).resolves.toBeUndefined();
    const before = await stat(target, { bigint: true });
    // The file system clock may be coarse (a kernel tick): wait until a
    // change made now gets a later ctime than the verified one.
    const tick = path.join(root, 'tick');
    for (let tries = 0; ; tries += 1) {
      await writeFile(tick, String(tries));
      if ((await stat(tick, { bigint: true })).ctimeNs > before.ctimeNs) break;
      expect(tries).toBeLessThan(1000);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await writeFile(target, 'tampered bytes');
    await utimes(target, verifiedAt, verifiedAt);
    const after = await stat(target, { bigint: true });
    expect([after.dev, after.ino, after.size, after.mtimeNs]).toEqual([
      before.dev,
      before.ino,
      before.size,
      before.mtimeNs,
    ]);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    await expect(recheckBinary(result)).rejects.toThrow(BinaryChangedError);
  });

  it('refuses a resolution that no longer matches the file', async () => {
    const binary = await resolveExecutable(file);
    const stale = (field: 'mtimeNs' | 'ctimeNs'): ResolvedExecutable => ({
      ...binary,
      [field]: String(BigInt(binary[field]) - 1n),
    });
    for (const field of ['mtimeNs', 'ctimeNs'] as const) {
      await expect(verifyBinary(stale(field), { mode: 'advisory', digests: [] })).rejects.toThrow(
        BinaryChangedError,
      );
      await expect(
        verifyBinary(stale(field), { mode: 'strict', digests: [], platform: 'other' }),
      ).rejects.toThrow(BinaryChangedError);
    }
  });
});
