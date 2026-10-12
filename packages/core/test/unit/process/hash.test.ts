import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { NotRegularFileError, sha256File } from '../../../src/process/hash.js';

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
    await expect(sha256File(await file(''))).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    await expect(sha256File(await file('abc'))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('property: equals the one-shot digest for any content and chunk size', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 4096 }),
        fc.integer({ min: 1, max: 600 }),
        async (content, chunkBytes) => {
          const target = await file(content);
          await expect(sha256File(target, { chunkBytes })).resolves.toBe(oneShot(content));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('streams a large file through one fixed buffer (bounded memory)', async () => {
    const content = new Uint8Array(8 * 1024 * 1024 + 17);
    for (let i = 0; i < content.length; i += 4093) content[i] = i % 251;
    const target = await file(content);
    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    const digest = await sha256File(target);
    expect(digest).toBe(oneShot(content));
    expect(alloc.mock.calls).toEqual([[65536]]);
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
