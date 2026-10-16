import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FileChangedError, NotRegularFileError, sha256File } from '../../../src/process/hash.js';

let root = '';
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-hash-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function file(content: Uint8Array | string): Promise<string> {
  counter += 1;
  const target = path.join(root, `f${String(counter)}`);
  await writeFile(target, content);
  return target;
}

/** Hang guard of the real-file property tests (not a performance budget). */
const HANG_GUARD_MS = 60_000;

interface ReadCall {
  readonly buffer: Uint8Array;
  readonly offset: number;
  readonly length: number;
  readonly position: number | bigint | null;
  bytesRead: number;
}

type ReadMethod = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | bigint | null,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

/**
 * Runs `work` with `FileHandle.prototype.read` recorded (the prototype is
 * found through a handle of `target`; nothing else in this file reads while
 * `work` runs). `limit` shortens each read deterministically: a short read
 * the OS may return at any time.
 */
async function recordReads<T>(
  work: () => Promise<T>,
  target: string,
  limit?: (index: number, length: number) => number,
): Promise<{ result: T; calls: ReadCall[] }> {
  const probe = await open(target);
  const proto = Object.getPrototypeOf(probe) as { read: ReadMethod };
  await probe.close();
  const original = proto.read;
  const calls: ReadCall[] = [];
  const spy = vi.spyOn(proto, 'read').mockImplementation(async function (
    this: { fd: number },
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | bigint | null,
  ) {
    const call: ReadCall = { buffer, offset, length, position, bytesRead: 0 };
    const asked = limit === undefined ? length : limit(calls.length, length);
    calls.push(call);
    const out = await Reflect.apply(original, this, [buffer, offset, asked, position]);
    call.bytesRead = out.bytesRead;
    return out;
  });
  try {
    const value = await work();
    return { result: value, calls };
  } finally {
    spy.mockRestore();
  }
}

function oneShot(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('sha256File', () => {
  it('matches the FIPS 180-2 test vectors', async () => {
    await expect(sha256File(await file(''))).resolves.toMatchObject({
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      size: 0,
    });
    await expect(sha256File(await file('abc'))).resolves.toMatchObject({
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      size: 3,
    });
  });

  // Hang guard, not a performance budget (owner ruling): 200 real file writes
  // and hashes take a few seconds under the default --maxWorkers with
  // coverage; the timeout only stops a hung read. The run count is unchanged.
  // One file, rewritten per run: creating 200 new files made the property
  // slow under load on Windows (each new file is scanned on creation).
  it(
    'property: equals the one-shot digest for any content and chunk size',
    async () => {
      const target = await file('');
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ maxLength: 512 }),
          fc.integer({ min: 1, max: 600 }),
          async (content, chunkBytes) => {
            await writeFile(target, content);
            const result = await sha256File(target, { chunkBytes });
            expect(result.sha256).toBe(oneShot(content));
            expect(result.size).toBe(content.length);
          },
        ),
        { numRuns: 200 },
      );
    },
    HANG_GUARD_MS,
  );

  // A read may legally return fewer bytes than asked (a short read) at any
  // time, so the number of reads is not a property of sha256File; the
  // invariants are: every read goes into the one buffer of chunkBytes at
  // offset 0, nothing is allocated per read, the bytes read sum to the size,
  // and the digest is right. The default buffer is 4 MiB (W7-T5: fewer
  // reads, each of which waits for the scheduler under CPU contention).
  const DEFAULT_CHUNK = 4 * 1024 * 1024;
  it('streams a large file through one fixed buffer (bounded memory)', async () => {
    const content = new Uint8Array(8 * 1024 * 1024 + 17);
    for (let i = 0; i < content.length; i += 4093) content[i] = i % 251;
    const target = await file(content);
    const reads = await recordReads(() => sha256File(target), target);
    const digest = reads.result;
    expect(digest.sha256).toBe(oneShot(content));
    expect(digest.size).toBe(content.length);
    expect(new Set(reads.calls.map((call) => call.buffer)).size).toBe(1);
    for (const call of reads.calls) {
      expect(call.buffer.length).toBe(DEFAULT_CHUNK);
      expect(call.offset).toBe(0);
      expect(call.length).toBe(DEFAULT_CHUNK);
      expect(call.position).toBeNull();
    }
    expect(reads.calls.reduce((sum, call) => sum + call.bytesRead, 0)).toBe(content.length);
    // At least one read per chunk plus the read that returns 0 bytes; short
    // reads may add more, never fewer.
    expect(reads.calls.length).toBeGreaterThanOrEqual(
      Math.ceil(content.length / DEFAULT_CHUNK) + 1,
    );
    expect(reads.calls.at(-1)?.bytesRead).toBe(0);
  });

  it(
    'property: short reads of any length still give the one-shot digest',
    async () => {
      const target = await file('');
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 4096 }),
          fc.integer({ min: 1, max: 1024 }),
          fc.array(fc.integer({ min: 1, max: 1024 }), { minLength: 1, maxLength: 16 }),
          async (content, chunkBytes, pattern) => {
            await writeFile(target, content);
            // Deterministic short reads: the n-th read asks the real file for
            // at most pattern[n % pattern.length] bytes.
            const reads = await recordReads(
              () => sha256File(target, { chunkBytes }),
              target,
              (index, length) => Math.min(length, pattern[index % pattern.length] ?? length),
            );
            const digest = reads.result;
            expect(digest.sha256).toBe(oneShot(content));
            expect(digest.size).toBe(content.length);
            expect(new Set(reads.calls.map((call) => call.buffer)).size).toBe(1);
            expect(reads.calls.every((call) => call.offset === 0)).toBe(true);
            expect(reads.calls.reduce((sum, call) => sum + call.bytesRead, 0)).toBe(content.length);
            // After a short read the next read still asks for the whole buffer.
            expect(reads.calls.every((call) => call.length === chunkBytes)).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    },
    HANG_GUARD_MS,
  );

  it('binds the digest to the identity of the hashed file', async () => {
    const target = await file('identity');
    const facts = await stat(target, { bigint: true });
    await expect(sha256File(target)).resolves.toEqual({
      sha256: oneShot('identity'),
      size: 8,
      mtimeMs: Number(facts.mtimeMs),
      fileId: `${String(facts.dev)}:${String(facts.ino)}`,
    });
  });

  it('fails when the file changes while it is read', async () => {
    const target = await file('0123456789');
    const probe = await open(target);
    const proto: { read: (...args: never[]) => unknown } = Object.getPrototypeOf(probe) as {
      read: (...args: never[]) => unknown;
    };
    await probe.close();
    const original = proto.read;
    let first = true;
    vi.spyOn(proto, 'read').mockImplementation(function (this: unknown, ...args: never[]) {
      if (first) {
        first = false;
        appendFileSync(target, 'more');
      }
      return Reflect.apply(original, this, args);
    });
    const error: unknown = await sha256File(target, { chunkBytes: 4 }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(FileChangedError);
    expect((error as FileChangedError).path).toBe(target);
    expect((error as FileChangedError).name).toBe('FileChangedError');
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])('refuses chunkBytes %d', async (chunkBytes) => {
    await expect(sha256File(await file('x'), { chunkBytes })).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects a missing file with the filesystem error', async () => {
    await expect(sha256File(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a device that is not a regular file', async () => {
    const device = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';
    const error: unknown = await sha256File(device).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NotRegularFileError);
    expect((error as NotRegularFileError).path).toBe(device);
    expect((error as NotRegularFileError).name).toBe('NotRegularFileError');
  });

  it.runIf(process.platform !== 'win32')('posix: refuses a directory', async () => {
    await expect(sha256File(root)).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it.runIf(process.platform === 'linux')(
    'linux: refuses a FIFO without blocking on the open',
    async () => {
      const fifo = path.join(root, 'fifo');
      execFileSync('mkfifo', [fifo]);
      await expect(sha256File(fifo)).rejects.toBeInstanceOf(NotRegularFileError);
    },
  );
});
