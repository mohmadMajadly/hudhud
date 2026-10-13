// Binary verification (ADR-0011, K8, K9, plan §1.7, §1.8, §4.2): advisory
// is the digest table only; strict runs the OS check first; the digest is
// bound to the file identity; the cache is keyed by realpath, size, mtime.

import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveExecutable, type ResolvedExecutable } from '../../../../src/process/binary-path.js';
import type { FileIdentity } from '../../../../src/process/cwd.js';
import type { FileDigest } from '../../../../src/process/hash.js';
import type { BoundedCommand, CommandOutcome } from '../../../../src/process/verify/command.js';
import {
  assertSpawnable,
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

function resolved(overrides: Partial<ResolvedExecutable> = {}): ResolvedExecutable {
  return { requested: BIN, path: BIN, size: 10, mtimeMs: 1000, ...overrides };
}

function digestOf(overrides: Partial<FileDigest> = {}): FileDigest {
  return { sha256: SHA_A, size: 10, mtimeMs: 1000, fileId: '1:2', ...overrides };
}

function fileIdentity(
  overrides: Partial<Record<'dev' | 'ino' | 'size' | 'mtimeMs', bigint>> = {},
): FileIdentity {
  return {
    isFile: () => true,
    isDirectory: () => false,
    dev: 1n,
    ino: 2n,
    size: 10n,
    mtimeMs: 1000n,
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
    readonly stats?: (FileIdentity | Error)[];
    readonly signature?: CommandOutcome;
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
  return {
    calls,
    options: {
      mode: options.mode ?? 'advisory',
      digests: options.digests ?? [],
      platform: options.platform ?? 'darwin',
      hostEnv: {},
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
            return Promise.resolve(
              options.signature ?? { kind: 'exited', exitCode: 0, signal: null, stdout: '' },
            );
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
      verification: {
        status: 'failed',
        method: 'os-signature',
        mode: 'strict',
        detail: 'codesign failed: exit 1',
      },
    });
    expect(calls).not.toContain(`hash ${BIN}`);
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

describe('settleProbedVersion', () => {
  const digests: KnownDigest[] = [{ version: '2.1.296', sha256: SHA_A }];
  const base: VerifiedBinary = {
    path: BIN,
    sha256: SHA_A,
    size: 10,
    mtimeMs: 1000,
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
    fileId: '1:2',
    verification: { status: 'verified', method: 'sha256-manifest', mode: 'strict' },
  };

  function fs(realpathValue: string | Error, identity: FileIdentity | Error): IdentityFs {
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

  it('refuses a resolution that no longer matches the file', async () => {
    const binary = await resolveExecutable(file);
    await expect(
      verifyBinary({ ...binary, mtimeMs: binary.mtimeMs - 1 }, { mode: 'advisory', digests: [] }),
    ).rejects.toThrow(BinaryChangedError);
    await expect(
      verifyBinary(
        { ...binary, mtimeMs: binary.mtimeMs - 1 },
        { mode: 'strict', digests: [], platform: 'other' },
      ),
    ).rejects.toThrow(BinaryChangedError);
  });
});
