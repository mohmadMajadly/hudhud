// The release mode of the tarball check (plan §6.3 phase 2; scripts/lib/tarball.mjs
// `checkReleaseRecord`): the bytes a release would publish, read back from
// the packed tarballs, must equal the release record. Every mismatch names
// both values.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ADDON_FILE,
  DIGESTS_MODULE,
  renderDigestsModule,
  renderSha256Sums,
  sha256Hex,
  type Manifest,
  type ReleaseArch,
} from '../lib/addon-digests.mjs';
import {
  checkReleaseRecord,
  DIGESTS_BUILD,
  DIGESTS_SOURCE,
  parseCompiledDigests,
  type TarEntry,
} from '../lib/tarball.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const RECORD = 'native/win32-job/release/0.1.0/manifest.json';
const VERSION = '0.1.0';
const X64 = Buffer.from('x64 addon bytes');
const ARM64 = Buffer.from('arm64 addon bytes');
const X64_SHA = sha256Hex(X64);
const ARM64_SHA = sha256Hex(ARM64);

const TOOLCHAIN = {
  generator: 'Visual Studio 18 2026',
  vcToolsVersion: '14.44.35207',
  clVersion: '19.44.35229',
  windowsSdkVersion: '10.0.26100.0',
  cmakeVersion: '4.4.4',
  nodeApiHeadersVersion: '1.9.0',
};

const X64_ENTRY: ReleaseArch = {
  sha256: X64_SHA,
  size: X64.length,
  toolchain: { arch: 'x64', ...TOOLCHAIN },
};

const MANIFEST: Manifest = {
  release: '0.1.0',
  version: VERSION,
  arches: {
    arm64: { sha256: ARM64_SHA, size: ARM64.length, toolchain: { arch: 'arm64', ...TOOLCHAIN } },
    x64: X64_ENTRY,
  },
};

/**
 * What `tsc` emits for a generated table with the repository's compiler
 * options (NodeNext in a `"type": "module"` package, so ES module output;
 * the `.mts` name gives transpileModule, which reads no package.json, the
 * same module format).
 */
function compile(source: string): string {
  return ts.transpileModule(source, {
    fileName: 'win32-job-digests.mts',
    compilerOptions: {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      newLine: ts.NewLineKind.LineFeed,
    },
  }).outputText;
}

function entry(file: string, data: string | Buffer): TarEntry {
  return { path: file, data: Buffer.from(data), mode: 0o644 };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function table(version = VERSION, x64 = X64_SHA, manifest = RECORD): string {
  return renderDigestsModule({ version, x64, manifest });
}

function core(
  options: {
    source?: string | null;
    built?: string | null;
    optionalDependencies?: Record<string, string> | null;
  } = {},
): TarEntry[] {
  const source = options.source === undefined ? table() : options.source;
  const built = options.built === undefined ? compile(table()) : options.built;
  const optional =
    options.optionalDependencies === undefined
      ? { '@hudhudjs/win32-job-x64': '0.1.0' }
      : options.optionalDependencies;
  return [
    entry(
      'package.json',
      json({
        name: '@hudhudjs/core',
        version: '0.1.0',
        ...(optional === null ? {} : { optionalDependencies: optional }),
      }),
    ),
    ...(source === null ? [] : [entry(DIGESTS_SOURCE, source)]),
    ...(built === null ? [] : [entry(DIGESTS_BUILD, built)]),
  ];
}

function platform(
  arch: string,
  bytes: Buffer,
  options: { sums?: string | null; manifest?: string | null } = {},
): TarEntry[] {
  const sums = options.sums === undefined ? renderSha256Sums(sha256Hex(bytes)) : options.sums;
  const manifest =
    options.manifest === undefined
      ? json({ name: `@hudhudjs/win32-job-${arch}`, version: '0.1.0' })
      : options.manifest;
  return [
    ...(manifest === null ? [] : [entry('package.json', manifest)]),
    entry(ADDON_FILE, bytes),
    ...(sums === null ? [] : [entry('SHA256SUMS', sums)]),
  ];
}

const PLATFORMS = { x64: platform('x64', X64), arm64: platform('arm64', ARM64) };

describe('the digest table in the core tarball', () => {
  it('lies at the paths of the generated module and its build', () => {
    expect(DIGESTS_SOURCE).toBe('src/process/containment/win32-job-digests.ts');
    expect(DIGESTS_BUILD).toBe('dist/process/containment/win32-job-digests.js');
    expect(DIGESTS_MODULE).toBe(`packages/core/${DIGESTS_SOURCE}`);
  });

  it('is read from what tsc emits for the committed table', () => {
    const committed = readFileSync(path.join(REPO, DIGESTS_MODULE), 'utf8');
    const version = /^ {2}version: '([^']*)',$/mu.exec(committed)?.[1];
    const x64 = /^ {2}x64: '([^']*)',$/mu.exec(committed)?.[1];
    expect(parseCompiledDigests(compile(committed))).toEqual({ version, x64 });
  });

  it('refuses anything but exactly one compiled table', () => {
    const compiled = compile(table());
    expect(parseCompiledDigests('')).toBeNull();
    expect(parseCompiledDigests(`${compiled}\n${compiled}`)).toBeNull();
    expect(parseCompiledDigests(compiled.replace('    x64:', '    arm64:'))).toBeNull();
    expect(parseCompiledDigests(compiled.replaceAll('\n', '\r\n'))).toBeNull();
  });
});

describe('checkReleaseRecord', () => {
  it('passes tarballs that carry the record', () => {
    expect(checkReleaseRecord(MANIFEST, RECORD, { core: core(), platforms: PLATFORMS })).toEqual(
      [],
    );
  });

  it('names both values when an addon in a platform tarball differs', () => {
    const other = Buffer.from('other bytes!');
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core(),
        platforms: { ...PLATFORMS, arm64: platform('arm64', other) },
      }),
    ).toEqual([
      `the arm64 platform package: ${ADDON_FILE} in the tarball is sha256 ${sha256Hex(other)} size ${String(other.length)}, ${RECORD} records sha256 ${ARM64_SHA} size ${String(ARM64.length)}`,
      `the arm64 platform package: SHA256SUMS in the tarball does not name ${ARM64_SHA} alone`,
    ]);
    const sameHashWrongSize: Manifest = {
      ...MANIFEST,
      arches: {
        ...MANIFEST.arches,
        x64: { ...X64_ENTRY, size: 1 },
      },
    };
    expect(
      checkReleaseRecord(sameHashWrongSize, RECORD, { core: core(), platforms: PLATFORMS }),
    ).toEqual([
      `the x64 platform package: ${ADDON_FILE} in the tarball is sha256 ${X64_SHA} size ${String(X64.length)}, ${RECORD} records sha256 ${X64_SHA} size 1`,
    ]);
  });

  it('refuses incomplete platform tarballs', () => {
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core(),
        platforms: {
          x64: platform('x64', X64, { sums: null, manifest: null }).filter(
            (item) => item.path !== ADDON_FILE,
          ),
        },
      }),
    ).toEqual([
      'the arm64 platform package was not packed',
      `the x64 platform package: the tarball has no ${ADDON_FILE}`,
      `the x64 platform package: SHA256SUMS in the tarball does not name ${X64_SHA} alone`,
      "the x64 platform package: the tarball's package.json has no name and version",
    ]);
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core(),
        platforms: {
          ...PLATFORMS,
          x64: platform('x64', X64, { manifest: '{' }),
          arm64: platform('arm64', ARM64, { manifest: 'null' }),
        },
      }),
    ).toEqual([
      "the arm64 platform package: the tarball's package.json has no name and version",
      "the x64 platform package: the tarball's package.json has no name and version",
    ]);
  });

  it("requires the core's optional dependency to be the packed x64 version, and never arm64", () => {
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core({
          optionalDependencies: {
            '@hudhudjs/win32-job-x64': '0.0.9',
            '@hudhudjs/win32-job-arm64': '0.1.0',
          },
        }),
        platforms: PLATFORMS,
      }),
    ).toEqual([
      '@hudhudjs/core: lists @hudhudjs/win32-job-arm64 as an optional dependency (K17: x64 only)',
      '@hudhudjs/core: optionalDependencies.@hudhudjs/win32-job-x64 is 0.0.9, the packed @hudhudjs/win32-job-x64 is 0.1.0',
    ]);
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core({ optionalDependencies: null }),
        platforms: PLATFORMS,
      }),
    ).toEqual([
      '@hudhudjs/core: optionalDependencies.@hudhudjs/win32-job-x64 is undefined, the packed @hudhudjs/win32-job-x64 is 0.1.0',
    ]);
  });

  it("requires the core's table, source and build, to be written from this record", () => {
    const want = `${RECORD} records version ${VERSION}, x64 ${X64_SHA}`;
    const stale = table('0.0.9', ARM64_SHA, 'native/win32-job/release/0.0.9/manifest.json');
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core({ source: stale, built: compile(stale) }),
        platforms: PLATFORMS,
      }),
    ).toEqual([
      `@hudhudjs/core: ${DIGESTS_SOURCE} holds version 0.0.9, x64 ${ARM64_SHA} from native/win32-job/release/0.0.9/manifest.json; ${want}`,
      `@hudhudjs/core: ${DIGESTS_BUILD} holds version 0.0.9, x64 ${ARM64_SHA}; ${want}`,
    ]);
    // Each field alone is enough.
    for (const source of [
      table('0.0.9'),
      table(VERSION, ARM64_SHA),
      table(VERSION, X64_SHA, 'native/win32-job/release/0.0.0-dev/manifest.json'),
    ]) {
      expect(
        checkReleaseRecord(MANIFEST, RECORD, { core: core({ source }), platforms: PLATFORMS }),
      ).toHaveLength(1);
    }
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core({ built: compile(table(VERSION, ARM64_SHA)) }),
        platforms: PLATFORMS,
      }),
    ).toEqual([
      `@hudhudjs/core: ${DIGESTS_BUILD} holds version ${VERSION}, x64 ${ARM64_SHA}; ${want}`,
    ]);
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core({ built: compile(table('0.0.9')) }),
        platforms: PLATFORMS,
      }),
    ).toHaveLength(1);
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core({ source: null, built: null }),
        platforms: PLATFORMS,
      }),
    ).toEqual([
      `@hudhudjs/core: ${DIGESTS_SOURCE} is missing or not a generated table`,
      `@hudhudjs/core: ${DIGESTS_BUILD} is missing or not the compiled table (build first)`,
    ]);
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core({ source: 'export {};\n', built: 'export {};\n' }),
        platforms: PLATFORMS,
      }),
    ).toHaveLength(2);
  });

  it('refuses a core tarball without a package.json, and a record without x64', () => {
    expect(
      checkReleaseRecord(MANIFEST, RECORD, {
        core: core().filter((item) => item.path !== 'package.json'),
        platforms: PLATFORMS,
      }),
    ).toEqual([
      '@hudhudjs/core: the tarball has no readable package.json',
      '@hudhudjs/core: optionalDependencies.@hudhudjs/win32-job-x64 is undefined, the packed @hudhudjs/win32-job-x64 is 0.1.0',
    ]);
    // parseManifest never yields a record without x64; the check still names it.
    const noX64: Manifest = { ...MANIFEST, arches: {} };
    expect(checkReleaseRecord(noX64, RECORD, { core: core(), platforms: {} })).toEqual([
      `@hudhudjs/core: ${DIGESTS_SOURCE} holds version ${VERSION}, x64 ${X64_SHA} from ${RECORD}; ${RECORD} records version ${VERSION}, x64 undefined`,
      `@hudhudjs/core: ${DIGESTS_BUILD} holds version ${VERSION}, x64 ${X64_SHA}; ${RECORD} records version ${VERSION}, x64 undefined`,
    ]);
  });
});
