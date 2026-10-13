// The loader's strictness (W4-T2 "no silent skips"): every way the data can
// drift from the catalogue, the manifest or the line format fails the load,
// with every problem listed. Synthetic data directories, one per case.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import type { SuiteDeclaration } from './catalogue.js';
import {
  CONFORMANCE_ROOT,
  ConformanceDataError,
  decodeStored,
  expectFileOf,
  loadConformanceSuites,
  pinnedCliVersion,
  recordFileOf,
  type LoadOptions,
} from './loader.js';

const VERSION = '9.9.9';

const DEMO: SuiteDeclaration = {
  name: 'demo',
  source: 'test',
  platforms: ['linux'],
  cases: ['main'],
  declared: {},
};

type Json = Record<string, unknown>;

function entry(overrides: Json = {}): Json {
  return {
    suite: 'demo',
    case: 'main',
    file: 'demo/linux.jsonl',
    platform: 'linux',
    cliVersion: VERSION,
    scenario: 'a demo',
    research: '05 §5',
    recordedOn: '2026-10-13',
    recorder: 'test',
    recorderRevision: 'abcdef0',
    exit: { code: 0, signal: null },
    compressed: false,
    shapeMissing: [],
    ...overrides,
  };
}

function records(platform = 'linux'): Json[] {
  return [
    {
      t: 0,
      dir: 'config',
      v: { suite: 'demo', case: 'main', platform, argv: ['--verbose'], env: {} },
    },
    {
      t: 1,
      dir: 'in',
      v: { type: 'control_request', request_id: 'init_1', request: { subtype: 'initialize' } },
    },
    { t: 2, dir: 'out', v: { type: 'control_response', response: { subtype: 'success' } } },
    { t: 3, dir: 'err', v: 'warning\n' },
    { t: 4, dir: 'cmd', v: { stdin: 'eof' } },
    { t: 5, dir: 'exit', v: { code: 0, signal: null } },
  ];
}

function jsonl(lines: readonly unknown[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

const EMPTY_EXPECT = { dir: 'expect', effects: [], events: [] };

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

interface Data {
  readonly manifest?: unknown;
  readonly files?: Readonly<Record<string, string | Buffer>>;
}

/** A data directory: by default one valid demo recording with its expect file. */
function dataDir(data: Data = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hudhud-conformance-'));
  roots.push(root);
  const manifest = data.manifest ?? { $comment: 'c', format: 'f', entries: [entry()] };
  const files = data.files ?? {
    'demo/linux.jsonl': jsonl(records()),
    'demo/linux.expect.jsonl': jsonl(records().map(() => EMPTY_EXPECT)),
  };
  writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}

function load(root: string, options: Partial<LoadOptions> = {}) {
  return loadConformanceSuites({ root, catalogue: [DEMO], cliVersion: VERSION, ...options });
}

/** The problems a load reports. */
function problems(root: string, options: Partial<LoadOptions> = {}): readonly string[] {
  try {
    load(root, options);
  } catch (error) {
    if (error instanceof ConformanceDataError) return error.problems;
    throw error;
  }
  throw new Error('the load did not fail');
}

describe('loadConformanceSuites', () => {
  it('loads a valid directory with typed variants in catalogue order', () => {
    const [suite] = load(dataDir());
    expect(suite?.name).toBe('demo');
    expect(suite?.variants).toHaveLength(1);
    const variant = suite?.variants[0];
    expect(variant).toMatchObject({
      id: 'demo/linux',
      suite: 'demo',
      case: 'main',
      platform: 'linux',
      launch: { argv: ['--verbose'] },
    });
    expect(variant?.records).toHaveLength(6);
    expect(variant?.expect).toHaveLength(6);
    expect(variant?.expectFile.endsWith(path.join('demo', 'linux.expect.jsonl'))).toBe(true);
  });

  it('orders platforms and cases as the catalogue does', () => {
    const both: SuiteDeclaration = {
      ...DEMO,
      platforms: ['win32', 'linux'],
      cases: ['setup', 'main'],
    };
    const files: Record<string, string> = {};
    const entries: Json[] = [];
    for (const platform of ['linux', 'win32']) {
      for (const caseName of ['main', 'setup']) {
        const file = recordFileOf('demo', platform, caseName, false);
        const lines = records(platform).map((line, index) =>
          index === 0 ? { ...line, v: { ...(line['v'] as Json), case: caseName } } : line,
        );
        files[file] = jsonl(lines);
        files[expectFileOf(file)] = jsonl(lines.map(() => EMPTY_EXPECT));
        entries.push(entry({ file, platform, case: caseName }));
      }
    }
    const [suite] = load(dataDir({ manifest: { $comment: '', format: '', entries }, files }), {
      catalogue: [both],
    });
    expect(suite?.variants.map((variant) => variant.id)).toEqual([
      'demo/win32.setup',
      'demo/win32',
      'demo/linux.setup',
      'demo/linux',
    ]);
  });

  it('fails a suite without expectations, unless the update mode ignores them', () => {
    const root = dataDir({ files: { 'demo/linux.jsonl': jsonl(records()) } });
    expect(problems(root)).toEqual([
      'demo/linux.expect.jsonl: missing (the suite has no expectations)',
    ]);
    const [suite] = load(root, { expectations: 'ignored' });
    expect(suite?.variants[0]?.expect).toBeUndefined();
    // Stale expect files (the update mode after a re-recording) are not read.
    const stale = dataDir({
      files: { 'demo/linux.jsonl': jsonl(records()), 'demo/linux.expect.jsonl': 'stale\n' },
    });
    expect(load(stale, { expectations: 'ignored' })[0]?.variants[0]?.expect).toBeUndefined();
  });

  it('fails data without a manifest entry, and a directory outside the catalogue', () => {
    const root = dataDir({
      files: {
        'demo/linux.jsonl': jsonl(records()),
        'demo/linux.expect.jsonl': jsonl(records().map(() => EMPTY_EXPECT)),
        'demo/win32.jsonl': jsonl(records()),
        'other/linux.jsonl': '',
      },
    });
    expect(problems(root)).toEqual([
      'demo/win32.jsonl: no manifest entry lists it',
      'other/linux.jsonl: no manifest entry lists it',
      'other/: not a catalogue suite',
    ]);
  });

  it('fails a manifest entry without data and a catalogue recording without an entry', () => {
    expect(problems(dataDir({ files: {} }))).toEqual(['demo/linux.jsonl: missing']);
    expect(
      problems(dataDir({ manifest: { $comment: '', format: '', entries: [] }, files: {} })),
    ).toEqual(['demo: no linux main recording']);
  });

  it('fails a recording the catalogue does not declare, or stored otherwise', () => {
    const extra = dataDir({
      manifest: {
        $comment: '',
        format: '',
        entries: [entry(), entry({ case: 'setup', file: 'demo/linux.setup.jsonl' })],
      },
      files: {
        'demo/linux.jsonl': jsonl(records()),
        'demo/linux.expect.jsonl': jsonl(records().map(() => EMPTY_EXPECT)),
        'demo/linux.setup.jsonl': jsonl(records()),
      },
    });
    expect(problems(extra)).toEqual([
      'demo/linux.setup.jsonl: platform or case not declared in the catalogue',
    ]);
    expect(problems(dataDir(), { catalogue: [{ ...DEMO, compressed: true }] })).toEqual([
      'demo/linux.jsonl: compression differs from the catalogue',
    ]);
  });

  it('checks the manifest strictly: fields, versions, revisions, shapes, names', () => {
    expect(problems(dataDir({ manifest: [] }))).toEqual(['manifest.json: not an object']);
    expect(problems(dataDir({ manifest: { $comment: '', format: '', entries: {} } }))).toEqual([
      'manifest.json: entries is not an array',
    ]);
    const bad = dataDir({
      manifest: {
        $comment: '',
        extra: 1,
        entries: [
          entry({ cliVersion: '1.0.0', recorderRevision: 'HEAD', recordedOn: 'today' }),
          entry({ shapeMissing: ['out result'], typo: 1 }),
          entry({ exit: { code: 'x' }, compressed: 'no', platform: 'beos' }),
          entry({ file: 'demo/wrong.jsonl', orphansSelfExited: [1] }),
          entry({ scenario: '' }),
          entry({ shapeMissing: 'none' }),
          'not an entry',
        ],
      },
    });
    expect(problems(bad)).toEqual([
      'manifest.json: unknown field extra',
      'manifest.json: missing field format',
      'manifest.json demo/linux.jsonl: cliVersion "1.0.0" is not the pinned 9.9.9',
      'manifest.json demo/linux.jsonl: recordedOn is not a YYYY-MM-DD date',
      'manifest.json demo/linux.jsonl: recorderRevision is not a git revision',
      'manifest.json demo/linux.jsonl: unknown field typo',
      'manifest.json demo/linux.jsonl: the recording departed from the research: out result',
      'manifest.json demo/linux.jsonl: unknown platform "beos"',
      'manifest.json demo/linux.jsonl: exit is not {code, signal}',
      'manifest.json demo/linux.jsonl: compressed is not a boolean',
      'manifest.json demo/wrong.jsonl: orphansSelfExited is not a string array',
      'manifest.json demo/linux.jsonl: scenario is not a non-empty string',
      'manifest.json demo/linux.jsonl: shapeMissing is not a string array',
      'an entry is not an object',
      // Every entry after the first of the same file (four here).
      ...Array.from({ length: 4 }, () => 'manifest.json: demo/linux.jsonl is listed twice'),
    ]);
    expect(
      problems(
        dataDir({
          manifest: { $comment: '', format: '', entries: [entry({ file: 'demo/x.jsonl' })] },
        }),
      ),
    ).toEqual(['manifest.json demo/x.jsonl: file is not demo/linux.jsonl']);
  });

  it('fails without a manifest', () => {
    const root = dataDir();
    rmSync(path.join(root, 'manifest.json'));
    expect(problems(root)).toEqual(['manifest.json: missing']);
  });

  it('checks the record lines strictly', () => {
    const cases: [Json[] | string, string[]][] = [
      ['{"t":0\n', ['demo/linux.jsonl:1: not JSON']],
      ['[1]\n', ['demo/linux.jsonl:1: not an object']],
      [
        [{ t: 0, dir: 'config', v: {}, extra: 1 }],
        [
          'demo/linux.jsonl:1: not a conformance.schema.json record line',
          'demo/linux.jsonl:1: unknown field extra',
        ],
      ],
      [
        [...records().slice(0, 2), { t: -1, dir: 'sideways', v: 1 }, ...records().slice(2)],
        [
          'demo/linux.jsonl:3: not a conformance.schema.json record line',
          'demo/linux.jsonl:3: t is not a time',
          'demo/linux.jsonl:3: unknown dir "sideways"',
        ],
      ],
      [
        [...records().slice(1, 2), ...records().slice(0, 1), ...records().slice(2)],
        [
          'demo/linux.jsonl:1: the config line must be the first line, and only it',
          'demo/linux.jsonl:2: t goes back',
          'demo/linux.jsonl:2: the config line must be the first line, and only it',
        ],
      ],
      [records().slice(0, -1), ['demo/linux.jsonl: 0 exit lines, not 1']],
      [[...records(), { t: 9, dir: 'out', v: {} }], ['demo/linux.jsonl:7: out after the exit']],
      [
        [
          {
            t: 0,
            dir: 'config',
            v: { suite: 'x', case: 'main', platform: 'linux', argv: [1], env: { A: 1 }, more: 1 },
          },
          { t: 1, dir: 'in', v: 3 },
          { t: 1, dir: 'out', v: 'text' },
          { t: 1, dir: 'err', v: {} },
          { t: 1, dir: 'cmd', v: { stdin: 'close' } },
          { t: 1, dir: 'timer', v: { name: 1 } },
          { t: 2, dir: 'exit', v: { code: 1, signal: null } },
        ],
        [
          'demo/linux.jsonl:1: config unknown field more',
          'demo/linux.jsonl:1: config suite, case and platform differ from the manifest entry',
          'demo/linux.jsonl:1: config argv is not a string array',
          'demo/linux.jsonl:1: config env is not a map of strings and nulls',
          'demo/linux.jsonl:2: in is not a frame or a line',
          'demo/linux.jsonl:3: out is not a frame',
          'demo/linux.jsonl:4: err is not text',
          'demo/linux.jsonl:5: unknown cmd {"stdin":"close"}',
          'demo/linux.jsonl:6: timer is not {name}',
          'demo/linux.jsonl:7: exit differs from the manifest entry',
        ],
      ],
      [
        [{ t: 0, dir: 'config', v: 1 }, ...records().slice(1)],
        ['demo/linux.jsonl:1: config is not an object'],
      ],
    ];
    for (const [content, expected] of cases) {
      const text = typeof content === 'string' ? content : jsonl(content);
      const root = dataDir({ files: { 'demo/linux.jsonl': text } });
      expect(problems(root), text.slice(0, 60)).toEqual(expected);
    }
  });

  it('accepts a timer record and the recorder EOF after the exit', () => {
    const lines = [
      ...records().slice(0, 3),
      { t: 3, dir: 'timer', v: { name: 'idle' } },
      { t: 5, dir: 'exit', v: { code: 0, signal: null } },
      { t: 6, dir: 'cmd', v: { stdin: 'eof' } },
    ];
    const root = dataDir({
      files: {
        'demo/linux.jsonl': jsonl(lines),
        'demo/linux.expect.jsonl': jsonl(lines.map(() => EMPTY_EXPECT)),
      },
    });
    expect(load(root)[0]?.variants[0]?.records.map((record) => record.dir)).toEqual([
      'config',
      'in',
      'out',
      'timer',
      'exit',
      'cmd',
    ]);
  });

  it('checks the text: UTF-8, no BOM, no CR, no blank line, a final newline', () => {
    const text = jsonl(records());
    const cases: [string | Buffer, string[]][] = [
      [Buffer.from([0xff, 0xfe, 0x0a]), ['demo/linux.jsonl: not valid UTF-8']],
      [
        `${String.fromCharCode(0xfeff)}${text}`,
        ['demo/linux.jsonl: starts with a byte-order mark'],
      ],
      [text.replace('\n', '\r\n'), ['demo/linux.jsonl: contains a carriage return']],
      [text.slice(0, -1), ['demo/linux.jsonl: does not end with a newline']],
      [`${text}\n`, ['demo/linux.jsonl:7: blank line']],
    ];
    for (const [content, expected] of cases) {
      expect(problems(dataDir({ files: { 'demo/linux.jsonl': content } }))).toEqual(expected);
    }
  });

  it('checks compressed data: a gzip stream exactly when declared, intact', () => {
    const gz = 'demo/linux.jsonl.gz';
    const manifest = { $comment: '', format: '', entries: [entry({ file: gz, compressed: true })] };
    const catalogue = [{ ...DEMO, compressed: true }];
    const zipped = gzipSync(Buffer.from(jsonl(records())));
    const expectFile = { 'demo/linux.expect.jsonl': jsonl(records().map(() => EMPTY_EXPECT)) };
    const good = dataDir({ manifest, files: { [gz]: zipped, ...expectFile } });
    expect(load(good, { catalogue })[0]?.variants[0]?.records).toHaveLength(6);
    // A flipped byte inside the deflate data fails the CRC or the inflate.
    const corrupt = Buffer.from(zipped);
    corrupt[corrupt.length - 12] = (corrupt[corrupt.length - 12] ?? 0) ^ 0xff;
    const [problem] = problems(dataDir({ manifest, files: { [gz]: corrupt, ...expectFile } }), {
      catalogue,
    });
    expect(problem).toMatch(/^demo\/linux\.jsonl\.gz: gzip data is corrupt: /u);
    expect(
      problems(dataDir({ manifest, files: { [gz]: jsonl(records()), ...expectFile } }), {
        catalogue,
      }),
    ).toEqual(['demo/linux.jsonl.gz: not a gzip stream']);
    expect(problems(dataDir({ files: { 'demo/linux.jsonl': zipped, ...expectFile } }))).toEqual([
      'demo/linux.jsonl: gzip data in an uncompressed file',
    ]);
    expect(() => decodeStored(Buffer.from([0x1f]), true, 'one byte')).toThrow(
      /one byte: not a gzip stream/u,
    );
  });

  it('checks the expect file: one expect line per record line, nothing else', () => {
    const base = { 'demo/linux.jsonl': jsonl(records()) };
    const cases: [string, string[]][] = [
      [jsonl([EMPTY_EXPECT]), ['demo/linux.expect.jsonl: 1 expect lines for 6 record lines']],
      [
        jsonl([
          ...records()
            .slice(1)
            .map(() => EMPTY_EXPECT),
          { dir: 'expect', effects: [] },
        ]),
        ['demo/linux.expect.jsonl:6: not {"dir":"expect","effects":[],"events":[]}'],
      ],
      [
        jsonl([
          ...records()
            .slice(1)
            .map(() => EMPTY_EXPECT),
          { ...EMPTY_EXPECT, extra: 1 },
        ]),
        ['demo/linux.expect.jsonl:6: not {"dir":"expect","effects":[],"events":[]}'],
      ],
      [
        `${jsonl(
          records()
            .slice(1)
            .map(() => EMPTY_EXPECT),
        )}{\n`,
        ['demo/linux.expect.jsonl:6: not JSON'],
      ],
    ];
    for (const [content, expected] of cases) {
      const root = dataDir({ files: { ...base, 'demo/linux.expect.jsonl': content } });
      expect(problems(root)).toEqual(expected);
    }
  });

  it('rethrows anything that is not a data problem', () => {
    const root = dataDir();
    // A directory where the record file should be: reading it is an I/O error.
    rmSync(path.join(root, 'demo', 'linux.jsonl'));
    mkdirSync(path.join(root, 'demo', 'linux.jsonl'));
    expect(() => load(root)).toThrow(/EISDIR|EPERM|illegal operation/iu);
  });

  it('reads the pinned CLI version, and refuses a pin without one', () => {
    expect(pinnedCliVersion()).toMatch(/^\d+\.\d+\.\d+$/u);
    const root = dataDir();
    const pin = path.join(root, 'pin.json');
    writeFileSync(pin, '{}');
    expect(() => pinnedCliVersion(pin)).toThrow(ConformanceDataError);
  });

  it('points at the committed data directory by default', () => {
    expect(readFileSync(path.join(CONFORMANCE_ROOT, 'manifest.json'), 'utf8')).toContain(
      '"entries"',
    );
  });
});
