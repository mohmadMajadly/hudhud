// Binary verification through connect and the session gate (K8, K9; W5
// ruling 2): strict mode on Windows pins the publisher, a transient
// signature verdict (a check that did not complete) fails that attempt and
// is never cached, so the next attempt checks again; a definitive verdict is
// cached for the Harness.

import { describe, expect, it } from 'vitest';

import type { CommandOutcome } from '@hudhud/core/process';

import { connectWith } from '../../../src/connect.js';
import { CLAUDE_CODE_PUBLISHER } from '../../../src/known-binaries.js';
import { BINARY, FakeHost } from './fake-host.js';

const VALID: CommandOutcome = {
  kind: 'exited',
  exitCode: 0,
  signal: null,
  stdout: `Valid\n${CLAUDE_CODE_PUBLISHER.windowsSubject}`,
};

function strictWindows(outcomes: CommandOutcome[]): {
  readonly fake: FakeHost;
  readonly runs: () => number;
  readonly make: () => FakeHost['host'];
} {
  const fake = new FakeHost({
    platform: 'win32',
    cwd: 'C:\\work',
    env: { SystemRoot: 'C:\\Windows' },
  });
  let runs = 0;
  const host = {
    ...fake.host,
    verify: {
      ...fake.host.verify,
      signature: {
        fs: {
          realpath: (value: string) => Promise.resolve(value),
          lstat: () => Promise.resolve({ isFile: () => true, isSymbolicLink: () => false }),
        },
        run: () => {
          runs += 1;
          fake.log.push('signature');
          return Promise.resolve(outcomes.shift() ?? VALID);
        },
      },
    },
  };
  return { fake, runs: () => runs, make: () => host };
}

describe('strict verification on Windows', () => {
  it('pins the publisher: a valid signature of another subject is refused', async () => {
    const { make } = strictWindows([
      { kind: 'exited', exitCode: 0, signal: null, stdout: 'Valid\nCN=Someone Else' },
    ]);
    await expect(
      connectWith({ binaryPath: BINARY, binaryVerification: 'strict' }, make),
    ).rejects.toMatchObject({
      code: 'BINARY_VERIFICATION_FAILED',
      details: { status: 'failed', method: 'os-signature', mode: 'strict' },
    });
  });

  it('a transient verdict fails connect without being cached; the next connect checks again', async () => {
    const { make, runs } = strictWindows([{ kind: 'timeout' }]);
    await expect(
      connectWith({ binaryPath: BINARY, binaryVerification: 'strict' }, make),
    ).rejects.toMatchObject({
      code: 'BINARY_VERIFICATION_FAILED',
      details: { transient: true, method: 'os-signature' },
    });
    const harness = await connectWith({ binaryPath: BINARY, binaryVerification: 'strict' }, make);
    expect(harness.binary.verification).toMatchObject({ status: 'verified', mode: 'strict' });
    expect(runs()).toBe(2);
    await harness[Symbol.asyncDispose]();
  });

  it('within a Harness: a transient re-verification fails that session only, the next checks again', async () => {
    const outcomes: CommandOutcome[] = [VALID, { kind: 'spawn-error', errno: 'EBUSY' }];
    const { fake, make, runs } = strictWindows(outcomes);
    const harness = await connectWith({ binaryPath: BINARY, binaryVerification: 'strict' }, make);
    expect(runs()).toBe(1);
    // The file is updated in place; the session gate verifies it again.
    fake.binary = { ...fake.binary, mtimeMs: 2000, ino: 2 };
    await expect(harness.sessions.create()).rejects.toMatchObject({
      code: 'BINARY_VERIFICATION_FAILED',
      details: { transient: true },
    });
    expect(fake.log).not.toContain('spawn');
    const session = await harness.sessions.create();
    expect(runs()).toBe(3);
    await session.close();
    // A definitive verdict is cached: an unchanged binary is not checked again.
    const again = await harness.sessions.create();
    expect(runs()).toBe(3);
    await again.close();
    await harness[Symbol.asyncDispose]();
  });
});
