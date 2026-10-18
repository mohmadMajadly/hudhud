// The digest table and the K4 probe format (K4, K8, ADR-0011, plan §1.8).

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_PUBLISHER,
  CLAUDE_VERSION_PROBE_ARGS,
  CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  KNOWN_BINARIES,
  knownDigestsFor,
  parseClaudeVersion,
  platformKey,
} from '../../src/provenance.js';

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));
}

interface PinFile {
  readonly version: string;
  readonly platforms: Readonly<
    Record<
      string,
      { readonly sha256?: string; readonly size?: number; readonly pendingGate?: boolean }
    >
  >;
}

describe('the committed digest table (known-binaries.ts, the single source)', () => {
  const pin = readJson('../../../../tooling/cli-pin.json') as PinFile;

  it('equals tooling/cli-pin.json for every pinned platform', () => {
    const entry = KNOWN_BINARIES[pin.version];
    expect(entry).toBeDefined();
    const pinned = Object.entries(pin.platforms).filter(([, value]) => value.pendingGate !== true);
    expect(pinned.map(([key]) => key).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64',
    ]);
    for (const [key, value] of pinned) {
      expect(entry?.[key]).toEqual({ sha256: value.sha256, size: value.size });
    }
    // Nothing beyond the pin: the table has exactly the pinned platforms.
    expect(Object.keys(entry ?? {}).sort()).toEqual(pinned.map(([key]) => key).sort());
  });

  it('pins no platform as pending its gate', () => {
    expect(Object.values(pin.platforms).filter((value) => value.pendingGate === true)).toEqual([]);
  });

  it('is the only copy: no JSON mirror ships beside it', () => {
    expect(() => readJson('../../src/known-binaries.json')).toThrow();
  });

  it('pins the Authenticode publisher of the pinned win32-x64 binary (ruling 9)', () => {
    expect(Object.isFrozen(CLAUDE_CODE_PUBLISHER)).toBe(true);
    expect(CLAUDE_CODE_PUBLISHER.windowsSubject).toBe(
      'CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US, SERIALNUMBER=4860621, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US',
    );
  });

  it('pins the Developer ID Team ID of the darwin binaries (macOS gate, research 10 §5)', () => {
    expect(CLAUDE_CODE_PUBLISHER.darwinTeamId).toBe('Q6L2SF6YDW');
  });

  it('is frozen and well formed', () => {
    expect(Object.isFrozen(KNOWN_BINARIES)).toBe(true);
    for (const [version, platforms] of Object.entries(KNOWN_BINARIES)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Object.isFrozen(platforms)).toBe(true);
      for (const entry of Object.values(platforms)) {
        expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isSafeInteger(entry.size) && entry.size > 0).toBe(true);
      }
    }
  });
});

describe('knownDigestsFor', () => {
  /** A table of two versions, as the window holds several (ADR-0004 §4). */
  const TABLE = {
    '2.1.296': {
      'linux-x64': { sha256: 'a'.repeat(64), size: 10 },
      'win32-x64': { sha256: 'b'.repeat(64), size: 11 },
    },
    '2.1.302': { 'linux-x64': { sha256: 'f'.repeat(64), size: 12 } },
  };

  it('lists the table entries of one platform, every version in table order', () => {
    expect(knownDigestsFor('linux-x64', {}, TABLE)).toEqual([
      { version: '2.1.296', sha256: 'a'.repeat(64), size: 10 },
      { version: '2.1.302', sha256: 'f'.repeat(64), size: 12 },
    ]);
    expect(knownDigestsFor('win32-x64', {}, TABLE)).toEqual([
      { version: '2.1.296', sha256: 'b'.repeat(64), size: 11 },
    ]);
    expect(knownDigestsFor('linux-arm64', {}, TABLE)).toEqual([]);
  });

  it('adds the application digests of that platform, lower-cased and without a size', () => {
    const app = {
      '2.1.297': { 'linux-x64': 'C'.repeat(64), 'win32-x64': 'd'.repeat(64) },
      '2.1.298': { 'darwin-arm64': 'e'.repeat(64) },
    };
    expect(knownDigestsFor('linux-x64', app, TABLE)).toEqual([
      { version: '2.1.296', sha256: 'a'.repeat(64), size: 10 },
      { version: '2.1.302', sha256: 'f'.repeat(64), size: 12 },
      { version: '2.1.297', sha256: 'c'.repeat(64) },
    ]);
    expect(knownDigestsFor('darwin-arm64', app, TABLE)).toEqual([
      { version: '2.1.298', sha256: 'e'.repeat(64) },
    ]);
    expect(knownDigestsFor('linux-arm64', app, {})).toEqual([]);
  });

  it('serves the committed table by default: one entry per version for each platform it holds', () => {
    for (const key of ['linux-x64', 'win32-x64', 'darwin-arm64', 'darwin-x64']) {
      expect(knownDigestsFor(key)).toEqual(
        Object.entries(KNOWN_BINARIES).flatMap(([version, platforms]) => {
          const entry = platforms[key];
          return entry === undefined ? [] : [{ version, sha256: entry.sha256, size: entry.size }];
        }),
      );
      expect(knownDigestsFor(key)).toHaveLength(Object.keys(KNOWN_BINARIES).length);
    }
    expect(knownDigestsFor('linux-arm64')).toEqual([]);
  });
});

describe('platformKey', () => {
  it('joins platform and architecture like the npm platform packages', () => {
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey()).toBe(`${process.platform}-${process.arch}`);
  });
});

describe('the K4 probe', () => {
  it('runs `--version` with a 15 s timeout', () => {
    expect(CLAUDE_VERSION_PROBE_ARGS).toEqual(['--version']);
    expect(Object.isFrozen(CLAUDE_VERSION_PROBE_ARGS)).toBe(true);
    expect(CLAUDE_VERSION_PROBE_TIMEOUT_MS).toBe(15_000);
  });

  it.each([
    ['2.1.296 (Claude Code)\n', '2.1.296'],
    ['2.1.296 (Claude Code)\r\n', '2.1.296'],
    ['2.1.296 (Claude Code)', '2.1.296'],
    ['3.0.0-beta.1 (Claude Code)\n', '3.0.0-beta.1'],
  ])('parses %j', (stdout, version) => {
    expect(parseClaudeVersion(stdout)).toBe(version);
  });

  it.each([
    '',
    '\n',
    '2.1.296\n',
    'v2.1.296 (Claude Code)\n',
    '2.1.296 (Claude Code)\n\n',
    'warning\n2.1.296 (Claude Code)\n',
    '2.1.296 (Claude Code) extra\n',
    ' 2.1.296 (Claude Code)\n',
    '2.1 (Claude Code)\n',
    '1234567890.1.1 (Claude Code)\n',
  ])('rejects %j', (stdout) => {
    expect(parseClaudeVersion(stdout)).toBeUndefined();
  });

  it('never returns anything but a version-shaped string', () => {
    fc.assert(
      fc.property(fc.string(), (stdout) => {
        const version = parseClaudeVersion(stdout);
        return version === undefined || /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
      }),
    );
  });
});
