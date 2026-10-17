import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bumpReport,
  bumpedPinText,
  compareReleases,
  releaseVersion,
  runBump,
} from '../../src/canary/bump.js';
import type { BumpHost } from '../../src/canary/bump.js';
import type { RunPin } from '../../src/cli/newest.js';
import { CliFetchError } from '../../src/cli/errors.js';
import type { FakeRegistry, Release } from '../cli/fake-registry.js';
import {
  fakeRegistry,
  manifestFor,
  pinDocument,
  release,
  serve,
  serveSdk,
} from '../cli/fake-registry.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const OLD_LINUX = release('linux-x64', '2.1.296');
const OLD_WIN = release('win32-x64', '2.1.296');
const LINUX = release('linux-x64', '2.2.0');
const WIN = release('win32-x64', '2.2.0');

const PENDING = {
  package: '@anthropic-ai/claude-code-darwin-arm64',
  file: 'claude',
  pendingGate: true,
};

/** The committed pin's layout: a comment first, then version and platforms. */
function committedPin(): Record<string, unknown> {
  const doc = pinDocument(OLD_LINUX, OLD_WIN) as Record<string, unknown> & {
    platforms: Record<string, unknown>;
  };
  return {
    $comment: 'Pinned Claude Code CLI under test.',
    version: doc['version'],
    platforms: { ...doc.platforms, 'darwin-arm64': PENDING },
  };
}

let root = '';
let registry: FakeRegistry;
let files: Map<string, string>;
let out = '';
let err = '';

const PIN_FILE = (): string => path.join(root, 'tooling', 'cli-pin.json');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hudhud-bump-'));
  registry = fakeRegistry();
  serve(registry, LINUX);
  serve(registry, WIN);
  files = new Map([[PIN_FILE(), `${JSON.stringify(committedPin(), null, 2)}\n`]]);
  out = '';
  err = '';
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

function host(argv: string[], env: Record<string, string> = {}): BumpHost {
  return {
    argv,
    env,
    repoRoot: root,
    fetch: registry.fetch,
    platform: process.platform,
    now: () => NOW,
    readFile: (file) => {
      const text = files.get(file);
      return text === undefined
        ? Promise.reject(new Error(`ENOENT ${file}`))
        : Promise.resolve(text);
    },
    replaceFile: (file, text) => {
      files.set(file, text);
      return Promise.resolve();
    },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
}

function pinNow(): Record<string, unknown> & { platforms: Record<string, unknown> } {
  return JSON.parse(files.get(PIN_FILE()) ?? '') as Record<string, unknown> & {
    platforms: Record<string, unknown>;
  };
}

function entryOf(r: Release): unknown {
  return { package: r.pkg, file: r.file, integrity: r.integrity, sha256: r.sha256, size: r.size };
}

describe('release versions', () => {
  it('parses X.Y.Z only and compares numerically', () => {
    expect(releaseVersion('2.1.296')).toEqual([2, 1, 296]);
    expect(releaseVersion('2.2.0-next.1')).toBeUndefined();
    expect(releaseVersion('latest')).toBeUndefined();
    expect(compareReleases([2, 1, 296], [2, 1, 30])).toBeGreaterThan(0);
    expect(compareReleases([2, 1, 0], [2, 2, 0])).toBeLessThan(0);
    expect(compareReleases([3, 0, 0], [2, 9, 9])).toBeGreaterThan(0);
    expect(compareReleases([2, 2, 0], [2, 2, 0])).toBe(0);
  });
});

describe('runBump', () => {
  it('records, cross-checks, verifies every pinned platform and rewrites only the pin', async () => {
    serveSdk(registry, '0.9.0', '2.2.0', manifestFor('2.2.0', LINUX, WIN));
    expect(await runBump(host(['2.2.0']))).toBe(0);
    expect(err).toBe('');
    const pin = pinNow();
    // Key order, comment and the pending entry are kept; version and digests move.
    expect(Object.keys(pin)).toEqual(['$comment', 'version', 'platforms']);
    expect(pin['$comment']).toBe('Pinned Claude Code CLI under test.');
    expect(pin['version']).toBe('2.2.0');
    expect(pin.platforms).toEqual({
      'linux-x64': entryOf(LINUX),
      'win32-x64': entryOf(WIN),
      'darwin-arm64': PENDING,
    });
    expect(Object.keys(pin.platforms)).toEqual(['linux-x64', 'win32-x64', 'darwin-arm64']);
    expect(out).toContain(`verified ${LINUX.pkg}@2.2.0 sha256=${LINUX.sha256}`);
    expect(out).toContain('cli:bump 2.1.296 -> 2.2.0: tooling/cli-pin.json updated.');
    // The SDK release that served the cross-check is part of the reproduction.
    expect(out).toContain('  pnpm cli:bump 2.2.0 --sdk 0.9.0\n');
    expect(out).toContain(`registry integrity ${WIN.integrity} (recorded ${NOW.toISOString()})`);
    // The binaries landed in the default cache.
    expect(await readdir(path.join(root, '.cache', 'claude-cli', '2.2.0'))).toEqual([
      'linux-x64',
      'win32-x64',
    ]);
  });

  it('cross-checks against an explicit SDK release and keeps the flags in the record', async () => {
    serveSdk(registry, '0.8.0', '2.2.0', manifestFor('2.2.0', LINUX, WIN));
    serveSdk(registry, '0.9.0', '2.3.0');
    files.set(PIN_FILE(), JSON.stringify({ ...committedPin(), version: '2.3.0' }, null, 2));
    expect(
      await runBump(host(['2.2.0', '--sdk', '0.8.0', '--allow-downgrade', '--cache', 'c'])),
    ).toBe(0);
    expect(out).toContain('  pnpm cli:bump 2.2.0 --sdk 0.8.0 --allow-downgrade\n');
    expect(await readdir(path.join(root, 'c'))).toContain('2.2.0');
  });

  it('honours HUDHUD_CLI_CACHE', async () => {
    serveSdk(registry, '0.9.0', '2.2.0', manifestFor('2.2.0', LINUX, WIN));
    expect(await runBump(host(['2.2.0'], { HUDHUD_CLI_CACHE: 'env-cache' }))).toBe(0);
    expect(await readdir(path.join(root, 'env-cache'))).toContain('2.2.0');
  });

  it('fails before any binary download when no SDK release describes the version', async () => {
    serveSdk(registry, '0.9.0', '2.3.0');
    expect(await runBump(host(['2.2.0']))).toBe(1);
    expect(err).toContain(
      '[cross-check-failed] @anthropic-ai/claude-agent-sdk@0.9.0 (latest) bundles CLI 2.3.0, not 2.2.0: pass --sdk <version>',
    );
    expect(err).toContain('tooling/cli-pin.json was not changed');
    expect(registry.calls).not.toContain(LINUX.tarballUrl);
    expect(pinNow()['version']).toBe('2.1.296');
    serveSdk(registry, '0.9.1', undefined);
    err = '';
    expect(await runBump(host(['2.2.0']))).toBe(1);
    expect(err).toContain('bundles CLI unknown, not 2.2.0');
  });

  it('leaves the pin unchanged when a later platform fails to verify', async () => {
    const tampered = release('win32-x64', '2.2.0', 'not what the SDK says');
    serveSdk(
      registry,
      '0.9.0',
      '2.2.0',
      manifestFor('2.2.0', LINUX, { ...tampered, size: WIN.size }),
    );
    expect(await runBump(host(['2.2.0']))).toBe(1);
    expect(err).toContain('[binary-mismatch]');
    expect(pinNow()['version']).toBe('2.1.296');
    expect(out).toContain(`verified ${LINUX.pkg}@2.2.0`);
  });

  it('refuses the pinned version, a downgrade without the flag and a pre-release', async () => {
    expect(await runBump(host(['2.1.296']))).toBe(2);
    expect(err).toContain('2.1.296 is already the pinned version');
    expect(await runBump(host(['2.1.200']))).toBe(2);
    expect(err).toContain('is older than the pinned 2.1.296; pass --allow-downgrade');
    expect(await runBump(host(['2.2.0-next.1']))).toBe(2);
    expect(err).toContain('"2.2.0-next.1" is not a release version X.Y.Z');
    expect(registry.calls).toEqual([]);
  });

  it.each([[[]], [['2.2.0', '2.3.0']], [['--bogus']], [['2.2.0', '--sdk', '../x']]])(
    'rejects %j with exit 2',
    async (argv) => {
      expect(await runBump(host(argv))).toBe(2);
      expect(err).toContain('usage: cli:bump');
    },
  );

  it('reports an unreadable, invalid or pre-release pin and a pin without digests', async () => {
    files.delete(PIN_FILE());
    expect(await runBump(host(['2.2.0']))).toBe(1);
    expect(err).toContain('cli:bump: Error: ENOENT');
    files.set(PIN_FILE(), JSON.stringify({ ...committedPin(), version: '2.1.0-rc.1' }));
    err = '';
    expect(await runBump(host(['2.2.0']))).toBe(1);
    expect(err).toContain('[pin-invalid]');
    expect(err).toContain('is not a release version');
    files.set(
      PIN_FILE(),
      JSON.stringify({ version: '2.1.296', platforms: { 'darwin-arm64': PENDING } }),
    );
    serveSdk(registry, '0.9.0', '2.2.0', manifestFor('2.2.0', LINUX, WIN));
    err = '';
    expect(await runBump(host(['2.2.0']))).toBe(1);
    expect(err).toContain('no platform with digests to bump');
  });
});

describe('bumpedPinText', () => {
  it('keeps the document when there is nothing to apply and refuses one without platforms', () => {
    const doc = committedPin();
    expect(bumpedPinText(doc, [])).toBe(`${JSON.stringify(doc, null, 2)}\n`);
    expect(() => bumpedPinText({ version: '1.0.0' }, [])).toThrow(CliFetchError);
  });
});

describe('bumpReport', () => {
  const runPin: RunPin = {
    package: LINUX.pkg,
    version: '2.2.0',
    platform: 'linux-x64',
    file: 'claude',
    integrity: LINUX.integrity,
    sha256: LINUX.sha256,
    size: LINUX.size,
    recordedAt: NOW.toISOString(),
    crossCheck: 'verified',
    crossCheckDetail: 'sdk',
  };

  it('prints the digest-table entry, the window and every follow-up command', () => {
    const report = bumpReport('2.1.296', [runPin], 'pnpm cli:bump 2.2.0 --sdk 0.9.0');
    expect(report).toContain(
      `    '2.2.0': Object.freeze({\n      'linux-x64': Object.freeze({\n        sha256: '${LINUX.sha256}',\n        size: ${String(LINUX.size)},\n      }),\n    }),`,
    );
    expect(report).toContain("set CLAUDE_CODE_COMPAT.maxTested to '2.2.0'");
    expect(report).toContain('Get-AuthenticodeSignature <cache>\\2.2.0\\win32-x64\\claude.exe');
    expect(report).toContain('pnpm fixtures:record');
    expect(report).toContain(
      'HUDHUD_REQUEST_SHAPE_UPDATE=1 pnpm vitest run --project integration packages/claude-code/test/integration/request-shape',
    );
    expect(report).toContain('dispatch .github/workflows/macos-gate.yml on it');
    expect(report).toContain('CLAUDE_CODE_PUBLISHER.darwinTeamId');
    expect(report).toContain('pnpm check:full on Linux and on Windows');
    expect(bumpReport('2.1.296', [], 'x')).toContain('cli:bump 2.1.296 -> 2.1.296');
  });
});
