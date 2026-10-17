// The real host seam (nodeHost) and the public entry points over it, run
// without the user's CLI: `binaryPath` is the running Node.js binary, whose
// `--version` output is not a Claude Code version, so connect stops at the
// probe (BINARY_PROBE_FAILED) after the real discovery, verification and
// probe ran. The config directory is a fresh temp directory, so the user's
// config is never read. Also: no signal handlers (K22), by run and by
// source.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BinaryProbeError, InvalidOptionsError } from '@hudhudjs/core';
import { hostExit } from '@hudhudjs/core/binding';

import { CLAUDE_CODE_ADAPTER, nodeHost } from '../../../src/adapter.js';
import { CLAUDE_CODE_COMPAT_POLICY } from '../../../src/compat.js';
import { connect, connectWith, hudhud, session } from '../../../src/connect.js';
import { KNOWN_BINARIES } from '../../../src/known-binaries.js';
import { BINARY, FakeHost } from './fake-host.js';

let configDir = '';

beforeAll(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'hudhud-w5-config-'));
});

afterAll(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe('nodeHost', () => {
  it('is the host: platform, environment, the real seams and the committed tables', () => {
    const host = nodeHost();
    expect(host).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      compat: CLAUDE_CODE_COMPAT_POLICY,
      knownBinaries: KNOWN_BINARIES,
      hostExit,
    });
    // Read when a session starts, not when the Harness was made.
    expect(host.cwd()).toBe(process.cwd());
    expect(host.os().platform).toBe(process.platform);
    // The addon package is not shipped until A2: unavailable on every host for now.
    expect(['loaded', 'unavailable']).toContain(host.loadJobAddon().status);
    expect(CLAUDE_CODE_ADAPTER).toEqual({ name: 'claude-code', adapterApiVersion: 1 });
  });
});

describe('the public entry points on the real host', () => {
  it('connect runs discovery, verification and the probe of a non-Claude binary, then refuses', async () => {
    const error = await connect({
      binaryPath: process.execPath,
      claudeCode: { configDir },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BinaryProbeError);
    expect(error).toMatchObject({ details: { reason: 'unparseable-output' } });
  });

  it('session() validates, checks the cwd, then connects the same way', async () => {
    const error = await hudhud
      .session({ binaryPath: process.execPath, cwd: configDir, claudeCode: { configDir } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BinaryProbeError);
    // Pinned as the calls above: if the refusal ever moved, this would still
    // never reach an installed claude or the real config directory (R8-4).
    await expect(
      session({
        permissionMode: 'bypassPermissions',
        binaryPath: process.execPath,
        cwd: configDir,
        claudeCode: { configDir },
      }),
    ).rejects.toBeInstanceOf(InvalidOptionsError);
    expect(hudhud.connect).toBe(connect);
    expect(Object.isFrozen(hudhud)).toBe(true);
  });
});

describe('no signal handlers (K22)', () => {
  it('a session on the real host-exit hook adds no signal listener and leaves no exit listener', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'SIGQUIT'] as const;
    const before = signals.map((name) => process.listenerCount(name));
    const exits = process.listenerCount('exit');
    const fake = new FakeHost();
    const harness = await connectWith({ binaryPath: BINARY }, () => ({ ...fake.host, hostExit }));
    const live = await harness.sessions.create();
    expect(process.listenerCount('exit')).toBe(exits + 1);
    await live.close();
    expect(signals.map((name) => process.listenerCount(name))).toEqual(before);
    expect(process.listenerCount('exit')).toBe(exits);
    await harness[Symbol.asyncDispose]();
  });

  it('no adapter source installs a process signal or exit handler', async () => {
    const src = fileURLToPath(new URL('../../../src/', import.meta.url));
    const files = (await readdir(src, { recursive: true, encoding: 'utf8' })).filter((file) =>
      file.endsWith('.ts'),
    );
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = await readFile(path.join(src, file), 'utf8');
      expect(text, file).not.toMatch(/process\s*\.\s*(on|once|addListener|prependListener)\s*\(/u);
      expect(text, file).not.toMatch(/['"]SIG(INT|TERM|HUP|BREAK|QUIT)['"]\s*,\s*\(/u);
    }
  });
});
