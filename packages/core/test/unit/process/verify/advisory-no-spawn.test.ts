// K8, plan §4.2 and §5.5 W3-T2: advisory verification never starts a
// process (no PowerShell, no codesign, never the binary). Every process API
// of node:child_process is replaced by a spy that throws; advisory
// verification runs with the production defaults and none is called. The
// strict case proves the patch is effective (the spy is reached).

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => {
  const refuse = (name: string) =>
    vi.fn<(...args: unknown[]) => never>(() => {
      throw new Error(`child_process.${name} must not be called`);
    });
  return {
    spawn: refuse('spawn'),
    spawnSync: refuse('spawnSync'),
    exec: refuse('exec'),
    execSync: refuse('execSync'),
    execFile: refuse('execFile'),
    execFileSync: refuse('execFileSync'),
    fork: refuse('fork'),
  };
});

vi.mock('node:child_process', () => ({ ...spies, default: spies }));

const { resolveExecutable } = await import('../../../../src/process/binary-path.js');
const { verifyBinary, VerificationCache } =
  await import('../../../../src/process/verify/verify.js');

function called(): string[] {
  return Object.entries(spies)
    .filter(([, spy]) => spy.mock.calls.length > 0)
    .map(([name]) => name);
}

let root = '';
let file = '';
let sha = '';

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-advisory-'));
  file = path.join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
  await writeFile(file, 'pretend binary', { mode: 0o755 });
  sha = createHash('sha256').update('pretend binary').digest('hex');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

describe('advisory verification', () => {
  it('starts no process for a match, a mismatch, an empty table or a cache hit', async () => {
    const binary = await resolveExecutable(file);
    const cache = new VerificationCache();
    for (const digests of [
      [{ version: '1.0.0', sha256: sha }],
      [{ version: '1.0.0', sha256: 'c'.repeat(64) }],
      [],
    ]) {
      await verifyBinary(binary, { mode: 'advisory', digests, cache });
      await verifyBinary(binary, { mode: 'advisory', digests, cache });
    }
    // Every platform's signature check is in reach, none is used.
    for (const platform of ['win32', 'darwin', 'other'] as const) {
      await verifyBinary(binary, { mode: 'advisory', digests: [], platform });
    }
    expect(called()).toEqual([]);
  });

  it('is not vacuous: strict verification reaches the patched module', async () => {
    const binary = await resolveExecutable(file);
    const result = await verifyBinary(binary, {
      mode: 'strict',
      digests: [{ version: '1.0.0', sha256: sha }],
      platform: 'darwin',
      deps: {
        signature: {
          // Pretend /usr/bin/codesign is in place; the runner is the default one.
          fs: {
            realpath: (value) => Promise.resolve(value),
            lstat: () => Promise.resolve({ isFile: () => true, isSymbolicLink: () => false }),
          },
        },
      },
    });
    expect(called()).toEqual(['spawn']);
    expect(spies.spawn.mock.calls[0]?.[0]).toBe('/usr/bin/codesign');
    // The refused spawn is a failed (transient) signature check, and strict fails closed.
    expect(result.verification).toEqual({
      status: 'failed',
      method: 'os-signature',
      mode: 'strict',
      detail: 'codesign failed: spawn failed: unknown error',
      transient: true,
    });
  });
});
