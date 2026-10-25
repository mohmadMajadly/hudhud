// The job addon's release record tooling (plan §6.3; scripts/addon/manifest.mjs):
// the toolset-of-record components, collecting a build into an artifact,
// the toolchain gate of the record check, the phase 2 reproduction check,
// writing a release record in the committed format, and the lead's local
// comparison with a CI manifest. All through an in-memory file system on
// every OS; every refusal must name its cause and, for a mismatch, both
// values.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ADDON_FILE,
  DIGESTS_MODULE,
  parseManifest,
  renderDigestsModule,
  renderReleaseSums,
  renderReleaseToolchains,
  renderSha256Sums,
  renderToolchain,
  sha256Hex,
  UsageError,
  type Manifest,
  type ReleaseArch,
} from '../lib/addon-digests.mjs';
import {
  parseArgs,
  RELEASE_ARCHES,
  renderManifest,
  runManifest,
  toolsetOfRecord,
  USAGE,
  VERSION_FILE,
  type Options,
} from '../lib/addon-manifest.mjs';
import type { Identity } from '../lib/addon-identity.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = path.resolve('/repo');
const VERSION = '0.1.0';
const RECORD = 'native/win32-job/release/0.1.0/manifest.json';

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
const ARM64_SHA = sha256Hex(ARM64);

function toolchainOf(arch: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    arch,
    generator: 'Visual Studio 18 2026',
    vcToolsVersion: '14.44.35207',
    clVersion: '19.44.35229',
    windowsSdkVersion: '10.0.26100.0',
    cmakeVersion: '4.4.4',
    nodeApiHeadersVersion: '1.9.0',
    ...overrides,
  };
}

const X64_ENTRY: ReleaseArch = { sha256: X64_SHA, size: X64.length, toolchain: toolchainOf('x64') };
const ARM64_ENTRY: ReleaseArch = {
  sha256: ARM64_SHA,
  size: ARM64.length,
  toolchain: toolchainOf('arm64'),
};

function manifestOf(overrides: Partial<Manifest> = {}): Manifest {
  return {
    release: '0.1.0',
    version: VERSION,
    arches: { arm64: ARM64_ENTRY, x64: X64_ENTRY },
    ...overrides,
  };
}

/** The committed record and the table written from it. */
function recordFiles(manifest: Manifest = manifestOf(), at = RECORD): Record<string, string> {
  return {
    [at]: renderManifest(manifest),
    [DIGESTS_MODULE]: renderDigestsModule({
      version: manifest.version,
      x64: String(manifest.arches['x64']?.sha256),
      manifest: at,
    }),
  };
}

/** An artifact directory as `collect` writes it. */
function artifact(
  dir: string,
  bytes: Uint8Array,
  arch: string,
  options: { version?: string; toolchain?: Record<string, string>; identity?: Identity } = {},
): Record<string, Uint8Array | string> {
  return {
    [`${dir}/${ADDON_FILE}`]: bytes,
    [`${dir}/toolchain.json`]: renderToolchain(
      options.toolchain ?? toolchainOf(arch),
      options.identity,
    ),
    [`${dir}/SHA256SUMS`]: renderSha256Sums(sha256Hex(bytes)),
    ...(options.version === undefined
      ? {}
      : { [`${dir}/${VERSION_FILE}`]: `${options.version}\n` }),
  };
}

/** A local build tree as `native/win32-job/build.mjs` leaves it. */
function buildTree(
  arch: string,
  bytes: Uint8Array,
  toolchain = toolchainOf(arch),
  identity?: Identity,
): Record<string, Uint8Array | string> {
  return {
    [`native/win32-job/build/${arch}/Release/${ADDON_FILE}`]: bytes,
    [`native/win32-job/build/${arch}/toolchain.json`]: renderToolchain(toolchain, identity),
  };
}

/** A file that exists but cannot be read. */
const UNREADABLE = Symbol('unreadable');

interface Fs {
  readonly files: Map<string, Uint8Array | string | typeof UNREADABLE>;
  readonly out: string[];
  readonly err: string[];
  readonly dirs: string[];
  readonly loaded: string[];
}

function io(
  options: {
    files?: Record<string, Uint8Array | string | typeof UNREADABLE>;
    platform?: string;
    hostArch?: string;
    version?: () => unknown;
  } = {},
) {
  const fs: Fs = {
    files: new Map(
      Object.entries(options.files ?? {}).map(([file, data]) => [path.resolve(ROOT, file), data]),
    ),
    out: [],
    err: [],
    dirs: [],
    loaded: [],
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
        if (data === UNREADABLE) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return typeof data === 'string' ? new TextEncoder().encode(data) : data;
      },
      writeFile: (file: string, data: Uint8Array | string): void => {
        fs.files.set(file, data);
      },
      makeDir: (dir: string): void => {
        fs.dirs.push(dir);
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

function text(fs: Fs, file: string): string | undefined {
  const data = fs.files.get(path.resolve(ROOT, file));
  if (data === undefined || data === UNREADABLE) return undefined;
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

/** Runs a command; returns the exit code and the joined output. */
function run(options: Options, setup: Parameters<typeof io>[0] = {}) {
  const { fs, io: deps } = io(setup);
  const code = runManifest(options, deps);
  return { code, fs, out: fs.out.join('\n'), err: fs.err.join('\n') };
}

describe('toolsetOfRecord', () => {
  it('names the side-by-side MSVC toolset, its Spectre libraries and the SDK', () => {
    expect(toolsetOfRecord(toolchainOf('x64'))).toEqual({
      platformToolset: 'v143',
      tools: 'Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64',
      spectre: 'Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre',
      sdk: 'Microsoft.VisualStudio.Component.Windows11SDK.26100',
      sdkBuild: '26100',
    });
    expect(
      toolsetOfRecord(
        toolchainOf('arm64', { vcToolsVersion: '14.38.33130', windowsSdkVersion: '10.0.20348.0' }),
      ),
    ).toEqual({
      platformToolset: 'v143',
      tools: 'Microsoft.VisualStudio.Component.VC.14.38.17.8.ARM64',
      spectre: 'Microsoft.VisualStudio.Component.VC.14.38.17.8.ARM64.Spectre',
      sdk: 'Microsoft.VisualStudio.Component.Windows10SDK.20348',
      sdkBuild: '20348',
    });
  });

  it('refuses what it cannot name', () => {
    expect(toolsetOfRecord(toolchainOf('ia32'))).toBe('unknown arch ia32');
    expect(toolsetOfRecord(toolchainOf('x64', { vcToolsVersion: '14.51.36231' }))).toBe(
      'no platform toolset is known for MSVC 14.51.36231',
    );
    expect(toolsetOfRecord(toolchainOf('x64', { windowsSdkVersion: '8.1' }))).toBe(
      'Windows SDK 8.1 is not a 10.0.<build>.<revision> version',
    );
  });
});

describe('renderManifest', () => {
  it('renders the committed record byte for byte', () => {
    const committed = readFileSync(
      path.join(REPO, 'native/win32-job/release/0.0.0-dev/manifest.json'),
      'utf8',
    );
    const parsed = parseManifest(committed);
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(renderManifest(parsed)).toBe(committed);
  });

  it('sorts the arches and orders the toolchain fields', () => {
    const shuffled = manifestOf();
    const reordered: Manifest = {
      ...shuffled,
      arches: {
        x64: {
          ...X64_ENTRY,
          toolchain: Object.fromEntries(Object.entries(toolchainOf('x64')).reverse()),
        },
        arm64: ARM64_ENTRY,
      },
    };
    expect(renderManifest(reordered)).toBe(renderManifest(shuffled));
    const rendered = JSON.parse(renderManifest(reordered)) as { arches: object };
    expect(Object.keys(rendered.arches)).toEqual(['arm64', 'x64']);
  });
});

describe('parseArgs', () => {
  it('reads every command', () => {
    expect(parseArgs(['components', '--arch', 'arm64'])).toEqual({
      command: 'components',
      arch: 'arm64',
    });
    expect(parseArgs(['collect', '--out', 'o', '--arch', 'x64'])).toEqual({
      command: 'collect',
      arch: 'x64',
      out: 'o',
    });
    expect(parseArgs(['check-toolchain', '--toolchain', 't.json'])).toEqual({
      command: 'check-toolchain',
      toolchain: 't.json',
    });
    expect(parseArgs(['verify', '--dir', 'd', '--record', RECORD])).toEqual({
      command: 'verify',
      dir: 'd',
      record: RECORD,
    });
    expect(parseArgs(['verify', '--dir', 'd'])).toEqual({
      command: 'verify',
      dir: 'd',
      record: undefined,
    });
    expect(parseArgs(['write', '--release', '0.1.0', '--dir', 'd', '--out', 'o'])).toEqual({
      command: 'write',
      release: '0.1.0',
      dir: 'd',
      out: 'o',
    });
    expect(parseArgs(['compare', '--manifest', 'm.json'])).toEqual({
      command: 'compare',
      manifest: 'm.json',
    });
  });

  it('refuses bad usage', () => {
    const cases: [string[], RegExp][] = [
      [[], /^usage: manifest\.mjs components/u],
      [['publish'], /^usage: /u],
      [['toString'], /^usage: /u],
      [['__proto__'], /^usage: /u],
      [['components', '--out', 'o'], /^components takes no "--out"\nusage: /u],
      [['components', '--arch'], /^missing value for --arch$/u],
      [['components', '--arch', ''], /^missing value for --arch$/u],
      [['components', '--arch', 'x64', '--arch', 'x64'], /^--arch given twice$/u],
      [['collect', '--arch', 'x64'], /^collect needs --out\nusage: /u],
      [['components', '--arch', 'ia32'], /^unknown arch "ia32"\nusage: /u],
    ];
    for (const [argv, message] of cases) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
      expect(() => parseArgs(argv)).toThrow(message);
    }
    expect(USAGE.split('\n')).toHaveLength(6);
  });
});

describe('components', () => {
  it('prints the component ids of the toolset of record, one per line', () => {
    const result = run({ command: 'components', arch: 'arm64' }, { files: recordFiles() });
    expect(result.code).toBe(0);
    expect(result.fs.out).toEqual([
      'Microsoft.VisualStudio.Component.VC.14.44.17.14.ARM64',
      'Microsoft.VisualStudio.Component.VC.14.44.17.14.ARM64.Spectre',
      'Microsoft.VisualStudio.Component.Windows11SDK.26100',
    ]);
  });

  it('names the committed record: the real table names one with both arches', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'addon', 'manifest.mjs'), 'components', '--arch', 'x64'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      'Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64',
      'Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre',
      'Microsoft.VisualStudio.Component.Windows11SDK.26100',
    ]);
  });

  it('refuses a record it cannot read or use', () => {
    const noArm64 = manifestOf({
      arches: { x64: X64_ENTRY },
    });
    const newer = manifestOf({
      arches: {
        x64: {
          ...X64_ENTRY,
          toolchain: toolchainOf('x64', { vcToolsVersion: '14.51.36231' }),
        },
      },
    });
    const cases: [Record<string, string>, string][] = [
      [{}, `manifest: cannot read ${DIGESTS_MODULE} (ENOENT)`],
      [
        { [DIGESTS_MODULE]: 'export {};\n' },
        `manifest: ${DIGESTS_MODULE} is not a generated digest table`,
      ],
      [
        {
          [DIGESTS_MODULE]: renderDigestsModule({
            version: VERSION,
            x64: X64_SHA,
            manifest: RECORD,
          }),
        },
        `manifest: cannot read ${RECORD} (ENOENT)`,
      ],
      [
        { ...recordFiles(), [RECORD]: '{}' },
        `manifest: ${RECORD}: fields  are not arches, release, version`,
      ],
      [recordFiles(noArm64), `manifest: ${RECORD} records no arm64 build`],
      [recordFiles(newer), `manifest: ${RECORD} records no arm64 build`],
    ];
    for (const [files, message] of cases) {
      const result = run({ command: 'components', arch: 'arm64' }, { files });
      expect(result.code).toBe(1);
      expect(result.err).toBe(message);
      expect(result.out).toBe('');
    }
    const result = run({ command: 'components', arch: 'x64' }, { files: recordFiles(newer) });
    expect(result.err).toBe(
      `manifest: ${RECORD}: no platform toolset is known for MSVC 14.51.36231`,
    );
  });
});

describe('collect', () => {
  const out = 'D:/a/_temp/addon/x64';

  it('copies a build into an artifact with its SHA256SUMS and the version it reports', () => {
    const result = run({ command: 'collect', arch: 'x64', out }, { files: buildTree('x64', X64) });
    expect(result.code).toBe(0);
    expect(result.fs.dirs).toEqual([path.resolve(ROOT, out)]);
    expect(result.fs.files.get(path.resolve(ROOT, out, ADDON_FILE))).toEqual(X64);
    expect(text(result.fs, `${out}/SHA256SUMS`)).toBe(renderSha256Sums(X64_SHA));
    expect(text(result.fs, `${out}/toolchain.json`)).toBe(renderToolchain(toolchainOf('x64')));
    expect(text(result.fs, `${out}/${VERSION_FILE}`)).toBe(`${VERSION}\n`);
    expect(result.fs.loaded).toEqual([
      path.resolve(ROOT, `native/win32-job/build/x64/Release/${ADDON_FILE}`),
    ]);
    expect(result.fs.out[0]).toBe(
      `collected x64 ${ADDON_FILE}: sha256 ${X64_SHA}, size ${String(X64.length)}, version ${VERSION}`,
    );
  });

  it('records no version for an arch the host cannot load', () => {
    const arm = 'D:/a/_temp/addon/arm64';
    const result = run(
      { command: 'collect', arch: 'arm64', out: arm },
      { files: buildTree('arm64', ARM64) },
    );
    expect(result.code).toBe(0);
    expect(result.fs.loaded).toEqual([]);
    expect(text(result.fs, `${arm}/${VERSION_FILE}`)).toBeUndefined();
    expect(text(result.fs, `${arm}/SHA256SUMS`)).toBe(renderSha256Sums(ARM64_SHA));
    expect(result.fs.out[0]).toContain('version (not loadable on this host)');
    const linux = run(
      { command: 'collect', arch: 'x64', out },
      { files: buildTree('x64', X64), platform: 'linux' },
    );
    expect(linux.code).toBe(0);
    expect(linux.fs.loaded).toEqual([]);
  });

  it('refuses a build that is not what it claims, and writes nothing', () => {
    const tree = 'native/win32-job/build/x64';
    const addon = `${tree}/Release/${ADDON_FILE}`;
    const cases: [Record<string, Uint8Array | string>, string][] = [
      [{}, `cannot read ${addon} (ENOENT)`],
      [{ [addon]: X64 }, `cannot read ${tree}/toolchain.json (ENOENT)`],
      [
        { ...buildTree('x64', X64), [`${tree}/toolchain.json`]: '{' },
        `${tree}/toolchain.json: not an object`,
      ],
      [
        { ...buildTree('x64', X64), [`${tree}/toolchain.json`]: '{"arch":"x64"}' },
        `${tree}/toolchain.json: fields arch are not`,
      ],
      [
        buildTree('x64', X64, toolchainOf('arm64')),
        `${tree}/toolchain.json describes a arm64 build, not x64`,
      ],
      [buildTree('x64', new Uint8Array(8)), `${addon} is not a PE image, not x64 (0x8664)`],
      [buildTree('x64', ARM64), `${addon} is built for machine 0xaa64, not x64 (0x8664)`],
    ];
    for (const [files, message] of cases) {
      const result = run({ command: 'collect', arch: 'x64', out }, { files });
      expect(result.code).toBe(1);
      expect(result.err.replaceAll('\\', '/')).toContain(`manifest: ${message}`);
      expect(result.fs.dirs).toEqual([]);
    }
  });

  it('refuses an addon that does not load or reports no version', () => {
    const throws = run(
      { command: 'collect', arch: 'x64', out },
      {
        files: buildTree('x64', X64),
        version: () => {
          throw new Error('dlopen failed');
        },
      },
    );
    expect(throws.code).toBe(1);
    expect(throws.err).toMatch(/^manifest: cannot load .*: Error: dlopen failed$/u);
    const bad = run(
      { command: 'collect', arch: 'x64', out },
      { files: buildTree('x64', X64), version: () => 7 },
    );
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/reports version 7, not a semver version$/u);
    expect(bad.fs.dirs).toEqual([]);
  });
});

describe('check-toolchain (the record check must run)', () => {
  const file = 'D:/a/_temp/addon/x64/toolchain.json';

  it('passes the toolchain of record', () => {
    const result = run(
      { command: 'check-toolchain', toolchain: file },
      { files: { ...recordFiles(), [file]: renderToolchain(toolchainOf('x64')) } },
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${file} is the toolchain of record (${RECORD})`);
  });

  it('names every differing field with both values', () => {
    const result = run(
      { command: 'check-toolchain', toolchain: file },
      {
        files: {
          ...recordFiles(),
          [file]: renderToolchain(
            toolchainOf('x64', { generator: 'Visual Studio 17 2022', clVersion: '19.44.35230' }),
          ),
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `manifest: ${file} is not the toolchain of record (${RECORD}), so the record check would be skipped; differing fields: clVersion 19.44.35230 (record 19.44.35229)`,
    );
    expect(result.out).toBe(
      'toolchain differs from the record: generator Visual Studio 17 2022 (record Visual Studio 18 2026), information only: it does not change the bytes',
    );
  });

  it('passes a different generator, reporting it as information (run 38947897592)', () => {
    const result = run(
      { command: 'check-toolchain', toolchain: file },
      {
        files: {
          ...recordFiles(),
          [file]: renderToolchain(toolchainOf('x64', { generator: 'Visual Studio 17 2022' })),
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.fs.out).toEqual([
      'toolchain differs from the record: generator Visual Studio 17 2022 (record Visual Studio 18 2026), information only: it does not change the bytes',
      `${file} is the toolchain of record (${RECORD})`,
    ]);
    expect(result.err).toBe('');
  });

  it('refuses what it cannot compare', () => {
    const noArm64 = manifestOf({
      arches: { x64: X64_ENTRY },
    });
    const cases: [Record<string, string>, string][] = [
      [{ [file]: renderToolchain(toolchainOf('x64')) }, `cannot read ${DIGESTS_MODULE} (ENOENT)`],
      [recordFiles(), `cannot read ${file} (ENOENT)`],
      [{ ...recordFiles(), [file]: 'nope' }, `${file}: not an object`],
      [
        { ...recordFiles(noArm64), [file]: renderToolchain(toolchainOf('arm64')) },
        `${RECORD} records no arm64 build`,
      ],
    ];
    for (const [files, message] of cases) {
      const result = run({ command: 'check-toolchain', toolchain: file }, { files });
      expect(result.code).toBe(1);
      expect(result.err).toBe(`manifest: ${message}`);
    }
  });
});

describe('verify (release phase 2: the rebuild reproduces the committed record)', () => {
  const dir = 'D:/a/_temp/addon/x64';

  it('passes a rebuild equal to the record, noting a different generator', () => {
    const result = run(
      { command: 'verify', dir, record: RECORD },
      {
        files: {
          ...recordFiles(),
          ...artifact(dir, X64, 'x64', {
            version: VERSION,
            toolchain: toolchainOf('x64', { generator: 'Visual Studio 17 2022' }),
          }),
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.fs.out).toEqual([
      'x64: toolchain differs from the record: generator Visual Studio 17 2022 (record Visual Studio 18 2026), information only: it does not change the bytes',
      `x64: reproduces ${RECORD} (sha256 ${X64_SHA}, size ${String(X64.length)}, version ${VERSION})`,
    ]);
  });

  it('refuses equal bytes from a different toolchain of record', () => {
    const result = run(
      { command: 'verify', dir, record: RECORD },
      {
        files: {
          ...recordFiles(),
          ...artifact(dir, X64, 'x64', {
            toolchain: toolchainOf('x64', { clVersion: '19.44.35230' }),
          }),
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `manifest: x64: the rebuild was not built with the toolchain of record (${RECORD}); differing fields: clVersion 19.44.35230 (record 19.44.35229)`,
    );
  });

  it('accepts a backslash path and an artifact without a version (arm64)', () => {
    const arm = 'D:/a/_temp/addon/arm64';
    const result = run(
      { command: 'verify', dir: arm, record: RECORD.replaceAll('/', '\\') },
      { files: { ...recordFiles(), ...artifact(arm, ARM64, 'arm64') } },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('arm64: reproduces');
  });

  it('without --record, checks against the record the table names (release phase 1)', () => {
    const result = run(
      { command: 'verify', dir, record: undefined },
      { files: { ...recordFiles(), ...artifact(dir, X64, 'x64', { version: VERSION }) } },
    );
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      `x64: reproduces ${RECORD} (sha256 ${X64_SHA}, size ${String(X64.length)}, version ${VERSION})`,
    );
    const noTable = run(
      { command: 'verify', dir, record: undefined },
      { files: artifact(dir, X64, 'x64') },
    );
    expect(noTable.code).toBe(1);
    expect(noTable.err).toBe(`manifest: cannot read ${DIGESTS_MODULE} (ENOENT)`);
  });

  it('names both values when the rebuild differs', () => {
    const other = fakePe(0x8664, 'other bytes');
    const result = run(
      { command: 'verify', dir, record: RECORD },
      { files: { ...recordFiles(), ...artifact(dir, other, 'x64', { version: '0.2.0' }) } },
    );
    expect(result.code).toBe(1);
    expect(result.fs.err).toEqual([
      `manifest: x64: the rebuild does not reproduce ${RECORD}: sha256 ${sha256Hex(other)} (record ${X64_SHA}), size ${String(other.length)} (record ${String(X64.length)})`,
      'manifest: x64: inputs: the record names no input identity',
      `manifest: x64: the rebuild reports version 0.2.0 (record ${VERSION})`,
    ]);
    const versionOnly = run(
      { command: 'verify', dir, record: RECORD },
      { files: { ...recordFiles(), ...artifact(dir, X64, 'x64', { version: '0.2.0' }) } },
    );
    expect(versionOnly.fs.err).toEqual([
      `manifest: x64: the rebuild reports version 0.2.0 (record ${VERSION})`,
    ]);
  });

  it('requires the table to be written from the tag record', () => {
    const older = 'native/win32-job/release/0.0.9/manifest.json';
    const result = run(
      { command: 'verify', dir, record: RECORD },
      {
        files: {
          ...recordFiles(manifestOf({ release: '0.0.9' }), older),
          [RECORD]: renderManifest(manifestOf()),
          ...artifact(dir, X64, 'x64'),
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `manifest: ${DIGESTS_MODULE} is written from ${older}, not ${RECORD}; regenerate it: node scripts/addon/write-digests.mjs --from-manifest ${RECORD}`,
    );
  });

  it('refuses a missing or inconsistent record or artifact', () => {
    const sums = `${dir}/SHA256SUMS`;
    const version = `${dir}/${VERSION_FILE}`;
    const noArm64 = manifestOf({
      arches: { x64: X64_ENTRY },
    });
    const good = { ...recordFiles(), ...artifact(dir, X64, 'x64') };
    const cases: [Options, Record<string, Uint8Array | string | typeof UNREADABLE>, string][] = [
      [
        { command: 'verify', dir, record: 'release/0.1.0/manifest.json' },
        good,
        'release/0.1.0/manifest.json is not native/win32-job/release/<release>/manifest.json',
      ],
      [
        { command: 'verify', dir, record: RECORD },
        {},
        `cannot read ${RECORD} (ENOENT); commit the release record before tagging`,
      ],
      [
        { command: 'verify', dir, record: RECORD },
        { ...good, [RECORD]: renderManifest(manifestOf({ release: '0.1.1' })) },
        `${RECORD}: release 0.1.1 is not its directory 0.1.0`,
      ],
      [
        { command: 'verify', dir, record: RECORD },
        { ...good, [DIGESTS_MODULE]: 'export {};\n' },
        `${DIGESTS_MODULE} is not a generated digest table`,
      ],
      [
        { command: 'verify', dir, record: RECORD },
        { ...good, [sums]: UNREADABLE },
        `cannot read ${sums} (EACCES)`,
      ],
      [
        { command: 'verify', dir, record: RECORD },
        { ...good, [sums]: 'garbage\n' },
        `${sums} is not a SHA256SUMS of ${ADDON_FILE}`,
      ],
      [
        { command: 'verify', dir, record: RECORD },
        { ...good, [sums]: renderSha256Sums(ARM64_SHA) },
        `${sums} names ${ARM64_SHA}, ${dir}/${ADDON_FILE} is ${X64_SHA}`,
      ],
      [
        { command: 'verify', dir, record: RECORD },
        { ...good, [version]: UNREADABLE },
        `cannot read ${version} (EACCES)`,
      ],
      [
        { command: 'verify', dir, record: RECORD },
        { ...good, [version]: '0.1.0' },
        `${version} holds no addon version`,
      ],
      [
        { command: 'verify', dir, record: RECORD },
        { ...good, [`${dir}/toolchain.json`]: renderToolchain(toolchainOf('ia32')) },
        `${dir}/toolchain.json: unknown arch ia32`,
      ],
      [
        { command: 'verify', dir, record: RECORD },
        { ...recordFiles(noArm64), ...artifact(dir, ARM64, 'arm64') },
        `${RECORD} records no arm64 build`,
      ],
    ];
    for (const [options, files, message] of cases) {
      const result = run(options, { files });
      expect(result.code).toBe(1);
      expect(result.err.replaceAll('\\', '/')).toBe(`manifest: ${message}`);
    }
  });
});

describe('write (the release record from the CI artifacts)', () => {
  const dir = 'D:/a/_temp/addon';
  const out = 'D:/a/_temp/record';
  const both = {
    ...artifact(`${dir}/x64`, X64, 'x64', { version: VERSION }),
    ...artifact(`${dir}/arm64`, ARM64, 'arm64'),
  };

  it('writes manifest.json, SHA256SUMS and toolchain.json in the committed format', () => {
    const result = run({ command: 'write', release: '0.1.0', dir, out }, { files: both });
    expect(result.code).toBe(0);
    const manifest = manifestOf();
    expect(text(result.fs, `${out}/manifest.json`)).toBe(renderManifest(manifest));
    expect(text(result.fs, `${out}/SHA256SUMS`)).toBe(renderReleaseSums(manifest));
    expect(text(result.fs, `${out}/toolchain.json`)).toBe(renderReleaseToolchains(manifest));
    expect(result.fs.dirs).toEqual([path.resolve(ROOT, out)]);
    expect(result.fs.out).toEqual([
      `release record 0.1.0 (addon version ${VERSION}):`,
      `  arm64 sha256 ${ARM64_SHA} size ${String(ARM64.length)}`,
      `  x64 sha256 ${X64_SHA} size ${String(X64.length)}`,
    ]);
    expect(RELEASE_ARCHES).toEqual(['arm64', 'x64']);
    const withArmVersion = run(
      { command: 'write', release: '0.1.0', dir, out },
      { files: { ...both, ...artifact(`${dir}/arm64`, ARM64, 'arm64', { version: VERSION }) } },
    );
    expect(withArmVersion.code).toBe(0);
  });

  it('refuses incomplete or inconsistent artifacts and writes nothing', () => {
    const cases: [string, Record<string, Uint8Array | string>, string][] = [
      [
        '0.1.0',
        artifact(`${dir}/x64`, X64, 'x64', { version: VERSION }),
        `cannot read ${dir}/arm64/${ADDON_FILE} (ENOENT)`,
      ],
      [
        '0.1.0',
        { ...artifact(`${dir}/x64`, X64, 'x64'), ...artifact(`${dir}/arm64`, ARM64, 'arm64') },
        `${dir}/x64/${VERSION_FILE} is missing: the x64 build records the addon version`,
      ],
      [
        '0.1.0',
        { ...both, ...artifact(`${dir}/arm64`, ARM64, 'arm64', { version: '0.2.0' }) },
        `the arm64 build reports version 0.2.0, x64 ${VERSION}`,
      ],
      ['../0.1.0', both, 'the manifest would be invalid: release is not a release name'],
      [
        '0.1.0',
        { ...both, ...artifact(`${dir}/arm64`, X64, 'arm64') },
        `${dir}/arm64/${ADDON_FILE} is built for machine 0x8664, not arm64 (0xaa64)`,
      ],
    ];
    for (const [release, files, message] of cases) {
      const result = run({ command: 'write', release, dir, out }, { files });
      expect(result.code).toBe(1);
      expect(result.err.replaceAll('\\', '/')).toBe(`manifest: ${message}`);
      expect(result.fs.dirs).toEqual([]);
    }
  });
});

describe('compare (the lead checks CI against an independent local build)', () => {
  const ci = 'E:/downloads/addon-record/manifest.json';
  const ciFiles = { [ci]: renderManifest(manifestOf()) };

  it('prints MATCH per arch and exits 0 when every arch matches', () => {
    const result = run(
      { command: 'compare', manifest: ci },
      {
        files: {
          ...ciFiles,
          ...buildTree('x64', X64, toolchainOf('x64', { generator: 'Visual Studio 17 2022' })),
          ...buildTree('arm64', ARM64),
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.fs.out).toEqual([
      `comparing the local builds with ${ci} (release 0.1.0, version ${VERSION})`,
      `arm64: MATCH sha256 ${ARM64_SHA} size ${String(ARM64.length)}`,
      `x64: MATCH sha256 ${X64_SHA} size ${String(X64.length)}`,
      'x64: toolchain differs: generator local Visual Studio 17 2022 (CI Visual Studio 18 2026), information only: it does not change the bytes',
      `all 2 architectures match ${ci}`,
    ]);
    expect(result.err).toBe('');
  });

  it('fails equal bytes from a different toolchain of record, counting each arch once', () => {
    const other = fakePe(0x8664, 'local x64');
    const result = run(
      { command: 'compare', manifest: ci },
      {
        files: {
          ...ciFiles,
          ...buildTree('x64', other, toolchainOf('x64', { cmakeVersion: '4.4.5' })),
          ...buildTree('arm64', ARM64, toolchainOf('arm64', { cmakeVersion: '4.4.5' })),
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.fs.out.slice(1)).toEqual([
      'arm64: TOOLCHAIN MISMATCH (not the same toolchain of record): cmakeVersion local 4.4.5 (CI 4.4.4)',
      `arm64: MATCH sha256 ${ARM64_SHA} size ${String(ARM64.length)}`,
      'x64: TOOLCHAIN MISMATCH (not the same toolchain of record): cmakeVersion local 4.4.5 (CI 4.4.4)',
      `x64: MISMATCH local sha256 ${sha256Hex(other)} size ${String(other.length)}, CI sha256 ${X64_SHA} size ${String(X64.length)}`,
      'x64: inputs: the CI names no input identity',
    ]);
    expect(result.err).toBe(`manifest: 2 of 2 architectures do not match ${ci}`);
  });

  it('prints MISMATCH with both values, or the build command for a missing build, and exits 1', () => {
    const other = fakePe(0xaa64, 'local arm64');
    const result = run(
      { command: 'compare', manifest: ci },
      { files: { ...ciFiles, ...buildTree('arm64', other) } },
    );
    expect(result.code).toBe(1);
    expect(result.fs.out[1]).toBe(
      `arm64: MISMATCH local sha256 ${sha256Hex(other)} size ${String(other.length)}, CI sha256 ${ARM64_SHA} size ${String(ARM64.length)}`,
    );
    expect(result.fs.out[2]).toBe('arm64: inputs: the CI names no input identity');
    expect(result.fs.out[3]?.replaceAll('\\', '/')).toBe(
      `x64: NO LOCAL BUILD (cannot read native/win32-job/build/x64/Release/${ADDON_FILE} (ENOENT)); run node native/win32-job/build.mjs --toolset-of-record --arch x64`,
    );
    expect(result.err).toBe(`manifest: 2 of 2 architectures do not match ${ci}`);
  });

  it('refuses an unreadable CI manifest', () => {
    const result = run({ command: 'compare', manifest: ci });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`manifest: cannot read ${ci} (ENOENT)`);
    const thrown = io();
    thrown.io.readFile = () => {
      throw new Error('boom');
    };
    expect(runManifest({ command: 'compare', manifest: ci }, thrown.io)).toBe(1);
    expect(thrown.fs.err).toEqual([`manifest: cannot read ${ci} (Error: boom)`]);
  });
});

describe('the command line', () => {
  it('exits 2 on a usage error and writes nothing', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'addon', 'manifest.mjs'), 'collect', '--arch', 'x64'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^manifest: collect needs --out\nusage: manifest\.mjs/u);
  });
});

describe('the input identity (diagnostic only; the gate stays the bytes)', () => {
  const KERNEL32 = 'sdk/lib/10.0.26100.0/um/x64/kernel32.lib';
  const CL = 'msvc/bin/hostx64/x64/cl.exe';
  function identityOf(overrides: Partial<Identity> = {}): Identity {
    return {
      visualStudio: '17.14.37710.0',
      windowsSdkBuild: '10.1.26100.7705',
      files: { [CL]: 'a'.repeat(64), [KERNEL32]: 'b'.repeat(64) },
      ...overrides,
    };
  }
  const drifted = identityOf({
    windowsSdkBuild: '10.1.26100.9457',
    files: { [CL]: 'a'.repeat(64), [KERNEL32]: 'c'.repeat(64) },
  });
  const withIdentity = manifestOf({
    arches: { arm64: ARM64_ENTRY, x64: { ...X64_ENTRY, identity: identityOf() } },
  });
  const dir = 'D:/a/_temp/addon/x64';

  it('round-trips through the committed record format', () => {
    const text = renderManifest(withIdentity);
    const parsed = parseManifest(text);
    expect(parsed).toEqual(withIdentity);
    expect(renderManifest(parsed as Manifest)).toBe(text);
    const toolchain = (JSON.parse(text) as { arches: { x64: { toolchain: object } } }).arches.x64
      .toolchain;
    expect(Object.keys(toolchain).at(-1)).toBe('identity');
    expect(JSON.parse(renderReleaseToolchains(parsed as Manifest))).toHaveProperty(
      'x64.identity.windowsSdkBuild',
      '10.1.26100.7705',
    );
  });

  it('names the inputs that differ when the rebuild does not reproduce the record', () => {
    const other = fakePe(0x8664, 'drifted');
    const result = run(
      { command: 'verify', dir, record: RECORD },
      {
        files: {
          ...recordFiles(withIdentity),
          ...artifact(dir, other, 'x64', { version: VERSION, identity: drifted }),
        },
      },
    );
    expect(result.code).toBe(1);
    expect(result.fs.err).toEqual([
      `manifest: x64: the rebuild does not reproduce ${RECORD}: sha256 ${sha256Hex(other)} (record ${X64_SHA}), size ${String(other.length)} (record ${String(X64.length)})`,
      'manifest: x64: inputs: Windows SDK build 10.1.26100.9457 (record 10.1.26100.7705)',
      `manifest: x64: inputs: ${KERNEL32}: sha256 ${'c'.repeat(64)} (record ${'b'.repeat(64)})`,
    ]);
  });

  it('says so when no recorded input differs, and when the rebuild records none', () => {
    const other = fakePe(0x8664, 'drifted');
    const same = run(
      { command: 'verify', dir, record: RECORD },
      {
        files: {
          ...recordFiles(withIdentity),
          ...artifact(dir, other, 'x64', { identity: identityOf() }),
        },
      },
    );
    expect(same.fs.err.slice(1)).toEqual([
      'manifest: x64: inputs: none of the recorded inputs differs from the record; the change is in an input the identity does not cover',
    ]);
    const none = run(
      { command: 'verify', dir, record: RECORD },
      { files: { ...recordFiles(withIdentity), ...artifact(dir, other, 'x64') } },
    );
    expect(none.fs.err.slice(1)).toEqual([
      'manifest: x64: inputs: the rebuild names no input identity (record has one)',
    ]);
  });

  it('reports differing inputs as information when the bytes reproduce', () => {
    const result = run(
      { command: 'verify', dir, record: RECORD },
      {
        files: {
          ...recordFiles(withIdentity),
          ...artifact(dir, X64, 'x64', { identity: drifted }),
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.fs.out.slice(0, 2)).toEqual([
      'x64: inputs (information only, the bytes reproduce): Windows SDK build 10.1.26100.9457 (record 10.1.26100.7705)',
      `x64: inputs (information only, the bytes reproduce): ${KERNEL32}: sha256 ${'c'.repeat(64)} (record ${'b'.repeat(64)})`,
    ]);
  });

  it('reports differing inputs in the toolchain check as information', () => {
    const file = 'D:/a/_temp/addon/x64/toolchain.json';
    const result = run(
      { command: 'check-toolchain', toolchain: file },
      {
        files: {
          ...recordFiles(withIdentity),
          [file]: renderToolchain(toolchainOf('x64'), drifted),
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.fs.out.slice(0, 2)).toEqual([
      'inputs (information only): Windows SDK build 10.1.26100.9457 (record 10.1.26100.7705)',
      `inputs (information only): ${KERNEL32}: sha256 ${'c'.repeat(64)} (record ${'b'.repeat(64)})`,
    ]);
  });

  it('keeps the identity when it collects a build and writes a record', () => {
    const collected = run(
      { command: 'collect', arch: 'x64', out: 'out/x64' },
      { files: buildTree('x64', X64, toolchainOf('x64'), identityOf()) },
    );
    expect(collected.code).toBe(0);
    expect(text(collected.fs, 'out/x64/toolchain.json')).toBe(
      renderToolchain(toolchainOf('x64'), identityOf()),
    );
    const out = 'record';
    const written = run(
      { command: 'write', release: '0.1.0', dir: 'D:/a/_temp/addon', out },
      {
        files: {
          ...artifact('D:/a/_temp/addon/x64', X64, 'x64', {
            version: VERSION,
            identity: identityOf(),
          }),
          ...artifact('D:/a/_temp/addon/arm64', ARM64, 'arm64'),
        },
      },
    );
    expect(written.code).toBe(0);
    expect(text(written.fs, `${out}/manifest.json`)).toBe(renderManifest(withIdentity));
  });

  it('compares identities with a CI manifest', () => {
    const ci = 'E:/downloads/addon-record/manifest.json';
    const ciFiles = { [ci]: renderManifest(withIdentity) };
    const other = fakePe(0x8664, 'local x64');
    const matched = run(
      { command: 'compare', manifest: ci },
      {
        files: {
          ...ciFiles,
          ...buildTree('x64', X64, toolchainOf('x64'), drifted),
          ...buildTree('arm64', ARM64),
        },
      },
    );
    expect(matched.code).toBe(0);
    expect(matched.fs.out).toContain(
      `x64: inputs (information only): ${KERNEL32}: sha256 ${'c'.repeat(64)} (CI ${'b'.repeat(64)})`,
    );
    const mismatched = run(
      { command: 'compare', manifest: ci },
      {
        files: {
          ...ciFiles,
          ...buildTree('x64', other, toolchainOf('x64'), drifted),
          ...buildTree('arm64', ARM64),
        },
      },
    );
    expect(mismatched.code).toBe(1);
    expect(mismatched.fs.out).toContain(
      `x64: inputs: ${KERNEL32}: sha256 ${'c'.repeat(64)} (CI ${'b'.repeat(64)})`,
    );
  });
});
