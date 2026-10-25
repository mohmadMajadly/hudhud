// The job addon digest tool (plan §6.2; lead rulings on A2): argument
// parsing, the PE machine check, toolchains, the release manifest and its
// derived files, the generated digest table (written from a manifest only),
// and staging (never touching the table), all through an in-memory file
// system on every OS.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ADDON_FILE,
  ARCHES,
  checkToolchain,
  DIGESTS_MODULE,
  BYTE_FIELDS,
  informationalDifferences,
  INFORMATIONAL_FIELDS,
  isAddonVersion,
  parseArgs,
  parseDigestsModule,
  parseManifest,
  parseSha256Sums,
  peMachine,
  releaseOf,
  renderDigestsModule,
  renderReleaseSums,
  renderReleaseToolchains,
  renderSha256Sums,
  renderToolchain,
  sha256Hex,
  TOOLCHAIN_FIELDS,
  toolchainDifferences,
  toolchainIdentity,
  UsageError,
  writeDigests,
  type Options,
} from '../lib/addon-digests.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ROOT = path.resolve('/repo');
const VERSION = '0.1.0';
const MANIFEST = 'native/win32-job/release/0.0.0-dev/manifest.json';

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
    generator: 'Visual Studio 17 2022',
    vcToolsVersion: '14.44.35207',
    clVersion: '19.44.35229',
    windowsSdkVersion: '10.0.26100.0',
    cmakeVersion: '4.4.4',
    nodeApiHeadersVersion: '1.9.0',
    ...overrides,
  };
}

const MANIFEST_VALUE = {
  release: '0.0.0-dev',
  version: VERSION,
  arches: {
    arm64: { sha256: ARM64_SHA, size: ARM64.length, toolchain: toolchainOf('arm64') },
    x64: { sha256: X64_SHA, size: X64.length, toolchain: toolchainOf('x64') },
  },
};
const MANIFEST_TEXT = `${JSON.stringify(MANIFEST_VALUE, null, 2)}\n`;
const TABLE = renderDigestsModule({ version: VERSION, x64: X64_SHA, manifest: MANIFEST });

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
const BUILD_X64_TOOLCHAIN = 'native/win32-job/build/x64/toolchain.json';
const BUILD_ARM64 = `native/win32-job/build/arm64/Release/${ADDON_FILE}`;
const BUILD_ARM64_TOOLCHAIN = 'native/win32-job/build/arm64/toolchain.json';
const X64_BUILD = {
  [BUILD_X64]: X64,
  [BUILD_X64_TOOLCHAIN]: renderToolchain(toolchainOf('x64')),
};

function stageOpts(overrides: Partial<Extract<Options, { mode: 'stage' }>> = {}): Options {
  return {
    mode: 'stage',
    arch: 'x64',
    addon: undefined,
    toolchain: undefined,
    version: undefined,
    ...overrides,
  };
}

function file(fs: Fs, name: string): Uint8Array | string | undefined {
  return fs.files.get(path.join(ROOT, name));
}

describe('parseArgs', () => {
  it('reads both modes', () => {
    expect(parseArgs(['--from-manifest', MANIFEST])).toEqual({
      mode: 'from-manifest',
      manifest: MANIFEST,
    });
    expect(parseArgs(['--stage', '--arch', 'x64'])).toEqual(stageOpts());
    expect(
      parseArgs([
        '--stage',
        '--arch',
        'arm64',
        '--addon',
        'a.node',
        '--toolchain',
        't.json',
        '--version',
        '1.2.3',
      ]),
    ).toEqual({
      mode: 'stage',
      arch: 'arm64',
      addon: 'a.node',
      toolchain: 't.json',
      version: '1.2.3',
    });
  });

  it('refuses bad usage', () => {
    const cases: [string[], RegExp][] = [
      [[], /^usage: /],
      [['--arch', 'x64'], /^usage: /],
      [['--stage', '--arch', 'ia32'], /^usage: /],
      [['--stage'], /^usage: /],
      [['--arch'], /missing value for --arch/],
      [['--arch', ''], /missing value for --arch/],
      [['--stage', '--arch', 'x64', '--arch', 'x64'], /--arch given twice/],
      [['--stage', '--stage', '--arch', 'x64'], /--stage given twice/],
      [['--stage', '--arch', 'x64', '--check'], /unknown argument "--check"/],
      [['--from-manifest', MANIFEST, '--stage'], /--from-manifest takes no other argument/],
      [['--from-manifest', MANIFEST, '--arch', 'x64'], /--from-manifest takes no other argument/],
    ];
    for (const [argv, message] of cases) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
      expect(() => parseArgs(argv)).toThrow(message);
    }
  });
});

describe('isAddonVersion', () => {
  it('accepts semver with an optional pre-release only', () => {
    for (const value of ['0.1.0', '10.20.30', '1.0.0-rc.1'])
      expect(isAddonVersion(value)).toBe(true);
    for (const value of ['0.1', '01.0.0', '1.0.0+build', ' 0.1.0', '0.1.0\n', 1, undefined]) {
      expect(isAddonVersion(value)).toBe(false);
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

describe('SHA256SUMS of a platform package', () => {
  it('round-trips the sha256sum format and refuses anything else', () => {
    expect(renderSha256Sums(X64_SHA)).toBe(`${X64_SHA}  hudhud_win32_job.node\n`);
    expect(parseSha256Sums(renderSha256Sums(X64_SHA))).toBe(X64_SHA);
    expect(parseSha256Sums(`${X64_SHA}  hudhud_win32_job.node`)).toBeNull();
    expect(parseSha256Sums(`${X64_SHA}  other.node\n`)).toBeNull();
    expect(parseSha256Sums('')).toBeNull();
  });
});

describe('toolchains', () => {
  it('accepts exactly the fields that change the bytes', () => {
    expect(TOOLCHAIN_FIELDS).toEqual([
      'arch',
      'generator',
      'vcToolsVersion',
      'clVersion',
      'windowsSdkVersion',
      'cmakeVersion',
      'nodeApiHeadersVersion',
    ]);
    expect(checkToolchain(toolchainOf('x64'))).toEqual(toolchainOf('x64'));
    expect(checkToolchain(null)).toBe('not an object');
    expect(checkToolchain([])).toBe('not an object');
    expect(checkToolchain({ ...toolchainOf('x64'), extra: 'x' })).toMatch(/^fields /);
    const missing = Object.fromEntries(
      Object.entries(toolchainOf('x64')).filter(([field]) => field !== 'cmakeVersion'),
    );
    expect(checkToolchain(missing)).toMatch(/^fields /);
    expect(checkToolchain(toolchainOf('x64', { clVersion: '"19"' }))).toBe(
      'clVersion is not a value',
    );
    expect(checkToolchain({ ...toolchainOf('x64'), clVersion: 19 })).toBe(
      'clVersion is not a value',
    );
  });

  it('accepts an input identity after the fields, checks it and keeps it apart', () => {
    const identity = {
      visualStudio: '17.14.37710.0',
      windowsSdkBuild: '10.1.26100.7705',
      files: { 'msvc/bin/hostx64/x64/cl.exe': 'a'.repeat(64) },
    };
    const value = { ...toolchainOf('x64'), identity };
    expect(checkToolchain(value)).toEqual(toolchainOf('x64'));
    expect(toolchainIdentity(value)).toEqual(identity);
    expect(toolchainIdentity(toolchainOf('x64'))).toBeUndefined();
    expect(toolchainIdentity(null)).toBeUndefined();
    expect(toolchainIdentity('x')).toBeUndefined();
    const broken = { ...toolchainOf('x64'), identity: { ...identity, visualStudio: '17' } };
    expect(checkToolchain(broken)).toBe('identity: visualStudio is not a version');
    expect(toolchainIdentity(broken)).toBeUndefined();
    const rendered = renderToolchain(toolchainOf('x64'), identity);
    expect(Object.keys(JSON.parse(rendered) as object)).toEqual([...TOOLCHAIN_FIELDS, 'identity']);
    expect(renderToolchain(toolchainOf('x64'))).not.toContain('identity');
  });

  it('names the byte-changing fields in which two toolchains differ, in field order', () => {
    expect(toolchainDifferences(toolchainOf('x64'), toolchainOf('x64'))).toEqual([]);
    const other = toolchainOf('x64', {
      windowsSdkVersion: '10.0.26200.0',
      generator: 'Visual Studio 18 2026',
      vcToolsVersion: '14.51.36231',
    });
    expect(toolchainDifferences(toolchainOf('x64'), other)).toEqual([
      'vcToolsVersion',
      'windowsSdkVersion',
    ]);
    expect(informationalDifferences(toolchainOf('x64'), other)).toEqual(['generator']);
    expect(informationalDifferences(toolchainOf('x64'), toolchainOf('x64'))).toEqual([]);
  });

  it('compares every field but the generator exactly (lead ruling on A3, run 38947897592)', () => {
    expect(INFORMATIONAL_FIELDS).toEqual(['generator']);
    expect(BYTE_FIELDS).toEqual([
      'arch',
      'vcToolsVersion',
      'clVersion',
      'windowsSdkVersion',
      'cmakeVersion',
      'nodeApiHeadersVersion',
    ]);
  });

  it('renders the fields in their order', () => {
    const shuffled = Object.fromEntries(Object.entries(toolchainOf('x64')).reverse());
    expect(renderToolchain(shuffled)).toBe(`${JSON.stringify(toolchainOf('x64'), null, 2)}\n`);
  });
});

describe('the release manifest', () => {
  it('reads a manifest and derives the record files from it', () => {
    const manifest = parseManifest(MANIFEST_TEXT);
    expect(manifest).toEqual(MANIFEST_VALUE);
    if (typeof manifest === 'string') return;
    expect(renderReleaseSums(manifest)).toBe(
      `${ARM64_SHA}  arm64/${ADDON_FILE}\n${X64_SHA}  x64/${ADDON_FILE}\n`,
    );
    expect(JSON.parse(renderReleaseToolchains(manifest))).toEqual({
      arm64: toolchainOf('arm64'),
      x64: toolchainOf('x64'),
    });
    expect(releaseOf(MANIFEST)).toBe('0.0.0-dev');
    expect(releaseOf('native/win32-job/release/../manifest.json')).toBeNull();
    expect(releaseOf('elsewhere/manifest.json')).toBeNull();
  });

  it('refuses a malformed manifest with the reason', () => {
    const x64 = MANIFEST_VALUE.arches.x64;
    const cases: [unknown, unknown][] = [
      [[], 'not an object'],
      [
        { ...MANIFEST_VALUE, extra: 1 },
        'fields arches,extra,release,version are not arches, release, version',
      ],
      [{ ...MANIFEST_VALUE, release: '../x' }, 'release is not a release name'],
      [{ ...MANIFEST_VALUE, release: 7 }, 'release is not a release name'],
      [{ ...MANIFEST_VALUE, version: 'v1' }, 'version is not semver'],
      [{ ...MANIFEST_VALUE, version: 1 }, 'version is not semver'],
      [{ ...MANIFEST_VALUE, arches: [] }, 'arches is not an object'],
      [{ ...MANIFEST_VALUE, arches: null }, 'arches is not an object'],
      [{ ...MANIFEST_VALUE, arches: { ia32: x64 } }, 'unknown arch ia32'],
      [{ ...MANIFEST_VALUE, arches: { x64: 1 } }, 'x64 is not an object'],
      [{ ...MANIFEST_VALUE, arches: { x64: null } }, 'x64 is not an object'],
      [
        { ...MANIFEST_VALUE, arches: { x64: { sha256: X64_SHA } } },
        'x64 fields are not sha256, size, toolchain',
      ],
      [
        { ...MANIFEST_VALUE, arches: { x64: { ...x64, sha256: 'x' } } },
        'x64.sha256 is not a sha256',
      ],
      [{ ...MANIFEST_VALUE, arches: { x64: { ...x64, sha256: 1 } } }, 'x64.sha256 is not a sha256'],
      [{ ...MANIFEST_VALUE, arches: { x64: { ...x64, size: 0 } } }, 'x64.size is not a size'],
      [{ ...MANIFEST_VALUE, arches: { x64: { ...x64, size: '1' } } }, 'x64.size is not a size'],
      [
        { ...MANIFEST_VALUE, arches: { x64: { ...x64, toolchain: {} } } },
        expect.stringMatching(/^x64\.toolchain: fields /),
      ],
      [
        { ...MANIFEST_VALUE, arches: { x64: { ...x64, toolchain: toolchainOf('arm64') } } },
        'x64.toolchain.arch is arm64',
      ],
      [{ ...MANIFEST_VALUE, arches: { arm64: MANIFEST_VALUE.arches.arm64 } }, 'no x64 build'],
    ];
    expect(parseManifest('{')).toBe('not JSON');
    for (const [value, reason] of cases)
      expect(parseManifest(JSON.stringify(value))).toEqual(reason);
  });
});

describe('the generated digest table module', () => {
  it('round-trips and refuses anything but its own output', () => {
    expect(parseDigestsModule(TABLE)).toEqual({
      version: VERSION,
      x64: X64_SHA,
      manifest: MANIFEST,
    });
    expect(parseDigestsModule(`${TABLE}// edited\n`)).toBeNull();
    expect(parseDigestsModule(TABLE.replace(/^ {2}x64: .*$/mu, ''))).toBeNull();
    expect(parseDigestsModule(TABLE.replace(/^ {2}version: .*$/mu, ''))).toBeNull();
    expect(parseDigestsModule(TABLE.replace(/^ \* `native.*$/mu, ''))).toBeNull();
    expect(parseDigestsModule(TABLE.replace(X64_SHA, X64_SHA.toUpperCase()))).toBeNull();
    expect(parseDigestsModule('export const WIN32_JOB_DIGESTS = Object.freeze({});\n')).toBeNull();
  });

  it('refuses values that are not a version, a sha256 or a release manifest', () => {
    const table = { version: VERSION, x64: X64_SHA, manifest: MANIFEST };
    expect(() => renderDigestsModule({ ...table, version: "1.0.0' + x" })).toThrow(
      'invalid addon version',
    );
    expect(() => renderDigestsModule({ ...table, x64: 'f'.repeat(63) })).toThrow(
      'invalid x64 sha256',
    );
    expect(() => renderDigestsModule({ ...table, manifest: 'manifest.json' })).toThrow(
      'invalid release manifest path',
    );
  });

  it('lists the platform packages of both arches', () => {
    expect(ARCHES['x64']).toEqual({ machine: 0x8664, packageDir: 'packages/win32-job-x64' });
    expect(ARCHES['arm64']).toEqual({ machine: 0xaa64, packageDir: 'packages/win32-job-arm64' });
  });
});

describe('writeDigests --from-manifest (the only writer of the table)', () => {
  it('writes the table from the manifest, and leaves an equal table untouched', () => {
    const fresh = io({ files: { [MANIFEST]: MANIFEST_TEXT } });
    expect(writeDigests({ mode: 'from-manifest', manifest: MANIFEST }, fresh.io)).toBe(0);
    expect(file(fresh.fs, DIGESTS_MODULE)).toBe(TABLE);
    expect(fresh.fs.out).toEqual([
      `wrote ${DIGESTS_MODULE} from ${MANIFEST} (x64 ${X64_SHA}, version ${VERSION})`,
    ]);

    const same = io({ files: { [MANIFEST]: MANIFEST_TEXT, [DIGESTS_MODULE]: TABLE } });
    expect(
      writeDigests({ mode: 'from-manifest', manifest: MANIFEST.replaceAll('/', '\\') }, same.io),
    ).toBe(0);
    expect(same.fs.writes).toEqual([]);
    expect(same.fs.out).toEqual([`${DIGESTS_MODULE} already holds ${MANIFEST}`]);
  });

  it('refuses a path, file or manifest that is not a release record', () => {
    const cases: [string, Record<string, string>, string][] = [
      [
        'manifest.json',
        {},
        'manifest.json is not native/win32-job/release/<release>/manifest.json in the repository',
      ],
      [MANIFEST, {}, `cannot read ${MANIFEST} (ENOENT)`],
      [MANIFEST, { [MANIFEST]: '{' }, `${MANIFEST}: not JSON`],
      [
        MANIFEST,
        { [MANIFEST]: JSON.stringify({ ...MANIFEST_VALUE, release: '1.0.0' }) },
        `${MANIFEST}: release 1.0.0 is not its directory 0.0.0-dev`,
      ],
    ];
    for (const [manifest, files, message] of cases) {
      const { fs, io: deps } = io({ files });
      expect(writeDigests({ mode: 'from-manifest', manifest }, deps)).toBe(1);
      expect(fs.err).toEqual([`write-digests: ${message}`]);
      expect(fs.writes).toEqual([]);
    }
    const odd = io({ files: {} });
    odd.io.readFile = () => {
      throw new Error('odd');
    };
    expect(writeDigests({ mode: 'from-manifest', manifest: MANIFEST }, odd.io)).toBe(1);
    expect(odd.fs.err).toEqual([`write-digests: cannot read ${MANIFEST} (Error: odd)`]);
  });
});

describe('writeDigests --stage (never writes the table)', () => {
  it('stages the bytes, their SHA256SUMS and the toolchain, loading the version on Windows x64', () => {
    const { fs, io: deps } = io({ files: X64_BUILD });
    expect(writeDigests(stageOpts(), deps)).toBe(0);
    expect(fs.loaded).toEqual([path.join(ROOT, BUILD_X64)]);
    expect(fs.writes).toEqual([
      `packages/win32-job-x64/${ADDON_FILE}`,
      'packages/win32-job-x64/SHA256SUMS',
      'packages/win32-job-x64/toolchain.json',
    ]);
    expect(file(fs, `packages/win32-job-x64/${ADDON_FILE}`)).toBe(X64);
    expect(file(fs, 'packages/win32-job-x64/SHA256SUMS')).toBe(renderSha256Sums(X64_SHA));
    expect(file(fs, 'packages/win32-job-x64/toolchain.json')).toBe(
      renderToolchain(toolchainOf('x64')),
    );
    expect(fs.err).toEqual([]);
    expect(fs.out[0]).toBe(
      `staged x64 ${ADDON_FILE} (sha256 ${X64_SHA}, version ${VERSION}) in packages/win32-job-x64`,
    );
  });

  it('takes a CI artifact with its toolchain, and the version off Windows', () => {
    const { fs, io: deps } = io({
      files: { 'a/x64.node': X64, 'a/toolchain.json': renderToolchain(toolchainOf('x64')) },
      platform: 'linux',
    });
    expect(
      writeDigests(
        stageOpts({ addon: 'a/x64.node', toolchain: 'a/toolchain.json', version: VERSION }),
        deps,
      ),
    ).toBe(0);
    expect(fs.loaded).toEqual([]);
    expect(fs.writes).not.toContain(DIGESTS_MODULE);
  });

  it('stages arm64 with --version on an x64 host (K17: not in the table)', () => {
    const { fs, io: deps } = io({
      files: {
        [BUILD_ARM64]: ARM64,
        [BUILD_ARM64_TOOLCHAIN]: renderToolchain(toolchainOf('arm64')),
      },
    });
    expect(writeDigests(stageOpts({ arch: 'arm64', version: VERSION }), deps)).toBe(0);
    expect(fs.loaded).toEqual([]);
    expect(file(fs, 'packages/win32-job-arm64/SHA256SUMS')).toBe(renderSha256Sums(ARM64_SHA));
  });

  it('refuses what it cannot vouch for, writing nothing', () => {
    const tc = renderToolchain(toolchainOf('x64'));
    const cases: [
      Partial<Extract<Options, { mode: 'stage' }>>,
      Record<string, Uint8Array | string>,
      string | RegExp,
    ][] = [
      [
        { addon: 'a.node' },
        { 'a.node': X64 },
        '--addon needs the toolchain.json of that build (--toolchain <file>)',
      ],
      [
        {},
        {},
        `cannot read ${path.join(ROOT, BUILD_X64)} (ENOENT); build it first: node native/win32-job/build.mjs --arch x64`,
      ],
      [
        {},
        { [BUILD_X64]: 'not an addon', [BUILD_X64_TOOLCHAIN]: tc },
        `${path.join(ROOT, BUILD_X64)} is not a PE image`,
      ],
      [
        {},
        { [BUILD_X64]: ARM64, [BUILD_X64_TOOLCHAIN]: tc },
        `${path.join(ROOT, BUILD_X64)} is built for machine 0xaa64, not x64 (0x8664)`,
      ],
      [{}, { [BUILD_X64]: X64 }, `cannot read ${path.join(ROOT, BUILD_X64_TOOLCHAIN)} (ENOENT)`],
      [
        {},
        { [BUILD_X64]: X64, [BUILD_X64_TOOLCHAIN]: '{' },
        `${path.join(ROOT, BUILD_X64_TOOLCHAIN)}: not an object`,
      ],
      [
        {},
        { [BUILD_X64]: X64, [BUILD_X64_TOOLCHAIN]: renderToolchain(toolchainOf('arm64')) },
        `${path.join(ROOT, BUILD_X64_TOOLCHAIN)} describes a arm64 build`,
      ],
      [
        { version: '0.2.0' },
        X64_BUILD,
        'the addon reports version "0.1.0", --version says "0.2.0"',
      ],
    ];
    for (const [overrides, files, message] of cases) {
      const { fs, io: deps } = io({ files });
      expect(writeDigests(stageOpts(overrides), deps)).toBe(1);
      expect(fs.err).toEqual([`write-digests: ${String(message)}`]);
      expect(fs.writes).toEqual([]);
    }
  });

  it('refuses a version that cannot be read or is not semver', () => {
    const unloadable = io({
      files: X64_BUILD,
      version: () => {
        throw new Error('dlopen failed');
      },
    });
    expect(writeDigests(stageOpts(), unloadable.io)).toBe(1);
    expect(unloadable.fs.err[0]).toMatch(/cannot load .*: Error: dlopen failed$/u);

    for (const bad of [undefined, 1, '', 'v0.1.0', '0.1', '01.0.0']) {
      const wrong = io({ files: X64_BUILD, version: () => bad });
      expect(writeDigests(stageOpts(), wrong.io)).toBe(1);
      expect(wrong.fs.err).toEqual([
        `write-digests: the addon version ${JSON.stringify(bad)} is not a semver version`,
      ]);
      expect(wrong.fs.writes).toEqual([]);
    }
    const matches = io({ files: X64_BUILD });
    expect(writeDigests(stageOpts({ version: VERSION }), matches.io)).toBe(0);
  });

  it('needs --version when the addon cannot be loaded on this host', () => {
    for (const [platform, hostArch] of [
      ['linux', 'x64'],
      ['win32', 'arm64'],
    ] as const) {
      const { fs, io: deps } = io({ files: X64_BUILD, platform, hostArch });
      expect(writeDigests(stageOpts(), deps)).toBe(1);
      expect(fs.err).toEqual([
        `write-digests: the x64 addon cannot be loaded on ${platform}-${hostArch}: give its version with --version`,
      ]);
    }
  });

  it('refuses an unknown architecture', () => {
    const { io: deps } = io();
    expect(() => writeDigests(stageOpts({ arch: 'ia32' }), deps)).toThrow(UsageError);
  });
});

describe('the command line', () => {
  it('exits 2 on a usage error and writes nothing', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'addon', 'write-digests.mjs'), '--stage', '--arch', 'ia32'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^write-digests: usage: write-digests\.mjs --from-manifest/u);
  });
});
