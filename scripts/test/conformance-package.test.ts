// The data package @hudhudjs/conformance (scripts/lib/conformance-package.mjs,
// scripts/conformance-package.mjs; ADR-0004 amendment of 2026-10-18): which
// fixtures it ships, the rendered index, and that the built package holds
// exactly the canonical expected streams, byte for byte. Needs a prior
// `pnpm build` (which builds the package), like the tarball check.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  compareFiles,
  CONFORMANCE_PACKAGE,
  INDEX_DTS,
  loadExpected,
  PACKAGE_DIR,
  renderIndexJs,
  SOURCE_DIR,
  streamsOf,
} from '../lib/conformance-package.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const VERSION = (
  JSON.parse(readFileSync(path.join(REPO, PACKAGE_DIR, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('streamsOf', () => {
  it('takes every expected stream and nothing of the raw recordings', () => {
    const { streams, problems } = streamsOf([
      'manifest.json',
      'text-turn/linux.jsonl',
      'text-turn/win32.expect.jsonl',
      'text-turn/linux.expect.jsonl',
      'big-frame-5mb/linux.jsonl.gz',
      'resume/linux.setup.expect.jsonl',
    ]);
    expect(problems).toEqual([]);
    expect(streams).toEqual([
      {
        scenario: 'resume',
        platform: 'linux',
        case: 'setup',
        path: 'dist/streams/resume/linux.setup.expect.jsonl',
        specifier: `${CONFORMANCE_PACKAGE}/streams/resume/linux.setup.expect.jsonl`,
      },
      {
        scenario: 'text-turn',
        platform: 'linux',
        case: null,
        path: 'dist/streams/text-turn/linux.expect.jsonl',
        specifier: `${CONFORMANCE_PACKAGE}/streams/text-turn/linux.expect.jsonl`,
      },
      {
        scenario: 'text-turn',
        platform: 'win32',
        case: null,
        path: 'dist/streams/text-turn/win32.expect.jsonl',
        specifier: `${CONFORMANCE_PACKAGE}/streams/text-turn/win32.expect.jsonl`,
      },
    ]);
  });

  it('refuses an expected stream of an unknown shape, and an empty suite', () => {
    expect(
      streamsOf(['darwin.expect.jsonl', 'a/b/linux.expect.jsonl', 'X/linux.expect.jsonl']).problems,
    ).toEqual([
      `${SOURCE_DIR}/X/linux.expect.jsonl: not <scenario>/<platform>[.<case>].expect.jsonl`,
      `${SOURCE_DIR}/a/b/linux.expect.jsonl: not <scenario>/<platform>[.<case>].expect.jsonl`,
      `${SOURCE_DIR}/darwin.expect.jsonl: not <scenario>/<platform>[.<case>].expect.jsonl`,
    ]);
    expect(streamsOf(['manifest.json']).problems).toEqual([
      `${SOURCE_DIR} holds no expected stream`,
    ]);
  });
});

describe('the index', () => {
  it('lists the version and every stream, frozen', async () => {
    const { streams } = streamsOf(['t/linux.expect.jsonl']);
    const text = renderIndexJs('1.2.3', streams);
    const url = `data:text/javascript,${encodeURIComponent(text)}`;
    const module = (await import(url)) as {
      HUDHUD_VERSION: string;
      CONFORMANCE_STREAMS: readonly unknown[];
    };
    expect(module.HUDHUD_VERSION).toBe('1.2.3');
    expect(module.CONFORMANCE_STREAMS).toEqual(streams);
    expect(Object.isFrozen(module.CONFORMANCE_STREAMS)).toBe(true);
    expect(Object.isFrozen(module.CONFORMANCE_STREAMS[0])).toBe(true);
    expect(INDEX_DTS).toContain(
      'export declare const CONFORMANCE_STREAMS: readonly ConformanceStream[];',
    );
  });
});

describe('the built package', () => {
  const expected = loadExpected(REPO, VERSION);
  const dist = path.join(REPO, PACKAGE_DIR, 'dist');
  const built = readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return {
        path: path.relative(path.join(REPO, PACKAGE_DIR), file).replaceAll('\\', '/'),
        data: readFileSync(file),
      };
    });

  it('ships every expected stream of the suite, byte for byte, and nothing else', () => {
    expect(expected.problems).toEqual([]);
    expect(expected.streams.length).toBeGreaterThanOrEqual(70);
    expect(compareFiles(expected.files, built)).toEqual([]);
    for (const stream of expected.streams) {
      const source = readFileSync(
        path.join(REPO, SOURCE_DIR, stream.scenario, stream.path.split('/').at(-1) ?? ''),
      );
      expect(readFileSync(path.join(REPO, PACKAGE_DIR, stream.path)).equals(source)).toBe(true);
    }
  });

  it('indexes them at the package version', async () => {
    const index = (await import(pathToFileURL(path.join(dist, 'index.js')).href)) as {
      HUDHUD_VERSION: string;
      CONFORMANCE_STREAMS: readonly { path: string }[];
    };
    expect(index.HUDHUD_VERSION).toBe(VERSION);
    expect(index.CONFORMANCE_STREAMS.map((stream) => stream.path)).toEqual(
      expected.streams.map((stream) => stream.path),
    );
  });

  it('names a changed, missing or extra file', () => {
    const files = new Map([
      ['dist/a', Buffer.from('a')],
      ['dist/b', Buffer.from('b')],
    ]);
    expect(
      compareFiles(files, [
        { path: 'dist/a', data: Buffer.from('changed') },
        { path: 'dist/c', data: Buffer.from('c') },
      ]),
    ).toEqual([
      `dist/a: differs from its source (${SOURCE_DIR} or the generated index)`,
      'dist/c: not a file of the conformance data',
      'dist/b: missing',
    ]);
  });
});
