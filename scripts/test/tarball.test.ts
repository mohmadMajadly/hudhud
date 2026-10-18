import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  checkFileList,
  checkImports,
  checkSchemaSpecifiers,
  bundledPackages,
  checkLegalFiles,
  checkPackedManifest,
  checkRequiredFiles,
  checkSourceManifest,
  checkRepositoryFields,
  checkSourceMap,
  checkTarball,
  cleanEnv,
  coversPath,
  IMPORT_CHILD,
  isPublishable,
  isSafeEntryPath,
  listEntryPoints,
  looksLikeText,
  MAX_SCAN_BYTES,
  nativeSkipReason,
  parseImportResults,
  readTarGz,
  renderTypeProject,
  resolveInside,
  rootProblem,
  scanEntries,
  supportsPlatform,
  repositorySlug,
  type PackageJson,
  type TarEntry,
} from '../lib/tarball.mjs';

// ---- a tar writer for the tests ------------------------------------------------

interface Item {
  readonly name: string;
  readonly data?: string | Buffer;
  readonly type?: string;
  readonly prefix?: string;
  /** Corrupts the checksum. */
  readonly badChecksum?: boolean;
  /** Overrides the size field text. */
  readonly sizeField?: string;
}

function header(item: Item, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(item.name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(item.sizeField ?? `${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(item.type ?? '0', 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  if (item.prefix !== undefined) block.write(item.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  const text = item.badChecksum === true ? '0000000' : sum.toString(8).padStart(6, '0');
  block.write(`${text}\0 `, 148, 'ascii');
  return block;
}

function tar(items: readonly Item[], { end = true } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    const data = Buffer.from(item.data ?? '');
    parts.push(header(item, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const gz = (items: readonly Item[], options?: { end?: boolean }): Buffer =>
  gzipSync(tar(items, options));

function pax(path: string): string {
  const body = ` path=${path}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length)
    length = String(length).length + body.length;
  return `${String(length)}${body}`;
}

const file = (name: string, data = 'x'): Item => ({ name: `package/${name}`, data });

// ---- reading ------------------------------------------------------------------

describe('readTarGz', () => {
  it('reads regular files, drops package/ and ignores directories', () => {
    const entries = readTarGz(
      gz([
        { name: 'package/', type: '5' },
        file('package.json', '{}'),
        file('dist/a.js', 'export {}'),
        { name: 'dist/b.js', prefix: 'package', data: 'prefixed' },
      ]),
    );
    expect(entries.map((entry) => entry.path)).toEqual(['package.json', 'dist/a.js', 'dist/b.js']);
    expect(entries[1]?.data.toString()).toBe('export {}');
    expect(entries[0]?.mode).toBe(0o644);
  });

  it('reads pax and GNU long names and skips global pax headers', () => {
    const long = `package/dist/${'d'.repeat(120)}/file.js`;
    const entries = readTarGz(
      gz([
        { name: 'pax_global_header', type: 'g', data: pax('ignored') },
        { name: 'PaxHeader', type: 'x', data: pax(long) },
        { name: 'cut', data: 'one' },
        { name: '././@LongLink', type: 'L', data: `${long}x\0` },
        { name: 'cut2', data: 'two' },
        { name: 'PaxHeader', type: 'x', data: '13 mtime=1.5\n11 noequal\n' },
        { name: 'package/plain.js', data: 'three' },
      ]),
    );
    expect(entries.map((entry) => entry.path)).toEqual([
      `dist/${'d'.repeat(120)}/file.js`,
      `dist/${'d'.repeat(120)}/file.jsx`,
      'plain.js',
    ]);
  });

  it('reads a name that fills its field, a NUL type flag and an empty size field', () => {
    const exact = `package/${'n'.repeat(92)}`;
    expect(exact).toHaveLength(100);
    const entries = readTarGz(
      gz([
        { name: exact, data: 'a' },
        { name: 'package/old.js', type: '\0', data: 'b' },
        { name: 'package/empty.js', sizeField: '\0' },
      ]),
    );
    expect(entries.map((item) => item.path)).toEqual([exact.slice(8), 'old.js', 'empty.js']);
    expect(entries[2]?.data).toHaveLength(0);
  });

  it('reads a tar without the end blocks', () => {
    expect(readTarGz(gz([file('a.js')], { end: false })).map((entry) => entry.path)).toEqual([
      'a.js',
    ]);
  });

  it.each([
    ['a checksum mismatch', [{ ...file('a.js'), badChecksum: true }], 'checksum'],
    ['a link', [{ name: 'package/l', type: '2' }], 'unsupported entry type'],
    ['a path outside package/', [{ name: 'other/a.js', data: 'x' }], 'outside package/'],
    ['a parent segment', [{ name: 'package/../a.js', data: 'x' }], 'unsafe path'],
    ['an absolute path', [{ name: '/package/a.js', data: 'x' }], 'unsafe path'],
    ['package as a file', [{ name: 'package', data: 'x' }], 'package is a file'],
    ['a bad number', [{ ...file('a.js'), sizeField: 'zz' }], 'bad number'],
    ['a truncated entry', [{ ...file('a.js'), sizeField: '00000010000\0' }], 'truncated'],
    [
      'a malformed pax record',
      [{ name: 'p', type: 'x', data: 'zz path=a\n' }, file('a.js')],
      'malformed pax',
    ],
    [
      'a pax record cut short',
      [{ name: 'p', type: 'x', data: '99 path=a\n' }, file('a.js')],
      'malformed pax',
    ],
  ] as const)('refuses %s', (_name, items, message) => {
    expect(() => readTarGz(gz(items))).toThrow(message);
  });

  it('refuses a directory entry outside package/ and accepts the package directory', () => {
    expect(() => readTarGz(gz([{ name: 'elsewhere/', type: '5' }]))).toThrow('outside package/');
    expect(readTarGz(gz([{ name: 'package/', type: '5' }]))).toEqual([]);
  });

  it('refuses more entries than the limit and data that is not gzip', () => {
    const many = Array.from({ length: 20_001 }, (_unused, index) => file(`f${String(index)}`, ''));
    expect(() => readTarGz(gz(many))).toThrow('too many entries');
    expect(() => readTarGz(Buffer.from('not gzip'))).toThrow();
  });
});

describe('isSafeEntryPath', () => {
  it.each([
    ['a/b.js', true],
    ['a', true],
    ['', false],
    ['/a', false],
    ['a/', false],
    ['a//b', false],
    ['./a', false],
    ['a/../b', false],
    ['a\\b', false],
    ['C:/a', false],
    ['a\0b', false],
  ])('%j -> %s', (input, expected) => {
    expect(isSafeEntryPath(input)).toBe(expected);
  });
});

// ---- manifests ----------------------------------------------------------------

describe('isPublishable and supportsPlatform', () => {
  it('takes a publishConfig or a public package as publishable', () => {
    expect(isPublishable({ private: true })).toBe(false);
    expect(isPublishable({ private: true, publishConfig: { access: 'public' } })).toBe(true);
    expect(isPublishable({})).toBe(true);
    expect(isPublishable({ private: false })).toBe(true);
  });

  it('applies os and cpu with npm negation', () => {
    const win: PackageJson = { os: ['win32'], cpu: ['x64'] };
    expect(supportsPlatform(win, 'win32', 'x64')).toBe(true);
    expect(supportsPlatform(win, 'linux', 'x64')).toBe(false);
    expect(supportsPlatform(win, 'win32', 'arm64')).toBe(false);
    expect(supportsPlatform({}, 'linux', 'x64')).toBe(true);
    expect(supportsPlatform({ os: [] }, 'linux', 'x64')).toBe(true);
    expect(supportsPlatform({ os: ['!win32'] }, 'win32', 'x64')).toBe(false);
    expect(supportsPlatform({ os: ['!win32'] }, 'linux', 'x64')).toBe(true);
  });
});

describe('nativeSkipReason', () => {
  const addon: PackageJson = {
    os: ['win32'],
    cpu: ['x64'],
    exports: {
      './hudhud_win32_job.node': './hudhud_win32_job.node',
      './package.json': './package.json',
    },
  };

  it('skips a native platform package off its own platform, with the reason', () => {
    expect(nativeSkipReason(addon, 'linux')).toBe('native, built on win32 only');
    expect(nativeSkipReason(addon, 'darwin')).toBe('native, built on win32 only');
    expect(
      nativeSkipReason({ os: ['!linux'], exports: { './a': { default: './a.node' } } }, 'linux'),
    ).toBe('native, built on another platform only');
  });

  it('checks it on its own platform, whatever the cpu (a missing build is then a problem)', () => {
    expect(nativeSkipReason(addon, 'win32')).toBeNull();
    expect(nativeSkipReason({ exports: addon.exports }, 'linux')).toBeNull();
  });

  it('never skips a package without a native entry point', () => {
    const js: PackageJson = { os: ['win32'], exports: { '.': './index.js' } };
    expect(nativeSkipReason(js, 'linux')).toBeNull();
    expect(nativeSkipReason({ os: ['win32'] }, 'linux')).toBeNull();
    expect(nativeSkipReason({ os: ['win32'], exports: './a.node' }, 'linux')).toBeNull();
    expect(nativeSkipReason({ os: ['win32'], exports: ['./a.node'] }, 'linux')).toBeNull();
  });
});

describe('checkSourceManifest and checkPackedManifest', () => {
  it('refuses scripts that run while packing', () => {
    expect(checkSourceManifest({ scripts: { test: 'x' } })).toEqual([]);
    expect(checkSourceManifest({})).toEqual([]);
    expect(checkSourceManifest({ scripts: { prepack: 'x', postpack: 'y' } })).toEqual([
      'scripts.prepack would run while packing',
      'scripts.postpack would run while packing',
    ]);
  });

  const source: PackageJson = { name: 'p', version: '1.0.0' };

  it('accepts a resolved manifest', () => {
    expect(
      checkPackedManifest(source, {
        name: 'p',
        version: '1.0.0',
        dependencies: { a: '1.2.3', b: '^1.0.0' },
        scripts: { build: 'x' },
      }),
    ).toEqual([]);
  });

  it('flags another name or version, unresolved specifiers and install scripts', () => {
    expect(
      checkPackedManifest(source, {
        name: 'q',
        version: '2.0.0',
        dependencies: { a: 'workspace:*', b: 'catalog:', c: 'file:../c', d: 'link:../d' },
        optionalDependencies: { e: 'github:o/r' },
        peerDependencies: { f: 'git+https://example.org/f.git' },
        scripts: { postinstall: 'node x', prepare: 'y', install: 'z', preinstall: 'w' },
      }),
    ).toEqual([
      'package.json name q differs from the source',
      'package.json version 2.0.0 differs from the source',
      'dependencies.a is still workspace:* (pack must resolve it)',
      'dependencies.b is still catalog: (pack must resolve it)',
      'dependencies.c is still file:../c (pack must resolve it)',
      'dependencies.d is still link:../d (pack must resolve it)',
      'optionalDependencies.e is still github:o/r (pack must resolve it)',
      'peerDependencies.f is still git+https://example.org/f.git (pack must resolve it)',
      "scripts.preinstall would run on the consumer's install",
      "scripts.install would run on the consumer's install",
      "scripts.postinstall would run on the consumer's install",
      "scripts.prepare would run on the consumer's install",
    ]);
  });
});

// ---- file list ----------------------------------------------------------------

describe('repositorySlug and checkRepositoryFields (R6-4, R7-3)', () => {
  const SLUG = 'example-owner/hudhud';
  const linked = {
    name: '@hudhudjs/core',
    repository: {
      type: 'git',
      url: 'git+https://github.com/example-owner/hudhud.git',
      directory: 'packages/core',
    },
    homepage: 'https://github.com/example-owner/hudhud/tree/main/packages/core#readme',
    bugs: { url: 'https://github.com/example-owner/hudhud/issues' },
  } as PackageJson;

  it('takes the slug from GITHUB_REPOSITORY, else from the origin remote', () => {
    expect(repositorySlug(SLUG, 'https://github.com/other/x.git')).toBe(SLUG);
    expect(repositorySlug(undefined, 'https://github.com/example-owner/hudhud.git\n')).toBe(SLUG);
    expect(repositorySlug('', 'https://github.com/example-owner/hudhud')).toBe(SLUG);
    expect(repositorySlug(undefined, 'ssh://github.com/example-owner/hudhud.git')).toBeNull();
  });

  it('refuses anything that is not a GitHub repository slug', () => {
    expect(repositorySlug('owner/repo/extra', undefined)).toBeNull();
    expect(repositorySlug('../x', undefined)).toBeNull();
    expect(repositorySlug(undefined, undefined)).toBeNull();
    expect(repositorySlug(undefined, 'https://gitlab.com/example-owner/hudhud.git')).toBeNull();
    expect(repositorySlug(undefined, 'https://github.com/example-owner')).toBeNull();
    expect(repositorySlug(undefined, '/srv/mirror/hudhud.git')).toBeNull();
  });

  it('accepts the repository, homepage and bugs of the package directory', () => {
    expect(checkRepositoryFields(linked, 'packages/core', SLUG)).toEqual([]);
  });

  it('refuses a manifest without them, as npm trusted publishing would', () => {
    expect(checkRepositoryFields({ name: '@hudhudjs/core' }, 'packages/core', SLUG)).toEqual([
      'package.json repository must be { type: "git", url: "git+https://github.com/example-owner/hudhud.git", directory: "packages/core" }, is undefined',
      'package.json homepage must be https://github.com/example-owner/hudhud/tree/main/packages/core#readme, is undefined',
      'package.json bugs.url must be https://github.com/example-owner/hudhud/issues, is undefined',
    ]);
  });

  it('refuses another repository, a string form, another directory or another homepage', () => {
    const variants: PackageJson[] = [
      { ...linked, repository: 'github:example-owner/hudhud' } as PackageJson,
      {
        ...linked,
        repository: {
          type: 'git',
          url: 'git+https://github.com/someone/hudhud.git',
          directory: 'packages/core',
        },
      } as PackageJson,
      {
        ...linked,
        repository: {
          type: 'git',
          url: 'git+https://github.com/example-owner/hudhud.git',
          directory: 'packages/hudhud',
        },
      } as PackageJson,
      { ...linked, homepage: 'https://example.com' } as PackageJson,
      { ...linked, bugs: 'https://github.com/example-owner/hudhud/issues' } as PackageJson,
    ];
    for (const manifest of variants) {
      expect(checkRepositoryFields(manifest, 'packages/core', SLUG)).toHaveLength(1);
    }
  });
});

describe('coversPath', () => {
  it('covers a file, a directory and simple globs', () => {
    expect(coversPath('dist', 'dist/a.js')).toBe(true);
    expect(coversPath('dist/', 'dist/a/b.js')).toBe(true);
    expect(coversPath('dist', 'distant/a.js')).toBe(false);
    expect(coversPath('a.js', 'a.js')).toBe(true);
    expect(coversPath('*.node', 'x.node')).toBe(true);
    expect(coversPath('*.node', 'sub/x.node')).toBe(false);
    expect(coversPath('dist/*.js', 'dist/a.js')).toBe(true);
    expect(coversPath('a.b/*', 'a.b/c')).toBe(true);
    expect(coversPath('a.b/*', 'axb/c')).toBe(false);
  });
});

describe('checkFileList', () => {
  const manifest: PackageJson = {
    files: ['dist', './src', 'schemas', '!schemas/.baseline', '!**/*.tsbuildinfo'],
  };
  const good = [
    'package.json',
    'README.md',
    'LICENSE',
    'NOTICE',
    'dist/index.js',
    'src/index.ts',
    'schemas/a.json',
  ];

  it('accepts a clean package', () => {
    expect(checkFileList(manifest, good)).toEqual([]);
    expect(
      checkFileList(manifest, [
        ...good.filter((p) => p !== 'LICENSE'),
        'LICENSE.md',
        'CHANGELOG.md',
      ]),
    ).toEqual([]);
  });

  it('requires package.json, a README, a LICENSE and a NOTICE', () => {
    expect(checkFileList({}, [])).toEqual([
      'package.json is missing',
      'README is missing',
      'LICENSE is missing',
      'NOTICE is missing',
    ]);
    expect(checkFileList({}, ['package.json', 'README', 'LICENCE', 'NOTICE.md'])).toEqual([]);
  });

  it('flags a files entry that packs nothing', () => {
    expect(
      checkFileList(
        manifest,
        good.filter((p) => !p.startsWith('dist')),
      ),
    ).toContain('files entry dist matches nothing in the tarball (not built?)');
  });

  it('flags files outside the allowlist and negated paths', () => {
    const problems = checkFileList(manifest, [...good, 'extra/x.js', 'schemas/.baseline/a.json']);
    expect(problems).toContain('extra/x.js: not covered by the files allowlist');
    expect(problems).toContain('schemas/.baseline/a.json: not covered by the files allowlist');
    expect(problems).toContain('schemas/.baseline/a.json: the schema baseline');
  });

  it.each([
    ['test/a.js', 'a test, fixture or tooling directory'],
    ['dist/__tests__/a.js', 'a test, fixture or tooling directory'],
    ['conformance/x.jsonl', 'a test, fixture or tooling directory'],
    ['dist/a.test.js', 'a test file'],
    ['dist/a.spec.ts', 'a test file'],
    ['dist/a.test.js.map', 'a test file'],
    ['dist/.tsbuildinfo', 'TypeScript build info'],
    ['.env', 'an environment file'],
    ['.env.local', 'an environment file'],
    ['key.pem', 'a key or certificate file'],
    ['id_rsa', 'a key or certificate file'],
    ['npm-debug.log', 'a log file'],
    ['.DS_Store', 'an editor or OS file'],
    ['a.js~', 'an editor or OS file'],
    ['.gitignore', 'a git or npm configuration file'],
    ['.npmrc', 'a git or npm configuration file'],
  ])('flags %s as %s', (path, label) => {
    expect(
      checkFileList({ files: [path] }, ['package.json', 'README', 'LICENSE', 'NOTICE', path]),
    ).toContain(`${path}: ${label}`);
  });

  it('treats a manifest without files as allowing only the always-included files', () => {
    expect(checkFileList({}, ['package.json', 'README', 'LICENSE', 'NOTICE', 'x.js'])).toEqual([
      'x.js: not covered by the files allowlist',
    ]);
  });
});

// ---- source maps --------------------------------------------------------------

describe('resolveInside and checkSourceMap', () => {
  it('resolves against the directory of the map and refuses to leave the package', () => {
    expect(resolveInside('dist/a/b.js.map', '../../src/a/b.ts')).toBe('src/a/b.ts');
    expect(resolveInside('dist/b.js.map', './x//y.ts')).toBe('dist/x/y.ts');
    expect(resolveInside('b.js.map', '../x')).toBeNull();
    expect(resolveInside('dist/b.js.map', '../../x')).toBeNull();
  });

  const map = (sources: unknown, extra: object = {}): string =>
    JSON.stringify({ version: 3, sources, ...extra });

  const packed = new Set(['src/a.ts', 'dist/a.js', 'dist/a.js.map']);

  it('accepts relative sources inside the package that are packed', () => {
    expect(checkSourceMap('dist/a.js.map', map(['../src/a.ts']), packed)).toEqual([]);
    expect(
      checkSourceMap('dist/a.js.map', map(['../src/a.ts'], { sourceRoot: '' }), packed),
    ).toEqual([]);
  });

  it('flags a source that is not in the tarball (R7-6: src dropped from files)', () => {
    expect(checkSourceMap('dist/index.js.map', map(['../src/absent.ts']), packed)).toEqual([
      'dist/index.js.map: source "../src/absent.ts" (src/absent.ts) is not in the tarball',
    ]);
    expect(
      checkSourceMap('dist/a.js.map', map(['../src/a.ts']), new Set(['dist/a.js.map'])),
    ).toEqual(['dist/a.js.map: source "../src/a.ts" (src/a.ts) is not in the tarball']);
  });

  it('flags unreadable maps and unsafe sources', () => {
    expect(checkSourceMap('m.map', 'nope', packed)).toEqual(['m.map: not valid JSON']);
    expect(checkSourceMap('m.map', 'null', packed)).toEqual(['m.map: not a source map']);
    expect(checkSourceMap('m.map', '{}', packed)).toEqual(['m.map: no sources list']);
    expect(
      checkSourceMap('dist/m.map', map(['../src/a.ts'], { sourceRoot: '/x' }), packed),
    ).toEqual(['dist/m.map: has a sourceRoot']);
    expect(
      checkSourceMap(
        'dist/m.map',
        map([1, 'C:\\x\\a.ts', '/srv/u/a.ts', 'file:///a.ts', '..\\a.ts', '../../../a.ts']),
        packed,
      ),
    ).toEqual([
      'dist/m.map: a source is not a string',
      'dist/m.map: absolute or non-portable source "C:\\\\x\\\\a.ts"',
      'dist/m.map: absolute or non-portable source "/srv/u/a.ts"',
      'dist/m.map: absolute or non-portable source "file:///a.ts"',
      'dist/m.map: absolute or non-portable source "..\\\\a.ts"',
      'dist/m.map: source "../../../a.ts" lies outside the package',
    ]);
  });
});

// ---- content ------------------------------------------------------------------

const entry = (path: string, data: string | Buffer): TarEntry => ({
  path,
  data: Buffer.from(data),
  mode: 0o644,
});

describe('looksLikeText and scanEntries', () => {
  it('tells text from binary', () => {
    expect(looksLikeText(Buffer.from('plain'))).toBe(true);
    expect(looksLikeText(Buffer.from([1, 0, 2]))).toBe(false);
  });

  it('finds the strings of the build machine in any spelling, without repeating them', () => {
    const forbidden = ['D:\\build\\hudhud', 'secret-machine-name', ''];
    const problems = scanEntries(
      [
        entry('a.js', 'const p = "D:/build/hudhud/x";'),
        entry('b.js', JSON.stringify({ p: 'D:\\build\\hudhud' })),
        entry('c.js', 'Secret-Machine-Name'),
        entry('d.js', 'clean'),
        entry('e.bin', Buffer.from([0, 1, 2])),
      ],
      forbidden,
    );
    expect(problems).toEqual([
      'a.js: contains a path or string of the build machine',
      'b.js: contains a path or string of the build machine',
      'c.js: contains a path or string of the build machine',
    ]);
  });

  it('applies the repository privacy rules and names file, line and rule only', () => {
    const home = ['C:', 'Users', 'someone', 'x'].join('\\');
    const problems = scanEntries([entry('src/a.ts', `ok\n// ${home}\n`)], []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^src\/a\.ts:2: privacy rule /);
    expect(problems[0]).not.toContain('someone');
  });

  it('refuses to skip a file too large to scan', () => {
    const big = Buffer.alloc(MAX_SCAN_BYTES + 1, 0x61);
    expect(scanEntries([entry('big.js', big)], [])).toEqual([
      `big.js: too large to scan (${String(MAX_SCAN_BYTES + 1)} bytes)`,
    ]);
  });
});

// ---- exports ------------------------------------------------------------------

describe('listEntryPoints', () => {
  const manifest: PackageJson = {
    name: '@s/p',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './raw': { types: { types: './dist/raw.d.ts' }, default: { default: './dist/raw.js' } },
      './schemas/*': './schemas/*.json',
      './schemas/*.json': './schemas/*.json',
      './package.json': './package.json',
    },
  };
  const paths = [
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/raw.js',
    'dist/raw.d.ts',
    'schemas/a.json',
    'schemas/b.json',
    'schemas/notes.txt',
  ];

  it('lists subpaths, expands patterns and types the JS entries', () => {
    expect(listEntryPoints(manifest, paths)).toEqual({
      problems: [],
      entries: [
        { specifier: '@s/p', kind: 'js', runtime: 'dist/index.js', types: 'dist/index.d.ts' },
        { specifier: '@s/p/raw', kind: 'js', runtime: 'dist/raw.js', types: 'dist/raw.d.ts' },
        { specifier: '@s/p/schemas/a', kind: 'json', runtime: 'schemas/a.json' },
        { specifier: '@s/p/schemas/b', kind: 'json', runtime: 'schemas/b.json' },
        { specifier: '@s/p/schemas/a.json', kind: 'json', runtime: 'schemas/a.json' },
        { specifier: '@s/p/schemas/b.json', kind: 'json', runtime: 'schemas/b.json' },
        { specifier: '@s/p/package.json', kind: 'json', runtime: 'package.json' },
      ],
    });
  });

  it('flags missing targets, a pattern that matches nothing and malformed maps', () => {
    const result = listEntryPoints(manifest, ['package.json']);
    expect(result.problems).toEqual([
      'exports .: dist/index.js is not in the tarball',
      'exports .: types dist/index.d.ts is not in the tarball',
      'exports ./raw: dist/raw.js is not in the tarball',
      'exports ./raw: types dist/raw.d.ts is not in the tarball',
      'exports ./schemas/* matches no file',
      'exports ./schemas/*.json matches no file',
    ]);
    expect(listEntryPoints({ name: 'p' }, []).problems).toEqual([
      'exports must be an object of subpaths',
    ]);
    expect(listEntryPoints({ name: 'p', exports: [] }, []).problems).toEqual([
      'exports must be an object of subpaths',
    ]);
    expect(listEntryPoints({ name: 'p', exports: {} }, []).problems).toEqual([
      'exports lists no entry point',
    ]);
    expect(
      listEntryPoints({ name: 'p', exports: { x: './x.js', './y': { types: './y.d.ts' } } }, [])
        .problems,
    ).toEqual(['exports key x is not a subpath', 'exports ./y has no default target']);
  });

  it('looks through a default condition for types and takes a plain string target', () => {
    const nested: PackageJson = {
      name: 'p',
      exports: {
        '.': { default: { types: './a.d.ts', default: './a.js' } },
        './b': './b.js',
        './c': ['./c.js'],
        './d': { import: { types: './d.d.ts' }, default: './d.js' },
        './lib/*': './lib/*.js',
        './e': { import: './e.js', default: { types: './e.d.ts', default: './e.js' } },
      },
    };
    const result = listEntryPoints(nested, [
      'a.js',
      'a.d.ts',
      'b.js',
      'd.js',
      'd.d.ts',
      'lib/x.js',
      'e.js',
      'e.d.ts',
    ]);
    expect(result.entries).toEqual([
      { specifier: 'p', kind: 'js', runtime: 'a.js', types: 'a.d.ts' },
      { specifier: 'p/b', kind: 'js', runtime: 'b.js' },
      { specifier: 'p/d', kind: 'js', runtime: 'd.js', types: 'd.d.ts' },
      { specifier: 'p/lib/x', kind: 'js', runtime: 'lib/x.js' },
      { specifier: 'p/e', kind: 'js', runtime: 'e.js', types: 'e.d.ts' },
    ]);
    expect(result.problems).toEqual(['exports ./c has no default target']);
  });

  it('lists a native addon subpath as native, never as JS to import', () => {
    const platform: PackageJson = {
      name: '@s/addon-x64',
      exports: {
        './a.node': './a.node',
        './bin/*': './bin/*.node',
        './package.json': './package.json',
      },
    };
    expect(listEntryPoints(platform, ['package.json', 'a.node', 'bin/b.node'])).toEqual({
      problems: [],
      entries: [
        { specifier: '@s/addon-x64/a.node', kind: 'native', runtime: 'a.node' },
        { specifier: '@s/addon-x64/bin/b', kind: 'native', runtime: 'bin/b.node' },
        { specifier: '@s/addon-x64/package.json', kind: 'json', runtime: 'package.json' },
      ],
    });
    expect(listEntryPoints(platform, ['package.json', 'bin/b.node']).problems).toEqual([
      'exports ./a.node: a.node is not in the tarball',
    ]);
  });
});

describe('checkSchemaSpecifiers', () => {
  const a = { specifier: 'p/schemas/a', kind: 'json' as const, runtime: 'schemas/a.json' };
  const aJson = { specifier: 'p/schemas/a.json', kind: 'json' as const, runtime: 'schemas/a.json' };

  it('wants every schema importable by its file name', () => {
    expect(checkSchemaSpecifiers('p', [a, aJson])).toEqual([]);
    expect(checkSchemaSpecifiers('p', [a])).toEqual([
      'p/schemas/a.json is not importable (the exports map lacks it)',
    ]);
  });

  it('ignores files outside schemas/ and entries that are not JSON', () => {
    expect(
      checkSchemaSpecifiers('p', [
        { specifier: 'p/package.json', kind: 'json', runtime: 'package.json' },
        { specifier: 'p', kind: 'js', runtime: 'dist/index.js' },
        { specifier: 'p/x', kind: 'json' },
      ]),
    ).toEqual([]);
  });
});

// ---- one tarball --------------------------------------------------------------

const LICENSE_TEXT = 'Apache License 2.0';
const NOTICE_TEXT = 'hudhud\nCopyright\n';
const LEGAL = [
  { label: 'LICENSE' as const, data: Buffer.from(LICENSE_TEXT) },
  { label: 'NOTICE' as const, data: Buffer.from(NOTICE_TEXT) },
];

describe('checkRequiredFiles and checkLegalFiles', () => {
  it('names each required file that no path matches', () => {
    expect(checkRequiredFiles(['README.md', 'LICENSE', 'NOTICE'])).toEqual([]);
    expect(checkRequiredFiles(['README.md'])).toEqual(['LICENSE is missing', 'NOTICE is missing']);
  });

  it('accepts copies equal to the repository files and leaves absence to checkRequiredFiles', () => {
    expect(
      checkLegalFiles([entry('LICENSE', LICENSE_TEXT), entry('NOTICE', NOTICE_TEXT)], LEGAL),
    ).toEqual([]);
    expect(checkLegalFiles([entry('README.md', 'x')], LEGAL)).toEqual([]);
  });

  it('names every LICENSE that differs and every NOTICE that does not begin with the root file', () => {
    expect(
      checkLegalFiles(
        [
          entry('LICENSE', LICENSE_TEXT),
          entry('LICENCE.md', 'other'),
          entry('NOTICE', `${NOTICE_TEXT} `),
          entry('NOTICE.md', `x${NOTICE_TEXT}`),
          entry('NOTICE.txt', NOTICE_TEXT.slice(1)),
          entry('dist/NOTICE', 'not at the root'),
        ],
        LEGAL,
      ),
    ).toEqual([
      "LICENCE.md differs from the repository's LICENSE",
      "NOTICE.md does not begin with the repository's NOTICE",
      "NOTICE.txt does not begin with the repository's NOTICE",
    ]);
  });

  it('accepts a NOTICE that adds third-party notices after the root text (R6-2)', () => {
    expect(
      checkLegalFiles([entry('NOTICE', `${NOTICE_TEXT}\n--- ajv ---\n\nMIT\n`)], LEGAL),
    ).toEqual([]);
  });

  it("finds the packages a bundle includes by esbuild's node_modules markers", () => {
    expect(
      bundledPackages(
        [
          '// node_modules/ajv/dist/runtime/ucs2length.js',
          'var a = require_ucs2length();',
          '// node_modules/fast-deep-equal/index.js',
          '// node_modules/ajv/dist/runtime/equal.js',
          '// node_modules/@scope/pkg/index.js',
          '  "node_modules/ajv/dist/runtime/equal.js"(exports) {',
          'const s = "// node_modules/not-a-marker/x.js";',
        ].join('\n'),
      ),
    ).toEqual(['@scope/pkg', 'ajv', 'fast-deep-equal']);
    expect(bundledPackages('export {};')).toEqual([]);
  });

  it('refuses a label that is not a legal file', () => {
    expect(() =>
      checkLegalFiles([], [{ label: 'COPYING' as 'NOTICE', data: Buffer.from('') }]),
    ).toThrow('not a legal file: COPYING');
  });
});

describe('checkTarball', () => {
  const source: PackageJson = {
    name: 'p',
    version: '1.0.0',
    files: ['dist', 'src'],
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  };
  const packed = JSON.stringify(source);
  const clean = [
    file('package.json', packed),
    file('README.md'),
    file('LICENSE', LICENSE_TEXT),
    file('NOTICE', NOTICE_TEXT),
    file('dist/index.js', 'export {}'),
    file('dist/index.d.ts', 'export {}'),
    file('dist/index.js.map', JSON.stringify({ sources: ['../src/index.ts'] })),
    file('src/index.ts', 'export {};'),
  ];

  it('passes a clean tarball and lists its entry points', () => {
    const report = checkTarball(source, gz(clean), [], LEGAL);
    expect(report.problems).toEqual([]);
    expect(checkTarball(source, gz(clean), []).problems).toEqual([]);
    expect(report.paths).toContain('dist/index.js');
    expect(report.entryPoints).toEqual([
      { specifier: 'p', kind: 'js', runtime: 'dist/index.js', types: 'dist/index.d.ts' },
    ]);
  });

  it('reports a source map whose source is not packed (R7-6)', () => {
    const withoutSrc = clean.filter((item) => item.name !== 'package/src/index.ts');
    expect(checkTarball({ ...source, files: ['dist'] }, gz(withoutSrc), []).problems).toEqual([
      'dist/index.js.map: source "../src/index.ts" (src/index.ts) is not in the tarball',
    ]);
  });

  it('reports a LICENSE or NOTICE that is not the repository file', () => {
    const drifted = clean.map((item) =>
      item.name === 'package/NOTICE' ? file('NOTICE', 'Copyright someone else') : item,
    );
    expect(checkTarball(source, gz(drifted), [], LEGAL).problems).toEqual([
      "NOTICE does not begin with the repository's NOTICE",
    ]);
  });

  it('reports bundled third-party code that NOTICE does not list (R6-2)', () => {
    const bundle = '// node_modules/ajv/dist/runtime/equal.js\nvar x;\n';
    const bundled = [
      ...clean,
      file('src/generated/v.gen.ts', bundle),
      file('dist/generated/v.gen.js', bundle),
    ];
    expect(checkTarball(source, gz(bundled), [], LEGAL).problems).toEqual([
      'src/generated/v.gen.ts bundles code of ajv, which NOTICE does not list (--- ajv --- and its license)',
    ]);
    const listed = bundled.map((item) =>
      item.name === 'package/NOTICE'
        ? file('NOTICE', `${NOTICE_TEXT}\n--- ajv ---\n\nMIT\n`)
        : item,
    );
    expect(checkTarball(source, gz(listed), [], LEGAL).problems).toEqual([]);
  });

  it('collects the problems of every stage', () => {
    const report = checkTarball(
      source,
      gz([
        file(
          'package.json',
          JSON.stringify({ name: 'q', version: '1.0.0', dependencies: { a: 'workspace:*' } }),
        ),
        file('dist/index.js', 'D:/machine/x'),
        file('dist/bad.js.map', JSON.stringify({ sources: ['/abs/a.ts'] })),
      ]),
      ['D:\\machine'],
    );
    expect(report.problems).toEqual(
      expect.arrayContaining([
        'README is missing',
        'package.json name q differs from the source',
        'dependencies.a is still workspace:* (pack must resolve it)',
        expect.stringContaining('absolute or non-portable source'),
        'dist/index.js: contains a path or string of the build machine',
      ]),
    );
  });

  it('reports a tarball that cannot be read and a package.json that is not JSON', () => {
    expect(checkTarball(source, Buffer.from('nope'), []).problems[0]).toMatch(
      /^cannot read the tarball: /,
    );
    const report = checkTarball(
      source,
      gz([file('package.json', '{'), file('README'), file('LICENSE'), file('dist/x.js')]),
      [],
    );
    expect(report.problems).toContain('package.json is not valid JSON');
    expect(report.problems).toContain(
      'exports ./: dist/index.js is not in the tarball'.replace('./:', '.:'),
    );
  });

  it('reports a tarball without package.json', () => {
    const report = checkTarball(
      source,
      gz([file('README'), file('LICENSE'), file('dist/index.js')]),
      [],
    );
    expect(report.problems).toContain('package.json is missing');
  });
});

// ---- consumer project ---------------------------------------------------------

describe('parseImportResults and checkImports', () => {
  const entries = [
    { specifier: 'p', kind: 'js' as const },
    { specifier: 'p/x', kind: 'js' as const },
  ];
  const base = 'file:///proj/node_modules/';

  it('reads the child output', () => {
    expect(parseImportResults('{"a":{"ok":true,"url":"u","names":["x"]}}')).toEqual({
      a: { ok: true, url: 'u', names: ['x'] },
    });
    expect(parseImportResults('{}')).toEqual({});
  });

  it.each(['nope', '[]', 'null', '{"a":1}', '{"a":null}'])(
    'refuses the child output %j',
    (text) => {
      expect(() => parseImportResults(text)).toThrow(/import child/);
    },
  );

  it('accepts imports from the installed packages', () => {
    expect(
      checkImports(
        entries,
        {
          p: { ok: true, url: `${base}p/dist/index.js`, names: ['a'] },
          'p/x': { ok: true, url: `${base}p/dist/x.js`, names: ['b'] },
        },
        base,
      ),
    ).toEqual([]);
  });

  it('flags a missing, failed, misplaced or empty import', () => {
    expect(
      checkImports(
        [
          ...entries,
          { specifier: 'p/y', kind: 'js' as const },
          { specifier: 'p/z', kind: 'js' as const },
        ],
        {
          p: { ok: false, code: 'ERR_MODULE_NOT_FOUND' },
          'p/x': { ok: true, url: 'file:///repo/packages/p/dist/x.js', names: ['b'] },
          'p/y': { ok: true, url: `${base}p/y.js` },
        },
        base,
      ),
    ).toEqual([
      'p: import failed (ERR_MODULE_NOT_FOUND)',
      'p/x: resolved outside the installed packages',
      'p/y: exports nothing',
      'p/z: not imported',
    ]);
    expect(checkImports(entries.slice(0, 1), { p: { ok: true, names: ['a'] } }, base)).toEqual([
      'p: resolved outside the installed packages',
    ]);
  });

  it('ships a child that imports with the resolver of the consumer', () => {
    expect(IMPORT_CHILD).toContain('import.meta.resolve(specifier)');
    expect(IMPORT_CHILD).toContain('HUDHUD_TARBALL_SPECIFIERS');
    expect(IMPORT_CHILD).toContain("{ with: { type: 'json' } }");
  });

  // R5-6: `./schemas/*` mapped `x.json` to `x.json.json`; an import pinned to
  // the file the exports map names catches a specifier that resolves elsewhere.
  it('pins an entry that names its package to the exact file', () => {
    const json = {
      specifier: '@s/p/schemas/a.json',
      kind: 'json' as const,
      runtime: 'schemas/a.json',
      packageName: '@s/p',
    };
    expect(
      checkImports(
        [json],
        { [json.specifier]: { ok: true, url: `${base}@s/p/schemas/a.json`, names: ['default'] } },
        base,
      ),
    ).toEqual([]);
    expect(
      checkImports(
        [json],
        {
          [json.specifier]: {
            ok: true,
            url: `${base}@s/p/schemas/a.json.json`,
            names: ['default'],
          },
        },
        base,
      ),
    ).toEqual([
      `@s/p/schemas/a.json: resolved to ${base}@s/p/schemas/a.json.json, not schemas/a.json`,
    ]);
  });
});

describe('renderTypeProject', () => {
  it('renders a strict NodeNext project that imports every specifier', () => {
    const { tsconfig, source } = renderTypeProject(
      ['@s/p', '@s/p/raw'],
      '/repo/node_modules/@types',
    );
    const config = JSON.parse(tsconfig) as {
      compilerOptions: Record<string, unknown>;
      files: string[];
    };
    expect(config.compilerOptions).toMatchObject({
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      skipLibCheck: false,
      types: ['node'],
      typeRoots: ['/repo/node_modules/@types'],
    });
    expect(config.files).toEqual(['check.ts']);
    expect(source).toBe(
      'import * as m0 from "@s/p";\nimport * as m1 from "@s/p/raw";\nexport const all = [m0, m1];\n',
    );
    expect(tsconfig.endsWith('\n')).toBe(true);
  });
});

describe('cleanEnv', () => {
  const parent = {
    PATH: '/bin',
    LANG: 'C',
    LC_ALL: 'C',
    NPM_TOKEN: 'x',
    NODE_AUTH_TOKEN: 'y',
    HOME: '/srv/someone',
    Path: 'P',
    SystemRoot: 'S',
  };

  it('keeps only what a tool needs on POSIX and points npm at the temporary root', () => {
    const env = cleanEnv(parent, '/tmp/root', 'linux');
    expect(env).toEqual({
      npm_config_userconfig: '/tmp/root/user.npmrc',
      npm_config_globalconfig: '/tmp/root/global.npmrc',
      npm_config_cache: '/tmp/root/npm-cache',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      HOME: '/tmp/root',
      TMPDIR: '/tmp/root',
      PATH: '/bin',
      LANG: 'C',
      LC_ALL: 'C',
    });
  });

  it('keeps the Windows system variables and moves the profile to the root', () => {
    const env = cleanEnv(parent, 'C:/root', 'win32');
    expect(env).toMatchObject({
      Path: 'P',
      SystemRoot: 'S',
      USERPROFILE: 'C:/root',
      TEMP: 'C:/root',
      TMP: 'C:/root',
      APPDATA: 'C:/root/appdata',
      LOCALAPPDATA: 'C:/root/localappdata',
      HOME: 'C:/root',
    });
    expect(env).not.toHaveProperty('NPM_TOKEN');
    expect(env).not.toHaveProperty('NODE_AUTH_TOKEN');
    expect(env).not.toHaveProperty('LANG');
  });
});

describe('rootProblem', () => {
  const parentOf = (dir: string): string =>
    dir === '/' ? '/' : dir.slice(0, dir.lastIndexOf('/')) || '/';
  const inside = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`);

  it('accepts a clean root', () => {
    expect(rootProblem('/tmp/x/root', '/repo', () => false, inside, parentOf)).toBeNull();
  });

  it('refuses a root inside the repository', () => {
    expect(rootProblem('/repo/tmp/root', '/repo', () => false, inside, parentOf)).toBe(
      'the temporary root lies inside the repository',
    );
  });

  it('refuses a root under an ancestor that would change resolution', () => {
    const problem = rootProblem('/tmp/x/root', '/repo', (dir) => dir === '/tmp', inside, parentOf);
    expect(problem).toContain('an ancestor of the temporary root (/tmp)');
    expect(problem).toContain('HUDHUD_TEST_ROOT');
    expect(rootProblem('/a', '/repo', (dir) => dir === '/', inside, parentOf)).toContain('(/)');
  });
});
