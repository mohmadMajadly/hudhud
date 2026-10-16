// Pipeline order of the assembled adapter (plan §5.7 acceptance; W5 ruling
// 8): validate -> guard -> cwd -> resolve -> verify -> probe (exactly one per
// connect, K4) -> posture -> [session] re-verify -> registry claim -> spawn
// -> job assignment before process.started -> driver. Every ordering is read
// from the fake host's log; nothing real runs.

import { describe, expect, it } from 'vitest';

import {
  InvalidOptionsError,
  ProjectCredentialEnvError,
  SessionIdInUseError,
} from '@hudhudjs/core';

import { connectWith, sessionWith } from '../../../src/connect.js';
import {
  at,
  BINARY,
  captureEvents,
  DIGEST,
  FakeHost,
  PROJECT,
  settle,
  VERSION,
} from './fake-host.js';

const CREDS = { env: { ANTHROPIC_BASE_URL: 'http://redirect.example' } };

function count(log: readonly string[], prefix: string): number {
  return log.filter((entry) => entry.startsWith(prefix)).length;
}

describe('validation comes before any file system access', () => {
  it('connect: invalid options never make the host', async () => {
    const fake = new FakeHost();
    await expect(connectWith({ binaryPath: '' }, fake.make)).rejects.toBeInstanceOf(
      InvalidOptionsError,
    );
    await expect(
      connectWith({ claudeCode: { unknown: true } } as never, fake.make),
    ).rejects.toBeInstanceOf(InvalidOptionsError);
    expect(fake.log).toEqual([]);
  });

  it('session(): invalid options, and argv/env problems, touch nothing', async () => {
    const fake = new FakeHost();
    await expect(
      sessionWith({ binaryPath: BINARY, permissionMode: 'bypassPermissions' }, fake.make),
    ).rejects.toBeInstanceOf(InvalidOptionsError);
    expect(fake.log).toEqual([]);
    // An env map with two spellings of one variable is refused on win32
    // before the guard, the cwd or the binary is looked at.
    const win = new FakeHost({ platform: 'win32' });
    await expect(
      sessionWith({ binaryPath: BINARY, env: { Path: 'a', PATH: 'b' } }, win.make),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS', details: { rule: 'env-duplicate' } });
    expect(win.log).toEqual(['host']);
  });

  it('sessions.create: invalid options touch nothing of the session', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const before = fake.log.length;
    await expect(harness.sessions.create({ maxFrameBytes: 1 })).rejects.toBeInstanceOf(
      InvalidOptionsError,
    );
    await expect(harness.sessions.resume('not-a-uuid')).rejects.toMatchObject({
      details: { rule: 'session-id' },
    });
    expect(fake.log.slice(before)).toEqual([]);
    await harness[Symbol.asyncDispose]();
  });
});

describe('connect: resolve -> verify -> gate -> one probe -> posture', () => {
  it('runs the steps in order with exactly one --version probe (K4)', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    expect(fake.log).toEqual([
      'host',
      `resolve ${BINARY}`,
      'hash',
      // The spawn gate, then the probe's own identity check right before it runs.
      'identity',
      'identity',
      'probe --version',
      'user-settings /home/user/.claude/settings.json',
    ]);
    // The probe: the verified realpath, `--version` only, a hudhud-owned
    // directory, hudhud's pinned keys and no credential (least privilege).
    expect(fake.probes[0]).toMatchObject({
      file: BINARY,
      args: ['--version'],
      cwd: '/tmp/hudhud-probe-1',
      timeoutMs: 15_000,
    });
    expect(fake.probes[0]?.env).toMatchObject({ PATH: '/usr/bin', DISABLE_AUTOUPDATER: '1' });
    expect(fake.probes[0]?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    // Sessions never probe an unchanged binary again.
    const a = await harness.sessions.create();
    const b = await harness.sessions.create();
    expect(count(fake.log, 'probe')).toBe(1);
    await a.close();
    await b.close();
    await harness[Symbol.asyncDispose]();
  });
});

describe('session(): guard -> cwd -> connect -> posture -> gate -> claim -> spawn', () => {
  it('runs the guard and the cwd before anything is resolved, probed or spawned', async () => {
    const fake = new FakeHost();
    fake.guardFs.dir(`${PROJECT}/.git`);
    let claimed = false;
    fake.beforeSpawn = () => {
      claimed = true;
    };
    const session = await sessionWith(
      { binaryPath: BINARY, cwd: PROJECT, workspaceTrust: 'full' },
      fake.make,
    );
    const log = fake.log;
    expect(at(log, 'guard')).toBeLessThan(at(log, `cwd ${PROJECT}`));
    expect(at(log, `cwd ${PROJECT}`)).toBeLessThan(at(log, 'resolve'));
    expect(at(log, 'resolve')).toBeLessThan(at(log, 'hash'));
    expect(at(log, 'hash')).toBeLessThan(at(log, 'probe'));
    expect(at(log, 'probe')).toBeLessThan(at(log, 'user-settings'));
    // The session's own posture scan and gate follow the connect steps.
    const afterProbe = log.slice(at(log, 'probe'));
    expect(afterProbe).toEqual([
      'probe --version',
      'user-settings /home/user/.claude/settings.json',
      'user-settings /home/user/.claude/settings.json',
      'identity',
      'spawn',
      'write:control_request:initialize',
    ]);
    expect(claimed).toBe(true);
    await session.close();
  });

  it('a guard refusal spawns nothing, the probe included', async () => {
    const fake = new FakeHost();
    fake.guardFs.dir(`${PROJECT}/.git`).json(`${PROJECT}/.claude/settings.json`, CREDS);
    const error = await sessionWith(
      { binaryPath: BINARY, cwd: PROJECT, workspaceTrust: 'full' },
      fake.make,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectCredentialEnvError);
    expect(error).toMatchObject({ details: { variables: ['ANTHROPIC_BASE_URL'] } });
    expect(JSON.stringify(error)).not.toContain('redirect.example');
    expect(fake.log.some((entry) => entry.startsWith('probe') || entry === 'spawn')).toBe(false);
    expect(fake.log.some((entry) => entry.startsWith('cwd'))).toBe(false);
  });

  it('sessions.create: a guard refusal spawns nothing', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    fake.guardFs.dir(`${PROJECT}/.git`).json(`${PROJECT}/.claude/settings.local.json`, CREDS);
    await expect(
      harness.sessions.create({ cwd: PROJECT, claudeCode: { settingSources: ['user', 'local'] } }),
    ).rejects.toBeInstanceOf(ProjectCredentialEnvError);
    expect(fake.log).not.toContain('spawn');
    expect(harness.registry.size).toBe(0);
    await harness[Symbol.asyncDispose]();
  });
});

describe('the spawn gate re-verifies before every spawn (TOCTOU)', () => {
  it('a changed binary is resolved, verified and probed again before the spawn', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    // A legitimate in-place update: new mtime and inode, same known digest.
    fake.binary = { ...fake.binary, mtimeMs: 2000, ino: 2 };
    const before = fake.log.length;
    const session = await harness.sessions.create();
    expect(fake.log.slice(before)).toEqual([
      `cwd ${PROJECT}`,
      'user-settings /home/user/.claude/settings.json',
      'identity',
      `resolve ${BINARY}`,
      'hash',
      'identity',
      'identity',
      'probe --version',
      'identity',
      'spawn',
      'write:control_request:initialize',
    ]);
    expect(count(fake.log, 'probe')).toBe(2);
    expect(harness.current.binary.mtimeMs).toBe(2000);
    await session.close();
    await harness[Symbol.asyncDispose]();
  });

  it('a binary replaced by unknown bytes is refused in strict mode before the spawn', async () => {
    const fake = new FakeHost();
    const harness = await connectWith(
      { binaryPath: BINARY, binaryVerification: 'strict' },
      fake.make,
    );
    fake.binary = { ...fake.binary, mtimeMs: 2000, ino: 2, sha256: 'c'.repeat(64) };
    await expect(harness.sessions.create()).rejects.toMatchObject({
      code: 'BINARY_VERIFICATION_FAILED',
      details: { status: 'unverified', mode: 'strict' },
    });
    expect(fake.log).not.toContain('spawn');
    expect(harness.registry.size).toBe(0);
    await harness[Symbol.asyncDispose]();
  });

  it('a re-verified binary whose new version is known-broken is refused without the opt-in (Q7)', async () => {
    const policy = {
      minTested: VERSION,
      maxTested: VERSION,
      knownBroken: [{ version: '2.1.297', reason: 'loses turns (test listing)' }],
    };
    for (const allow of [false, true]) {
      const fake = new FakeHost({ compat: policy });
      const harness = await connectWith(
        { binaryPath: BINARY, claudeCode: { dangerouslyAllowKnownBrokenVersion: allow } },
        fake.make,
      );
      fake.binary = {
        ...fake.binary,
        mtimeMs: 2000,
        ino: 2,
        sha256: 'e'.repeat(64),
        version: '2.1.297',
      };
      if (allow) {
        const session = await harness.sessions.create();
        expect(session.info.version).toBe('2.1.297');
        await session.close();
      } else {
        await expect(harness.sessions.create()).rejects.toMatchObject({
          code: 'HARNESS_VERSION_KNOWN_BROKEN',
          details: { version: '2.1.297', reason: 'loses turns (test listing)' },
        });
        expect(fake.log).not.toContain('spawn');
        expect(harness.registry.size).toBe(0);
      }
      // The Harness keeps the connect facts either way.
      expect(harness.binary.version).toBe(VERSION);
      await harness[Symbol.asyncDispose]();
    }
  });

  it('a binary that changes again right before the spawn is refused', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    fake.binary = { ...fake.binary, mtimeMs: 2000, ino: 2 };
    fake.probe = () => {
      const stdout = `${fake.binary.version} (Claude Code)\n`;
      // The file changes once more while the probe runs.
      fake.binary = { ...fake.binary, mtimeMs: 3000, ino: 3 };
      return { kind: 'exited', exitCode: 0, signal: null, stdout };
    };
    await expect(harness.sessions.create()).rejects.toMatchObject({
      code: 'BINARY_VERIFICATION_FAILED',
    });
    expect(fake.log).not.toContain('spawn');
    await harness[Symbol.asyncDispose]();
  });
});

describe('the registry claim comes before the spawn', () => {
  it('holds the id while the CLI spawns; a second live resume of it is SESSION_ID_IN_USE', async () => {
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const id = '11111111-2222-4333-8444-555555555555';
    let heldAtSpawn = false;
    fake.beforeSpawn = () => {
      heldAtSpawn = harness.registry.has(id);
    };
    const first = await harness.sessions.resume(id);
    expect(heldAtSpawn).toBe(true);
    const spawns = count(fake.log, 'spawn');
    const second = await harness.sessions.resume(id.toUpperCase()).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(SessionIdInUseError);
    expect(count(fake.log, 'spawn')).toBe(spawns);
    await first.close();
    await settle();
    // Released on the end: the id can be resumed again.
    const again = await harness.sessions.resume(id);
    await again.close();
    await harness[Symbol.asyncDispose]();
  });
});

describe('job assignment before process.started (ADR-0009 §1)', () => {
  it('the job holds the process before the machine writes initialize', async () => {
    const fake = new FakeHost({ job: 'loaded' });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    expect(harness.capabilities.processContainment).toBe('job');
    const session = await harness.sessions.create();
    const log = fake.log;
    expect(at(log, 'spawn')).toBeLessThan(at(log, 'job:create'));
    expect(at(log, 'job:assign')).toBeLessThan(at(log, 'write:control_request:initialize'));
    expect(session.info.containment).toBe('job');
    await session.close();
    await settle();
    expect(fake.log).toContain('job:close');
    await harness[Symbol.asyncDispose]();
  });

  it('a failed assignment keeps the session best-effort with containment.fallback', async () => {
    const fake = new FakeHost({ job: 'assign-fails' });
    const harness = await connectWith({ binaryPath: BINARY }, fake.make);
    const captured = captureEvents(harness);
    const session = await harness.sessions.create();
    expect(session.info.containment).toBe('best-effort');
    await session.close();
    expect(captured[0]).toContainEqual(
      expect.objectContaining({
        type: 'diagnostic',
        code: 'containment.fallback',
        data: { step: 'assign-process', code: 'WIN32_5' },
      }),
    );
    await harness[Symbol.asyncDispose]();
  });
});

describe('the digest fixture', () => {
  it('is the verified digest of the fake binary', () => {
    expect(new FakeHost().binary.sha256).toBe(DIGEST);
  });
});
