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
  await rm(root, { recursive: true, force: true });
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

  it('property: equals the one-shot digest for any content and chunk size', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 4096 }),
        fc.integer({ min: 1, max: 600 }),
        async (content, chunkBytes) => {
          const target = await file(content);
          const result = await sha256File(target, { chunkBytes });
          expect(result.sha256).toBe(oneShot(content));
          expect(result.size).toBe(content.length);
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);

  it('streams a large file through one fixed buffer (bounded memory)', async () => {
    const content = new Uint8Array(8 * 1024 * 1024 + 17);
    for (let i = 0; i < content.length; i += 4093) content[i] = i % 251;
    const target = await file(content);
    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    const digest = await sha256File(target);
    expect(digest.sha256).toBe(oneShot(content));
    expect(alloc.mock.calls).toEqual([[65536]]);
  });

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
