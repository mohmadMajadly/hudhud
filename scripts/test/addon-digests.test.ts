// The job addon digest tool (plan §6.2): argument parsing, the PE machine
// check, the generated digest table module, and every outcome of
// writeDigests through an in-memory file system (fake addon files, wrong
// arch, missing file, version mismatch, check against the committed table).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WIN32_JOB_DIGESTS } from '../../packages/core/src/process/containment/win32-job-digests.js';
import {
  ADDON_FILE,
  ARCHES,
  DIGESTS_MODULE,
  parseArgs,
  parseDigestsModule,
  peMachine,
  renderDigestsModule,
  renderSha256Sums,
  sha256Hex,
  UsageError,
  writeDigests,
  type Options,
} from '../lib/addon-digests.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = path.resolve('/repo');
const VERSION = '0.1.0';

/** A minimal PE image: `MZ`, `e_lfanew` at 0x3c, `PE\0\0` and the machine type. */
function fakePe(machine: number, tail = 'payload'): Uint8Array {
  const bytes = new Uint8Array(0x100 + tail.length);
  bytes.set([0x4d, 0x5a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(0x3c, 0x80, true);
  view.setUint32(0x80, 0x50450000, false);
  view.setUint16(0x84, machine, true);
  bytes.set(new TextEncoder().encode(tail), 0x100);
  return bytes;
}

const X64 = fakePe(0x8664);
const ARM64 = fakePe(0xaa64);
const X64_SHA = sha256Hex(X64);

interface Fs {
  readonly files: Map<string, Uint8Array | string>;
  readonly out: string[];
  readonly err: string[];
  readonly loaded: string[];
  readonly writes: string[];
}

function io(
  options: {
    files?: Record<string, Uint8Array | string>;
    platform?: string;
    hostArch?: string;
    version?: () => unknown;
  } = {},
) {
  const fs: Fs = {
    files: new Map(
      Object.entries(options.files ?? {}).map(([file, data]) => [path.join(ROOT, file), data]),
    ),
    out: [],
    err: [],
    loaded: [],
    writes: [],
  };
  return {
    fs,
    io: {
      root: ROOT,
      platform: options.platform ?? 'win32',
      hostArch: options.hostArch ?? 'x64',
      readFile: (file: string): Uint8Array => {
        const data = fs.files.get(file);
        if (data === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return typeof data === 'string' ? new TextEncoder().encode(data) : data;
      },
      writeFile: (file: string, data: Uint8Array | string): void => {
        fs.writes.push(path.relative(ROOT, file).replaceAll('\\', '/'));
        fs.files.set(file, data);
      },
      loadVersion: (file: string): unknown => {
        fs.loaded.push(file);
        return (options.version ?? (() => VERSION))();
      },
      log: (line: string): void => {
        fs.out.push(line);
      },
      error: (line: string): void => {
        fs.err.push(line);
      },
    },
  };
}

const BUILD_X64 = `native/win32-job/build/x64/Release/${ADDON_FILE}`;
const BUILD_ARM64 = `native/win32-job/build/arm64/Release/${ADDON_FILE}`;
const COMMITTED = renderDigestsModule({ version: VERSION, x64: X64_SHA });

function opts(overrides: Partial<Options> = {}): Options {
  return { arch: 'x64', addon: undefined, version: undefined, check: false, ...overrides };
}

function file(fs: Fs, name: string): Uint8Array | string | undefined {
  return fs.files.get(path.join(ROOT, name));
}

describe('parseArgs', () => {
  it('reads every option', () => {
    expect(parseArgs(['--arch', 'x64'])).toEqual(opts());
    expect(
      parseArgs(['--check', '--arch', 'arm64', '--addon', 'a.node', '--version', '1.2.3']),
    ).toEqual({ arch: 'arm64', addon: 'a.node', version: '1.2.3', check: true });
  });

  it('refuses bad usage', () => {
    const cases: [string[], RegExp][] = [
      [[], /^usage: /],
      [['--arch', 'ia32'], /^usage: /],
      [['--arch'], /missing value for --arch/],
      [['--arch', ''], /missing value for --arch/],
      [['--arch', 'x64', '--arch', 'x64'], /--arch given twice/],
      [['--arch', 'x64', '--check', '--check'], /--check given twice/],
      [['--arch', 'x64', '--force'], /unknown argument "--force"/],
    ];
    for (const [argv, message] of cases) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
      expect(() => parseArgs(argv)).toThrow(message);
    }
  });
});

describe('peMachine', () => {
  it('reads the machine type of a PE image', () => {
    expect(peMachine(X64)).toBe(0x8664);
    expect(peMachine(ARM64)).toBe(0xaa64);
    // A view into a larger buffer is read at its own offset.
    const padded = new Uint8Array(X64.length + 3);
    padded.set(X64, 3);
    expect(peMachine(padded.subarray(3))).toBe(0x8664);
  });

  it('refuses anything that is not a PE image', () => {
    expect(peMachine(new Uint8Array(0x3f).fill(0x4d))).toBeNull();
    const notMz = X64.slice();
    notMz[1] = 0;
    expect(peMachine(notMz)).toBeNull();
    const notMz0 = X64.slice();
    notMz0[0] = 0;
    expect(peMachine(notMz0)).toBeNull();
    const outside = X64.slice();
    new DataView(outside.buffer).setUint32(0x3c, outside.length - 5, true);
    expect(peMachine(outside)).toBeNull();
    const noSignature = X64.slice();
    noSignature[0x81] = 0x46;
    expect(peMachine(noSignature)).toBeNull();
  });
});

describe('the generated digest table module', () => {
  it('is what the core ships, byte for byte', () => {
    const committed = readFileSync(path.join(REPO, DIGESTS_MODULE), 'utf8');
    const table = parseDigestsModule(committed);
    expect(table).toEqual(WIN32_JOB_DIGESTS);
    expect(table).not.toBeNull();
    if (table !== null) expect(renderDigestsModule(table)).toBe(committed);
  });

  it('round-trips and refuses anything but its own output', () => {
    expect(parseDigestsModule(COMMITTED)).toEqual({ version: VERSION, x64: X64_SHA });
    expect(parseDigestsModule(`${COMMITTED}// edited\n`)).toBeNull();
    expect(parseDigestsModule(COMMITTED.replace(/^ {2}x64: .*$/mu, ''))).toBeNull();
    expect(parseDigestsModule(COMMITTED.replace(/^ {2}version: .*$/mu, ''))).toBeNull();
    expect(parseDigestsModule(COMMITTED.replace(X64_SHA, X64_SHA.toUpperCase()))).toBeNull();
    expect(parseDigestsModule('export const WIN32_JOB_DIGESTS = Object.freeze({});\n')).toBeNull();
  });

  it('refuses values that are not a version or a sha256', () => {
    expect(() => renderDigestsModule({ version: "1.0.0' + x", x64: X64_SHA })).toThrow(
      'invalid addon version',
    );
    expect(() => renderDigestsModule({ version: VERSION, x64: 'f'.repeat(63) })).toThrow(
      'invalid x64 sha256',
    );
  });

  it('writes SHA256SUMS in sha256sum format', () => {
    expect(renderSha256Sums(X64_SHA)).toBe(`${X64_SHA}  hudhud_win32_job.node\n`);
  });

  it('lists x64 in the table and arm64 outside it (K17)', () => {
    expect(ARCHES['x64']).toEqual({
      machine: 0x8664,
      packageDir: 'packages/win32-job-x64',
      inTable: true,
    });
    expect(ARCHES['arm64']).toEqual({
      machine: 0xaa64,
      packageDir: 'packages/win32-job-arm64',
      inTable: false,
    });
  });
});

describe('writeDigests', () => {
  it('writes the table from a build, loads the version on Windows x64 and stages the bytes', () => {
    const { fs, io: deps } = io({ files: { [BUILD_X64]: X64 } });
    expect(writeDigests(opts(), deps)).toBe(0);
    expect(fs.loaded).toEqual([path.join(ROOT, BUILD_X64)]);
    expect(file(fs, DIGESTS_MODULE)).toBe(COMMITTED);
    expect(file(fs, `packages/win32-job-x64/${ADDON_FILE}`)).toBe(X64);
    expect(file(fs, 'packages/win32-job-x64/SHA256SUMS')).toBe(renderSha256Sums(X64_SHA));
    expect(fs.err).toEqual([]);
    expect(fs.out).toEqual([
      `wrote ${DIGESTS_MODULE} (x64 ${X64_SHA}, version ${VERSION})`,
      `staged x64 ${ADDON_FILE} (sha256 ${X64_SHA}, version ${VERSION}) in packages/win32-job-x64`,
    ]);
  });

  it('leaves an equal table untouched and replaces a different one', () => {
    const same = io({ files: { [BUILD_X64]: X64, [DIGESTS_MODULE]: COMMITTED } });
    expect(writeDigests(opts(), same.io)).toBe(0);
    expect(same.fs.writes).not.toContain(DIGESTS_MODULE);

    const older = renderDigestsModule({ version: VERSION, x64: '0'.repeat(64) });
    const other = io({ files: { [BUILD_X64]: X64, [DIGESTS_MODULE]: older } });
    expect(writeDigests(opts(), other.io)).toBe(0);
    expect(file(other.fs, DIGESTS_MODULE)).toBe(COMMITTED);

    const otherVersion = renderDigestsModule({ version: '0.0.9', x64: X64_SHA });
    const bumped = io({ files: { [BUILD_X64]: X64, [DIGESTS_MODULE]: otherVersion } });
    expect(writeDigests(opts(), bumped.io)).toBe(0);
    expect(file(bumped.fs, DIGESTS_MODULE)).toBe(COMMITTED);
  });

  it('takes a CI artifact path and the version off Windows', () => {
    const { fs, io: deps } = io({
      files: { 'artifacts/x64.node': X64 },
      platform: 'linux',
      hostArch: 'x64',
    });
    expect(writeDigests(opts({ addon: 'artifacts/x64.node', version: VERSION }), deps)).toBe(0);
    expect(fs.loaded).toEqual([]);
    expect(file(fs, DIGESTS_MODULE)).toBe(COMMITTED);
  });

  it('refuses a missing file, naming the build command', () => {
    const { fs, io: deps } = io();
    expect(writeDigests(opts(), deps)).toBe(1);
    expect(fs.err).toEqual([
      `write-digests: cannot read ${path.join(ROOT, BUILD_X64)} (ENOENT); build it first: node native/win32-job/build.mjs --arch x64`,
    ]);
    expect(fs.writes).toEqual([]);

    const odd = io();
    odd.io.readFile = () => {
      throw new Error('odd');
    };
    expect(writeDigests(opts(), odd.io)).toBe(1);
    expect(odd.fs.err[0]).toMatch(/\(Error: odd\)/u);
  });

  it('refuses a file that is not a PE image', () => {
    const { fs, io: deps } = io({ files: { [BUILD_X64]: 'not an addon' } });
    expect(writeDigests(opts(), deps)).toBe(1);
    expect(fs.err).toEqual([`write-digests: ${path.join(ROOT, BUILD_X64)} is not a PE image`]);
    expect(fs.writes).toEqual([]);
  });

  it('refuses a build of the wrong architecture', () => {
    const { fs, io: deps } = io({ files: { [BUILD_X64]: ARM64 } });
    expect(writeDigests(opts(), deps)).toBe(1);
    expect(fs.err).toEqual([
      `write-digests: ${path.join(ROOT, BUILD_X64)} is built for machine 0xaa64, not x64 (0x8664)`,
    ]);
    expect(fs.loaded).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  it('refuses a version that differs from --version, or that cannot be read', () => {
    const differs = io({ files: { [BUILD_X64]: X64 } });
    expect(writeDigests(opts({ version: '0.2.0' }), differs.io)).toBe(1);
    expect(differs.fs.err).toEqual([
      'write-digests: the addon reports version "0.1.0", --version says "0.2.0"',
    ]);
    expect(differs.fs.writes).toEqual([]);

    const matches = io({ files: { [BUILD_X64]: X64 } });
    expect(writeDigests(opts({ version: VERSION }), matches.io)).toBe(0);

    const unloadable = io({
      files: { [BUILD_X64]: X64 },
      version: () => {
        throw new Error('dlopen failed');
      },
    });
    expect(writeDigests(opts(), unloadable.io)).toBe(1);
    expect(unloadable.fs.err[0]).toMatch(/cannot load .*: Error: dlopen failed$/u);

    for (const bad of [undefined, 1, '', 'v0.1.0', '0.1', '01.0.0']) {
      const wrong = io({ files: { [BUILD_X64]: X64 }, version: () => bad });
      expect(writeDigests(opts(), wrong.io)).toBe(1);
      expect(wrong.fs.err).toEqual([
        `write-digests: the addon version ${JSON.stringify(bad)} is not a semver version`,
      ]);
      expect(wrong.fs.writes).toEqual([]);
    }
  });

  it('needs --version when the addon cannot be loaded on this host', () => {
    for (const [platform, hostArch] of [
      ['linux', 'x64'],
      ['win32', 'arm64'],
    ] as const) {
      const { fs, io: deps } = io({ files: { [BUILD_X64]: X64 }, platform, hostArch });
      expect(writeDigests(opts(), deps)).toBe(1);
      expect(fs.err).toEqual([
        `write-digests: the x64 addon cannot be loaded on ${platform}-${hostArch}: give its version with --version`,
      ]);
    }
  });

  it('--check verifies the build against the committed table and writes only the package', () => {
    const { fs, io: deps } = io({ files: { [BUILD_X64]: X64, [DIGESTS_MODULE]: COMMITTED } });
    expect(writeDigests(opts({ check: true }), deps)).toBe(0);
    expect(fs.writes).toEqual([
      `packages/win32-job-x64/${ADDON_FILE}`,
      'packages/win32-job-x64/SHA256SUMS',
    ]);
  });

  it('--check refuses a build the committed table does not hold', () => {
    const cases: [string | undefined, string][] = [
      [undefined, `${DIGESTS_MODULE} is not a generated digest table`],
      [
        'export const WIN32_JOB_DIGESTS = Object.freeze({});\n',
        `${DIGESTS_MODULE} is not a generated digest table`,
      ],
      [
        renderDigestsModule({ version: VERSION, x64: '0'.repeat(64) }),
        `the build differs from the committed digest table: built ${X64_SHA}, committed ${'0'.repeat(64)}`,
      ],
      [
        renderDigestsModule({ version: '0.2.0', x64: X64_SHA }),
        "the addon version 0.1.0 differs from the table's 0.2.0",
      ],
    ];
    for (const [committed, message] of cases) {
      const files: Record<string, Uint8Array | string> = { [BUILD_X64]: X64 };
      if (committed !== undefined) files[DIGESTS_MODULE] = committed;
      const { fs, io: deps } = io({ files });
      expect(writeDigests(opts({ check: true }), deps)).toBe(1);
      expect(fs.err).toEqual([`write-digests: ${message}`]);
      expect(fs.writes).toEqual([]);
    }
  });

  it('stages arm64 without touching the table, checking only its version (K17)', () => {
    const { fs, io: deps } = io({
      files: { [BUILD_ARM64]: ARM64, [DIGESTS_MODULE]: COMMITTED },
    });
    expect(writeDigests(opts({ arch: 'arm64', version: VERSION }), deps)).toBe(0);
    expect(fs.loaded).toEqual([]);
    expect(fs.writes).toEqual([
      `packages/win32-job-arm64/${ADDON_FILE}`,
      'packages/win32-job-arm64/SHA256SUMS',
    ]);
    expect(file(fs, 'packages/win32-job-arm64/SHA256SUMS')).toBe(
      renderSha256Sums(sha256Hex(ARM64)),
    );

    const otherVersion = io({ files: { [BUILD_ARM64]: ARM64, [DIGESTS_MODULE]: COMMITTED } });
    expect(writeDigests(opts({ arch: 'arm64', version: '0.2.0' }), otherVersion.io)).toBe(1);
    expect(otherVersion.fs.err).toEqual([
      "write-digests: the addon version 0.2.0 differs from the table's 0.1.0",
    ]);
  });

  it('refuses an unknown architecture', () => {
    const { io: deps } = io();
    expect(() => writeDigests(opts({ arch: 'ia32' }), deps)).toThrow(UsageError);
  });
});

describe('the command line', () => {
  it('exits 2 on a usage error and writes nothing', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'addon', 'write-digests.mjs'), '--arch', 'ia32'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^write-digests: usage: write-digests\.mjs --arch x64\|arm64/u);
  });
});
