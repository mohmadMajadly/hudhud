import { describe, expect, it } from 'vitest';

import { normalizeRecords, Normalizer, projectSlug } from '../../src/fixtures/normalize.js';
import type { NormalizeContext } from '../../src/fixtures/normalize.js';

const KEY = 'hudhud-fake-api-key-not-a-credential';
// A key-shaped string assembled at run time: the redactor must catch the
// `sk-ant-` shape, and the repository's privacy scan refuses that shape in
// source text.
const KEY_SHAPED = ['sk', 'ant', 'api03', 'abc_DEF'].join('-');

const WIN: NormalizeContext = {
  paths: [
    { path: 'D:\\t\\hudhud-run-ab\\work', token: '<work>' },
    { path: 'D:\\t\\hudhud-run-ab\\cfg', token: '<cfg>' },
    { path: 'D:\\t\\hudhud-run-ab', token: '<root>' },
    { path: '', token: '<empty>' },
  ],
  pids: [4242],
  secrets: [KEY, ''],
  version: '2.1.296',
  cwd: 'D:\\t\\hudhud-run-ab\\work',
};

describe('projectSlug', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(projectSlug('D:\\t\\run_1\\work')).toBe('D--t-run-1-work');
  });
});

describe('Normalizer.string', () => {
  it('redacts secrets, API keys and bearer tokens', () => {
    const n = new Normalizer(WIN);
    expect(n.string(`key=${KEY} other=${KEY_SHAPED} Authorization: Bearer abc.def`)).toBe(
      'key=<redacted> other=<redacted> Authorization: Bearer <redacted>',
    );
  });

  it('replaces sandbox paths in both slash styles and any case, longest first, and the project slug', () => {
    const n = new Normalizer(WIN);
    expect(n.string('D:\\t\\hudhud-run-ab\\work\\a.txt')).toBe('<work>\\a.txt');
    expect(n.string('d:/t/hudhud-run-ab/cfg/projects')).toBe('<cfg>/projects');
    expect(n.string('D:\\t\\hudhud-run-ab\\cfg\\projects\\D--t-hudhud-run-ab-work\\memory')).toBe(
      '<cfg>\\projects\\<proj>\\memory',
    );
    expect(n.string('D:\\t\\hudhud-run-ab\\tmp')).toBe('<root>\\tmp');
  });

  it('numbers uuids and long hex ids by first appearance, case-insensitively', () => {
    const n = new Normalizer({ paths: [], pids: [], secrets: [] });
    const a = 'd6e7fffb-1111-4222-8333-444455556666';
    const b = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(n.string(`${a} ${b} ${a.toUpperCase()}`)).toBe('<uuid-1> <uuid-2> <uuid-1>');
    expect(n.string('cc-msg-d7b08732db699f1fdbbee445b4819b90 1234567890123456789')).toBe(
      'cc-msg-<hex-1> 1234567890123456789',
    );
  });

  it('replaces timestamps, the version and pids in path or name segments only', () => {
    const n = new Normalizer(WIN);
    expect(n.string('at 2026-10-12T15:41:28.123Z v2.1.296')).toBe('at <timestamp> v<version>');
    expect(n.string('sessions\\4242.json /x/4242 cc-4242.sock 42420 tokens 4242 /4242')).toBe(
      'sessions\\1001.json /x/4242 cc-1001.sock 42420 tokens 4242 /1001',
    );
  });

  it('works without version or cwd', () => {
    const n = new Normalizer({ paths: [], pids: [], secrets: [], version: '' });
    expect(n.string('2.1.296')).toBe('2.1.296');
  });
});

describe('Normalizer.value', () => {
  it('maps pid fields, zeroes timing and cost fields, keeps other numbers', () => {
    const n = new Normalizer(WIN);
    expect(
      n.value({
        pid: 4242,
        child_pid: 77,
        parentPid: 77,
        duration_ms: 123,
        duration_api_ms: 5,
        total_cost_usd: 0.25,
        createdAt: 1,
        timestamp: 2,
        ttftMs: 3,
        num_turns: 2,
        usage: { input_tokens: 10 },
        pidless: 5,
        items: 4,
        format: 1,
        nested: [{ pid: 0 }, { pid: 1.5 }],
      }),
    ).toEqual({
      pid: 1001,
      child_pid: 1002,
      parentPid: 1002,
      duration_ms: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      createdAt: 0,
      timestamp: 0,
      ttftMs: 0,
      num_turns: 2,
      usage: { input_tokens: 10 },
      pidless: 5,
      items: 4,
      format: 1,
      nested: [{ pid: 0 }, { pid: 1.5 }],
    });
  });

  it('normalizes keys, strings, versions under version keys and leaves scalars', () => {
    const n = new Normalizer({ paths: [], pids: [], secrets: [] });
    expect(
      n.value({
        claude_code_version: '9.9.9',
        version: '1.0.0-beta.1',
        other_version: 'not semver',
        'd6e7fffb-1111-4222-8333-444455556666': true,
        list: [1, 'x', null, false],
      }),
    ).toEqual({
      claude_code_version: '<version>',
      version: '<version>',
      other_version: 'not semver',
      '<uuid-1>': true,
      list: [1, 'x', null, false],
    });
    expect(n.value(3)).toBe(3);
    expect(n.value(null)).toBeNull();
  });
});

describe('normalizeRecords', () => {
  it('learns pids from every record before replacing them in strings', () => {
    const lines = normalizeRecords(
      [
        { t: 0, dir: 'out', v: { type: 'system', path: '/cfg/sessions/9001.json' } },
        {
          t: 5,
          dir: 'out',
          v: { type: 'control_response', response: { response: { pid: 9001 } } },
        },
        { t: 6, dir: 'exit', v: { code: 0, signal: null } },
      ],
      { paths: [], pids: [], secrets: [] },
    );
    expect(lines).toEqual([
      { t: 0, dir: 'out', v: { type: 'system', path: '/cfg/sessions/1001.json' } },
      { t: 5, dir: 'out', v: { type: 'control_response', response: { response: { pid: 1001 } } } },
      { t: 6, dir: 'exit', v: { code: 0, signal: null } },
    ]);
  });
});
